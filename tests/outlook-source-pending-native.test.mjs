import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { setupSourcePolicy, source, literal, certification } from "./fixtures/outlook-template-source-policy.mjs"
import { fn } from "./fixtures/outlook-insertion-native.mjs"

const migrationPath = "supabase/migrations/20261023042232_bound_outlook_pending_source_audit_scan.sql"
const originalBodyMd5 = "2e30cf2c5d0a4d5ec83ea91721b54fa4"
const originalFunction = fn(source("supabase/migrations/20261022040757_propagate_outlook_source_recipient_changes.sql"), "private.outlook_template_source_is_pending")
const apply = f => f.owner.query(`begin; ${source(migrationPath)} commit;`)
const metadata = f => f.owner.one(`select jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'volatile',provolatile,'securityDefiner',prosecdef,'strict',proisstrict,'parallel',proparallel,'body',prosrc)
  from pg_proc where oid='private.outlook_template_source_is_pending(text,text,uuid)'::regprocedure;`)
const withFixture = async (callback, { repaired = true } = {}) => {
  const f = await setupSourcePolicy({ sourcePendingOptimized: false })
  try {
    assert.equal(await f.owner.one("select to_jsonb(md5(prosrc)) from pg_proc where oid='private.outlook_template_source_is_pending(text,text,uuid)'::regprocedure;"), originalBodyMd5)
    await f.owner.query(originalFunction.replace("private.outlook_template_source_is_pending(", "private.synthetic_reference_source_is_pending("))
    if (repaired) await apply(f)
    await callback(f)
  } finally {
    await f.close()
    assert.equal(existsSync(join(f.data,"postmaster.pid")),false)
    assert.deepEqual(readdirSync(f.socket),[])
  }
}
const pending = (f,kind,id,run=certification) => f.owner.one(`select to_jsonb(private.outlook_template_source_is_pending(${kind===null?"null":literal(kind)},${id===null?"null":literal(id)},${literal(run)}::uuid));`)
async function parity(f, runs = [certification]) {
  for (const run of runs) for (const kind of ["contact","group","external",null]) for (const id of ["one","two","crew","other","absent",null]) {
    const args=`${kind===null?"null":literal(kind)},${id===null?"null":literal(id)},${literal(run)}::uuid`
    const result=await f.owner.one(`select jsonb_build_array(private.synthetic_reference_source_is_pending(${args}),private.outlook_template_source_is_pending(${args}));`)
    assert.deepEqual(result,[result[0],result[0]],`${kind}/${id}/${run}`)
  }
}

test("source pending optimization preserves exact function OID/ACL/settings/security and all business state",async()=>withFixture(async f=>{
  const before=await metadata(f),state=await f.state()
  await apply(f)
  const after=await metadata(f)
  assert.notEqual(after.body,before.body)
  assert.deepEqual({...after,body:before.body},before)
  assert.deepEqual(await f.state(),state)
}, {repaired:false}))

test("pending predicate rejects an unexpected installed body before any replacement or data change",async()=>withFixture(async f=>{
  await f.owner.query(`create or replace function private.outlook_template_source_is_pending(p_kind text,p_id text,p_run_id uuid)
    returns boolean language sql stable security invoker set search_path='' as $$ select true $$;`)
  const before=await metadata(f),state=await f.state(),writer=await f.session("drift-owner",false)
  await assert.rejects(writer.query(`begin; ${source(migrationPath)} commit;`),e=>e.code==="55000"&&/OUTLOOK_PENDING_SOURCE_DRIFT/.test(e.message))
  assert.deepEqual(await metadata(f),before);assert.deepEqual(await f.state(),state)
}, {repaired:false}))

