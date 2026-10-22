import assert from "node:assert/strict"
import test from "node:test"
import { saveConflictApi } from "./fixtures/phonebook-taiwan-cas-api.mjs"
import { setupSaveConflicts } from "./fixtures/phonebook-taiwan-cas.mjs"
import { PHONEBOOK_COMPANY_CONFLICT } from "../lib/phonebookCompanySave.ts"
import { TAIWAN_REMARKS_CONFLICT } from "../lib/taiwanRemarksSave.ts"
const companyMessage = "The company changed or was removed. Reopen it."
const baselineMessage = "The saved remarks changed. Keep the draft and reload."
const writeMessage = "The remark save could not be confirmed."
const auditMessage = "The remark audit could not be confirmed. No changes were saved."
const neutral = "No changes were saved. Your draft is still here; try again."

test("actual phonebook API/SDK maps only exact new and legacy business conflicts, retaining other statuses and redaction", async t => {
  const f = saveConflictApi("phonebook")
  for (const [name, error, status, message] of [
    ["new exact marker", { code:"P0001",message:companyMessage,details:"PHONEBOOK_COMPANY_CONFLICT" },409,PHONEBOOK_COMPANY_CONFLICT],
    ["legacy exact marker", { code:"40001",message:companyMessage },409,PHONEBOOK_COMPANY_CONFLICT],
    ["missing typed detail", { code:"P0001",message:companyMessage },500],
    ["wrong typed detail", { code:"P0001",message:companyMessage,details:"PHONEBOOK_COMPANY_CONFLICT_OTHER" },500],
    ["wrong message", { code:"P0001",message:`${companyMessage} private`,details:"PHONEBOOK_COMPANY_CONFLICT" },500],
    ["genuine serialization", { code:"40001",message:"could not serialize private query" },500],
    ["unknown P0001", { code:"P0001",message:"private error" },500],
    ["deadlock", { code:"40P01",message:"private" },409],
    ["lock timeout", { code:"55P03",message:"private" },409],
    ["duplicate", { code:"23505",message:"private" },409],
    ["ambiguous source", { code:"23514",message:"private" },409],
    ["input", { code:"22023",message:"private" },400],
  ]) await t.test(name, async () => {
    f.controls.error = error
    const before = f.calls.length, result = await f.request()
    assert.equal(result.status,status)
    if(message) assert.equal(result.body.message,message)
    assert.equal(f.calls.length,before+1)
    assert.match(result.cacheControl,/private.*no-store/)
    assert.doesNotMatch(JSON.stringify(result.body),/private|P0001|40001|PHONEBOOK_COMPANY_CONFLICT|serialize/)
  })
  for(const [auth,status] of [["Unauthorized",401],["Forbidden",403]]) await t.test(auth,async()=>{
    f.controls.auth=auth
    const before=f.calls.length
    assert.equal((await f.request()).status,status)
    assert.equal(f.calls.length,before)
  })
  assert.ok(f.permissions.every(p=>p.page==="phonebook"&&p.access==="edit"))
})

test("actual Taiwan API/SDK separates baseline conflicts from definite rolled-back saves and unknown failures",async t=>{
  const f=saveConflictApi("taiwan")
  const cases=[
    ["new baseline",{code:"P0001",message:baselineMessage,details:"TAIWAN_REMARKS_CONFLICT"},409,"REMARKS_CONFLICT",TAIWAN_REMARKS_CONFLICT],
    ["legacy baseline",{code:"40001",message:baselineMessage},409,"REMARKS_CONFLICT",TAIWAN_REMARKS_CONFLICT],
    ...[writeMessage,auditMessage].flatMap(message=>[
      ["new unconfirmed",{code:"P0001",message,details:"TAIWAN_REMARKS_UNCONFIRMED"},409,"REMARKS_UNCONFIRMED",neutral],
      ["legacy unconfirmed",{code:"40001",message},409,"REMARKS_UNCONFIRMED",neutral],
    ]),
    ["missing detail",{code:"P0001",message:baselineMessage},503],
    ["mismatched detail",{code:"P0001",message:writeMessage,details:"TAIWAN_REMARKS_CONFLICT"},503],
    ["marker suffix",{code:"P0001",message:baselineMessage,details:"TAIWAN_REMARKS_CONFLICT_OTHER"},503],
    ["wrong case",{code:"P0001",message:baselineMessage.toLowerCase(),details:"TAIWAN_REMARKS_CONFLICT"},503],
    ["genuine serialization",{code:"40001",message:"private serialization error"},503],
    ["unknown P0001",{code:"P0001",message:"private"},503],
    ["unknown no-data",{code:"P0002",message:"private"},503],
    ["deadlock",{code:"40P01",message:"private"},409],
    ["lock timeout",{code:"55P03",message:"private"},409],
    ["input",{code:"22023",message:"private"},400],
  ]
  for(const [name,error,status,code,message] of cases)await t.test(name,async()=>{
    f.controls.error=error
    const before=f.calls.length,result=await f.request()
    assert.equal(result.status,status)
    if(code)assert.equal(result.body.code,code)
    if(message)assert.equal(result.body.message,message)
    assert.equal(f.calls.length,before+1)
    assert.match(result.cacheControl,/private.*no-store/)
    assert.doesNotMatch(JSON.stringify(result.body),/private|P0001|40001|TAIWAN_REMARKS|serialize|audit/)
    if(code==="REMARKS_UNCONFIRMED")assert.doesNotMatch(result.body.message,/another session|changed|reload/)
  })
  for(const [auth,status]of[["Unauthorized",401],["Forbidden",403]])await t.test(auth,async()=>{
    f.controls.auth=auth;const before=f.calls.length
    assert.equal((await f.request()).status,status);assert.equal(f.calls.length,before)
  })
  assert.ok(f.permissions.every(p=>p.page==="taiwan-remarks"&&p.access==="edit"))
})

