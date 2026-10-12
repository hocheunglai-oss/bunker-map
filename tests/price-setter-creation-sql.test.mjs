import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { setup } from "./fixtures/price-setter-sql.mjs"
import { setupReportPublicationApp } from "./fixtures/report-publication-app.mjs"
import { confirmPriceSetterCreation, priceSetterDeletionSnapshot } from "../lib/priceSetterMutation.ts"

async function create(f, requestId=randomUUID(), kind="port") {
  return (await f.db.query("select public.create_price_setter_port($1::uuid,$2::text) as result",[requestId,kind])).rows[0].result
}
async function all(f) {
  return { ...await f.state(), receipts:(await f.db.query("select * from public.price_setter_creation_receipts order by request_id")).rows,
    fence:(await f.db.query("select public.get_bunker_map_backup_export_fence() as result")).rows[0].result }
}

test("creation allocates unique normalized default names and server order; exact retry is read-only even after editing",async()=>{
  const f=await setup()
  try {
    await f.db.exec("update ports set display_order=10; insert into ports(name,type,display_order) values(' NEW PORT ',null,40),('new port 2','port',20),('New Port 3','divider',null); set role service_role")
    const requestId=randomUUID(), result=await create(f,requestId)
    assert.equal(result.port.name,"New Port 3");assert.equal(result.port.display_order,41);assert.equal(result.replayed,false)
    confirmPriceSetterCreation(result,{operation:"create",requestId,kind:"port"})
    const first=await all(f)
    assert.deepEqual(await create(f,requestId),{...result,replayed:true});assert.deepEqual(await all(f),first)
    await f.db.query("update ports set name='Edited port',hsfo=0,display_order=-5 where id=$1",[result.portId])
    const edited=await all(f), replay=await create(f,requestId)
    assert.equal(replay.port.name,"Edited port");assert.equal(replay.port.hsfo,0);assert.equal(replay.port.display_order,-5)
    confirmPriceSetterCreation(replay,{operation:"create",requestId,kind:"port"});assert.deepEqual(await all(f),edited)
    const next=await create(f), divider=await create(f,randomUUID(),"divider")
    assert.equal(next.port.name,"New Port 3");assert.equal(next.port.display_order,41)
    assert.equal(divider.port.name,"Section");assert.equal(divider.port.type,"divider");assert.equal(divider.port.display_order,42)
    assert.equal((await all(f)).receipts.length,3);assert.equal((await all(f)).history,null)
  }finally{await f.db.close()}
})

test("receipt survives actual guarded deletion; delayed retry cannot resurrect the port or mutate another row",async()=>{
  const f=await setup()
  try {
    await f.db.exec("set role service_role")
    const requestId=randomUUID(), result=await create(f,requestId)
    await f.db.query("select public.delete_price_setter_port($1,$2::jsonb,'{}'::jsonb)",[result.portId,JSON.stringify(priceSetterDeletionSnapshot(result.port))])
    const before=await all(f), retry=await create(f,requestId)
    assert.deepEqual(retry,{requestId,portId:result.portId,kind:"port",replayed:true,port:null})
    assert.equal(confirmPriceSetterCreation(retry,{operation:"create",requestId,kind:"port"}).port,null)
    assert.deepEqual(await all(f),before);assert.equal(before.receipts.length,1)
    await assert.rejects(create(f,requestId,"divider"),error=>error.code==="P0002"&&error.message==="CREATION_KIND_CHANGED")
    assert.deepEqual(await all(f),before)
    const next=await create(f)
    assert.notEqual(next.portId,result.portId);assert.equal(next.port.name,"New Port")
  }finally{await f.db.close()}
})

test("invalid input and integer order overflow fail without receipts, ports, history or backup mutations",async()=>{
  const f=await setup()
  try {
    const before=await all(f)
    for(const [id,kind] of [[null,"port"],[randomUUID(),null],[randomUUID(),"PORT"],[randomUUID(),"bad"]]) {
      await assert.rejects(create(f,id,kind),error=>error.code==="22023");assert.deepEqual(await all(f),before)
    }
    await f.db.exec("update ports set display_order=2147483647")
    const overflow=await all(f)
    await assert.rejects(create(f),error=>error.code==="P0002"&&error.message==="CREATION_ORDER_FULL")
    assert.deepEqual(await all(f),overflow)
    await f.db.exec("update ports set display_order=-2147483648")
    assert.equal((await create(f)).port.display_order,1)
  }finally{await f.db.close()}
})

test("suppressed, altered or failed port/receipt triggers roll back the entire transaction and permit the same request retry",async()=>{
  const f=await setup()
  try {
    for(const [table,timing,body] of [
      ["ports","before","return null;"],
      ["ports","before","new.hsfo:=99; return new;"],
      ["ports","before","raise exception 'synthetic failure';"],
      ["price_setter_creation_receipts","before","return null;"],
      ["price_setter_creation_receipts","before","new.kind:='divider'; return new;"],
      ["price_setter_creation_receipts","after","raise exception 'synthetic failure';"],
      ["price_setter_creation_receipts","after","delete from public.ports where id=new.port_id; return new;"],
    ]) {
      await f.db.exec(`create function public.fail_creation_fixture() returns trigger language plpgsql as $$begin ${body} end$$;
        create trigger fixture_failure ${timing} insert on public.${table} for each row execute function public.fail_creation_fixture();`)
      const before=await all(f), id=randomUUID()
      await assert.rejects(create(f,id));assert.deepEqual(await all(f),before)
      await f.db.exec(`drop trigger fixture_failure on public.${table}; drop function public.fail_creation_fixture();`)
      assert.equal((await create(f,id)).replayed,false)
    }
  }finally{await f.db.close()}
})