test("missing certification, absent sources, null identities and unknown kinds retain original fail-closed semantics",async()=>withFixture(async f=>{
  await f.seed({contacts:[{id:"one"}],groups:[{id:"crew"}]})
  const missing="99999999-9999-4999-8999-999999999999"
  await parity(f,[certification,missing])
  assert.equal(await pending(f,"contact","one"),false)
  assert.equal(await pending(f,"group","crew"),false)
  assert.equal(await pending(f,"contact","absent"),true)
  assert.equal(await pending(f,"external","absent"),false)
  assert.equal(await pending(f,"external","one",missing),true)
}))

test("contact metadata no-ops, email/name edits and same-ID delete/restore remain equivalent to the frozen original",async()=>withFixture(async f=>{
  await f.seed({contacts:[{id:"one"},{id:"two"}],groups:[{id:"crew"}],members:[{group:"crew",contact:"one"}]})
  await f.owner.query("update public.shared_addressbook_contacts set updated_at=clock_timestamp() where id='one';")
  assert.equal(await pending(f,"contact","one"),false);await parity(f)
  await f.owner.query("update public.shared_addressbook_contacts set display_name='Changed name',primary_email='changed@example.invalid' where id='one';")
  assert.equal(await pending(f,"contact","one"),true);assert.equal(await pending(f,"group","crew"),true);await parity(f)
  const afterEdit="22222222-2222-4222-8222-222222222222";await f.certify(afterEdit)
  assert.equal(await pending(f,"contact","one",afterEdit),false);await parity(f,[certification,afterEdit])
  await f.owner.query("delete from public.shared_addressbook_contacts where id='one';")
  assert.equal(await pending(f,"contact","one",afterEdit),true);await parity(f,[certification,afterEdit])
  await f.owner.query("insert into public.shared_addressbook_contacts(id,source_book,source_card,display_name,primary_email) values('one','SYNTHETIC','restored','Restored','restored@example.invalid');")
  assert.equal(await pending(f,"contact","one",afterEdit),true);await parity(f,[certification,afterEdit])
  const restored="33333333-3333-4333-8333-333333333333";await f.certify(restored)
  assert.equal(await pending(f,"contact","one",restored),false);await parity(f,[certification,afterEdit,restored])
}))

test("group rename, member source-book edit/move/delete and member contact changes preserve both group identities",async()=>withFixture(async f=>{
  await f.seed({contacts:[{id:"one"},{id:"two"}],groups:[{id:"crew"},{id:"other"}],members:[{group:"crew",contact:"one"},{group:"other",contact:"two"}]})
  await f.owner.query("update public.shared_addressbook_groups set updated_at=clock_timestamp() where id='crew';")
  assert.equal(await pending(f,"group","crew"),false);await parity(f)
  await f.owner.query("update public.shared_addressbook_groups set name='Renamed',nickname='new-crew' where id='crew';")
  assert.equal(await pending(f,"group","crew"),true);await parity(f)
  const next="44444444-4444-4444-8444-444444444444";await f.certify(next)
  await f.owner.query("update public.shared_addressbook_group_members set group_id='other',source_book='MOVED' where group_id='crew' and contact_id='one';")
  assert.equal(await pending(f,"group","crew",next),true);assert.equal(await pending(f,"group","other",next),true);await parity(f,[certification,next])
  const moved="55555555-5555-4555-8555-555555555555";await f.certify(moved)
  await f.owner.query("update public.shared_addressbook_contacts set primary_email='new-member@example.invalid' where id='one';")
  assert.equal(await pending(f,"group","other",moved),true);assert.equal(await pending(f,"group","crew",moved),false);await parity(f,[next,moved])
  await f.owner.query("delete from public.shared_addressbook_group_members where group_id='other' and contact_id='one';")
  await parity(f,[certification,next,moved])
}))

