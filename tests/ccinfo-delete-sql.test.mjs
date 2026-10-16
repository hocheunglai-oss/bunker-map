import assert from "node:assert/strict"
import test from "node:test"
import { fixtureSql, stateSql, companyId, companyFileId, countryId, managedPortId, legacyPortId, foreignPortId, initialVersion } from "./fixtures/ccinfo-delete-sql.mjs"
import { parseCcinfoDeleteReceipt } from "../lib/ccinfoDelete.ts"
const { PGlite } = await import(process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite")
async function fixture() { const db = new PGlite(); try { await db.exec(fixtureSql()); return db } catch (error) { await db.close(); throw error } }
const state = async db => { await db.exec("reset role"); try { return (await db.query(stateSql)).rows[0].state } finally { await db.exec("set role service_role") } }
const call = async (db, kind = "country", id = countryId, bulk = true, version = initialVersion) => (await db.query("select public.delete_ccinfo_record($1,$2::uuid,$3::timestamptz,$4) as receipt", [kind,id,version,bulk])).rows[0].receipt
const freshAudit = (before, after) => after.audit.filter(row => !before.audit.some(old => old.id === row.id))

test("atomic country bulk deletion removes only stable-ID and null-ID exact legacy ports, with one committed backup epoch", async () => {
  const db = await fixture()
  try {
    const before = await state(db), receipt = await call(db), after = await state(db)
    assert.deepEqual(receipt, { schema:"fcuno.ccinfo-delete/v1",kind:"country",id:countryId,deletedAt:receipt.deletedAt,deletedCount:1,portsDeleted:2,portsDetached:0 })
    assert.ok(!after.countries.some(row => row.id === countryId))
    assert.ok(!after.ports.some(row => [managedPortId,legacyPortId].includes(row.id)))
    assert.deepEqual(after.ports.find(row => row.id === foreignPortId), before.ports.find(row => row.id === foreignPortId))
    assert.deepEqual(after.files,before.files); assert.deepEqual(after.folders,before.folders)
    assert.equal(freshAudit(before,after).length,3)
    assert.equal(new Set(freshAudit(before,after).map(row => row.request_context.ccinfoDeleteRequestId)).size,1)
    assert.equal(after.epochs.length,before.epochs.length+1)
  } finally { await db.close() }
})

test("default country deletion preserves ports and exact content, applying only the existing FK detachment/version audit", async () => {
  const db = await fixture()
  try {
    const before = await state(db), receipt = await call(db,"country",countryId,false), after = await state(db)
    assert.equal(receipt.portsDeleted,0); assert.equal(receipt.portsDetached,1)
    assert.equal(after.ports.length,before.ports.length)
    const detached=after.ports.find(row=>row.id===managedPortId), original=before.ports.find(row=>row.id===managedPortId)
    assert.equal(detached.country_id,null); assert.equal(detached.country_name,original.country_name)
    assert.ok(detached.updated_at>original.updated_at)
    for (const row of before.ports.filter(row=>row.id!==managedPortId)) assert.deepEqual(after.ports.find(item=>item.id===row.id),row)
    assert.equal(freshAudit(before,after).length,2)
    assert.equal(after.epochs.length,before.epochs.length+1)
  } finally { await db.close() }
})

test("company deletion retains existing polymorphic-file policy and verifies the existing company-file cascade audit", async () => {
  const db = await fixture()
  try {
    const before=await state(db), receipt=await call(db,"company",companyId,false),after=await state(db)
    assert.equal(receipt.deletedCount,1); assert.equal(receipt.portsDeleted,0); assert.equal(receipt.portsDetached,0)
    assert.deepEqual(after.companies,[]); assert.deepEqual(after.companyFiles,[])
    assert.deepEqual(after.files,before.files); assert.deepEqual(after.folders,before.folders)
    const logs=freshAudit(before,after)
    assert.equal(logs.length,2); assert.ok(logs.some(row=>row.table_name==="cc_company_files"&&row.record_pk.id===companyFileId))
  } finally { await db.close() }
})

test("exact future-version CAS can delete a port without inventing a future wall-clock deletion time", async () => {
  const db = await fixture()
  try {
    const receipt=await call(db,"port",managedPortId,false)
    assert.ok(Date.parse(receipt.deletedAt)<Date.parse(initialVersion))
    assert.equal(parseCcinfoDeleteReceipt(receipt,{kind:"port",id:managedPortId,expectedUpdatedAt:initialVersion,deletePorts:false}).id,managedPortId)
  } finally { await db.close() }
})

test("stale/missing/invalid versions and case-space ambiguous legacy country names fail before any deletion", async () => {
  const db=await fixture()
  try {
    const before=await state(db)
    for(const [kind,id,bulk,version] of [["country",countryId,true,"2099-10-12T00:00:00.123455Z"],["country","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",true,initialVersion],["company",companyId,true,initialVersion],["port",managedPortId,false,null]]) {
      await assert.rejects(call(db,kind,id,bulk,version)); assert.deepEqual(await state(db),before)
    }
    await db.query("update public.cc_countries set notes='INDEPENDENT EDIT' where id=$1",[countryId])
    const changed=await state(db)
    await assert.rejects(call(db),error=>error.code==="40001"); assert.deepEqual(await state(db),changed)
  } finally { await db.close() }
  for(const alias of ["SYNTHETIC OLD"," synthetic old "]) {
    const db=await fixture()
    try { await db.query("insert into public.cc_countries(name) values($1)",[alias]); const before=await state(db)
      await assert.rejects(call(db),error=>error.code==="23514"); assert.deepEqual(await state(db),before)
    } finally { await db.close() }
  }
})

test("suppressed/altered delete, FK cascade, audit receipt and late genuine audit errors roll back every row/audit/epoch", async () => {
  for(const [table,event,body] of [
    ["cc_countries","delete","return null;"],["cc_ports","delete","return null;"],["cc_company_files","delete","return null;"],
    ["audit_logs","insert","return null;"],["audit_logs","insert","new.actor_id:='ALTERED'; return new;"],
    ["audit_logs","insert","new.before_row:='{}'::jsonb; return new;"],
    ["audit_logs","insert","if new.table_name='cc_countries' then raise exception 'SYNTHETIC LATE AUDIT FAILURE'; end if; return new;"],
  ]) {
    const db=await fixture()
    try {
      const before=await state(db)
      await db.exec(`reset role; create function public.inject_ccinfo_delete_fault() returns trigger language plpgsql as $$ begin ${body} end; $$; create trigger inject_ccinfo_delete_fault before ${event} on public.${table} for each row execute function public.inject_ccinfo_delete_fault(); set role service_role;`)
      await assert.rejects(table==="cc_company_files"?call(db,"company",companyId,false):call(db))
      assert.deepEqual(await state(db),before,`${table}: full rollback`)
    } finally { await db.close() }
  }
})

test("new deletion RPC is service-only invoker with bounded locks/statement and rejects unaudited calls", async () => {
  const db=await fixture()
  try {
    const acl=(await db.query("select prosecdef,proconfig,has_function_privilege('anon',oid,'execute') as anon,has_function_privilege('authenticated',oid,'execute') as authenticated,has_function_privilege('service_role',oid,'execute') as service from pg_proc where oid='public.delete_ccinfo_record(text,uuid,timestamptz,boolean)'::regprocedure")).rows[0]
    assert.deepEqual(acl,{prosecdef:false,proconfig:['search_path=""','lock_timeout=5s','statement_timeout=15s'],anon:false,authenticated:false,service:true})
    const before=await state(db)
    await db.exec("select set_config('request.headers','{}',false)")
    await assert.rejects(call(db),error=>error.code==="42501"); assert.deepEqual(await state(db),before)
    await db.exec("set role anon")
    await assert.rejects(call(db),/permission denied/)
  } finally { await db.close() }
})