test("actual native five guards traverse SDK/API once, preserve atomic rollback and keep neutral errors distinct",{timeout:120000},async t=>{
  const db=await setupSaveConflicts(),company=saveConflictApi("phonebook",db),remarks=saveConflictApi("taiwan",db)
  try{
    await t.test("phonebook stale version",async()=>{
      const before=await db.snapshot(),result=await company.request({...company.payload,expectedUpdatedAt:"2026-10-14T00:00:00.123455+00:00"})
      assert.equal(result.status,409);assert.equal(result.body.message,PHONEBOOK_COMPANY_CONFLICT)
      assert.equal(company.databaseStates.at(-1).code,"P0001");assert.equal(company.calls.length,1)
      assert.deepEqual(await db.snapshot(),before)
    })
    const cases=[
      ["baseline","",{...remarks.payload,changes:[{...remarks.payload.changes[0],expected:{id:2,exists:true,content:"STALE"}}]},"REMARKS_CONFLICT"],
      ["suppressed write","create function private.api_notice_write() returns trigger language plpgsql as $$begin return null;end$$;create trigger z_api_fault before update on public.remarks for each row execute function private.api_notice_write();",remarks.payload,"REMARKS_UNCONFIRMED"],
      ["suppressed audit","create function private.api_notice_audit() returns trigger language plpgsql as $$begin return null;end$$;create trigger z_api_fault before insert on public.audit_logs for each row execute function private.api_notice_audit();",remarks.payload,"REMARKS_UNCONFIRMED"],
      ["late readback","create function private.api_notice_late() returns trigger language plpgsql as $$begin if new.id=2 and pg_trigger_depth()=1 then update public.remarks set content='LATE ALTERATION' where id=1;end if;return new;end$$;create trigger zz_api_late after update on public.remarks for each row execute function private.api_notice_late();",{changes:[{id:1,content:"FIRST",expected:{id:1,exists:true,content:"OLD"}},...remarks.payload.changes]},"REMARKS_UNCONFIRMED"],
      ["genuine unclassified audit exception","create function private.api_notice_audit_failure() returns trigger language plpgsql as $$begin raise exception 'GENUINE PRIVATE AUDIT FAILURE';end$$;create trigger z_api_fault before insert on public.audit_logs for each row execute function private.api_notice_audit_failure();",remarks.payload,null,503],
    ]
    for(const[name,setup,payload,code,status=409]of cases)await t.test(name,async()=>{
      if(setup)await db.owner.query(setup)
      try{
        const before=await db.snapshot(),calls=remarks.calls.length,result=await remarks.request(payload)
        assert.equal(result.status,status)
        if(code)assert.equal(result.body.code,code)
        else assert.equal(result.body.code,undefined)
        if(code==="REMARKS_UNCONFIRMED")assert.equal(result.body.message,neutral)
        const receipt=remarks.databaseStates.at(-1)
        assert.equal(receipt.code,"P0001");assert.deepEqual(receipt.after,receipt.before)
        assert.equal(remarks.calls.length,calls+1)
        assert.deepEqual(await db.snapshot(),before)
        assert.doesNotMatch(JSON.stringify(result.body),/PRIVATE|GENUINE|P0001|AUDIT FAILURE/)
      }finally{await db.owner.query("drop trigger if exists z_api_fault on public.remarks;drop trigger if exists z_api_fault on public.audit_logs;drop trigger if exists zz_api_late on public.remarks;")}
    })
  }finally{await db.close()}
})
