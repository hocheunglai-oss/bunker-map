import assert from "node:assert/strict"
import test from "node:test"
import {performance}from"node:perf_hooks"
import { setupAtomicEligibility, atomicSignature, helperSignature, randomUUID, literal, json, source, migrationPath } from "./fixtures/outlook-atomic-eligibility-native.mjs"
import {seedRealisticActivationVolume}from"./fixtures/outlook-atomic-eligibility-volume.mjs"

const withFixture = async callback => {const f=await setupAtomicEligibility();try{await callback(f)}finally{await f.close()}}
const parity = async f => assert.equal(await f.hint(),(await f.refresh()).mode==="full")

test("realistic75snapshot/27MBledger/485template workload runs both actual full-history proofs under the unchanged10s transaction fence",async t=>{
  const f=await setupAtomicEligibility({baseline:false})
  try{
    const{packet,volume}=await seedRealisticActivationVolume(f)
    assert.deepEqual([volume.contacts,volume.groups,volume.members,volume.templates,volume.refs,volume.toRefs,volume.ccRefs,volume.bccRefs,volume.htmlBytes,volume.textBytes,volume.snapshotCount,volume.ledger],[3461,359,1155,485,1507,469,305,733,5422514,5062489,75,8630])
    assert.ok(volume.snapshotBytes>=190000000&&volume.snapshotBytes<=200000000)
    assert.ok(volume.ledgerPayloadBytes>=27000000&&volume.ledgerPayloadBytes<=29000000)
    await f.worker.query("reset role;set track_functions='all';set role service_role;begin;set local statement_timeout='10s';")
    const start=performance.now(),result=await f.commitProof(packet),elapsedMs=performance.now()-start
    assert.equal(result.certified,true);assert.equal(result.atomicTemplateActivation,true)
    assert.equal(result.templateReconciliation.updatedTemplates,485)
    assert.equal(result.templateReconciliation.verification.exchangeTruth.snapshots,75)
    assert.equal(result.templateReconciliation.verification.valid,true)
    const profile=await f.worker.one("select coalesce(jsonb_agg(to_jsonb(p)order by total_time desc),'[]')from pg_stat_xact_user_functions p;")
    assert.equal(profile.find(p=>p.funcname==="verify_outlook_exchange_truth_ledger").calls,2)
    assert.equal(profile.find(p=>p.funcname==="verify_outlook_exchange_truth_ledger_without_group_smtp_guard").calls,2)
    await f.worker.query("commit;")
    t.diagnostic(JSON.stringify({schema:"fcuno.atomic-eligibility-realistic-native/v1",volume,elapsedMs,profile,limits:["Genuine nativePostgreSQL17.6/synthetic data; external Exchange values and payload distribution not production data.","All snapshot/ledger/reference/groupSMTP validators and row/audit/version/backup guards are real tracked source.","Built-in PostgreSQL SHA256 supplies identical digest bytes; pgcrypto extension implementation timing is not reproduced.","Local unchanged10s gate passed; this does not establish hosted10s success or a production certificate."]}))
  }finally{await f.close()}
})

test("hourly commit retains exactly two actual full-history verifications, before and after template rows",async()=>withFixture(async f=>{
  const packet=await f.changed()
  await f.worker.query("reset role;set track_functions='all';set role service_role;begin;")
  const result=await f.commitProof(packet)
  assert.equal(result.atomicTemplateActivation,true)
  assert.equal(result.templateReconciliation.verification.valid,true)
  const calls=await f.worker.one("select to_jsonb(calls)from pg_stat_xact_user_functions where funcid='public.verify_outlook_exchange_truth_ledger()'::regprocedure;")
  assert.equal(calls,2)
  await f.worker.query("commit;")
  assert.equal((await f.template("template")).recipient_resolution.refs.to[0].resolvedAddress,"changed@example.invalid")
}))

test("atomic OID/ACL/config stay exact and public getter plus both original full guards are byte unchanged",async()=>withFixture(async f=>{
  const after=await f.metadata()
  for(const[name,before]of Object.entries(f.beforeMetadata)){
    const actual=after[name]
    if(name===f.atomicMetadataKey){assert.notEqual(actual.body,before.body);assert.deepEqual({...actual,body:before.body},before)}
    else assert.deepEqual(actual,before)
  }
  assert.equal(await f.owner.one(`select to_jsonb(has_function_privilege('service_role','${helperSignature}','EXECUTE'));`),false)
  for(const role of["anon","authenticated","service_role"]){
    const client=await f.session("private-hint-"+role,false);await client.query(`set role ${role};`)
    await assert.rejects(f.hint(randomUUID(),client),/permission denied/)
  }
}))

