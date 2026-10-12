import assert from "node:assert/strict"
import test from "node:test"
import { createClient } from "@supabase/supabase-js"
import { setup } from "./fixtures/price-setter-sql.mjs"
import { setupReportPublicationApp } from "./fixtures/report-publication-app.mjs"
import { confirmPriceSetterInventory } from "../lib/priceSetterInventory.ts"

test("actual SDK table-cap reproduction and scalar SQL inventory retain all rows, exact values and deterministic order", async()=>{
  const f=await setup()
  try {
    await f.db.exec(`insert into ports(id,name,display_order,hsfo) select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Port '||n,case when n%3=0 then null else n%7 end,0 from generate_series(1,1205) n`)
    const raw=(await f.db.query("select read_price_setter_inventory() as value")).rows[0].value
    const complete=confirmPriceSetterInventory(raw)
    assert.equal(complete.count,1209);assert.equal(complete.ports.filter(p=>p.hsfo===0).length,1205)
    let requests=[]
    const client=createClient("https://isolated.invalid","synthetic-only",{global:{fetch:async(url)=>{
      requests.push(String(url));assert.match(String(url),/^https:\/\/isolated\.invalid\/rest\/v1\//)
      const isRpc=String(url).includes("/rpc/read_price_setter_inventory")
      return new Response(JSON.stringify(isRpc?raw:raw.ports.slice(0,1000)),{status:200,headers:{"Content-Type":"application/json","Content-Range":isRpc?"0-0/*":"0-999/*"}})
    }}})
    const old=await client.from("ports").select("id,name,type,lat,lng,hsfo,vlsfo,mgo,hsfo_formula,vlsfo_formula,mgo_formula,updated_at,display_order").order("display_order",{ascending:true,nullsFirst:false}).order("id",{ascending:true})
    assert.equal(old.error,null);assert.equal(old.data.length,1000)
    assert.ok(old.data.every(p=>p&&typeof p.id==="string"&&typeof p.name==="string"),"old initial-load shape check silently accepts the truncated list")
    const response=await client.rpc("read_price_setter_inventory",{})
    assert.equal(response.error,null);assert.deepEqual(confirmPriceSetterInventory(response.data),complete)
    assert.equal(requests.length,2)
    assert.deepEqual((await f.db.query("select id from ports order by display_order asc nulls last,id")).rows.map(r=>r.id),complete.ports.map(p=>p.id))
    await f.db.exec("delete from ports")
    assert.deepEqual((await f.db.query("select read_price_setter_inventory() as value")).rows[0].value,{version:1,count:0,ports:[]})
  } finally {await f.db.close()}
})
test("inventory is read-only invoker SQL, service-only execution, exact projection, and does not advance the backup epoch", async()=>{
  const f=await setup()
  try {
    await f.db.query("select create_price_setter_port($1::uuid,'port')",["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"])
    await f.db.exec("alter table ports add column private_test_secret text default 'PRIVATE'; alter table ports enable row level security")
    const before=await f.state(),epoch=(await f.db.query("select to_jsonb(t) as value from private.bunker_map_backup_mutations t")).rows
    assert.equal(epoch.length,1,"exercise a real nonempty backup mutation marker")
    const catalog=(await f.db.query("select prosecdef,provolatile,proretset,proconfig from pg_proc where oid='public.read_price_setter_inventory()'::regprocedure")).rows[0]
    assert.equal(catalog.prosecdef,false);assert.equal(catalog.provolatile,"s");assert.equal(catalog.proretset,false);assert.ok(catalog.proconfig.includes('search_path=""'))
    for(const role of ["anon","authenticated"]){
      await f.db.exec(`set role ${role}`)
      await assert.rejects(f.db.query("select read_price_setter_inventory()"),/permission denied/)
      await f.db.exec("reset role")
    }
    await f.db.exec("set role service_role")
    const result=confirmPriceSetterInventory((await f.db.query("select read_price_setter_inventory() as value")).rows[0].value)
    assert.equal(result.count,5);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|private_test_secret/)
    assert.deepEqual(await f.state(),before)
    await f.db.exec("reset role")
    assert.deepEqual((await f.db.query("select to_jsonb(t) as value from private.bunker_map_backup_mutations t")).rows,epoch)
  } finally {await f.db.close()}
})
test("actual View-authorized inventory API reads complete SQL once, denies unauthorized callers and safely rejects broken reads",async()=>{
  const app=await setupReportPublicationApp()
  try {
    app.control.access="view"
    await app.db.exec(`insert into ports(name,display_order) select 'Extra port '||n,n from generate_series(1,1205) n`)
    const req=()=>new Request("http://localhost/api/admin/prices",{headers:{Referer:"https://evil.invalid/admin/users"}})
    const before=await app.state(),publications=await app.publications(),response=await app.priceRoute.GET(req())
    assert.equal(response.status,200);assert.equal(confirmPriceSetterInventory(await response.json()).count,1212)
    assert.deepEqual(app.permissions,[{page:"pricesetter",access:"view"}]);assert.deepEqual(app.calls,[{name:"read_price_setter_inventory",args:{}}])
    assert.match(response.headers.get("Cache-Control"),/private, no-store/)
    assert.equal(app.auditHeaders[0]["x-bunker-admin-page-id"],"pricesetter")
    assert.deepEqual(await app.state(),before);assert.deepEqual(await app.publications(),publications)
    const ports=confirmPriceSetterInventory(await (await app.priceRoute.GET(req())).json()).ports
    const input={operation:"reorder",expected:ports.map(p=>[p.id,p.display_order]),order:ports.map(p=>p.id).reverse()}
    const reorder=()=>app.priceRoute.PATCH(new Request("http://localhost/api/admin/prices",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)}))
    const deniedCalls=app.calls.length;assert.equal((await reorder()).status,403);assert.equal(app.calls.length,deniedCalls)
    app.control.access="edit"
    const changed=await reorder();assert.equal(changed.status,200)
    assert.deepEqual((await changed.json()).order,input.order.map((id,i)=>[id,i+1]))
    const reordered=await app.state();assert.equal((await (await reorder()).json()).replayed,true);assert.deepEqual(await app.state(),reordered)
    assert.deepEqual(reordered.ports.map(({display_order,...p})=>p),before.ports.map(({display_order,...p})=>p))
    assert.deepEqual(await app.publications(),publications)
    for(const option of ["readFailure","badRead"]){app.control[option]=true;assert.equal((await app.priceRoute.GET(req())).status,503);app.control[option]=false}
    for(const [auth,status] of [["Unauthorized",401],["Forbidden",403]]){app.control.auth=auth;const calls=app.calls.length;assert.equal((await app.priceRoute.GET(req())).status,status);assert.equal(app.calls.length,calls)}
  } finally {await app.db.close()}
})