test("server-only invoker RPC and minimal receipt grants; actual backup epoch tracks commits, not replays or rollbacks",async()=>{
  const f=await setup()
  try {
    const meta=(await f.db.query("select prosecdef,proconfig from pg_proc where oid='public.create_price_setter_port(uuid,text)'::regprocedure")).rows[0]
    assert.equal(meta.prosecdef,false);assert.ok(meta.proconfig.includes('search_path=""'))
    assert.equal((await f.db.query("select relrowsecurity from pg_class where oid='public.price_setter_creation_receipts'::regclass")).rows[0].relrowsecurity,true)
    assert.equal((await f.db.query("select count(*)::int as n from pg_constraint where conrelid='public.price_setter_creation_receipts'::regclass and contype='f'")).rows[0].n,0)
    for(const role of ["anon","authenticated"]) {
      for(const privilege of ["select","insert","update","delete","truncate"]) assert.equal((await f.db.query("select has_table_privilege($1,'public.price_setter_creation_receipts',$2) as ok",[role,privilege])).rows[0].ok,false)
      await f.db.exec(`set role ${role}`);await assert.rejects(create(f),error=>error.code==="42501");await f.db.exec("reset role")
    }
    for(const privilege of ["select","insert","update","delete","truncate"]) assert.equal((await f.db.query("select has_table_privilege('service_role','public.price_setter_creation_receipts',$1) as ok",[privilege])).rows[0].ok,["select","insert"].includes(privilege))
    const trigger=(await f.db.query("select tgtype::int as type,tgfoid::regprocedure::text as fn,tgenabled from pg_trigger where tgrelid='public.price_setter_creation_receipts'::regclass and tgname='bunker_map_backup_epoch_fence'")).rows[0]
    assert.equal(trigger.type,60);assert.equal(trigger.fn,"private.record_bunker_map_backup_mutation()");assert.equal(trigger.tgenabled,"O")
    await f.db.exec("set role service_role")
    const before=await all(f), id=randomUUID()
    await create(f,id);const committed=await all(f)
    assert.ok(committed.fence.epoch>before.fence.epoch)
    await create(f,id);assert.deepEqual(await all(f),committed)
    await f.db.exec("begin");await create(f);await f.db.exec("rollback");assert.deepEqual(await all(f),committed)
    for(const sql of ["delete from public.price_setter_creation_receipts","update public.price_setter_creation_receipts set kind='divider'","truncate public.price_setter_creation_receipts"]) await assert.rejects(f.db.exec(sql),error=>error.code==="42501")
  }finally{await f.db.close()}
})

test("actual API/audit/SQL creation confirms requests, retries and retired receipts; View denial precedes all privileged work",async()=>{
  const f=await setupReportPublicationApp()
  const requestId=randomUUID(), input={operation:"create",requestId,kind:"port",actorId:f.control.actorId,expectedVersion:"0"}
  const request=()=>f.priceRoute.PUT(new Request("http://localhost/api/admin/prices",{method:"PUT",headers:{"content-type":"application/json",referer:"https://evil.invalid/admin/users"},body:JSON.stringify(input)}))
  try {
    const publications=await f.publications()
    const response=await request(), result=await response.json()
    assert.equal(response.status,200);confirmPriceSetterCreation(result,input)
    const state=await all(f)
    assert.equal((await request()).status,200);assert.deepEqual(await all(f),state)
    assert.deepEqual(await f.publications(),publications,"creation never publishes reports")
    assert.equal(f.auditHeaders.at(-1)["x-bunker-admin-page-id"],"pricesetter");assert.equal(f.auditHeaders.at(-1)["x-bunker-admin-user"],"SERVER-EDITOR")
    f.control.badWrite=true
    assert.equal((await request()).status,503);assert.deepEqual(await all(f),state)
    f.control.badWrite=false
    await f.db.query("select public.delete_price_setter_port($1,$2::jsonb,'{}'::jsonb)",[result.portId,JSON.stringify(priceSetterDeletionSnapshot(result.port))])
    assert.equal((await (await request()).json()).port,null)
    f.control.access="view";const calls=f.calls.length
    assert.equal((await request()).status,403);assert.equal(f.calls.length,calls)
  }finally{await f.db.close()}
})

test("all three backup consumers gate durable receipts by proven schema capability, never a later maximum migration; recovery forbids destructive REST reconstruction",()=>{
  for(const file of ["app/api/backups/bunker-map-drive/route.ts","lib/systemHealth.ts","scripts/validate-backup.mjs"]) {
    const text=readFileSync(new URL(`../${file}`,import.meta.url),"utf8")
    assert.doesNotMatch(text,/PRICE_SETTER_CREATION_MIGRATION_HEAD/)
    assert.match(text,/key: "priceSetterCreationReceipts", table: "price_setter_creation_receipts"/)
    assert.match(text,/\.table === "price_setter_creation_receipts" \? pricingSchemaVersion !== "none"/)
    assert.match(text,/pricingBackupSchemaFrom(?:Inventory|Artifact)/)
  }
  const recovery=readFileSync(new URL("../scripts/restore-backup-to-recovery.mjs",import.meta.url),"utf8")
  assert.match(recovery,/restore|Restore/);assert.match(recovery,/owner|Owner/)
})
