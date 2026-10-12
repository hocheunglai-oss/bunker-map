import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { setupReportPublicationApp } from "./fixtures/report-publication-app.mjs"
import { confirmPriceSetterCreation } from "../lib/priceSetterMutation.ts"

const otherActor="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const req=(method,body)=>new Request("http://localhost/api/admin/prices/creation",{method,headers:{"content-type":"application/json",referer:"https://evil.invalid/admin/users"},...(method!=="GET"?{body:JSON.stringify(body)}:{})})
const read=f=>f.creationRoute.GET(req("GET"))
const ack=(f,requestId,actorId=f.control.actorId)=>f.creationRoute.POST(req("POST",{actorId,requestId}))
const create=(f,input)=>f.priceRoute.PUT(req("PUT",input))
const input=(f,version="0",requestId=randomUUID())=>({operation:"create",kind:"port",actorId:f.control.actorId,expectedVersion:version,requestId})
const fence=async f=>(await f.db.query("select public.get_bunker_map_backup_export_fence() as result")).rows[0].result

test("actual authenticated recovery API/audit/SQL returns only the server actor's pending request and revision, without writes",async()=>{
  const f=await setupReportPublicationApp()
  try{
    const before=await f.state(), marker=await fence(f), r=await read(f)
    assert.equal(r.status,200);assert.match(r.headers.get("Cache-Control"),/private, no-store/)
    assert.deepEqual(await r.json(),{actorId:f.control.actorId,version:"0",pending:null})
    assert.deepEqual(await f.state(),before);assert.deepEqual(await fence(f),marker)
    assert.equal(f.auditHeaders.at(-1)["x-bunker-admin-user"],"SERVER-EDITOR")
    assert.equal(f.auditHeaders.at(-1)["x-bunker-admin-page-id"],"pricesetter")
    const original=input(f), response=await create(f,original), added=await response.json()
    assert.equal(response.status,200);confirmPriceSetterCreation(added,original)
    const stored=await f.state(), committed=await fence(f)
    assert.deepEqual(await (await read(f)).json(),{actorId:original.actorId,version:"1",pending:{requestId:original.requestId,kind:"port"}})
    f.control.actorId=otherActor
    assert.deepEqual(await (await read(f)).json(),{actorId:otherActor,version:"0",pending:null})
    assert.deepEqual(await f.state(),stored);assert.deepEqual(await fence(f),committed);assert.deepEqual(await f.publications(),[])
  }finally{await f.db.close()}
})

