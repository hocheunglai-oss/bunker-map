import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { transformSync } from "esbuild"
import ts from "typescript"
import { createAdminAuditContext } from "../lib/adminAudit"
import * as deletion from "../lib/ccinfoDelete"
import { ccinfoLegacyContentWriteMessage } from "../lib/ccinfoSave"

const id="11111111-1111-4111-8111-111111111111",version="2099-10-12T00:00:00.123456Z"
const input:deletion.CcinfoDeleteRequest={kind:"company",id,expectedUpdatedAt:version,deletePorts:false}
const receipt:deletion.CcinfoDeleteReceipt={schema:"fcuno.ccinfo-delete/v1",kind:"company",id,deletedAt:"2026-10-16T07:30:00.123456Z",deletedCount:1,portsDeleted:0,portsDetached:0}

test("delete request/receipt validates exact captured identity/version and truthful wall-clock acknowledgement",()=>{
  assert.deepEqual(deletion.parseCcinfoDeleteRequest(input),input)
  assert.deepEqual(deletion.parseCcinfoDeleteReceipt(receipt,input),receipt,"future saved versions do not imply a future deletion time")
  for(const value of [null,[],{...input,kind:"other"},{...input,id:"bad"},{...input,actor:"SPOOFED"},{...input,deletePorts:true},{...input,expectedUpdatedAt:"2026-02-31T00:00:00Z"},{...input,expectedUpdatedAt:"2026-10-16T00:00:00.1234567Z"}]) assert.throws(()=>deletion.parseCcinfoDeleteRequest(value),error=>error instanceof deletion.CcinfoDeleteError&&error.status===400)
  for(const missing of [undefined,null,""]) assert.throws(()=>deletion.parseCcinfoDeleteRequest({...input,expectedUpdatedAt:missing}),error=>error instanceof deletion.CcinfoDeleteError&&error.status===409)
  for(const value of [null,{},[],{...receipt,id:"22222222-2222-4222-8222-222222222222"},{...receipt,kind:"country"},{...receipt,deletedCount:0},{...receipt,deletedCount:2},{...receipt,deletedAt:"2026-02-31T00:00:00Z"},{...receipt,portsDeleted:1},{...receipt,portsDetached:1},{...receipt,portsDeleted:-1},{...receipt,portsDeleted:1.5}]) assert.throws(()=>deletion.parseCcinfoDeleteReceipt(value,input))
  const country={...input,kind:"country" as const,deletePorts:true}
  assert.equal(deletion.parseCcinfoDeleteReceipt({...receipt,kind:"country",portsDeleted:10},country).portsDeleted,10)
  assert.throws(()=>deletion.parseCcinfoDeleteReceipt({...receipt,kind:"country",portsDetached:1},country))
})

test("browser deletion helper preserves raw version and typed401/403 evenHTML; transport and invalidACK never succeed",async()=>{
  const original=globalThis.fetch
  try {
    let submitted:deletion.CcinfoDeleteRequest|undefined
    globalThis.fetch=async(_url,init)=>{submitted=JSON.parse(String(init?.body)) as deletion.CcinfoDeleteRequest;return Response.json({deletion:receipt})}
    assert.equal((await deletion.deleteCcinfoRecord(input)).id,id);assert.deepEqual(submitted,input)
    for(const status of [401,403]) {
      globalThis.fetch=async()=>new Response("<html>Access expired</html>",{status})
      await assert.rejects(deletion.deleteCcinfoRecord(input),error=>error instanceof deletion.CcinfoDeleteError&&error.status===status)
    }
    for(const body of [{},{deletion:{...receipt,id:"WRONG"}},{deletion:{...receipt,deletedCount:0}}]) {
      globalThis.fetch=async()=>Response.json(body)
      await assert.rejects(deletion.deleteCcinfoRecord(input),error=>error instanceof deletion.CcinfoDeleteError&&error.status===502)
    }
    globalThis.fetch=async()=>{throw Error("Synthetic transport failure")}
    await assert.rejects(deletion.deleteCcinfoRecord(input),error=>error instanceof deletion.CcinfoDeleteError&&error.status===0)
  } finally {globalThis.fetch=original}
})

