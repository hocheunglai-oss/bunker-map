import assert from "node:assert/strict"
import test from "node:test"
import {performance} from "node:perf_hooks"
import {setupAtomicEligibility,atomicSignature,randomUUID,literal,source} from "./fixtures/outlook-atomic-eligibility-native.mjs"
import {seedRealisticActivationVolume} from "./fixtures/outlook-atomic-eligibility-volume.mjs"

const migrationPath="supabase/migrations/20261023081749_bound_atomic_outlook_full_proof_budget.sql"
const hourly="public.certify_staged_read_only_outlook_exchange_truth(uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text)"
const daily="public.certify_staged_full_outlook_truth_and_activate_templates(uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text)"
const targets=[atomicSignature,hourly,daily]
const metadata=f=>f.owner.one("select jsonb_object_agg(p.oid::regprocedure::text,to_jsonb(p)||jsonb_build_object('comment',obj_description(p.oid,'pg_proc')))from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private');")
const rollup=f=>f.owner.one("select jsonb_build_object("+[
  ["templates","public.email_templates","id"],["certifications","public.outlook_exchange_sync_certifications","run_id"],
  ["ledger","public.outlook_exchange_truth_ledger","ledger_sequence"],["snapshots","public.outlook_exchange_truth_snapshots","snapshot_sha256"],
  ["queue","public.outlook_exchange_sync_queue","id"],["audit","public.audit_logs","id"],["epochs","private.bunker_map_backup_mutations","mutation_id"],
].map(([name,table,key])=>"'"+name+"',(select jsonb_build_object('count',count(*),'sha256',public.outlook_exchange_truth_sha256(coalesce(string_agg(public.outlook_exchange_truth_sha256(to_jsonb(t)::text),''order by "+key+"),'')))from "+table+" t)").join(",")+");")
const apply=f=>f.owner.query("begin;"+source(migrationPath)+"commit;")
async function setup({repaired=true,baseline=true}={}){
  const f=await setupAtomicEligibility({baseline})
  try{f.beforeBudgetMetadata=await metadata(f);if(repaired)await apply(f);return f}catch(error){await f.close();throw error}
}
const withFixture=async callback=>{const f=await setup();try{await callback(f)}finally{await f.close()}}
const longClient=session=>({one:sql=>session.one(sql,{timeoutMs:30000})})
const retainLease=f=>f.owner.query("update public.outlook_exchange_sync_lock set expires_at=clock_timestamp()+interval'120 seconds';")
const profile=session=>session.one("select coalesce(jsonb_agg(to_jsonb(t)order by funcname),'[]')from pg_stat_xact_user_functions t;")
const assertTwoProofs=rows=>{
  for(const name of["verify_outlook_exchange_truth_ledger","synthetic_actual_full_proof","verify_outlook_exchange_truth_ledger_without_group_smtp_guard"])
    assert.equal(rows.find(row=>row.funcname===name)?.calls,2,name)
}
async function delayActualProofs(f,seconds=5.25){
  await f.owner.query("alter function public.verify_outlook_exchange_truth_ledger()rename to synthetic_actual_full_proof;create function public.verify_outlook_exchange_truth_ledger()returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $$begin perform pg_sleep("+seconds+");return public.synthetic_actual_full_proof();end;$$;")
  assert.equal(await f.owner.one("select to_jsonb(md5(prosrc))from pg_proc where oid='public.synthetic_actual_full_proof()'::regprocedure;"),"2b7f4e4c505d047449accb9c090537d1")
}
async function lateDelay(f,seconds){
  await f.owner.query("create function private.synthetic_budget_delay()returns trigger language plpgsql as $$begin perform pg_sleep("+seconds+");return null;end;$$;create trigger zzz_synthetic_budget_delay after update on public.email_templates for each statement execute function private.synthetic_budget_delay();")
}
async function rejectedUnchanged(f,packet,session,expected,{atomicFull=false}={}){
  const before=await rollup(f),started=performance.now()
  await assert.rejects(f.commitProof(packet,{session:longClient(session),atomicFull}),expected)
  assert.deepEqual(await rollup(f),before);assert.equal(await f.owner.one("select to_jsonb(1);"),1)
  return performance.now()-started
}