test("no-change and reconcile-only work cannot mint a fresh certificate",async()=>withFixture(async f=>{
  await f.acquire();await parity(f);assert.equal(await f.hint(),false)
  await f.rejectUnchanged(await f.packet(),/OUTLOOK_REFRESH_NOT_NEEDED/)
  // Stored recipient staleness alone still requests reconciliation, not a new
  // Exchange certification or an extension of its age.
  await f.owner.query(`alter table public.email_templates disable trigger user;
    update public.email_templates set recipient_resolution=jsonb_set(recipient_resolution,'{certificationRunId}',to_jsonb('${randomUUID()}'::text));
    alter table public.email_templates enable trigger user;`)
  assert.equal((await f.refresh()).mode,"reconcile");await parity(f)
  await f.rejectUnchanged(await f.packet(),/OUTLOOK_REFRESH_NOT_NEEDED/)
}))

test("a healthy rejected queue fence returns the original non-certified response without mutation",async()=>withFixture(async f=>{
  const packet=await f.changed(),wrong={...packet,fence:{...packet.fence,sequence:packet.fence.sequence+1}}
  const before=await f.completeState(),result=await f.commitProof(wrong)
  assert.equal(result.certified,false);assert.equal(result.evidenceRecorded,false)
  assert.match(result.reason,/fence|high-water/i);assert.deepEqual(await f.completeState(),before)
}))

for(const [label,sql]of[
  ["hash","update public.outlook_exchange_truth_ledger set payload_canonical_json='{}'where ledger_sequence=(select min(ledger_sequence)from public.outlook_exchange_truth_ledger);"],
  ["snapshot","update public.outlook_exchange_truth_snapshots set canonical_json=replace(canonical_json,'One','Two')where snapshot_kind='fcuno_raw';"]
]){
  test(`corrupt old ${label} retains the original integrity rejection even on a non-certified queue-fence return`,async()=>withFixture(async f=>{
    const packet=await f.changed(),wrong={...packet,fence:{...packet.fence,sequence:packet.fence.sequence+1}}
    await f.owner.query(sql);await f.rejectUnchanged(wrong,/OUTLOOK_REFRESH_TRUTH_INVALID/)
  }))
  test(`corrupt old ${label} retains the original integrity rejection even when metadata says no work`,async()=>withFixture(async f=>{
    await f.acquire();const packet=await f.packet();await f.owner.query(sql)
    await f.rejectUnchanged(packet,/OUTLOOK_REFRESH_TRUTH_INVALID/)
  }))
}

test("bound updates and prior unbound completed delivery use the same real source and queue fences",async()=>withFixture(async f=>{
  const packet=await f.changed();await parity(f);assert.equal(await f.hint(),true)
  const result=await f.commitProof(packet);assert.equal(result.certified,true)
  await f.release();f.run=randomUUID();await f.acquire();await parity(f);assert.equal(await f.hint(),false)
  await f.owner.query("insert into public.shared_addressbook_contacts(id,source_book,source_card,display_name,primary_email)values('unbound','SYNTHETIC','unbound','Unbound','unbound@example.invalid');")
  await f.settle(randomUUID());await parity(f);assert.equal(await f.hint(),true)
  assert.ok((await f.refresh()).reasons.includes("delivery-awaiting-verification"))
}))

test("queued work and a mismatching or expired lease remain fail closed",async()=>withFixture(async f=>{
  await f.acquire();await f.owner.query("update public.shared_addressbook_contacts set primary_email='pending@example.invalid'where id='one';")
  await parity(f);assert.equal(await f.hint(),false)
  await f.rejectUnchanged(await f.packet(),/OUTLOOK_REFRESH_QUEUE_NOT_SETTLED/)
  await assert.rejects(f.hint(randomUUID(),await f.session("wrong-lease-reader",false)),/OUTLOOK_REFRESH_LEASE_REQUIRED/)
  await f.owner.query("update public.outlook_exchange_sync_lock set expires_at=clock_timestamp()-interval'1 second';")
  await assert.rejects(f.hint(),/OUTLOOK_REFRESH_LEASE_REQUIRED/)
}))