test("shared deletion deadline covers ignored fetch abort and deferred JSON bodies; lateACK cannot turn uncertainty into success",async()=>{
  const originalFetch=globalThis.fetch,originalTimer=globalThis.setTimeout
  try {
    globalThis.setTimeout=((callback:TimerHandler,delay?:number,...args:unknown[])=>originalTimer(callback,delay===deletion.CCINFO_DELETE_TIMEOUT_MS?1:delay,...args)) as typeof setTimeout
    for(const phase of ["fetch","body"] as const) {
      let release!:(value:unknown)=>void
      const held=new Promise(resolve=>{release=resolve})
      let signal:AbortSignal|undefined
      globalThis.fetch=async(_url,init)=>{
        signal=init?.signal||undefined
        if(phase==="fetch") {await held;return Response.json({deletion:receipt})}
        return {status:200,ok:true,json:()=>held} as Response
      }
      await assert.rejects(deletion.deleteCcinfoRecord(input),error=>error instanceof deletion.CcinfoDeleteError&&error.status===0)
      assert.equal(signal?.aborted,true)
      release({deletion:receipt});await new Promise(resolve=>originalTimer(resolve,0))
    }
    const already=new AbortController();already.abort()
    globalThis.fetch=async()=>{assert.fail("Already-aborted deletion must not be submitted")}
    await assert.rejects(deletion.deleteCcinfoRecord(input,{signal:already.signal}))
  } finally {globalThis.fetch=originalFetch;globalThis.setTimeout=originalTimer}
})

function api({permission="edit",data=receipt,error=null as {code:string}|null,service=true}={}) {
  const calls:{page:string;access:string}[]=[],rpc:{name:string;args:unknown}[]=[],contexts:unknown[]=[]
  const modules:Record<string,unknown>={
    "next/server":{NextResponse:{json:Response.json}},
    "@/lib/adminAuth":{requireAdminPagePermission:async(page:string,access:string)=>{calls.push({page,access});if(permission==="anonymous")throw Error("Unauthorized");if(permission!=="edit")throw Error("Forbidden");return {authenticated:true,resetRequired:false,username:"SYNTHETIC SERVER USER",displayName:"Synthetic Server User",role:"STAFF",permissions:{ccinfo:"edit"},pages:[]}}},
    "@/lib/adminAudit":{createAdminAuditContext,createAdminAuditedSupabaseClient:(context:unknown)=>{contexts.push(context);return {rpc:async(name:string,args:unknown)=>{rpc.push({name,args});return {data,error}}}}},
    "@/lib/ccinfoDelete":deletion,
  }
  const mod:{exports:{POST?:(request:Request)=>Promise<Response>}}={exports:{}}
  const code=transformSync(readFileSync(new URL("../app/api/ccinfo/delete-record/route.ts",import.meta.url),"utf8"),{loader:"ts",format:"cjs",target:"node24"}).code
  new Function("require","module","exports","process",code)((name:string)=>{assert.ok(Object.hasOwn(modules,name),name);return modules[name]},mod,mod.exports,{env:{SUPABASE_SERVICE_ROLE_KEY:service?"synthetic-only-service-key":undefined}})
  return {calls,rpc,contexts,async request(body:unknown=input){return mod.exports.POST!(new Request("https://synthetic.invalid/api/ccinfo/delete-record",{method:"POST",headers:{"content-type":"application/json","referer":"https://synthetic.invalid/admin/phonebook","x-bunker-admin-user":"SPOOFED"},body:JSON.stringify(body)}))}}
}

test("actual deletion API authorizes exact CCINFO Edit first, pins trusted audit identity and exposes only verified receipt",async()=>{
  const f=api(),response=await f.request()
  assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"private, no-store")
  assert.deepEqual(await response.json(),{deletion:receipt})
  assert.deepEqual(f.calls,[{page:"ccinfo",access:"edit"}])
  assert.deepEqual(f.rpc,[{name:"delete_ccinfo_record",args:{p_kind:"company",p_id:id,p_expected_updated_at:version,p_delete_ports:false}}])
  assert.deepEqual(f.contexts,[{username:"SYNTHETIC SERVER USER",displayName:"Synthetic Server User",role:"STAFF",pageId:"ccinfo",pageLabel:"COUNTRY AND COMPANY INFO",pagePath:"/admin/ccinfo"}])
  for(const [permission,status] of [["view",403],["none",403],["anonymous",401]] as const) {
    const denied=api({permission}),response=await denied.request({invalid:true})
    assert.equal(response.status,status);assert.equal(denied.rpc.length,0);assert.equal(denied.contexts.length,0)
    assert.deepEqual(denied.calls,[{page:"ccinfo",access:"edit"}])
  }
})

test("actual API stale/ambiguous/missingbaseline/auditfail/unavailable/invalidACK responses stay private and cannot claim Deleted",async()=>{
  for(const [code,status] of [["40001",409],["23514",409],["55P03",409],["40P01",409],["22023",400],["P0001",503]] as const) {
    const response=await api({error:{code}}).request()
    assert.equal(response.status,status);assert.equal(response.headers.get("cache-control"),"private, no-store")
    assert.equal(Object.hasOwn(await response.json(),"deletion"),false)
  }
  const missing=api();assert.equal((await missing.request({...input,expectedUpdatedAt:undefined})).status,409);assert.equal(missing.rpc.length,0)
  const noService=api({service:false});assert.equal((await noService.request()).status,503);assert.equal(noService.rpc.length,0)
  assert.equal((await api({data:{...receipt,deletedCount:0} as unknown as deletion.CcinfoDeleteReceipt}).request()).status,502)
})