test("budget migration changes only3timeouts and1elapsed literal; OID/ACL/owners/allotherguards stay exact",async()=>withFixture(async f=>{
  const after=await metadata(f)
  const targetOids=await f.owner.one("select jsonb_agg(oid::text)from pg_proc where oid in("+targets.map(signature=>literal(signature)+"::regprocedure").join(",")+");")
  assert.deepEqual(Object.keys(after).sort(),Object.keys(f.beforeBudgetMetadata).sort())
  for(const[key,before]of Object.entries(f.beforeBudgetMetadata)){
    const actual=after[key],isTarget=targetOids.includes(before.oid)
    if(!isTarget){assert.deepEqual(actual,before);continue}
    const config=before.proconfig.map(value=>value==="statement_timeout=10s"?"statement_timeout=20s":value)
    const body=before.proname==="certify_staged_outlook_truth_and_activate"?before.prosrc.replace("interval '10 seconds'","interval '20 seconds'"):before.prosrc
    assert.deepEqual(actual,{...before,proconfig:config,prosrc:body});assert.ok(actual.proconfig.includes("lock_timeout=2s"))
  }
  assert.equal(Object.keys(after).filter(key=>JSON.stringify(after[key])!==JSON.stringify(f.beforeBudgetMetadata[key])).length,3)
  const rights=await f.owner.one("select jsonb_build_object('serviceHourly',has_function_privilege('service_role',"+literal(hourly)+",'EXECUTE'),'serviceDaily',has_function_privilege('service_role',"+literal(daily)+",'EXECUTE'),'servicePrivate',has_function_privilege('service_role',"+literal(atomicSignature)+",'EXECUTE'),'anonHourly',has_function_privilege('anon',"+literal(hourly)+",'EXECUTE'),'authDaily',has_function_privilege('authenticated',"+literal(daily)+",'EXECUTE'));")
  assert.deepEqual(rights,{serviceHourly:true,serviceDaily:true,servicePrivate:false,anonHourly:false,authDaily:false})
}))

test("unknown installed body rejects entire budget migration before changing another function",async()=>{
  const f=await setup({repaired:false})
  try{
    await f.owner.query("do $$begin execute replace(pg_get_functiondef("+literal(atomicSignature)+"::regprocedure),'interval ''10 seconds''','interval ''9 seconds''');end;$$;")
    const before=await metadata(f),writer=await f.session("drifted-migration",false)
    await assert.rejects(writer.query("begin;"+source(migrationPath)+"commit;"),error=>error.code==="55000"&&/OUTLOOK_ATOMIC_BUDGET_SOURCE_DRIFT/.test(error.message))
    assert.deepEqual(await metadata(f),before)
  }finally{await f.close()}
})

test("real75snapshot/485template delayed2proof workload: old10RED, nested20cannotresetouter10, actualcaller20GREEN",async t=>{
  const f=await setup({repaired:false,baseline:false})
  try{
    const{packet,volume}=await seedRealisticActivationVolume(f);await retainLease(f);await delayActualProofs(f)
    assert.deepEqual([volume.snapshotCount,volume.ledger,volume.templates,volume.refs],[75,8630,485,1507])
    assert.ok(volume.snapshotBytes>=190000000&&volume.snapshotBytes<=200000000)
    await f.worker.query("set statement_timeout=0;")
    const oldElapsed=await rejectedUnchanged(f,packet,f.worker,error=>error.code==="57014"&&/OUTLOOK_REFRESH_ACTIVATION_TIMEOUT/.test(error.message))
    assert.ok(oldElapsed>=10000)
    await apply(f)
    const outer10=await f.session("old-outer-timer");await outer10.query("set statement_timeout='10s';")
    const outerElapsed=await rejectedUnchanged(f,packet,outer10,error=>error.code==="57014"&&/canceling statement due to statement timeout/.test(error.message)&&!/OUTLOOK_REFRESH_ACTIVATION_TIMEOUT/.test(error.message))
    assert.ok(outerElapsed>=9500&&outerElapsed<15000)
    const worker=await f.session("hoisted20-timer");await worker.query("reset role;set track_functions='all';set role service_role;begin;set local statement_timeout='20s';")
    const start=performance.now(),result=await f.commitProof(packet,{session:longClient(worker)}),elapsedMs=performance.now()-start
    assert.ok(elapsedMs>10000&&elapsedMs<20000);assert.equal(result.certified,true);assert.equal(result.atomicTemplateActivation,true)
    assert.equal(result.templateReconciliation.updatedTemplates,485)
    const calls=await profile(worker);assertTwoProofs(calls);await worker.query("commit;")
    t.diagnostic(JSON.stringify({schema:"fcuno.atomic-budget-native/v1",volume,oldElapsed,outerElapsed,elapsedMs,profile:calls,
      limits:["NativePostgreSQL17.6/syntheticvolume; identical tracked SHA/ledger/group proofs execute twice.","Only an explicit5.25s delay per genuine proof models slower hosted execution; this is not hosted timing or a memory/restart repair claim.","Outer20s models PostgREST14function-setting hoisting; a hosted realRPC still requires root verification."]}))
  }finally{await f.close()}
})