const rehash = async f => f.owner.query(`do $$declare row_value record; previous text:=null; material text;begin
  for row_value in select * from public.outlook_exchange_truth_ledger order by ledger_sequence loop
    material:=public.outlook_exchange_truth_hash_material(row_value.ledger_sequence,row_value.entry_id,row_value.event_key,row_value.event_type,
      row_value.occurred_at_canonical,row_value.run_id,row_value.audit_log_id,row_value.queue_row_id,row_value.snapshot_sha256,previous,
      public.outlook_exchange_truth_sha256(row_value.payload_canonical_json));
    update public.outlook_exchange_truth_ledger set previous_entry_sha256=previous,
      payload_sha256=public.outlook_exchange_truth_sha256(row_value.payload_canonical_json),hash_material=material,
      entry_sha256=public.outlook_exchange_truth_sha256(material)where ledger_sequence=row_value.ledger_sequence;
    previous:=public.outlook_exchange_truth_sha256(material);
  end loop;end;$$;`)

for(const [label,change]of[
  ["unsupported historical worker",`payload_canonical_json=jsonb_set(payload_canonical_json::jsonb,'{workerVersion}','"fcuno-exchange-runbook/2026-07-23.2"')::text`],
  ["missing matching projection event",`event_type='synthetic_non_projection'`]
]){
  test(`${label} requests a real new full verification without pretending the old map is current`,async()=>withFixture(async f=>{
    await f.acquire()
    await f.owner.query(`update public.outlook_exchange_truth_ledger set ${change} where event_key=${literal("projection:"+f.baselineProof.result.runId)};`)
    await rehash(f);await parity(f);assert.equal(await f.hint(),true)
    assert.equal((await f.refresh()).mode,"full")
    const result=await f.commitProof(await f.packet());assert.equal(result.atomicTemplateActivation,true)
  }))
}

test("equal certification times retain the original legacy/global and getter tie-selection semantics",async()=>withFixture(async f=>{
  const run="ffffffff-ffff-4fff-8fff-ffffffffffff"
  await f.owner.query(`insert into public.outlook_exchange_sync_certifications select (jsonb_populate_record(null::public.outlook_exchange_sync_certifications,to_jsonb(c)||jsonb_build_object('run_id',${literal(run)}))).* from public.outlook_exchange_sync_certifications c limit 1;
    select public.append_outlook_exchange_truth_event('tie-certification','full_certification',clock_timestamp(),${literal(run)}::uuid,null,null,null,'{}');
    select public.append_outlook_exchange_truth_event(${literal("projection:"+run)},'full_projection_evidence',clock_timestamp(),${literal(run)}::uuid,null,null,${literal(f.baselineProof.result.sourceFingerprint)},'{"workerVersion":"fcuno-exchange-runbook/2026-07-23.2"}');`)
  await f.acquire()
  // Either original legacy tie winner requires full verification: one differs
  // from the getter's highest UUID; the other has an unsupported worker. The
  // private hint refuses to guess and invokes the unchanged getter fallback.
  assert.equal(await f.hint(),false);assert.equal((await f.refresh()).mode,"full")
  assert.equal((await f.commitProof(await f.packet())).atomicTemplateActivation,true)
}))