test("View, anonymous, forbidden and missing real identity fail before privileged recovery work; body identity grants no authority",async()=>{
  const f=await setupReportPublicationApp()
  try{
    for(const [auth,access,actorId,status] of [[null,"view",otherActor,403],["Unauthorized","edit",otherActor,401],["Forbidden","edit",otherActor,403],[null,"edit",null,401],[null,"edit","cached-user",401]]){
      Object.assign(f.control,{auth,access,actorId});const calls=f.calls.length, headers=f.auditHeaders.length
      for(const handler of [()=>read(f),()=>ack(f,randomUUID()),()=>create(f,input(f))]){
        const r=await handler();assert.equal(r.status,status);assert.equal(f.calls.length,calls);assert.equal(f.auditHeaders.length,headers)
      }
    }
    Object.assign(f.control,{auth:null,access:"edit",actorId:otherActor})
    const calls=f.calls.length, headers=f.auditHeaders.length
    const r=await create(f,{...input(f),actorId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"})
    assert.equal(r.status,409);assert.equal((await r.json()).code,"CREATION_ACCOUNT_CHANGED")
    assert.equal((await ack(f,randomUUID(),"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).status,409)
    assert.equal(f.calls.length,calls);assert.equal(f.auditHeaders.length,headers)
  }finally{await f.db.close()}
})

test("actual owned PUT rejects old/forged bodies and stale revisions; fenced legacy RPC cannot allocate via service role",async()=>{
  const f=await setupReportPublicationApp()
  try{
    const body=input(f), calls=f.calls.length, before=await f.state(), marker=await fence(f)
    for(const bad of [{operation:"create",requestId:body.requestId,kind:"port"},{...body,expectedVersion:0},{...body,expectedVersion:"00"},{...body,expectedVersion:"9223372036854775808"},{...body,portId:randomUUID()}]){
      assert.equal((await create(f,bad)).status,400);assert.equal(f.calls.length,calls)
    }
    await assert.rejects(f.db.query("select public.create_price_setter_port($1::uuid,'port')",[body.requestId]),e=>e.code==="42501")
    assert.deepEqual(await f.state(),before);assert.deepEqual(await fence(f),marker)
    assert.equal((await create(f,body)).status,200)
    const pending=await f.state(), pendingFence=await fence(f)
    const competing=await create(f,input(f))
    assert.equal(competing.status,409);assert.equal((await competing.json()).code,"CREATION_PENDING")
    assert.deepEqual(await f.state(),pending);assert.deepEqual(await fence(f),pendingFence)
    assert.equal((await ack(f,body.requestId)).status,200)
    const acknowledged=await f.state(), acknowledgedFence=await fence(f)
    const stale=await create(f,input(f))
    assert.equal(stale.status,409);assert.equal((await stale.json()).code,"CREATION_VERSION_CHANGED")
    assert.deepEqual(await f.state(),acknowledged);assert.deepEqual(await fence(f),acknowledgedFence)
    assert.equal((await create(f,input(f,"1"))).status,200)
  }finally{await f.db.close()}
})

test("malformed success and acknowledgement replies remain uncertain; exact retry is read-only and cannot settle another request",async()=>{
  const f=await setupReportPublicationApp()
  try{
    const body=input(f);f.control.badWrite=true
    assert.equal((await create(f,body)).status,503)
    const committed=await f.state(), marker=await fence(f)
    f.control.badWrite=false
    assert.equal((await create(f,body)).status,200);assert.deepEqual(await f.state(),committed);assert.deepEqual(await fence(f),marker)
    f.control.badWrite=true
    const uncertainAck=await ack(f,body.requestId)
    assert.equal(uncertainAck.status,503)
    const uncertainMessage=(await uncertainAck.json()).message
    assert.match(uncertainMessage,/Could not confirm the earlier addition/)
    assert.doesNotMatch(uncertainMessage,/Nothing new was added/)
    const acknowledged=await fence(f)
    f.control.badWrite=false
    assert.equal((await ack(f,body.requestId)).status,200);assert.deepEqual(await fence(f),acknowledged)
    assert.deepEqual(await (await read(f)).json(),{actorId:body.actorId,version:"1",pending:null})
    const next=input(f,"1");assert.equal((await create(f,next)).status,200)
    const pending=await fence(f)
    assert.equal((await ack(f,body.requestId)).status,200);assert.deepEqual(await fence(f),pending)
    assert.equal((await (await read(f)).json()).pending.requestId,next.requestId)
    f.control.actorId=otherActor
    assert.equal((await ack(f,next.requestId)).status,409);assert.deepEqual(await fence(f),pending)
    assert.deepEqual(await f.publications(),[])
  }finally{await f.db.close()}
})

test("failed or damaged recovery reads never become revision zero, expose private errors or allocate rows",async()=>{
  const f=await setupReportPublicationApp()
  try{
    const before=await f.state(), marker=await fence(f)
    for(const mode of ["readFailure","badRead"]){
      f.control[mode]=true;const r=await read(f);assert.equal(r.status,503)
      assert.doesNotMatch(JSON.stringify(await r.json()),/PRIVATE|credentials|revision|version/)
      f.control[mode]=false;assert.deepEqual(await f.state(),before);assert.deepEqual(await fence(f),marker)
    }
    const calls=f.calls.length
    for(const body of [null,{},[],{actorId:f.control.actorId,requestId:randomUUID(),operation:"delete"},{actorId:f.control.actorId,requestId:"bad"}]){
      assert.equal((await f.creationRoute.POST(req("POST",body))).status,400);assert.equal(f.calls.length,calls)
    }
  }finally{await f.db.close()}
})