test("actual20s server timer cancels57014 and rolls back every publication/write",async()=>withFixture(async f=>{
  const packet=await f.changed();await retainLease(f);await lateDelay(f,21)
  const worker=await f.session("server20-timeout");await worker.query("set statement_timeout='20s';")
  const elapsed=await rejectedUnchanged(f,packet,worker,error=>error.code==="57014"&&/canceling statement due to statement timeout/.test(error.message)&&!/OUTLOOK_REFRESH_ACTIVATION_TIMEOUT/.test(error.message))
  assert.ok(elapsed>=19500&&elapsed<26000)
  await f.owner.query("drop trigger zzz_synthetic_budget_delay on public.email_templates;")
  assert.equal((await f.commitProof(packet,{session:await f.session("server-timeout-clean-retry")})).atomicTemplateActivation,true)
}))

test("caller timer disabled still rejects beyond20s specifically at explicit elapsed commit fence",async()=>withFixture(async f=>{
  const packet=await f.changed();await retainLease(f);await lateDelay(f,20.05)
  const worker=await f.session("explicit20-fence");await worker.query("set statement_timeout=0;")
  const elapsed=await rejectedUnchanged(f,packet,worker,error=>error.code==="57014"&&/OUTLOOK_REFRESH_ACTIVATION_TIMEOUT/.test(error.message))
  assert.ok(elapsed>=20000&&elapsed<27000)
  await f.owner.query("drop trigger zzz_synthetic_budget_delay on public.email_templates;")
  assert.equal((await f.commitProof(packet,{session:await f.session("elapsed-fence-clean-retry")})).atomicTemplateActivation,true)
}))

test("daily full wrapper permits bounded>10s activation with both genuine proofs and unchanged mode",async t=>withFixture(async f=>{
  await f.owner.query("update public.shared_addressbook_contacts set primary_email='daily@example.invalid'where id='one';")
  await f.settle(randomUUID());f.run=randomUUID();await f.acquire(f.run,"full");await retainLease(f)
  const packet=await f.packet(f.run,"full");await delayActualProofs(f)
  const worker=await f.session("daily20-timer");await worker.query("reset role;set track_functions='all';set role service_role;begin;set local statement_timeout='20s';")
  const started=performance.now(),result=await f.commitProof(packet,{atomicFull:true,session:longClient(worker)}),elapsedMs=performance.now()-started
  assert.ok(elapsedMs>10000&&elapsedMs<20000);assert.equal(result.executionMode,"full");assert.equal(result.readOnlyVerification,false)
  assert.equal(result.atomicTemplateActivation,true);assertTwoProofs(await profile(worker));await worker.query("commit;")
  t.diagnostic(JSON.stringify({dailyElapsedMs:elapsedMs}))
}))

test("canonical contention still fails at2s without publication and allows clean retry",async()=>withFixture(async f=>{
  const packet=await f.changed(),blocker=await f.session("two-second-lock-holder",false)
  await blocker.query("begin;select pg_advisory_xact_lock(hashtextextended('email_templates_canonical_write',0));")
  const worker=await f.session("two-second-lock-waiter");await worker.query("set statement_timeout='20s';")
  const elapsed=await rejectedUnchanged(f,packet,worker,error=>error.code==="55P03"&&/lock timeout/.test(error.message))
  assert.ok(elapsed>=1900&&elapsed<6000);await blocker.query("rollback;")
  assert.equal((await f.commitProof(packet,{session:await f.session("lock-clean-retry")})).atomicTemplateActivation,true)
}))

test("increased proof budget never extends an expired delivery lease",async()=>withFixture(async f=>{
  const packet=await f.changed();await lateDelay(f,0.3)
  await f.owner.query("update public.outlook_exchange_sync_lock set expires_at=clock_timestamp()+interval'0.15 seconds';")
  await rejectedUnchanged(f,packet,await f.session("expired-delivery-lease"),error=>error.code==="P0001"&&/OUTLOOK_REFRESH_LEASE_REQUIRED/.test(error.message))
}))

test("corrupt history still fails real pre-row integrity proof without renewal",async()=>withFixture(async f=>{
  const packet=await f.changed()
  await f.owner.query("update public.outlook_exchange_truth_ledger set payload_canonical_json='{}'where ledger_sequence=(select min(ledger_sequence)from public.outlook_exchange_truth_ledger);")
  await rejectedUnchanged(f,packet,await f.session("corrupt-history"),/OUTLOOK_TEMPLATE_TRUTH_UNAVAILABLE/)
}))

test("exact replay retains original certificate age and immutable receipt without writes",async()=>withFixture(async f=>{
  const packet=await f.changed(),first=await f.commitProof(packet);await f.release()
  const before=await rollup(f),replay=await f.commitProof(packet,{session:await f.session("unchanged-replay")})
  assert.equal(replay.idempotent,true);assert.equal(replay.certifiedAt,first.certifiedAt)
  assert.deepEqual(replay.templateReconciliation,first.templateReconciliation);assert.deepEqual(await rollup(f),before)
}))
