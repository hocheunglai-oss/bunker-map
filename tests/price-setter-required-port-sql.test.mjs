import assert from "node:assert/strict"
import test from "node:test"
import { priceSetterSnapshot, buildPriceSetterChanges } from "../lib/priceSetterMutation.ts"
import { REPORT_PUBLICATIONS } from "../lib/reportPublication.ts"
import { setup, other } from "./fixtures/price-setter-sql.mjs"
import { setupReportPublicationApp } from "./fixtures/report-publication-app.mjs"

const roots = [...new Set([...REPORT_PUBLICATIONS.hongkong.names, ...REPORT_PUBLICATIONS.taiwan.names])]
async function fullState(f) { return { ...await f.state(), remarks: (await f.db.query("select * from remarks order by id")).rows } }

test("every required report root rejects renaming or divider conversion, even by a legacy direct writer", async () => {
  const f = await setup()
  try {
    await f.db.exec("set role service_role")
    for (const name of roots) {
      await f.db.exec("begin")
      await f.db.query("update ports set name=$1 where id=$2", [name.toUpperCase(), other])
      const before = await fullState(f)
      for (const sql of ["name='Renamed root'", "type='divider'", "type='invalid'", "name=' '", "name='Section',type='divider'"]) {
        await f.db.exec("savepoint guarded_update")
        await assert.rejects(f.db.query(`update ports set ${sql},hsfo=777 where id=$1`, [other]), e => e.code === "23503" && e.message === "PORT_REQUIRED_NAME")
        await f.db.exec("rollback to savepoint guarded_update")
        assert.deepEqual(await fullState(f), before)
      }
      await f.db.exec("rollback")
    }
  } finally { await f.db.close() }
})

test("required roots still allow case/space cleanup, prices, formulas, location and ordering; normal ports/dividers remain editable", async () => {
  const f = await setup()
  try {
    await f.db.query("update ports set name=' TAIChung ',type=null where id=$1", [other])
    await f.db.exec("set role service_role")
    const result = await f.save({ name: "Taichung", hsfo: 0, vlsfo_formula: "Basis + 1", lat: 0, lng: 0 }, { id: other })
    assert.equal(result.replayed, false)
    assert.equal((await f.row(other)).name, "Taichung"); assert.equal((await f.row(other)).hsfo, 0)
    await f.db.query("update ports set display_order=123,type='port' where id=$1", [other])
    assert.equal((await f.row(other)).display_order, 123)
    const before = await fullState(f)
    await f.save({ name: "TAICHUNG" }, { id: other })
    assert.equal((await f.row(other)).name, "TAICHUNG")
    assert.equal((await fullState(f)).ports.length, before.ports.length)
    await f.db.exec("insert into ports(name,type) values('Section','divider')")
    await f.db.exec("update ports set name='Another Section' where type='divider'")
    await f.save({ name: "Renamed ordinary port" })
    assert.equal((await f.row()).name, "Renamed ordinary port")
  } finally { await f.db.close() }
})

test("required-root save rolls back all prices, history, formulas and pre-update fallback moves", async () => {
  const f = await setupReportPublicationApp()
  try {
    await f.db.exec(`insert into remarks(id,content) values(105,'{"taichung::hsfo":"NA","dalian::mgo":"SE"}')`)
    for (const name of roots) {
      const port = (await f.db.query("select * from ports where name=$1", [name])).rows[0]
      const before = await fullState(f)
      await assert.rejects(f.save({ name: `Renamed ${name}`, hsfo: 0 }, { id: port.id }), e => e.code === "23503" && e.message === "PORT_REQUIRED_NAME")
      assert.deepEqual(await fullState(f), before)
    }
    assert.equal((await f.read("taiwan")).status, 200)
    assert.equal((await f.read("hongkong")).status, 200)
  } finally { await f.db.close() }
})

test("guard catches name/type changes introduced by another BEFORE trigger on a price-only update", async () => {
  const f = await setupReportPublicationApp()
  try {
    await f.db.exec(`reset role;
      create function public.synthetic_before_price() returns trigger language plpgsql as $$begin if old.name='Taichung' then new.name='Missing basis';end if;return new;end$$;
      create trigger synthetic_before_price before update of hsfo on ports for each row execute function public.synthetic_before_price();set role service_role`)
    const before = await fullState(f)
    await assert.rejects(f.db.query("update ports set hsfo=0 where id=$1", [f.chained]), e => e.code === "23503" && e.message === "PORT_REQUIRED_NAME")
    assert.deepEqual(await fullState(f), before)
    assert.equal((await f.read("taiwan")).status, 200)
  } finally { await f.db.close() }
})

test("trigger has no browser/service RPC execution grant and needs no definer privileges", async () => {
  const f = await setup()
  try {
    const meta = (await f.db.query("select prosecdef,proconfig from pg_proc where proname='protect_required_report_port_identity'")).rows[0]
    assert.equal(meta.prosecdef, false); assert.deepEqual(meta.proconfig, ['search_path=""'])
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal((await f.db.query("select has_function_privilege($1,'public.protect_required_report_port_identity()','execute') as allowed", [role])).rows[0].allowed, false)
    }
  } finally { await f.db.close() }
})

test("actual audited save API rejects the rename in plain language and still permits prices/replay and healthy report publication", async () => {
  const f = await setupReportPublicationApp()
  async function request(changes) {
    const row = await f.row(f.chained)
    return f.priceRoute.POST(new Request("http://localhost/api/admin/prices", { method: "POST", headers: { "content-type": "application/json", referer: "https://evil.invalid/admin/users" },
      body: JSON.stringify({ portId: row.id, expected: priceSetterSnapshot(row), changes: buildPriceSetterChanges({ ...row, ...changes }) }) }))
  }
  try {
    const before = await fullState(f)
    const response = await request({ name: "Renamed Taichung", hsfo: 0 }), body = await response.json()
    assert.equal(response.status, 409); assert.equal(body.code, "PORT_REQUIRED")
    assert.match(body.message, /Keep its existing name/); assert.match(body.message, /draft is still here/)
    assert.doesNotMatch(JSON.stringify(body), /23503|PORT_REQUIRED_NAME|trigger|SQL/)
    assert.deepEqual(await fullState(f), before)
    assert.equal((await f.read("taiwan")).status, 200)
    assert.equal((await request({ name: " TAICHUNG ", hsfo: 0 })).status, 200)
    assert.equal((await f.row(f.chained)).hsfo, 0)
    assert.equal((await f.read("taiwan")).status, 200)
    assert.equal((await f.publish(await f.input("taiwan"))).status, 200)
    for (const header of f.auditHeaders.filter(h => h["x-bunker-admin-page-id"] === "pricesetter")) assert.equal(header["x-bunker-admin-user"], "SERVER-EDITOR")
    f.control.access = "view"; const calls = f.calls.length
    assert.equal((await request({ name: "Bad rename" })).status, 403); assert.equal(f.calls.length, calls)
  } finally { await f.db.close() }
})
