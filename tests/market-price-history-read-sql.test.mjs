import assert from "node:assert/strict"
import test from "node:test"
import { setupMarketHistoryApp } from "./fixtures/market-price-history-app.mjs"

test("actual GET/audit/SQL returns complete raw market rows, preserves microseconds, and never mutates data", async () => {
  const f=await setupMarketHistoryApp()
  try {
    const before=await f.state()
    const response=await f.read(),data=await response.json()
    assert.equal(response.status,200);assert.equal(data.ports.length,2);assert.equal(data.rows.length,3)
    assert.ok(data.rows.some(row=>row.recorded_at==="2026-10-01T23:30:00.000001"))
    assert.deepEqual(await f.state(),before)
    assert.deepEqual(f.permissions,[{page:"taiwan-price-history",access:"view"}])
    assert.equal(f.auditHeaders[0]["x-bunker-admin-user"],"SERVER-EDITOR")
    assert.equal(f.auditHeaders[0]["x-bunker-admin-page-id"],"taiwan-price-history")
    f.control.access="view"
    assert.equal((await f.read("hongkong")).status,200)
    assert.deepEqual(await f.state(),before)
  } finally { await f.db.close() }
})

test("single scalar read exceeds ordinary 1,000-row limits, but oversize/incomplete snapshots fail closed", async () => {
  const f=await setupMarketHistoryApp()
  try {
    await f.db.exec(`insert into price_history(port_id,recorded_at,hsfo) select '${f.basis}','2020-01-01'::timestamp+g*interval '1 minute',g from generate_series(1,1001) g`)
    let response=await f.read("hongkong")
    assert.equal(response.status,200);assert.equal((await response.json()).rows.length,1004)
    const before=await f.state()
    for(const key of ["readFailure","badRead"]) {
      f.control[key]=true;response=await f.read();assert.equal(response.status,503)
      assert.doesNotMatch(JSON.stringify(await response.json()),/PRIVATE/);f.control[key]=false
    }
    assert.deepEqual(await f.state(),before)
    await f.db.exec(`insert into price_history(port_id,recorded_at,hsfo) select '${f.basis}','2021-01-01'::timestamp+g*interval '1 minute',g from generate_series(1,49000) g`)
    assert.equal((await f.read("hongkong")).status,503)
    for(const role of ["anon","authenticated"]) {
      await f.db.exec(`reset role;set role ${role}`)
      await assert.rejects(()=>f.db.query("select public.read_market_price_history('hongkong')"),/permission denied/)
    }
  } finally { await f.db.close() }
})

test("missing/ambiguous/divider root ports do not become blank editable history; denied requests never reach SQL", async () => {
  const f=await setupMarketHistoryApp()
  try {
    for(const auth of ["Unauthorized","Forbidden"]) {
      f.control.auth=auth;const n=f.calls.length
      assert.equal((await f.read()).status,auth==="Unauthorized"?401:403);assert.equal(f.calls.length,n)
    }
    f.control.auth=null
    // Deliberately model damaged/pre-guard legacy data. Ordinary updates now
    // cannot turn a required market root into a divider.
    await f.db.exec(`reset role;alter table ports disable trigger protect_required_report_port_identity;update ports set type='divider' where id='${f.chained}';alter table ports enable trigger protect_required_report_port_identity;set role service_role`)
    assert.equal((await f.read()).status,503)
    await f.db.exec(`update ports set type='port' where id='${f.chained}';insert into ports(name) values ('KAOHSIUNG')`)
    assert.equal((await f.read()).status,503)
  } finally { await f.db.close() }
})