test("unlinked audit rows and non-source-change ledger events cannot taint a certified source",async()=>withFixture(async f=>{
  await f.seed({contacts:[{id:"one"}],groups:[{id:"crew"}],members:[{group:"crew",contact:"one"}]})
  await f.owner.query(`insert into public.audit_logs(table_schema,table_name,operation,record_pk,changed_fields)
    values('public','shared_addressbook_contacts','UPDATE','{"id":"one"}',array['primary_email']);`)
  await f.owner.query(`select public.append_outlook_exchange_truth_event('synthetic-non-source','source_undo_annotation',clock_timestamp(),null,(select id from public.audit_logs order by occurred_at desc limit 1),null,null,'{}');`)
  assert.equal(await pending(f,"contact","one"),false);assert.equal(await pending(f,"group","crew"),false);await parity(f)
}))

test("69k wide audits and8558 prior source events:778 actual predicate calls stay bounded and preserve reference results",{timeout:90000},async()=>withFixture(async f=>{
  await f.seed({contacts:[{id:"one"}],groups:[{id:"crew"}],members:[{group:"crew",contact:"one"}]})
  await f.owner.query(`insert into public.audit_logs(id,table_schema,table_name,operation,record_pk,changed_fields,before_row,after_row)
    select gen_random_uuid(),'public',case when g%3=0 then 'shared_addressbook_groups' when g%3=1 then 'shared_addressbook_contacts' else 'shared_addressbook_group_members' end,
      'UPDATE',jsonb_build_object('id',case when g%3=0 then 'crew' else 'one' end,'group_id','crew'),
      case when g%3=0 then array['name'] when g%3=1 then array['primary_email'] else array['contact_id'] end,
      jsonb_build_object('group_id','crew','syntheticWide',repeat(md5(g::text),32)),jsonb_build_object('syntheticWide',repeat(md5((g+1)::text),32))
    from generate_series(1,69000)g;`)
  // Real immutable SHA writer/ledger links, synthetic historical metadata only.
  for(let offset=0;offset<8558;offset+=500)await f.owner.query(`do $$ declare a record;begin
    for a in select id from public.audit_logs order by id offset ${offset} limit ${Math.min(500,8558-offset)} loop
      perform public.append_outlook_exchange_truth_event('synthetic-history:'||a.id::text,'source_change',clock_timestamp(),null,a.id,null,null,'{}');
    end loop;end;$$;`)
  const current="66666666-6666-4666-8666-666666666666";await f.certify(current)
  await f.owner.query("analyze public.audit_logs;analyze public.outlook_exchange_truth_ledger;")
  const size=await f.owner.one("select jsonb_build_object('audits',(select count(*)from public.audit_logs),'sourceEvents',(select count(*)from public.outlook_exchange_truth_ledger where event_type='source_change'));")
  assert.ok(size.audits>=69000);assert.ok(size.sourceEvents>=8558)
  const calls=name=>`select to_jsonb(count(*)filter(where private.${name}(case when g%2=0 then 'group' else 'contact' end,case when g%2=0 then 'crew' else 'one' end,${literal(current)}::uuid))) from generate_series(1,778)g;`
  const old=await f.session("bounded-reference-benchmark",false)
  await old.query("set statement_timeout='8s';")
  const startOld=performance.now();let baselineMs,baselineTimedOut=false
  try{assert.equal(await old.one(calls('synthetic_reference_source_is_pending')),0)}catch(e){assert.equal(e.code,'57014');baselineTimedOut=true}finally{baselineMs=performance.now()-startOld}
  const startNew=performance.now();assert.equal(await f.owner.one(calls('outlook_template_source_is_pending')),0);const optimizedMs=performance.now()-startNew
  console.log(JSON.stringify({sourcePendingBenchmark:{...size,calls:778,baselineMs,baselineTimedOut,optimizedMs,globalVerifier:'not invoked;actual pending predicate and real linked SHA ledger only'}}))
  assert.ok(optimizedMs<3000,`778 guarded source checks exceeded3s: ${optimizedMs}`)
  assert.ok(baselineTimedOut||optimizedMs<baselineMs/2,`expected a measured improvement;old=${baselineMs},new=${optimizedMs}`)
}))