test("invalid latest group SMTP requests genuine full repair while exact live historical snapshot rules stay unchanged",async()=>withFixture(async f=>{
  const run=randomUUID()
  await f.owner.query(`do $$declare c public.outlook_exchange_sync_certifications%rowtype;projection jsonb;counts jsonb;canonical text;hash text;begin
    select * into c from public.outlook_exchange_sync_certifications order by certified_at desc limit 1;
    select canonical_json::jsonb,item_counts into projection,counts from public.outlook_exchange_truth_snapshots where snapshot_sha256=c.source_fingerprint;
    projection:=jsonb_set(projection,'{groups}','[{"sourceGroupId":"bad","groupName":"Bad","alias":"UPPER","smtpAddress":"upper@cosulich1.onmicrosoft.com","memberCount":1}]'::jsonb);
    counts:=jsonb_set(counts,'{groups}','1');canonical:=projection::text;hash:=public.outlook_exchange_truth_sha256(canonical);
    insert into public.outlook_exchange_truth_snapshots(snapshot_sha256,snapshot_kind,canonical_json,byte_length,item_counts)values(hash,'fcuno_exchange_projection',canonical,octet_length(canonical),counts);
    insert into public.outlook_exchange_sync_certifications select(jsonb_populate_record(null::public.outlook_exchange_sync_certifications,to_jsonb(c)||jsonb_build_object('run_id',${literal(run)},'source_fingerprint',hash,'certified_at',clock_timestamp()))).*;
    perform public.append_outlook_exchange_truth_event(${literal("bad-smtp-cert:"+run)},'full_certification',clock_timestamp(),${literal(run)}::uuid,null,null,hash,'{}');
    perform public.append_outlook_exchange_truth_event(${literal("projection:"+run)},'full_projection_evidence',clock_timestamp(),${literal(run)}::uuid,null,null,hash,'{"workerVersion":"fcuno-exchange-runbook/2026-10-22.2"}');
    end;$$;`)
  await f.acquire();await parity(f);assert.equal(await f.hint(),true)
  const truth=await f.owner.one("select public.verify_outlook_exchange_truth_ledger();")
  assert.equal(truth.integrityValid,true);assert.equal(truth.groupSmtpTruthValid,false)
  const result=await f.commitProof(await f.packet())
  assert.equal(result.atomicTemplateActivation,true);assert.equal(result.templateReconciliation.verification.valid,true)
}))

test("a malformed prior activation fence still rejects even when another source update already requires full work",async()=>withFixture(async f=>{
  const packet=await f.changed(),run=f.baselineProof.result.runId
  await f.owner.query(`select public.append_outlook_exchange_truth_event(${literal("template-activation:"+run)},'template_recipient_activation',clock_timestamp(),${literal(run)}::uuid,null,null,${literal(f.baselineProof.result.sourceFingerprint)},'{}');`)
  await assert.rejects(f.refresh(),/atomic activation queue receipt is malformed/)
  await f.rejectUnchanged(packet,/atomic activation queue receipt is malformed/)
}))

test("a late audit-writer failure rolls back certificate, ledger, templates, revisions and backup epochs",async()=>withFixture(async f=>{
  const packet=await f.changed()
  await f.owner.query(`create function private.synthetic_audit_failure()returns trigger language plpgsql as $$begin
    if new.table_name='email_templates'then raise exception 'SYNTHETIC_ACTUAL_AUDIT_WRITER_FAILURE';end if;return new;end;$$;
    create trigger synthetic_audit_failure before insert on public.audit_logs for each row execute function private.synthetic_audit_failure();`)
  await f.rejectUnchanged(packet,/SYNTHETIC_ACTUAL_AUDIT_WRITER_FAILURE/)
}))

test("corruption introduced after template rows is caught by the unchanged final full-history proof",async()=>withFixture(async f=>{
  const packet=await f.changed()
  await f.owner.query(`create function private.synthetic_late_history_corruption()returns trigger language plpgsql security definer as $$begin
    update public.outlook_exchange_truth_ledger set payload_canonical_json='{}'where ledger_sequence=(select min(ledger_sequence)from public.outlook_exchange_truth_ledger);return null;end;$$;
    create trigger zz_synthetic_late_history_corruption after update on public.email_templates for each statement execute function private.synthetic_late_history_corruption();`)
  await f.rejectUnchanged(packet,/Outlook template recipient evidence did not settle/)
}))

test("exact replay returns the original activation receipt without new proof, writes or certificate age",async()=>withFixture(async f=>{
  const packet=await f.changed(),first=await f.commitProof(packet)
  await f.release();const before=await f.completeState(),replay=await f.commitProof(packet)
  assert.equal(replay.idempotent,true);assert.equal(replay.certifiedAt,first.certifiedAt)
  assert.deepEqual(replay.templateReconciliation,first.templateReconciliation)
  assert.deepEqual(await f.completeState(),before)
}))

test("24h proactive renewal and unchanged 36h acceptance match the actual public getter",async()=>withFixture(async f=>{
  await f.acquire()
  for(const age of["23 hours 59 minutes","24 hours","35 hours 59 minutes","36 hours 1 minute","-6 minutes"]){
    await f.owner.query(`update public.outlook_exchange_sync_certifications set certified_at=clock_timestamp()-interval ${literal(age)};`)
    await parity(f)
    assert.equal(await f.hint(),age!=="23 hours 59 minutes")
  }
}))

