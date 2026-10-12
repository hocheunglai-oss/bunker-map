import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"
import * as mutation from "../lib/priceSetterMutation.ts"
import * as history from "../lib/priceHistoryRecords.ts"
import * as settings from "../lib/priceSetterSettings.ts"
import * as order from "../lib/priceSetterOrder.ts"
import * as inventory from "../lib/priceSetterInventory.ts"
import * as creationRecovery from "../lib/priceSetterCreationRecovery.ts"
import * as priceRequest from "../lib/priceSetterRequest.ts"
import * as adminPages from "../lib/adminPages.ts"
import { setup, basis, linked } from "./fixtures/price-setter-sql.mjs"

// The actual route and actual audit-client constructor run against the exact
// SQL migration. Only auth/session and Supabase's network adapter are synthetic.
async function harness() {
  const app = await setup(), headers = [], calls = []
  const env = { NEXT_PUBLIC_SUPABASE_URL: "https://example.test", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key", NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-anon-key" }
  const session = { username: "SYNTHETIC", displayName: "Synthetic Editor", role: "BT", permissions: { pricesetter: "edit" } }
  const modules = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@/lib/adminPages": adminPages,
    "@/lib/priceSetterMutation": mutation,
    "@/lib/priceHistoryRecords": history,
    "@/lib/priceSetterSettings": settings,
    "@/lib/priceSetterOrder": order,
    "@/lib/priceSetterInventory": inventory,
    "@/lib/priceSetterCreationRecovery": creationRecovery,
    "@/lib/priceSetterRequest": priceRequest,
    "@/lib/adminAuth": { async requireAdminPagePermissionForRequest(_request, page, access) { assert.equal(page, "pricesetter"); assert.equal(access, "edit"); return session } },
    "@supabase/supabase-js": { createClient(url, key, options) {
      assert.equal(url, env.NEXT_PUBLIC_SUPABASE_URL); assert.equal(key, env.SUPABASE_SERVICE_ROLE_KEY)
      headers.push(options.global.headers)
      return { async rpc(name, args) {
        calls.push({ name, args })
        try {
          const query = name === "save_price_setter_port"
            ? ["select public.save_price_setter_port($1::uuid,$2::jsonb,$3::jsonb,$4::timestamptz) as result", [args.p_port_id, JSON.stringify(args.p_expected), JSON.stringify(args.p_changes), args.p_recorded_at]]
            : name === "save_price_setter_fallback"
              ? ["select public.save_price_setter_fallback($1,$2,$3) as result", [args.p_key, args.p_expected_value, args.p_value]]
              : name === "reorder_price_setter_ports"
                ? ["select public.reorder_price_setter_ports($1::jsonb,$2::uuid[]) as result", [JSON.stringify(args.p_expected), args.p_order]]
                : ["select public.rename_price_setter_divider($1::uuid,$2,$3) as result", [args.p_port_id, args.p_expected_name, args.p_name]]
          assert.ok(["save_price_setter_port", "save_price_setter_fallback", "rename_price_setter_divider", "reorder_price_setter_ports"].includes(name))
          const result = await app.db.query(...query)
          return { data: result.rows[0].result, error: null }
        } catch (error) { return { data: null, error: { code: error.code, message: error.message } } }
      } }
    } },
  }
  function load(path) {
    const loaded = { exports: {} }, code = transformSync(readFileSync(new URL(path, import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
    class ServerClock extends Date { constructor(...args) { super(...(args.length ? args : ["2026-10-08T18:30:00.123Z"])) } }
    new Function("require", "module", "exports", "process", "Date", code)(name => {
      assert.ok(Object.hasOwn(modules, name), `Unexpected dependency ${name}`); return modules[name]
    }, loaded, loaded.exports, { env }, ServerClock)
    return loaded.exports
  }
  modules["@/lib/adminAudit"] = load("../lib/adminAudit.ts")
  const route = load("../app/api/admin/prices/route.ts")
  await app.db.exec("set role service_role")
  return { ...app, headers, calls, async input(changes = {}, expected) {
    const row = await app.row()
    return { portId: basis, expected: expected || mutation.priceSetterSnapshot(row), changes: mutation.buildPriceSetterChanges({ ...row, ...changes }) }
  }, async request(input, method = "POST") {
    const response = await route[method](new Request("https://example.test/api/admin/prices", { method, headers: { "Content-Type": "application/json", Referer: "https://example.test/admin/user-management" }, body: JSON.stringify(input) }))
    return { status: response.status, body: await response.json() }
  } }
}

test("actual endpoint, audit client and SQL transaction agree on the saved price/history/HK date", async () => {
  const app = await harness()
  try {
    const input = await app.input({ name: "New Basis", hsfo: 0 })
    const response = await app.request(input)
    assert.equal(response.status, 200)
    mutation.confirmPriceSetterSave(response.body, basis, input.changes, "2026-10-09")
    assert.equal((await app.row()).hsfo, 0); assert.equal((await app.row(linked)).vlsfo_formula, "New Basis + 0")
    assert.equal(response.body.history.recorded_at, "2026-10-09T02:30:00.123")
    assert.deepEqual(app.headers, [{ "x-bunker-admin-user": "SYNTHETIC", "x-bunker-admin-display-name": "Synthetic Editor", "x-bunker-admin-role": "BT", "x-bunker-admin-page-id": "pricesetter", "x-bunker-admin-page-label": adminPages.ADMIN_PAGE_DEFINITIONS.find(page => page.id === "pricesetter").label, "x-bunker-admin-page-path": "/admin/pricesetter" }])
    assert.equal(app.calls.length, 1)
    const before = await app.state(), replay = await app.request(input)
    assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.deepEqual(await app.state(), before)
    const conflict = await app.request({ ...input, changes: { ...input.changes, hsfo: 1 } })
    assert.equal(conflict.status, 409); assert.equal(conflict.body.code, "PRICE_CONFLICT"); assert.deepEqual(await app.state(), before)
  } finally { await app.db.close() }
})

test("actual settings PATCH and audit client agree with SQL on per-key merge, conflict, retry and divider rename", async () => {
  const app = await harness()
  try {
    const input = { operation: "fallback", key: "basis::hsfo", expectedValue: null, value: "NA" }
    assert.equal((await app.request(input, "PATCH")).status, 200)
    const merged = await app.request({ ...input, key: "other::mgo", value: "SE" }, "PATCH")
    assert.equal(merged.status, 200); assert.deepEqual(merged.body.fallbacks, { "basis::hsfo": "NA", "other::mgo": "SE" })
    assert.equal((await app.request({ ...input, value: "SE" }, "PATCH")).status, 409)
    assert.equal((await app.request(input, "PATCH")).status, 200)
    await app.db.exec("insert into ports(id,name,type) values('55555555-5555-4555-8555-555555555555','Old','divider')")
    const divider = { operation: "divider", portId: "55555555-5555-4555-8555-555555555555", expectedName: "Old", name: "New" }
    const renamed = await app.request(divider, "PATCH")
    assert.equal(renamed.status, 200); assert.equal(renamed.body.port.name, "New")
    assert.equal((await app.request({ ...divider, name: "Conflict" }, "PATCH")).status, 409)
    assert.equal((await app.request(divider, "PATCH")).status, 200)
    for (const header of app.headers) { assert.equal(header["x-bunker-admin-page-id"], "pricesetter"); assert.equal(header["x-bunker-admin-user"], "SYNTHETIC") }
    assert.equal(app.calls.length, 7)
    await app.db.exec("update remarks set content='{broken' where id=105")
    assert.equal((await app.request(input, "PATCH")).status, 503)
    assert.equal((await app.db.query("select content from remarks where id=105")).rows[0].content, "{broken")
  } finally { await app.db.close() }
})

test("actual price endpoint preserves renamed overrides and does not leak conflicting/corrupt settings", async () => {
  const app = await harness()
  try {
    await app.db.exec(`insert into remarks(id,content) values(105,'{"basis::hsfo":"NA","basis::mgo":"SE"}')`)
    const input = await app.input({ name: "New Basis", hsfo: 0 })
    const result = await app.request(input)
    assert.equal(result.status, 200)
    assert.deepEqual(JSON.parse((await app.db.query("select content from remarks where id=105")).rows[0].content), { "new basis::hsfo": "NA", "new basis::mgo": "SE" })
    assert.equal((await app.request(input)).body.replayed, true)
    await app.db.exec(`update remarks set content='{"new basis::hsfo":"NA","conflict::hsfo":"SE"}' where id=105`)
    const before = await app.state(), content = (await app.db.query("select content from remarks where id=105")).rows[0].content
    const conflict = await app.request(await app.input({ name: "Conflict" }))
    assert.equal(conflict.status, 409)
    assert.deepEqual(await app.state(), before)
    assert.equal((await app.db.query("select content from remarks where id=105")).rows[0].content, content)
    await app.db.exec("update remarks set content='{broken' where id=105")
    const broken = await app.request(await app.input({ name: "Next Basis" }))
    assert.equal(broken.status, 503)
    assert.doesNotMatch(JSON.stringify(broken.body), /Destination|Stored|SQL|P0001|broken/)
    assert.deepEqual(await app.state(), before)
  } finally { await app.db.close() }
})

test("actual reorder endpoint and audit client commit all positions, reject stale ordering and safely retry", async () => {
  const app = await harness()
  try {
    const rows = (await app.db.query("select id,display_order from ports order by display_order asc nulls last,id")).rows
    const input = { operation: "reorder", expected: rows.map(row => [row.id, row.display_order]), order: rows.map(row => row.id).reverse() }
    const result = await app.request(input, "PATCH")
    assert.equal(result.status, 200); order.confirmPriceSetterOrder(result.body, input.order)
    assert.equal((await app.request(input, "PATCH")).body.replayed, true)
    const before = await app.state()
    const stale = await app.request({ ...input, order: rows.map(row => row.id) }, "PATCH")
    assert.equal(stale.status, 409); assert.deepEqual(await app.state(), before)
    for (const header of app.headers) assert.equal(header["x-bunker-admin-page-id"], "pricesetter")
  } finally { await app.db.close() }
})

test("real SQL failures and broken formula chains surface as safe API errors with no partial writes", async () => {
  const app = await harness()
  try {
    const before = await app.state()
    const missing = await app.request(await app.input({ vlsfo_formula: "Missing + 0" }))
    assert.equal(missing.status, 400); assert.deepEqual(await app.state(), before)
    await app.db.exec("reset role; create function synthetic_failure() returns trigger language plpgsql as $$ begin raise exception 'PRIVATE SQL FAILURE'; end $$; create trigger test_failure before insert on price_history for each row execute function synthetic_failure(); set role service_role")
    const failure = await app.request(await app.input({ hsfo: 777 }))
    assert.equal(failure.status, 503); assert.doesNotMatch(JSON.stringify(failure.body), /PRIVATE/)
    assert.deepEqual(await app.state(), before)
  } finally { await app.db.close() }
})
