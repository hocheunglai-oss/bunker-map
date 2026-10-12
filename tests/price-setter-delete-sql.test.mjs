import assert from "node:assert/strict"
import test from "node:test"
import { priceSetterDeletionSnapshot } from "../lib/priceSetterMutation.ts"
import { REPORT_PUBLICATIONS } from "../lib/reportPublication.ts"
import { setup, basis, linked, other } from "./fixtures/price-setter-sql.mjs"
import { setupReportPublicationApp } from "./fixtures/report-publication-app.mjs"

async function input(f, id=other) { return { portId:id, expected:priceSetterDeletionSnapshot(await f.row(id)), expectedFallbacks:{} } }
async function remove(f, request) {
  return (await f.db.query("select public.delete_price_setter_port($1::uuid,$2::jsonb,$3::jsonb) as result", [request.portId, JSON.stringify(request.expected), JSON.stringify(request.expectedFallbacks)])).rows[0].result
}
async function fullState(f) { return { ...await f.state(), remarks:(await f.db.query("select * from remarks order by id")).rows } }

test("deletion removes only an unused reviewed row and its reviewed overrides; retry is read-only", async () => {
  const f=await setup()
  try {
    await f.db.exec(`insert into remarks(id,content) values(105,'{"other::hsfo":"NA","basis::mgo":"SE"}'); set role service_role`)
    const request=await input(f), original=await fullState(f)
    request.expectedFallbacks={"other::hsfo":"NA"}
    assert.deepEqual(await remove(f,request),{deletedId:other,replayed:false})
    const after=await fullState(f)
    assert.deepEqual(after.ports,original.ports.filter(p=>p.id!==other)); assert.deepEqual(after.history,original.history)
    assert.deepEqual(JSON.parse(after.remarks[0].content),{"basis::mgo":"SE"})
    assert.deepEqual(await remove(f,request),{deletedId:other,replayed:true}); assert.deepEqual(await fullState(f),after)
    await f.db.exec("update remarks set content='{\"other::hsfo\":\"SE\"}' where id=105")
    await remove(f,request)
    assert.equal((await fullState(f)).remarks[0].content,'{"other::hsfo":"SE"}',"absent-ID retry must not delete reused-name settings")
  } finally { await f.db.close() }
})

test("all mandatory report roots are protected even without explicit formulas/history", async () => {
  const f=await setup()
  try {
    await f.db.exec("update ports set hsfo_formula=null,vlsfo_formula=null,mgo_formula=null; set role service_role")
    for(const name of new Set([...REPORT_PUBLICATIONS.hongkong.names,...REPORT_PUBLICATIONS.taiwan.names])) {
      await f.db.exec("begin")
      await f.db.query("update ports set name=$1 where id=$2",[` ${name.toUpperCase()} `,other])
      const before=await fullState(f)
      await f.db.exec("savepoint deletion")
      await assert.rejects(remove(f,await input(f)),e=>e.code==="23503"&&e.message==="PORT_REQUIRED")
      await f.db.exec("rollback to savepoint deletion")
      assert.deepEqual(await fullState(f),before)
      await f.db.exec("rollback")
    }
  } finally { await f.db.close() }
})

test("basis, malformed formula, duplicate name and history checks prevent dangling references or cascade loss", async () => {
  const f=await setup()
  try {
    const before=await fullState(f)
    await assert.rejects(remove(f,await input(f,basis)),e=>e.code==="23503"&&e.message==="PORT_FORMULA")
    assert.deepEqual(await fullState(f),before)
    await f.db.exec("update ports set hsfo_formula=null,vlsfo_formula=null,mgo_formula=null")
    await f.db.query("update ports set hsfo_formula='bad legacy formula' where id=$1",[linked])
    await assert.rejects(remove(f,await input(f)),e=>e.code==="23503"&&e.message==="PORT_FORMULA_INVALID")
    await f.db.query("update ports set hsfo_formula=null,name=' OTHER ' where id=$1",[linked])
    await assert.rejects(remove(f,await input(f)),e=>e.code==="23503"&&e.message==="PORT_NAME")
    await f.db.query("update ports set name='Linked' where id=$1",[linked])
    await f.db.query("insert into price_history(port_id,hsfo) values($1,0)",[other])
    const withHistory=await fullState(f)
    await assert.rejects(remove(f,await input(f)),e=>e.code==="23503"&&e.message==="PORT_HISTORY")
    assert.deepEqual(await fullState(f),withHistory)
  } finally { await f.db.close() }
})

test("every saved field/order/kind and target override conflicts; unrelated overrides merge", async () => {
  const f=await setup()
  try {
    const request=await input(f)
    for(const [key,value] of Object.entries({name:"Changed",lat:0,lng:0,hsfo:0,vlsfo:0,mgo:0,hsfo_formula:"Basis + 0",vlsfo_formula:"Basis + 0",mgo_formula:"Basis + 0",updated_at:"2026-10-09",type:"divider",display_order:99})) {
      await f.db.query(`update ports set ${key}=$1 where id=$2`,[value,other])
      const before=await fullState(f)
      await assert.rejects(remove(f,request),e=>e.code==="P0002"); assert.deepEqual(await fullState(f),before)
      await f.db.query(`update ports set ${key}=$1 where id=$2`,[request.expected[key],other])
    }
    await f.db.exec(`insert into remarks(id,content) values(105,'{"other::mgo":"SE"}')`)
    const before=await fullState(f)
    await assert.rejects(remove(f,request),e=>e.code==="P0002"); assert.deepEqual(await fullState(f),before)
    await f.db.exec(`update remarks set content='{"basis::hsfo":"NA"}' where id=105`)
    await remove(f,request)
    assert.equal((await fullState(f)).remarks[0].content,'{"basis::hsfo":"NA"}')
  } finally { await f.db.close() }
})