for(const [label,eventType,runMatches]of[["same incoming run","full_certification",true],["other run","full_certification",false],["legacy incoming run","legacy_full_certification",true]]){
  test(`a SHA-valid historical dangling certification (${label}) cannot be healed by provisional insertion`,async()=>withFixture(async f=>{
    const packet=await f.changed(),dangling=runMatches?f.run:randomUUID()
    await f.owner.query(`select public.append_outlook_exchange_truth_event(${literal("dangling:"+dangling)},${literal(eventType)},clock_timestamp(),${literal(dangling)}::uuid,null,null,null,'{}');`)
    await assert.rejects(f.refresh(),/OUTLOOK_REFRESH_TRUTH_INVALID/)
    await f.rejectUnchanged(packet,/OUTLOOK_REFRESH_TRUTH_INVALID/)
  }))
}

for(const [kind,args]of[["audit",`${literal(randomUUID())}::uuid,null`],["queue",`null,${literal(randomUUID())}::uuid`]]){
  test(`missing historical ${kind} references are rejected before all provisional writes`,async()=>withFixture(async f=>{
    const packet=await f.changed()
    await f.owner.query(`select public.append_outlook_exchange_truth_event(${literal("dangling-"+kind)},'run_status',clock_timestamp(),null,${args},null,'{}');`)
    await assert.rejects(f.refresh(),/OUTLOOK_REFRESH_TRUTH_INVALID/)
    await f.rejectUnchanged(packet,/OUTLOOK_REFRESH_TRUTH_INVALID/)
  }))
}

test("orphan historical certification cannot be hidden by a newer valid certificate",async()=>withFixture(async f=>{
  const packet=await f.changed()
  await f.owner.query(`insert into public.outlook_exchange_sync_certifications select (jsonb_populate_record(null::public.outlook_exchange_sync_certifications,to_jsonb(c)||jsonb_build_object('run_id',${literal(randomUUID())},'certified_at',c.certified_at-interval'1 day'))).* from public.outlook_exchange_sync_certifications c limit 1;`)
  await assert.rejects(f.refresh(),/OUTLOOK_REFRESH_TRUTH_INVALID/)
  await f.rejectUnchanged(packet,/OUTLOOK_REFRESH_TRUTH_INVALID/)
}))

for(const [kind,sql]of[
  ["payload hash","update public.outlook_exchange_truth_ledger set payload_canonical_json='{}'where ledger_sequence=(select min(ledger_sequence)from public.outlook_exchange_truth_ledger);"],
  ["entry hash","update public.outlook_exchange_truth_ledger set entry_sha256=repeat('f',64)where ledger_sequence=(select min(ledger_sequence)from public.outlook_exchange_truth_ledger);"],
  ["snapshot hash","update public.outlook_exchange_truth_snapshots set canonical_json=replace(canonical_json,'One','Two')where snapshot_kind='fcuno_raw';"]
]){
  test(`old ${kind} corruption fails the unchanged pre-row whole-history proof and rolls everything back`,async()=>withFixture(async f=>{
    const packet=await f.changed();await f.owner.query(sql)
    await assert.rejects(f.refresh(),/OUTLOOK_REFRESH_TRUTH_INVALID/)
    await f.rejectUnchanged(packet,/OUTLOOK_TEMPLATE_TRUTH_UNAVAILABLE/)
  }))
}

test("migration rejects installed-source drift before creating the private hint or changing any existing function",async()=>{
  const f=await setupAtomicEligibility({apply:false})
  try{
    await f.owner.query(`alter function ${atomicSignature}rename to synthetic_original_atomic;
      create function ${atomicSignature.replace(/\([^]*$/,"(p_mode text,p_run uuid,p_seq bigint,p_at timestamptz,p_fp text,p_raw text,p_pc jsonb,p_rc jsonb,p_summary jsonb,p_worker text)")}
      returns jsonb language sql as $$select '{}'::jsonb$$;`)
    const before=await f.metadata()
    await assert.rejects(f.owner.query(`begin;${source(migrationPath)}commit;`),/OUTLOOK_ATOMIC_REFRESH_SOURCE_DRIFT/)
    const reader=await f.session("drift-inspector",false)
    assert.equal(await reader.one(`select to_jsonb(to_regprocedure('${helperSignature}')is null);`),true)
    // The failed migration's transaction and session are discarded, not reused.
    assert.equal(before[f.atomicMetadataKey].body.length,32)
  }finally{await f.close()}
})
