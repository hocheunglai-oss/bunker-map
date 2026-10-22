import assert from "node:assert/strict"
import test from "node:test"
import {setupOperationConflicts,countryId,managedPortId,companyId,companyFileId,rootId,targetId,fileId,missingId,initialVersion,renameSql,deletionSql,folderSql,folderDeleteSql,prepareSql,moveSql,source,migrationPath}from"./fixtures/ccinfo-operation-conflicts.mjs"
import {waitForBlock}from"./fixtures/native-postgres-ccinfo.mjs"

const fault=(table,event,body)=>`create function private.operation_fault()returns trigger language plpgsql as $$begin ${body} end$$;create trigger operation_fault ${event} on public.${table} for each row execute function private.operation_fault();`
export const cases=[
 ["country saved baseline",renameSql(countryId,"2099-10-12T00:00:00.123455Z"),"CCINFO_COUNTRY_CONFLICT","The country changed or was removed. Reopen it before renaming."],
 ["record saved baseline",deletionSql("country",countryId,true,"2099-10-12T00:00:00.123455Z"),"CCINFO_DELETE_CONFLICT","The entry changed or was removed. Refresh it before deleting."],
 ["port delete suppressed",deletionSql(),"CCINFO_DELETE_UNCONFIRMED","The port deletion could not be verified. No entries were deleted.",fault("cc_ports","before delete","return null;")],
 ["port resurrected after delete",deletionSql(),"CCINFO_DELETE_UNCONFIRMED","A deleted port is still present. No entries were deleted.",fault("cc_ports","after delete","insert into public.cc_ports select old.*;return old;")],
 ["entry delete suppressed",deletionSql("port",managedPortId,false),"CCINFO_DELETE_UNCONFIRMED","The deletion could not be verified. No entries were deleted.",fault("cc_ports","before delete","return null;")],
 ["entry resurrected after delete",deletionSql("port",managedPortId,false),"CCINFO_DELETE_UNCONFIRMED","The deleted entry is still present. No entries were deleted.",fault("cc_ports","after delete","insert into public.cc_ports select old.*;return old;")],
 ["detached port content altered",deletionSql("country",countryId,false),"CCINFO_DELETE_UNCONFIRMED","The preserved ports could not be verified. No entries were deleted.",fault("cc_ports","before update","new.notes:=coalesce(new.notes,'')||'SYNTHETIC ALTERATION';return new;")],
 ["company file cascade suppressed",deletionSql("company",companyId,false),"CCINFO_DELETE_UNCONFIRMED","The existing file cascade could not be verified. No entries were deleted.",fault("cc_company_files","before delete","return null;")],
 ["relocate owning entry missing",folderSql("rename",{entry:missingId}),"CCINFO_FOLDER_CONFLICT","This entry was removed. Reopen it."],
 ["relocate explicit identity stale",folderSql("rename",{version:"2099-10-12T00:00:00.123455Z"}),"CCINFO_FOLDER_CONFLICT","This folder changed. Reopen it before renaming."],
 ["relocate forged virtual identity",folderSql("rename",{folder:null,version:null}),"CCINFO_FOLDER_CONFLICT","This folder changed. Reopen it before renaming."],
 ["relocate virtual source absent",folderSql("rename",{folder:null,path:"MISSING",version:null}),"CCINFO_FOLDER_CONFLICT","This folder changed or was removed. Reopen it."],
 ["relocate parent absent",folderSql("move",{parent:"MISSING"}),"CCINFO_FOLDER_CONFLICT","The destination folder changed or was removed. Reopen it."],
 ["folder delete entry absent",folderDeleteSql({entry:missingId}),"CCINFO_FOLDER_CONFLICT","This entry was removed. Reopen it."],
 ["folder delete explicit identity stale",folderDeleteSql({version:"2099-10-12T00:00:00.123455Z"}),"CCINFO_FOLDER_CONFLICT","This folder changed. Reopen it before deleting."],
 ["folder delete forged virtual identity",folderDeleteSql({folder:null,version:null}),"CCINFO_FOLDER_CONFLICT","This folder changed. Reopen it before deleting."],
 ["folder delete empty virtual source absent",folderDeleteSql({folder:null,path:"MISSING",version:null}),"CCINFO_FOLDER_CONFLICT","This folder changed or was removed. Reopen it."],
 ["company file saved version stale",moveSql("company"),"CCINFO_FILE_CONFLICT","This file changed or was removed. Reopen it."],
 ["entry file saved version stale",moveSql(),"CCINFO_FILE_CONFLICT","This file changed or was removed. Reopen it."],
 ["file target entry absent",prepareSql({entry:missingId}),"CCINFO_FILE_TARGET_CONFLICT","The entry was removed. Reopen it."],
 ["file target stable destination absent",prepareSql({folder:missingId}),"CCINFO_FILE_TARGET_CONFLICT","The destination was removed. Reopen it."],
 ["file target virtual destination absent",prepareSql({folder:null,path:"MISSING"}),"CCINFO_FILE_TARGET_CONFLICT","The destination changed or was removed. Reopen it."],
]
assert.equal(cases.length,22)
const typed=(operation,detail,message)=>assert.rejects(operation,error=>{assert.equal(error.code,"P0001");assert.ok(error.message.includes("P0001: "+message+"\n"),error.message);assert.ok(error.message.includes("DETAIL:  "+detail+"\n"),error.message);return true})