const pageSource=readFileSync(new URL("../app/admin/ccinfo/page.tsx",import.meta.url),"utf8")
const pageAst=ts.createSourceFile("page.tsx",pageSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
function coreDelete({kind="company" as "company"|"country"|"port",pending=false,confirmations=[true],write=async()=>receipt}={}) {
  let node:ts.FunctionDeclaration|undefined
  const visit=(value:ts.Node)=>{if(ts.isFunctionDeclaration(value)&&value.name?.text==="deleteRecord")node=value;ts.forEachChild(value,visit)};visit(pageAst);assert.ok(node)
  const owner={current:1},rename={current:false},deleting={current:false}
  const state={messages:[] as string[],errors:[] as string[],busy:false,modal:true,resets:0,requests:[] as deletion.CcinfoDeleteRequest[],confirmations:[] as string[]}
  const dependencies={readOnly:false,recordRenamePendingRef:rename,recordDeletePendingRef:deleting,selectedId:id,selectedKind:kind,recordLoading:false,currentRecord:{id,name:"SYNTHETIC",updated_at:version},recordOwnerRef:owner,renderOwner:1,
    saveQueueRef:{current:{pending:()=>pending}},fileMutationLocksRef:{current:new Set()},uploadingFile:false,
    setMessage:(value:string)=>state.messages.push(value),setRecordDeleting:(value:boolean)=>{state.busy=value},setRecordRenameError:(value:string)=>state.errors.push(value),
    confirm:(value:string)=>{state.confirmations.push(value);return confirmations.shift()??true},
    deleteCcinfoRecord:async(value:deletion.CcinfoDeleteRequest)=>{state.requests.push(value);return write()},
    setRecordModalOpen:(value:boolean)=>{state.modal=value},resetSelection:()=>{state.resets++;owner.current++},
  }
  const code=transformSync(node.getText(pageAst),{loader:"ts",format:"cjs",target:"node24"}).code
  const run=new Function(...Object.keys(dependencies),`${code};return deleteRecord;`)(...Object.values(dependencies)) as ()=>Promise<void>
  return {run,state,owner,rename,deleting}
}
test("actual core delete captures owner/version, blocks pending writes/doubleclick and never resets a newer selection",async()=>{
  const waiting=coreDelete({pending:true});await waiting.run();assert.equal(waiting.state.requests.length,0)
  let release!:(value:deletion.CcinfoDeleteReceipt)=>void
  const held=coreDelete({write:()=>new Promise(resolve=>{release=resolve})})
  const first=held.run();await held.run();assert.equal(held.state.requests.length,1);assert.equal(held.rename.current,true);assert.equal(held.deleting.current,true)
  assert.deepEqual(held.state.requests[0],input)
  held.owner.current=2;release(receipt);await first
  assert.equal(held.state.resets,0);assert.equal(held.state.modal,true);assert.equal(held.state.messages.includes("Deleted."),false)
  assert.equal(held.rename.current,false);assert.equal(held.deleting.current,false)
})
test("actual core deletion retains failure draft/modal and preserves both optional bulk confirmations",async()=>{
  const failed=coreDelete({write:async()=>{throw new deletion.CcinfoDeleteError("SYNTHETIC CONFLICT: DRAFT RETAINED",409)}})
  await failed.run();assert.equal(failed.state.modal,true);assert.equal(failed.state.resets,0);assert.ok(failed.state.errors.includes("SYNTHETIC CONFLICT: DRAFT RETAINED"))
  const keep=coreDelete({kind:"country",confirmations:[true,false]});await keep.run();assert.equal(keep.state.requests[0].deletePorts,false);assert.equal(keep.state.confirmations.length,2)
  const bulk=coreDelete({kind:"country",confirmations:[true,true,true]});await bulk.run();assert.equal(bulk.state.requests[0].deletePorts,true);assert.equal(bulk.state.confirmations.length,3)
  const cancel=coreDelete({kind:"country",confirmations:[true,true,false]});await cancel.run();assert.equal(cancel.state.requests.length,0);assert.equal(cancel.state.resets,0)
})
test("legacy raw entity deletes cannot bypass the atomic operation, but files/folders and other pages remain unchanged",()=>{
  const url=new URL("https://synthetic.invalid/rest/v1/cc_ports")
  for(const table of ["cc_companies","cc_countries","cc_ports"]) assert.ok(ccinfoLegacyContentWriteMessage("ccinfo",table,"DELETE",url,"return=representation",undefined))
  for(const table of ["cc_entry_files","cc_entry_folders","cc_company_files"]) assert.equal(ccinfoLegacyContentWriteMessage("ccinfo",table,"DELETE",url,null,undefined),null)
  assert.equal(ccinfoLegacyContentWriteMessage("phonebook","cc_ports","DELETE",url,null,undefined),null)
})
