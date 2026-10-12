import assert from "node:assert/strict"
import test from "node:test"
import { priceSetterSnapshot, buildPriceSetterChanges } from "../lib/priceSetterMutation.ts"
import { setup, basis, linked, chained, other } from "./fixtures/price-setter-sql.mjs"

test("one SQL transaction preserves zero, HK date/history time, and transitive linked dates", async () => {
  const app = await setup()
  try {
    const result = await app.save({ hsfo: 0, lat: 0, lng: 0 })
    assert.equal(result.history.hsfo, 0)
    assert.equal(result.history.recorded_at, "2026-10-09T02:30:00.123")
    assert.equal(result.ports.length, 3)
    for (const port of result.ports) assert.equal(port.updated_at, "2026-10-09")
    assert.equal((await app.row(other)).updated_at, "2026-10-08")
    const second = await app.save({ hsfo: 10 }, { time: "2026-10-09T12:00:00+08:00" })
    assert.equal(second.history.id, result.history.id)
    assert.equal((await app.db.query("select count(*)::int as count from price_history")).rows[0].count, 1)
    await app.save({ hsfo: 20 }, { time: "2026-10-09T18:30:00Z" })
    assert.equal((await app.db.query("select count(*)::int as count from price_history")).rows[0].count, 2)
  } finally { await app.db.close() }
})

for (const stage of ["history_insert", "dependent_update", "duplicate_delete"]) test(`SQL failure at ${stage} rolls back the port, linked dates and history together`, async () => {
  const app = await setup()
  try {
    if (stage === "duplicate_delete") await app.db.exec(`insert into price_history(port_id,hsfo,recorded_at) values ('${basis}',500,'2026-10-09 01:00'),('${basis}',550,'2026-10-09 02:00')`)
    const before = await app.state()
    const table = stage === "dependent_update" ? "ports" : "price_history"
    const operation = stage === "dependent_update" ? "update" : stage === "duplicate_delete" ? "delete" : "insert"
    await app.db.exec(`create function synthetic_failure() returns trigger language plpgsql as $$ begin ${stage === "dependent_update" ? `if new.id='${linked}'::uuid then ` : ""}raise exception 'SYNTHETIC_FAILURE';${stage === "dependent_update" ? "end if; return new;" : ""} end $$; create trigger test_failure before ${operation} on ${table} for each row execute function synthetic_failure();`)
    await assert.rejects(app.save({ hsfo: 777 }), /SYNTHETIC_FAILURE/)
    assert.deepEqual(await app.state(), before, "no successful earlier step may survive a later failure")
  } finally { await app.db.close() }
})

test("stale saves cannot overwrite a newer edit; lost-response replay is a verified no-op", async () => {
  const app = await setup()
  try {
    const expected = priceSetterSnapshot(await app.row())
    const first = await app.save({ hsfo: 777 }, { expected })
    const before = await app.state()
    await assert.rejects(app.save({ hsfo: 888 }, { expected }), error => error.code === "P0002")
    assert.deepEqual(await app.state(), before)
    const replay = await app.save({ hsfo: 777 }, { expected })
    assert.equal(replay.replayed, true); assert.equal(replay.history.id, first.history.id)
    assert.deepEqual(await app.state(), before)
    const competing = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => app.save({ hsfo: 900 + i }, { expected: priceSetterSnapshot(first.ports.find(port => port.id === basis)) })))
    assert.equal(competing.filter(result => result.status === "fulfilled").length, 1)
    assert.equal(competing.filter(result => result.status === "rejected" && result.reason.code === "P0002").length, 19)
    assert.equal((await app.db.query("select count(*)::int as count from price_history")).rows[0].count, 1)
  } finally { await app.db.close() }
})

test("renaming a basis port retains formulas; invalid references/cycles roll back", async () => {
  const app = await setup()
  try {
    await app.save({ name: "New basis" })
    assert.equal((await app.row(linked)).vlsfo_formula, "New basis + 0")
    assert.equal((await app.row(linked)).mgo_formula, "New basis - -5")
    const before = await app.state()
    for (const changes of [{ vlsfo_formula: "Chained + 0" }, { vlsfo_formula: "Missing + 0" }, { name: "Other" }, { mgo_formula: "New basis + 0" }]) {
      await assert.rejects(app.save(changes), error => error.code === "22023")
      assert.deepEqual(await app.state(), before)
    }
  } finally { await app.db.close() }
})

test("RPC is invoker-only, refuses browser roles, validates direct SQL inputs, and survives different session timezones", async () => {
  const app = await setup()
  try {
    assert.equal((await app.db.query("select prosecdef from pg_proc where proname='save_price_setter_port'")).rows[0].prosecdef, false)
    for (const role of ["anon", "authenticated"]) {
      await app.db.exec(`set role ${role}`)
      await assert.rejects(app.db.query("select public.save_price_setter_port(null,null,null)"), error => error.code === "42501")
      await app.db.exec("reset role")
    }
    await app.db.exec("set timezone='America/Los_Angeles'; set role service_role")
    const saved = await app.save({ hsfo: 0 })
    assert.equal(saved.history.recorded_at, "2026-10-09T02:30:00.123")
    assert.equal(saved.ports.find(port => port.id === basis).updated_at, "2026-10-09")
    const before = await app.state()
    const current = await app.row(), expected = priceSetterSnapshot(current), changes = buildPriceSetterChanges(current)
    for (const bad of [{ ...changes, hsfo: "NaN" }, { ...changes, id: other }, { ...changes, lat: 91 }, { ...changes, mgo: -1 }]) {
      await assert.rejects(app.db.query("select public.save_price_setter_port($1::uuid,$2::jsonb,$3::jsonb)", [basis, JSON.stringify(expected), JSON.stringify(bad)]), error => error.code === "22023")
      assert.deepEqual(await app.state(), before)
    }
  } finally { await app.db.close() }
})

test("missing, malformed and ambiguous references further down a formula chain reject the entire save", async () => {
  const app = await setup()
  try {
    for (const formula of ["Missing + 0", "malformed formula", "+ 0"]) {
      await app.db.query("update ports set vlsfo_formula=$1 where id=$2", [formula, other])
      const before = await app.state()
      await assert.rejects(app.save({ vlsfo_formula: "Other + 0" }, { id: linked }), error => error.code === "22023")
      assert.deepEqual(await app.state(), before)
    }
    await app.db.query("update ports set vlsfo_formula='Basis + 0' where id=$1", [other])
    await app.db.exec("insert into ports(name) values ('BASIS')")
    const before = await app.state()
    await assert.rejects(app.save({ vlsfo_formula: "Other + 0" }, { id: linked }), error => error.code === "22023")
    assert.deepEqual(await app.state(), before)
  } finally { await app.db.close() }
})