test("genuine PostgreSQL17.6: all22 exact CCINFO guards are nonretryable and roll back content/files/pricing/audit/backup together",{timeout:120000},async t=>{
 const f=await setupOperationConflicts()
 try{
  for(const[name,sql,detail,message,setup]of cases)await t.test(name,async()=>{
   if(setup)await f.owner.query(setup)
   try{const before=await f.snapshot();await typed(f.execute(sql),detail,message);assert.deepEqual(await f.snapshot(),before)}
   finally{if(setup)await f.owner.query("drop function private.operation_fault()cascade;")}
  })
 }finally{await f.close()}
})

test("six replacement bodies change only their22 error states/details; wrappers/OIDs/owners/ACL/config remain identical",{timeout:120000},async()=>{
 const f=await setupOperationConflicts()
 try{
  assert.deepEqual(await f.identities(),f.beforeIdentities)
  const bodies=await f.bodies();let count=0
  for(const[signature,before]of Object.entries(f.beforeBodies)){
   const marker=signature.startsWith("rename_ccinfo_country")?"CCINFO_COUNTRY_CONFLICT":signature.startsWith("delete_ccinfo_record")?"CCINFO_DELETE_CONFLICT":signature.startsWith("move_ccinfo_file")?"CCINFO_FILE_CONFLICT":signature.startsWith("prepare_ccinfo_file_target")?"CCINFO_FILE_TARGET_CONFLICT":"CCINFO_FOLDER_CONFLICT"
   const expected=before.replace(/errcode\s*=\s*'40001',\s*message\s*=\s*'([^']*)'/g,(text,message)=>{count++;return text.replace("'40001'","'P0001'")+",detail='"+(signature.startsWith("delete_ccinfo_record")&&!message.startsWith("The entry changed")?"CCINFO_DELETE_UNCONFIRMED":marker)+"'"})
   assert.equal(bodies[signature],expected,signature)
  }
  assert.equal(count,22)
  for(const identity of await f.identities())assert.deepEqual([identity.invoker,identity.anon,identity.authenticated,identity.service],[true,false,false,true])
  for(const role of["anon","authenticated"]){const s=await f.session("denied-"+role,false);try{await assert.rejects(s.query(`set role ${role};${folderSql()}`),e=>e.code==="42501")}finally{await s.close()}}
 }finally{await f.close()}
})

test("concurrent winner remains committed; stale country deletion cannot overwrite renamed links or audit",{timeout:120000},async()=>{
 const f=await setupOperationConflicts()
 try{
  const a=await f.session("winning-rename"),b=await f.session("stale-delete"),observer=await f.session("observer")
  await a.begin();await a.one(renameSql());await b.begin()
  const pending=b.one(deletionSql()).then(value=>({value}),error=>({error}));await waitForBlock(observer,b,a,"relation","cc_countries");await a.query("commit;")
  const before=await f.snapshot(),outcome=await pending;assert.equal(outcome.error?.code,"P0001");assert.match(outcome.error.message,/CCINFO_DELETE_CONFLICT/);assert.deepEqual(await f.snapshot(),before)
 }finally{await f.close()}
})

test("ordinary audit P0001 and later folder-write exceptions remain unclassified and fully rolled back",{timeout:120000},async()=>{
 const f=await setupOperationConflicts()
 try{
  for(const[setup,sql]of[[fault("audit_logs","before insert","raise exception 'SYNTHETIC PRIVATE AUDIT FAILURE';"),deletionSql()],[fault("cc_entry_files","before update","raise exception 'SYNTHETIC PRIVATE FILE FAILURE';"),folderSql()]]){
   await f.owner.query(setup);try{const before=await f.snapshot();await assert.rejects(f.execute(sql),e=>e.code==="P0001"&&!/DETAIL:  CCINFO_/.test(e.message));assert.deepEqual(await f.snapshot(),before)}finally{await f.owner.query("drop function private.operation_fault()cascade;")}
  }
 }finally{await f.close()}
})

test("source MD5 drift stops migration before replacing any of the six RPCs",{timeout:120000},async()=>{
 const f=await setupOperationConflicts({repaired:false})
 try{
  const def=await f.owner.one("select to_jsonb(pg_get_functiondef('public.delete_ccinfo_record(text,uuid,timestamptz,boolean)'::regprocedure));")
  await f.owner.query(def.replace("AS $function$\n","AS $function$\n-- synthetic drift\n")+";")
  const before=await f.bodies(),identities=await f.identities(),s=await f.session("migration-owner",false)
  try{await assert.rejects(s.query(`begin;${source(migrationPath)}commit;`),e=>e.code==="55000"&&/CCINFO_OPERATION_SOURCE_MISMATCH/.test(e.message))}finally{await s.close()}
  assert.deepEqual(await f.bodies(),before);assert.deepEqual(await f.identities(),identities)
 }finally{await f.close()}
})
