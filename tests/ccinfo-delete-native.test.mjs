import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { fixtureSql, stateSql, countryId, otherCountryId, companyId, managedPortId, initialVersion } from "./fixtures/ccinfo-delete-sql.mjs"
import { setupNativeCcinfo, waitForBlock, literal } from "./fixtures/native-postgres-ccinfo.mjs"
import { parseCcinfoDeleteReceipt } from "../lib/ccinfoDelete.ts"

const sql = (kind="country",id=countryId,bulk=true,version=initialVersion) => `select public.delete_ccinfo_record(${literal(kind)},'${id}','${version}',${bulk});`
const settle = promise => promise.then(value=>({value}),error=>({error}))
const state = f => f.owner.one(stateSql)
async function isolated(t,name,work) {
  await t.test(name,async t=>{
    const f=await setupNativeCcinfo(fixtureSql())
    t.diagnostic(`Owned native cluster ${f.root}; ${f.version}; executable SHA256 ${f.runtimeSha256}`)
    try { await work(f,t) } finally { await f.close(); t.diagnostic("Owned sessions closed and server stopped.") }
  })
}

test("native PostgreSQL 17.6: CCINFO atomic deletion, writers, FK/audit and backup boundaries",{timeout:120000},async t=>{
  await isolated(t,"two concurrent deletions: exactly one commit; the stale writer cannot acknowledge an already removed row",async(f,t)=>{
    const first=await f.session("delete-first"),second=await f.session("delete-second"),observer=await f.session("delete-observer")
    await first.begin(); const receipt=await first.one(sql())
    await second.begin(); const pending=settle(second.one(sql()))
    t.diagnostic(JSON.stringify(await waitForBlock(observer,second,first,"relation","cc_countries")))
    await first.query("commit;")
    const after=await state(f),outcome=await pending
    assert.equal(outcome.error?.code,"40001");assert.equal(receipt.portsDeleted,2)
    assert.deepEqual(await state(f),after)
  })
  await isolated(t,"edit-first: a country version change wins and deletion rolls back without touching ports",async(f,t)=>{
    const editor=await f.session("country-editor"),deleter=await f.session("delete-after-edit"),observer=await f.session("edit-observer")
    await editor.begin();await editor.query(`update public.cc_countries set notes='CONCURRENT NOTES' where id='${countryId}';`)
    await deleter.begin();const pending=settle(deleter.one(sql()))
    t.diagnostic(JSON.stringify(await waitForBlock(observer,deleter,editor,"relation","cc_countries")))
    await editor.query("commit;");const before=await state(f)
    assert.equal((await pending).error?.code,"40001");assert.deepEqual(await state(f),before)
  })
  await isolated(t,"port writer first: moved-away ports are retained, while an earlier in-flight linked insert is included",async(f,t)=>{
    const writer=await f.session("port-writer"),deleter=await f.session("delete-after-ports"),observer=await f.session("ports-observer"),id=randomUUID()
    await writer.begin();await writer.query(`update public.cc_ports set country_id='${otherCountryId}',country_name='OTHER COUNTRY' where id='${managedPortId}'; insert into public.cc_ports(id,name,country_id,country_name) values('${id}','NEW LINKED PORT','${countryId}','SYNTHETIC OLD');`)
    await deleter.begin();const pending=settle(deleter.one(sql()))
    t.diagnostic(JSON.stringify(await waitForBlock(observer,deleter,writer,"relation","cc_ports")))
    await writer.query("commit;");const outcome=await pending
    assert.equal(outcome.error,undefined);await deleter.query("commit;")
    const after=await state(f)
    assert.equal(after.ports.find(row=>row.id===managedPortId).country_id,otherCountryId)
    assert.ok(!after.ports.some(row=>row.id===id));assert.equal(outcome.value.portsDeleted,2)
  })
  await isolated(t,"delete first: later cached-ID insertion waits then fails, without an orphan or partial audit",async(f,t)=>{
    const deleter=await f.session("delete-before-insert"),writer=await f.session("insert-after-delete"),observer=await f.session("insert-observer"),id=randomUUID()
    await deleter.begin();await deleter.one(sql())
    await writer.begin();const pending=settle(writer.query(`insert into public.cc_ports(id,name,country_id,country_name) values('${id}','LATE CACHED PORT','${countryId}','SYNTHETIC OLD');`))
    t.diagnostic(JSON.stringify(await waitForBlock(observer,writer,deleter,"relation","cc_ports")))
    await deleter.query("commit;");const after=await state(f),outcome=await pending
    assert.equal(outcome.error?.code,"23503");assert.deepEqual(await state(f),after)
  })
  await isolated(t,"rename first: identical lock order finishes without deadlock, then stale deletion refuses the renamed version",async(f,t)=>{
    const renamer=await f.session("rename-before-delete"),deleter=await f.session("delete-after-rename"),observer=await f.session("rename-observer")
    await renamer.begin();await renamer.one(`select public.rename_ccinfo_country('${countryId}','${initialVersion}','RENAMED COUNTRY');`)
    await deleter.begin();const pending=settle(deleter.one(sql()))
    t.diagnostic(JSON.stringify(await waitForBlock(observer,deleter,renamer,"relation","cc_countries")))
    await renamer.query("commit;");const after=await state(f)
    assert.equal((await pending).error?.code,"40001");assert.deepEqual(await state(f),after)
  })
  await isolated(t,"backup-exclusive fence blocks deletion before table locks; uncommitted result/audit/epoch remain invisible",async(f,t)=>{
    const backup=await f.session("backup-holder"),deleter=await f.session("delete-after-backup"),observer=await f.session("backup-observer"),before=await state(f)
    await backup.begin();await backup.query("select pg_advisory_xact_lock(730261052372033133::bigint);")
    await deleter.begin();const pending=settle(deleter.one(sql()))
    t.diagnostic(JSON.stringify(await waitForBlock(observer,deleter,backup,"advisory")))
    const locks=await observer.one(`select jsonb_build_object('writeLocks',count(*)) from pg_locks where pid=${deleter.pid} and granted and relation in('public.cc_countries'::regclass,'public.cc_ports'::regclass) and mode in('ShareRowExclusiveLock','RowExclusiveLock');`)
    assert.equal(locks.writeLocks,0);assert.deepEqual(await state(f),before)
    await backup.query("commit;");assert.equal((await pending).error,undefined)
    assert.deepEqual(await state(f),before)
    assert.equal((await observer.one("select public.get_bunker_map_backup_export_fence();")).ready,false)
    await deleter.query("commit;");assert.equal((await state(f)).epochs.length,before.epochs.length+1)
  })
  await isolated(t,"waiting statement cancellation and caller rollback never commit partial deletion/audit/backup state",async f=>{
    const backup=await f.session("cancel-backup-holder"),deleter=await f.session("cancel-deletion"),observer=await f.session("cancel-observer",false),before=await state(f)
    await backup.begin();await backup.query("select pg_advisory_xact_lock(730261052372033133::bigint);")
    await deleter.begin();const pending=settle(deleter.one(sql()))
    await waitForBlock(observer,deleter,backup,"advisory")
    await observer.one(`select to_jsonb(pg_cancel_backend(${deleter.pid}));`)
    assert.equal((await pending).error?.code,"57014");await backup.query("commit;")
    assert.deepEqual(await state(f),before)
    const rollback=await f.session("delete-rollback");await rollback.begin();await rollback.one(sql());await rollback.query("rollback;")
    assert.deepEqual(await state(f),before)
  })
  await isolated(t,"future-version company deletion has truthful time, existing cascade, exact ACL/GUC and one transaction",async f=>{
    const writer=await f.session("native-company-delete"),before=await state(f)
    await writer.begin();const receipt=await writer.one(sql("company",companyId,false))
    parseCcinfoDeleteReceipt(receipt,{kind:"company",id:companyId,expectedUpdatedAt:initialVersion,deletePorts:false})
    assert.ok(Date.parse(receipt.deletedAt)<Date.parse(initialVersion));await writer.query("commit;")
    const after=await state(f);assert.deepEqual(after.companies,[]);assert.deepEqual(after.companyFiles,[])
    assert.deepEqual(after.files,before.files);assert.deepEqual(after.folders,before.folders)
    assert.equal(after.audit.length,before.audit.length+2);assert.equal(after.epochs.length,before.epochs.length+1)
    const acl=await f.owner.one("select jsonb_build_object('definer',prosecdef,'config',proconfig,'anon',has_function_privilege('anon',oid,'execute'),'authenticated',has_function_privilege('authenticated',oid,'execute'),'service',has_function_privilege('service_role',oid,'execute')) from pg_proc where oid='public.delete_ccinfo_record(text,uuid,timestamptz,boolean)'::regprocedure;")
    assert.deepEqual(acl,{definer:false,config:['search_path=""','lock_timeout=5s','statement_timeout=15s'],anon:false,authenticated:false,service:true})
  })
  await isolated(t,"1000-port scale: set-based exact preimages and all1001 audit acknowledgements retain unrelated foreign ports",async(f,t)=>{
    const scaleCountry="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
    await f.owner.query(`do $$ begin perform set_config('request.headers','{}',false); end $$;
      insert into public.cc_countries(id,name,updated_at) values('${scaleCountry}','SCALE COUNTRY','${initialVersion}');
      insert into public.cc_ports(id,name,country_id,country_name,notes,updated_at)
      select md5('CCINFO-SCALE-'||n)::uuid,'SCALE PORT '||n,'${scaleCountry}','SCALE COUNTRY',repeat('SYNTHETIC CONTENT ',128),'${initialVersion}' from generate_series(1,1000) n;`)
    const before=await state(f),writer=await f.session("scale-delete")
    await writer.begin();const start=process.hrtime.bigint()
    const receipt=await writer.one(sql("country",scaleCountry,true))
    const elapsedMs=Number(process.hrtime.bigint()-start)/1e6
    assert.equal(receipt.portsDeleted,1000);await writer.query("commit;")
    const after=await state(f)
    assert.deepEqual(after.ports,before.ports.filter(row=>row.country_id!==scaleCountry))
    assert.equal(after.audit.length,before.audit.length+1001)
    assert.equal(after.epochs.length,before.epochs.length+1)
    t.diagnostic(JSON.stringify({ports:1000,notesBytesPerPort:Buffer.byteLength("SYNTHETIC CONTENT ".repeat(128)),verifiedAuditRows:1001,rpcElapsedMs:elapsedMs,hardTimingThreshold:false}))
  })
})