test("corrupt settings and failing/suppressed delete triggers roll back override cleanup and deletion", async () => {
  const f=await setup()
  try {
    const request=await input(f)
    await f.db.exec("insert into remarks(id,content) values(105,'{broken')")
    for(const content of ['{broken','[]','{"other::mgo":false}']) {
      await f.db.query("update remarks set content=$1 where id=105",[content])
      const before=await fullState(f)
      await assert.rejects(remove(f,request),e=>e.code==="P0001"); assert.deepEqual(await fullState(f),before)
    }
    await f.db.exec(`update remarks set content='{"other::mgo":"NA"}' where id=105;
      create function synthetic_delete_fail() returns trigger language plpgsql as $$ begin raise exception 'PRIVATE DELETE FAIL'; end $$;
      create trigger synthetic_failure before delete on ports for each row execute function synthetic_delete_fail()`)
    request.expectedFallbacks={"other::mgo":"NA"}
    let before=await fullState(f)
    await assert.rejects(remove(f,request),/PRIVATE DELETE FAIL/); assert.deepEqual(await fullState(f),before)
    await f.db.exec(`drop trigger synthetic_failure on ports; create function synthetic_delete_skip() returns trigger language plpgsql as $$ begin return null; end $$;
      create trigger synthetic_skip before delete on ports for each row execute function synthetic_delete_skip()`)
    before=await fullState(f)
    await assert.rejects(remove(f,request),/Deletion unconfirmed/); assert.deepEqual(await fullState(f),before)
  } finally { await f.db.close() }
})

test("service-only invoker deletion rejects malformed direct SQL and safely removes a divider", async () => {
  const f=await setup()
  try {
    const request=await input(f)
    assert.equal((await f.db.query("select prosecdef from pg_proc where proname='delete_price_setter_port'")).rows[0].prosecdef,false)
    for(const role of ["anon","authenticated"]) {
      await f.db.exec(`set role ${role}`)
      await assert.rejects(remove(f,request),e=>e.code==="42501"); await f.db.exec("reset role")
    }
    for(const bad of [{...request,expected:null},{...request,expected:{}},{...request,expected:{...request.expected,extra:1}},{...request,expectedFallbacks:null},{...request,expectedFallbacks:{"basis::mgo":"SE"}},{...request,expectedFallbacks:{"other::mgo":true}}]) {
      const before=await fullState(f);await assert.rejects(remove(f,bad),e=>e.code==="22023");assert.deepEqual(await fullState(f),before)
    }
    await f.db.query("update ports set type='divider',name='Section' where id=$1",[other])
    await f.db.exec("set role service_role");await remove(f,await input(f))
    assert.equal((await fullState(f)).ports.some(p=>p.id===other),false)
  } finally { await f.db.close() }
})

test("actual authenticated/audited deletion API protects Taiwan, preserves errors and confirms safe retry", async () => {
  const f=await setupReportPublicationApp()
  const request=async body=>{const response=await f.priceRoute.DELETE(new Request("http://localhost/api/admin/prices",{method:"DELETE",headers:{"content-type":"application/json",referer:"https://evil.invalid/admin/users"},body:JSON.stringify(body)}));return {status:response.status,body:await response.json()}}
  try {
    const target=await input(f,f.chained),before=await fullState(f)
    assert.equal((await f.read("taiwan")).status,200)
    const rejected=await request(target)
    assert.equal(rejected.status,409);assert.equal(rejected.body.code,"PORT_IN_USE");assert.match(rejected.body.message,/required by a market report/)
    assert.deepEqual(await fullState(f),before);assert.equal((await f.read("taiwan")).status,200)
    const safe=await input(f,f.other)
    f.control.beforeWrite=()=>f.db.query("update ports set hsfo=999 where id=$1",[f.other])
    assert.equal((await request(safe)).status,409)
    const fresh=await input(f,f.other)
    f.control.badWrite=true
    assert.equal((await request(fresh)).status,503,"committed malformed reply remains uncertain")
    f.control.badWrite=false
    const retry=await request(fresh)
    assert.equal(retry.status,200);assert.equal(retry.body.replayed,true)
    const deletionHeaders=f.auditHeaders.filter(h=>h['x-bunker-admin-page-id']==='pricesetter')
    assert.ok(deletionHeaders.length>=4);for(const h of deletionHeaders)assert.equal(h['x-bunker-admin-user'],'SERVER-EDITOR')
    f.control.access='view';const count=f.calls.length
    assert.equal((await request(target)).status,403);assert.equal(f.calls.length,count)
  } finally { await f.db.close() }
})
