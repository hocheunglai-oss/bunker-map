import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { setup, basis } from "./fixtures/price-setter-sql.mjs"

const divider = "55555555-5555-4555-8555-555555555555"
async function fallback(app, key, expected, value) {
  return (await app.db.query("select public.save_price_setter_fallback($1,$2,$3) as result", [key, expected, value])).rows[0].result
}
async function rename(app, expected, name, id = divider) {
  return (await app.db.query("select public.rename_price_setter_divider($1::uuid,$2,$3) as result", [id, expected, name])).rows[0].result
}
async function remarks(app) {
  return (await app.db.query("select * from public.remarks order by id")).rows
}

test("per-key fallback saves create the missing map, preserve other settings, and merge different-key edits", async () => {
  const app = await setup()
  try {
    await app.db.exec("insert into remarks(id,content) values (1,'KEEP NOTICE'),(101,'KEEP REPORT'); set role service_role")
    assert.deepEqual(await fallback(app, "basis::hsfo", null, "NA"), { key: "basis::hsfo", fallbacks: { "basis::hsfo": "NA" } })
    // PGlite executes queued statements in one backend. This proves merge/CAS
    // semantics, not multi-backend locking or production concurrency.
    await Promise.all([fallback(app, "basis::mgo", null, "SE"), fallback(app, "other::hsfo", null, "-"), fallback(app, "basis::vlsfo", null, "NA")])
    const saved = await remarks(app)
    assert.deepEqual(saved.slice(0, 2), [{ id: 1, content: "KEEP NOTICE" }, { id: 101, content: "KEEP REPORT" }])
    assert.deepEqual(JSON.parse(saved[2].content), { "basis::hsfo": "NA", "basis::mgo": "SE", "other::hsfo": "-", "basis::vlsfo": "NA" })
    const before = await remarks(app)
    await assert.rejects(fallback(app, "basis::hsfo", null, "SE"), error => error.code === "P0002")
    assert.deepEqual(await remarks(app), before)
    assert.deepEqual((await fallback(app, "basis::hsfo", null, "NA")).fallbacks, JSON.parse(before[2].content), "lost-response retry confirms the saved value")
    assert.deepEqual(await remarks(app), before)
  } finally { await app.db.close() }
})

test("unreadable stored fallback maps and invalid direct inputs never overwrite existing content", async () => {
  const app = await setup()
  try {
    for (const content of ["{broken", "null", "[]", '{"basis::hsfo":null}', '{"BASIS::hsfo":"NA"}', '{"basis::hsfo":"bad"}', '{"::hsfo":"NA"}']) {
      await app.db.query("insert into remarks(id,content) values(105,$1) on conflict(id) do update set content=excluded.content", [content])
      const before = await remarks(app)
      await assert.rejects(fallback(app, "basis::hsfo", null, "NA"), error => error.code === "P0001")
      assert.deepEqual(await remarks(app), before)
    }
    for (const content of [null, ""]) {
      await app.db.query("update remarks set content=$1 where id=105", [content])
      assert.equal((await fallback(app, "basis::hsfo", null, "NA")).fallbacks["basis::hsfo"], "NA")
    }
    const before = await remarks(app)
    for (const args of [[null,null,"NA"], ["BASIS::hsfo",null,"NA"], ["missing::hsfo",null,"NA"], ["basis::hsfo",null,"bad"], ["basis::hsfo","bad","NA"], ["basis::other",null,"NA"], [" ::hsfo",null,"NA"]]) {
      await assert.rejects(fallback(app, ...args), error => error.code === "22023")
      assert.deepEqual(await remarks(app), before)
    }
  } finally { await app.db.close() }
})

test("divider rename is a conflict-checked name-only edit with safe retry and rollback", async () => {
  const app = await setup()
  try {
    await app.db.query("insert into ports(id,name,type,hsfo,display_order,updated_at) values($1,'Old','divider',123,17,'2026-10-08')", [divider])
    const old = await app.row(divider), saved = await rename(app, "Old", " New ")
    assert.deepEqual(saved.port, { ...old, name: "New" })
    const before = await app.state()
    assert.deepEqual((await rename(app, "Old", "New")).port, saved.port)
    await assert.rejects(rename(app, "Old", "Other"), error => error.code === "P0002")
    await assert.rejects(rename(app, "Basis", "Overwrite actual port", basis), error => error.code === "P0002")
    await assert.rejects(fallback(app, "new::hsfo", null, "NA"), error => error.code === "22023")
    assert.deepEqual(await app.state(), before)
    for (const args of [[null,"Valid"], ["New",null], ["New"," "], ["New","x".repeat(201)]]) {
      await assert.rejects(rename(app, ...args), error => error.code === "22023")
    }
    await app.db.exec("create function synthetic_settings_failure() returns trigger language plpgsql as $$ begin raise exception 'SYNTHETIC_FAILURE'; end $$; create trigger test_settings_failure before update on ports for each row execute function synthetic_settings_failure()")
    await assert.rejects(rename(app, "New", "Failed"), /SYNTHETIC_FAILURE/)
    assert.deepEqual(await app.state(), before)
  } finally { await app.db.close() }
})

test("failed remark writes roll back and the two settings functions are invoker-only, service-only", async () => {
  const app = await setup()
  try {
    await fallback(app, "basis::hsfo", null, "NA")
    const before = await remarks(app)
    await app.db.exec("create function synthetic_settings_failure() returns trigger language plpgsql as $$ begin raise exception 'SYNTHETIC_FAILURE'; end $$; create trigger test_settings_failure before update on remarks for each row execute function synthetic_settings_failure()")
    await assert.rejects(fallback(app, "basis::mgo", null, "SE"), /SYNTHETIC_FAILURE/)
    assert.deepEqual(await remarks(app), before)
    const definitions = (await app.db.query("select proname,prosecdef,proconfig from pg_proc where proname in ('save_price_setter_fallback','rename_price_setter_divider')")).rows
    assert.equal(definitions.length, 2)
    for (const def of definitions) { assert.equal(def.prosecdef, false); assert.ok(def.proconfig.includes('search_path=""')); assert.ok(def.proconfig.includes('lock_timeout=5s')) }
    for (const role of ["anon", "authenticated"]) {
      await app.db.exec(`set role ${role}`)
      await assert.rejects(fallback(app, "basis::hsfo", "NA", "SE"), error => error.code === "42501")
      await assert.rejects(rename(app, "Old", "New"), error => error.code === "42501")
      await app.db.exec("reset role")
    }
  } finally { await app.db.close() }
})

test("append-only divider repair changes only lock order and acquires the table before the row", async () => {
  const app = await setup()
  try {
    const original = readFileSync(new URL("../supabase/migrations/20261008112629_atomic_price_setter_save.sql", import.meta.url), "utf8")
    const start = original.indexOf("create or replace function public.rename_price_setter_divider(")
    assert.ok(start >= 0)
    const previousBody = original.slice(start).split("as $$")[1].split("$$;")[0]
    const currentBody = (await app.db.query("select prosrc from pg_proc where oid='public.rename_price_setter_divider(uuid,text,text)'::regprocedure")).rows[0].prosrc
    const tableLock = "lock table public.ports in share row exclusive mode;"
    assert.ok(currentBody.indexOf(tableLock) >= 0)
    assert.ok(currentBody.indexOf(tableLock) < currentBody.indexOf("for update;"), "all supported writers must lock the table before an individual row")
    const normalize = value => value.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim()
    assert.equal(normalize(currentBody.replace(tableLock, "")), normalize(previousBody), "validation, stale-conflict, retry and return behavior remain identical")
  } finally { await app.db.close() }
})