test("large complete reorder rolls back suppressed or altered trigger writes instead of returning a false success",async()=>{
  const f=await setup()
  try {
    await f.db.exec("insert into ports(name,display_order) select 'Extra '||n,n from generate_series(1,2501) n; set role service_role")
    const ports=confirmPriceSetterInventory((await f.db.query("select read_price_setter_inventory() as value")).rows[0].value).ports
    const expected=ports.map(p=>[p.id,p.display_order]),order=ports.map(p=>p.id).reverse(),before=await f.state()
    const run=()=>f.db.query("select reorder_price_setter_ports($1::jsonb,$2::uuid[]) as value",[JSON.stringify(expected),order])
    for(const body of ["return null;","new.hsfo=123; return new;","new.display_order=2147483647; return new;"]){
      await f.db.exec(`reset role;create function synthetic_inventory_order() returns trigger language plpgsql as $$ begin ${body} end $$;create trigger synthetic_inventory_order before update on ports for each row execute function synthetic_inventory_order();set role service_role`)
      await assert.rejects(run(),/Port order was not persisted exactly/);assert.deepEqual(await f.state(),before)
      await f.db.exec("reset role;drop trigger synthetic_inventory_order on ports;drop function synthetic_inventory_order();set role service_role")
    }
    assert.deepEqual((await run()).rows[0].value.order,order.map((id,i)=>[id,i+1]))
    const saved=await f.state();assert.equal((await run()).rows[0].value.replayed,true);assert.deepEqual(await f.state(),saved)
  } finally {await f.db.close()}
})
