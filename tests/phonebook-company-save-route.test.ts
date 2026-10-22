import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"
import * as validation from "../lib/phonebookCompanySave"

const id="11111111-1111-4111-8111-111111111111", contactId="22222222-2222-4222-8222-222222222222"
const version="2026-10-14T00:00:00.123456+00:00"
const body={id,expectedUpdatedAt:version,patch:{name:" new company ",tel_no_1:"12345678"}}
const output=ts.transpileModule(readFileSync(new URL("../app/api/phonebook/company/route.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
function fixture(options: {auth?:string;error?:string;data?:unknown;service?:boolean}={}) {
  const calls:unknown[]=[]
  const handlers:Record<string,(request:Request)=>Promise<Response>>={}
  vm.runInNewContext(output,{
    exports:handlers,Error,Date,Set,process:{env:{SUPABASE_SERVICE_ROLE_KEY:options.service===false?undefined:"synthetic-private-key"}},
    require(name:string) {
      if(name==="next/server")return {NextResponse:Response}
      if(name==="@/lib/phonebookCompanySave")return validation
      if(name==="@/lib/adminAuth")return {requireAdminPagePermission:async(...args:unknown[])=>{calls.push(["permission",...args]);if(options.auth)throw new Error(options.auth);return {username:"TRUSTED EDITOR",displayName:"Trusted Editor",role:"ADMIN"}}}
      if(name==="@/lib/adminAudit")return {
        createAdminAuditContext(session:unknown,request:unknown,page:string){assert.equal(request,undefined);assert.equal(page,"phonebook");return session},
        createAdminAuditedSupabaseClient(context:{username:string},config:unknown){assert.equal(context.username,"TRUSTED EDITOR");assert.deepEqual(JSON.parse(JSON.stringify(config)),{useServiceRole:true});return {rpc:async(...args:unknown[])=>{calls.push(args);return {data:options.data??{company:{id,name:"NEW COMPANY",source_key:"unchanged",updated_at:"2026-10-14T00:00:01.000001+00:00"},contactIds:[contactId]},error:options.error?{code:options.error,message:"private database response"}:null}}}},
      }
      throw new Error(`Unexpected dependency ${name}`)
    },
  })
  return {calls,post:(input:unknown=body)=>handlers.POST(new Request("https://app-fixture.invalid/api/phonebook/company",{method:"POST",headers:{"content-type":"application/json","x-bunker-admin-user":"FORGED",referer:"https://app-fixture.invalid/admin/other-page"},body:JSON.stringify(input)}))}
}

test("actual company route enforces edit permission and sends one audited atomic RPC with normalized name",async()=>{
  const f=fixture(),response=await f.post()
  assert.equal(response.status,200);assert.match(response.headers.get("cache-control")!,/private.*no-store/)
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)),[["permission","phonebook","edit"],["save_phonebook_company",{p_id:id,p_expected_updated_at:version,p_patch:{name:"NEW COMPANY",tel_no_1:"12345678"}}]])
  assert.equal((await response.json()).company.source_key,"unchanged")
})

test("actual company route rejects unauthorized, forged immutable fields and invalid versions before database work",async()=>{
  for(const auth of ["Unauthorized","Forbidden"]){const f=fixture({auth});assert.equal((await f.post()).status,auth==="Unauthorized"?401:403);assert.equal(f.calls.length,1)}
  for(const input of [null,{...body,actor:"FORGED"},{...body,expectedUpdatedAt:null},{...body,patch:{name:"NEW",id}},{...body,patch:{name:"NEW",source_key:"changed"}},{...body,patch:{name:"\n"}},{...body,patch:{name:"NEW",notes:{nested:"no"}}}]) {
    const f=fixture();assert.equal((await f.post(input)).status,400);assert.equal(f.calls.length,1)
  }
  const f=fixture({service:false});assert.equal((await f.post()).status,503);assert.equal(f.calls.length,1)
})

test("actual company route reports stale/duplicate/ambiguous writes without publishing private SQL errors",async()=>{
  for(const [error,status] of [["40001",500],["23505",409],["23514",409],["55P03",409],["22023",400],["unexpected",500]] as const){
    const response=await fixture({error}).post();assert.equal(response.status,status);assert.doesNotMatch(await response.text(),/private database/)
  }
})

test("actual company route requires a new saved version and complete matching returned identities",async()=>{
  for(const data of [{},{company:{id,name:"NEW COMPANY",updated_at:version},contactIds:[]},{company:{id:contactId,name:"NEW COMPANY",updated_at:"2026-10-14T00:00:02Z"},contactIds:[]},{company:{id,name:"NEW COMPANY",updated_at:"2026-10-14T00:00:02Z"},contactIds:[contactId,contactId]}]) {
    assert.equal((await fixture({data}).post()).status,500)
  }
})
