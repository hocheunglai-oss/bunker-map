import assert from"node:assert/strict"
import test from"node:test"
import{operationApi}from"./fixtures/ccinfo-operation-conflicts-api.mjs"
import{setupOperationConflicts,countryId,companyId,companyFileId,rootId,targetId,missingId,initialVersion}from"./fixtures/ccinfo-operation-conflicts.mjs"
const country="The country changed or was removed. Reopen it before renaming.",baseline="The entry changed or was removed. Refresh it before deleting.",folder="This folder changed. Reopen it before renaming."
const unconfirmed=["The port deletion could not be verified. No entries were deleted.","A deleted port is still present. No entries were deleted.","The deletion could not be verified. No entries were deleted.","The deleted entry is still present. No entries were deleted.","The preserved ports could not be verified. No entries were deleted.","The existing file cascade could not be verified. No entries were deleted."]
test("actual CCINFO routes through pinned SDK classify only exact new/legacy errors and retain drafts/redaction",async t=>{
 for(const[domain,message,detail,fallback]of[["rename",country,"CCINFO_COUNTRY_CONFLICT",500],["delete",baseline,"CCINFO_DELETE_CONFLICT",503],["files",folder,"CCINFO_FOLDER_CONFLICT",500]]){
  const f=operationApi(domain)
  for(const[name,error,status]of[
   ["typed",{code:"P0001",message,details:detail},409],["legacy",{code:"40001",message},409],
   ["wrong detail",{code:"P0001",message,details:detail+"_OTHER"},fallback],["missing detail",{code:"P0001",message},fallback],
   ["wrong message",{code:"P0001",message:message+" PRIVATE",details:detail},fallback],["real serialization",{code:"40001",message:"PRIVATE SERIALIZATION"},fallback],
   ["unknown P0001",{code:"P0001",message:"PRIVATE SQL"},fallback],
   ["lock",{code:"55P03",message:"PRIVATE LOCK"},409],["deadlock",{code:"40P01",message:"PRIVATE DEADLOCK"},409],["validation",{code:"22023",message:"PRIVATE INPUT"},400],
  ])await t.test(domain+" "+name,async()=>{f.controls.error=error;const before=f.calls.length,result=await f.request();assert.equal(result.status,status);assert.equal(f.calls.length,before+1);assert.doesNotMatch(JSON.stringify(result.body),/PRIVATE|P0001|40001|CCINFO_.*CONFLICT/);assert.equal(result.body.ok,undefined);assert.equal(result.body.deletion,undefined)})
  assert.ok(f.permissions.every(p=>p.page==="ccinfo"&&p.access===(domain==="files"?"view":"edit")))
 }
})
test("every typed or exact legacy deletion readback rejection has neutral definite-rollback wording, never false baseline blame",async t=>{
 const f=operationApi("delete")
 for(const message of unconfirmed)for(const code of["P0001","40001"])await t.test(message+code,async()=>{
  f.controls.error={code,message,details:"CCINFO_DELETE_UNCONFIRMED"};const before=f.calls.length,result=await f.request();assert.equal(result.status,409);assert.equal(result.body.code,"DELETE_UNCONFIRMED");assert.equal(result.body.message,"No entries were deleted. Keep your draft and try again.");assert.equal(f.calls.length,before+1);assert.doesNotMatch(result.body.message,/changed|another|removed|audit/)
 })
 f.controls.error={code:"P0001",message:"Deletion audit details could not be verified. No entries were deleted."};assert.equal((await f.request()).status,503)
})
test("native guards traverse actual SDK/routes once with full rollback and correct published/pricing/file preservation",{timeout:120000},async t=>{
 const db=await setupOperationConflicts()
 try{
  for(const[domain,payload]of[["rename",{id:countryId,name:"RENAMED",expectedUpdatedAt:"2099-10-12T00:00:00.123455Z"}],["delete",{kind:"country",id:countryId,deletePorts:true,expectedUpdatedAt:"2099-10-12T00:00:00.123455Z"}],["files",{action:"moveFolder",entryKind:"country",entryId:countryId,entryName:"SYNTHETIC OLD",folderId:rootId,folderPath:"A",targetFolderPath:"MISSING",expectedUpdatedAt:initialVersion}]])await t.test(domain+" native baseline/destination",async()=>{const f=operationApi(domain,db),before=await db.snapshot(),result=await f.request(payload);assert.equal(result.status,409);assert.equal(f.calls.length,1);assert.deepEqual(await db.snapshot(),before);assert.deepEqual(f.driveCalls,[])})
  await t.test("suppressed native write is neutral409; genuine native audit failure remains503",async()=>{
   for(const[table,event,body,status]of[["cc_ports","delete","return null;",409],["audit_logs","insert","raise exception 'GENUINE PRIVATE AUDIT FAILURE';",503]]){
    await db.owner.query(`create function private.api_fault()returns trigger language plpgsql as $$begin ${body} end$$;create trigger api_fault before ${event} on public.${table} for each row execute function private.api_fault();`)
    try{const f=operationApi("delete",db),before=await db.snapshot(),result=await f.request();assert.equal(result.status,status);assert.equal(f.calls.length,1);assert.deepEqual(await db.snapshot(),before);assert.equal(result.body.code,status===409?"DELETE_UNCONFIRMED":undefined);assert.doesNotMatch(JSON.stringify(result.body),/PRIVATE|GENUINE|AUDIT FAILURE/)}finally{await db.owner.query("drop function private.api_fault()cascade;")}
   }
  })
  await t.test("prepare destination failure stops upload before any synthetic Drive mutation",async()=>{const f=operationApi("upload",db),before=await db.snapshot(),result=await f.request({folderId:missingId});assert.equal(result.status,500);assert.match(result.body.message,/destination folder/);assert.equal(f.calls.length,1);assert.deepEqual(f.driveCalls,[]);assert.deepEqual(f.temp,[]);assert.deepEqual(await db.snapshot(),before)})
  await t.test("native company file loses its exact version after reviewed load: typed file409 without a Drive action",async()=>{
   const f=operationApi("files",db);let winner
   f.controls.beforeRpc=async name=>{if(name==="move_ccinfo_file"){await db.owner.query(`update public.cc_company_files set updated_at=updated_at+interval '1 microsecond' where id='${companyFileId}';`);winner=await db.snapshot()}}
   const result=await f.request({action:"move",source:"company",fileId:companyFileId,entryKind:"company",entryId:companyId,entryName:"SYNTHETIC COMPANY",folderPath:"",folderId:""})
   assert.equal(result.status,409);assert.equal(f.calls.length,2);assert.deepEqual(f.driveCalls,[]);assert.deepEqual(await db.snapshot(),winner)
  })
  await t.test("destination disappears before registration: preserve Drive upload and report fixed500, never delete or claim success",async()=>{
   const f=operationApi("upload",db),before=await db.snapshot();f.controls.beforeRpc=async name=>{if(name==="register_ccinfo_file")await db.owner.query(`delete from public.cc_entry_folders where id='${targetId}';`)}
   const result=await f.request({});assert.equal(result.status,500);assert.match(result.body.message,/uploaded Drive file has been preserved/);assert.equal(f.calls.length,2);assert.ok(f.driveCalls.includes("create"));assert.ok(!f.driveCalls.includes("delete"));assert.equal(f.temp.filter(x=>x[0]==="rm").length,1)
   const after=await db.snapshot();for(const key of["cc_entry_files","cc_company_files","ports","price_history"])assert.deepEqual(after[key],before[key])
  })
 }finally{await db.close()}
})
