import assert from "node:assert/strict"
import test from "node:test"
import { setupHourlyVerification, randomUUID, literal, publicRefreshRpcNames } from "./fixtures/outlook-hourly-verification-native.mjs"
import { ref, source } from "./fixtures/outlook-template-source-policy.mjs"
import { waitForBlock } from "./fixtures/native-postgres-ccinfo.mjs"

const withFixture = async callback => { const f = await setupHourlyVerification(); try { await callback(f) } finally { await f.close() } }
const bound = id => ({ id, refs:{to:[ref("one")]} })
const rejectProof = async (f,packet,pattern) => assert.rejects(f.commitProof(packet,{session:await f.session("rejected-proof")}),pattern)

test("every public RPC spelling is UTF8-safe and new refresh endpoints match exact catalog names, not silently truncated identifiers",async()=>withFixture(async f=>{
  const names=new Set(Object.values(publicRefreshRpcNames))
  for(const path of ["tests/fixtures/outlook-hourly-verification-native.mjs","tests/outlook-hourly-verification-native.test.mjs"]) {
    for(const match of source(path).matchAll(/public\.([a-z][a-z0-9_]*)\(/g)) names.add(match[1])
  }
  for(const name of names) assert.ok(Buffer.byteLength(name,"utf8")<=63,`PostgREST RPC name would be truncated: ${name}`)
  const expected=Object.values(publicRefreshRpcNames).sort()
  const actual=await f.owner.one(`select jsonb_agg(p.proname order by p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (${expected.map(literal).join(',')});`)
  assert.deepEqual(actual,expected)
  const historicalLong="certify_staged_full_outlook_exchange_truth_and_activate_"+"templates"
  assert.ok(Buffer.byteLength(historicalLong,"utf8")>63)
  assert.equal(await f.owner.one(`select to_jsonb(count(*)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (${literal(historicalLong)},${literal(historicalLong.slice(0,63))});`),0)
}))

test("settled zero-change hour with a current certificate does no work and exposes no contact identities",async()=>withFixture(async f=>{
  await f.baseline({templates:[bound("template")]})
  assert.equal(await f.acquire(),true)
  const before=await f.proofState(), state=await f.refresh()
  assert.equal(state.schema,"fcuno.outlook-template-recipient-refresh-state/v1")
  assert.equal(state.runId,f.run); assert.equal(state.executionMode,"incremental"); assert.equal(state.verificationScope,"full")
  assert.equal(state.mode,"none"); assert.equal(state.queueSettled,true); assert.deepEqual(state.reasons,[])
  assert.doesNotMatch(JSON.stringify(state),/example\.invalid|"sourceId"|"refs"|body_html/)
  assert.deepEqual(await f.proofState(),before)
}))

test("missing certificate requests genuine full verification and retains incremental execution metadata",async()=>withFixture(async f=>{
  assert.equal(await f.acquire(),true)
  const state=await f.refresh()
  assert.equal(state.mode,"full"); assert.deepEqual(state.reasons,["certification-missing"])
  const packet=await f.packet(), result=await f.commitProof(packet)
  assert.equal(result.certified,true); assert.equal(result.executionMode,"incremental"); assert.equal(result.verificationScope,"full"); assert.equal(result.readOnlyVerification,true)
  assert.equal(result.atomicTemplateActivation,true); assert.equal(result.templateReconciliation.reconciled,true)
  const proof=await f.proofState()
  assert.equal(proof.certifications.length,1); assert.equal(proof.certifications[0].sync_mode,"full")
  const projection=proof.ledger.find(row=>row.event_key===`projection:${f.run}`)
  assert.deepEqual(JSON.parse(projection.payload_canonical_json).verificationSummary,packet.summary)
  const lease=await f.owner.one("select to_jsonb(l) from public.outlook_exchange_sync_lock l;")
  assert.equal(lease.sync_mode,"incremental"); assert.equal(lease.run_id,f.run)
}))

test("next zero-delivery run recovers an edited source after prior completed delivery but failed verification",async()=>withFixture(async f=>{
  await f.baseline({templates:[bound("template")]})
  await f.owner.query("update public.shared_addressbook_contacts set primary_email='new@example.invalid' where id='one';")
  f.run=randomUUID(); await f.acquire()
  let state=await f.refresh()
  assert.equal(state.mode,"none"); assert.equal(state.queueSettled,false); assert.deepEqual(state.reasons,["queue-not-settled"])
  await f.settle(randomUUID())
  assert.equal((await f.owner.one(`select to_jsonb(count(*)) from public.outlook_exchange_sync_queue where run_id=${literal(f.run)}::uuid and status='completed';`)),0)
  state=await f.refresh(); assert.equal(state.mode,"full"); assert.ok(state.reasons.includes("source-updated"))
  const packet=await f.packet(), result=await f.commitProof(packet)
  assert.equal(result.certified,true)
  await f.setCurrentTruth(result)
  await f.reconcile(result.runId,result.sourceFingerprint)
  assert.equal((await f.refresh()).mode,"none")
  const row=await f.template("template")
  assert.equal(row.recipient_resolution.refs.to[0].sourceId,"one")
  assert.equal(row.recipient_resolution.refs.to[0].resolvedAddress,"new@example.invalid")
}))

test("successful current-run delivery refreshes even an unbound contact exactly once",async()=>withFixture(async f=>{
  await f.baseline({templates:[bound("template")]})
  await f.owner.query("insert into public.shared_addressbook_contacts(id,source_book,source_card,display_name,primary_email) values('unbound','SYNTHETIC','unbound','Unbound','unbound@example.invalid');")
  await f.acquire(); await f.settle()
  const state=await f.refresh()
  assert.equal(state.mode,"full"); assert.deepEqual(state.reasons,["delivery-completed","delivery-awaiting-verification"])
  const result=await f.commitProof(await f.packet())
  assert.equal(result.atomicTemplateActivation,true)
  assert.equal((await f.refresh()).mode,"none")
  await f.release(); f.run=randomUUID(); await f.acquire()
  assert.equal((await f.refresh()).mode,"none")
}))

test("zero-delivery next hour recovers prior unbound delivery; certification never changes its own settled queue fence",async()=>withFixture(async f=>{
  await f.baseline({templates:[bound("template")]})
  await f.owner.query("insert into public.shared_addressbook_contacts(id,source_book,source_card,display_name,primary_email) values('unbound','SYNTHETIC','unbound','Unbound','unbound@example.invalid');")
  await f.settle(randomUUID()); f.run=randomUUID(); await f.acquire()
  const state=await f.refresh()
  assert.equal(state.mode,"full"); assert.deepEqual(state.reasons,["delivery-awaiting-verification"])
  const fence=await f.fence(), queue=await f.owner.one("select jsonb_agg(to_jsonb(q) order by queue_sequence) from public.outlook_exchange_sync_queue q;")
  const result=await f.commitProof(await f.packet())
  assert.equal(result.atomicTemplateActivation,true)
  assert.deepEqual(await f.fence(),fence)
  assert.deepEqual(await f.owner.one("select jsonb_agg(to_jsonb(q) order by queue_sequence) from public.outlook_exchange_sync_queue q;"),queue)
  await f.release(); f.run=randomUUID(); await f.acquire()
  assert.equal((await f.refresh()).mode,"none")
}))

test("metadata-only source no-op does not change the outbox fence or request another full verification",async()=>withFixture(async f=>{
  await f.baseline({templates:[bound("template")]})
  await f.acquire()
  const before=await f.fence(), proof=await f.proofState()
  await f.owner.query("update public.shared_addressbook_contacts set updated_at=clock_timestamp() where id='one';")
  assert.deepEqual(await f.fence(),before)
  assert.deepEqual(await f.proofState(),proof)
  assert.equal((await f.refresh()).mode,"none")
}))

test("daily full activation supersedes only original terminal failures, records its own final fence, and never loops next hour",async()=>withFixture(async f=>{
  await f.baseline({templates:[bound("template")]})
  await f.owner.query("update public.shared_addressbook_contacts set primary_email='daily@example.invalid' where id='one'; update public.outlook_exchange_sync_queue set status='failed',next_attempt_at=null,error_message='Synthetic terminal delivery failure' where status='pending';")
  f.run=randomUUID(); await f.acquire(f.run,"full")
  const packet=await f.packet(f.run,"full"), beforeFence=await f.fence()
  const result=await f.commitProof(packet,{atomicFull:true})
  assert.equal(result.certified,true); assert.equal(result.executionMode,"full"); assert.equal(result.readOnlyVerification,false)
  assert.equal(result.atomicTemplateActivation,true); assert.ok(result.supersededCount>0)
  const afterFence=await f.fence()
  assert.notDeepEqual(afterFence,beforeFence)
  const proof=await f.proofState(), cert=proof.certifications.find(c=>c.run_id===f.run)
  assert.equal(cert.queue_high_water_sequence,beforeFence.sequence)
  assert.equal(new Date(cert.queue_high_water_updated_at).toISOString(),new Date(beforeFence.updatedAt).toISOString())
  const activation=JSON.parse(proof.ledger.find(l=>l.event_key===`template-activation:${f.run}`).payload_canonical_json)
  assert.deepEqual(activation.postActivationQueueFence,{sequence:afterFence.sequence,updatedAt:afterFence.updatedAt})
  assert.equal(activation.executionMode,"full")
  const row=await f.template("template")
  assert.equal(row.recipient_resolution.refs.to[0].resolvedAddress,"daily@example.invalid")
  await f.release(); f.run=randomUUID(); await f.acquire()
  assert.equal((await f.refresh()).mode,"none")
  await f.owner.query("insert into public.shared_addressbook_contacts(id,source_book,source_card,display_name,primary_email) values('after-daily','SYNTHETIC','after-daily','After daily','later@example.invalid');")
  await f.settle(randomUUID())
  assert.equal((await f.refresh()).mode,"full")
}))

test("daily full wrapper preserves original rejection of active pending queue rows and exact full-mode lease",async()=>withFixture(async f=>{
  await f.baseline({templates:[bound("template")]})
  await f.owner.query("update public.shared_addressbook_contacts set primary_email='daily@example.invalid' where id='one';")
  const packet=await f.packet(f.run,"full"), before=await f.state(), beforeProof=await f.proofState()
  await assert.rejects(f.commitProof(packet,{atomicFull:true,session:await f.session("daily-no-lease")}),/OUTLOOK_REFRESH_LEASE_REQUIRED/)
  await f.acquire()
  await assert.rejects(f.commitProof(packet,{atomicFull:true,session:await f.session("daily-wrong-lease")}),/OUTLOOK_REFRESH_LEASE_REQUIRED/)
  await f.release(); await f.acquire(f.run,"full")
  const rejected=await f.commitProof(packet,{atomicFull:true})
  assert.equal(rejected.certified,false); assert.match(rejected.reason,/active or retryable queue row/)
  assert.deepEqual(await f.state(),before); assert.deepEqual(await f.proofState(),beforeProof)
}))

test("daily full late activation failure and exact replay have the same atomic rollback and no-TTL-reset contract",async()=>withFixture(async f=>{
  await f.baseline({templates:[bound("template")]})
  await f.owner.query("update public.shared_addressbook_contacts set primary_email='daily@example.invalid' where id='one';")
  await f.settle(randomUUID()); f.run=randomUUID(); await f.acquire(f.run,"full")
  const packet=await f.packet(f.run,"full"), before=await f.state(), beforeProof=await f.proofState()
  await f.owner.query(`create function private.synthetic_reject_daily_activation() returns trigger language plpgsql as $$ begin
    if new.recipient_resolution->>'certificationRunId'=${literal(f.run)} then raise exception 'SYNTHETIC_DAILY_ACTIVATION_REJECTED';end if;return new;end;$$;
    create trigger zz_synthetic_reject_daily_activation after update on public.email_templates for each row execute function private.synthetic_reject_daily_activation();`)
  await assert.rejects(f.commitProof(packet,{atomicFull:true,session:await f.session("daily-late-rejection")}),/SYNTHETIC_DAILY_ACTIVATION_REJECTED/)
  assert.deepEqual(await f.state(),before); assert.deepEqual(await f.proofState(),beforeProof)
  await f.owner.query("drop trigger zz_synthetic_reject_daily_activation on public.email_templates;")
  const first=await f.commitProof(packet,{atomicFull:true}); await f.release()
  const activated=await f.state(), activatedProof=await f.proofState(), replay=await f.commitProof(packet,{atomicFull:true})
  assert.equal(replay.idempotent,true); assert.equal(replay.certifiedAt,first.certifiedAt)
  assert.deepEqual(replay.templateReconciliation,first.templateReconciliation)
  assert.deepEqual(await f.state(),activated); assert.deepEqual(await f.proofState(),activatedProof)
}))

test("full proof committed before a partial derived batch recovers next hour without new certificate or TTL refresh",async()=>withFixture(async f=>{
  await f.baseline({templates:[bound("a"),bound("b")]})
  await f.owner.query("update public.shared_addressbook_contacts set primary_email='new@example.invalid' where id='one';")
  await f.settle(randomUUID()); f.run=randomUUID(); await f.acquire()
  // Model a historical separately committed full certificate, not the new atomic
  // hourly wrapper: new hourly activation can never leave a partial batch.
  const packet=await f.packet(randomUUID(),"full"), result=await f.commitProof(packet,{hourly:false})
  await f.setCurrentTruth(result)
  assert.equal((await f.reconcile(result.runId,result.sourceFingerprint,1)).complete,false)
  await f.release(); f.run=randomUUID(); await f.acquire()
  const before=await f.proofState(), state=await f.refresh()
  assert.equal(state.mode,"reconcile"); assert.equal(state.certificationRunId,result.runId); assert.equal(state.sourceFingerprint,result.sourceFingerprint)
  assert.deepEqual(state.reasons,["template-certification-stale"])
  assert.equal((await f.reconcile(state.certificationRunId,state.sourceFingerprint,1)).complete,true)
  assert.equal((await f.refresh()).mode,"none")
  assert.deepEqual(await f.proofState(),before)
}))

test("genuinely missing/deleted and dynamic recipients do not cause repeated full scans",async()=>withFixture(async f=>{
  const missing=ref("deleted",{status:"missing"})
  const dynamic=ref(null,{field:"cc",kind:"unresolved",literal:"<0BT>",name:"",address:"0BT",status:"missing"})
  await f.baseline({templates:[{id:"legacy",refs:{to:[missing],cc:[dynamic]}}]})
  await f.acquire()
  assert.equal((await f.refresh()).mode,"none")
  const row=await f.template("legacy")
  assert.equal(row.recipient_resolution.counts.missing,2)
  assert.equal(row.to_recipients,missing.literal); assert.equal(row.cc_recipients,"<0BT>")
}))

test("new certificates reject absent, wrong-mode and expired live leases without changing evidence",async()=>withFixture(async f=>{
  const packet=await f.packet()
  const before=await f.proofState()
  await rejectProof(f,packet,/OUTLOOK_REFRESH_LEASE_REQUIRED/)
  await f.acquire(f.run,"full")
  await rejectProof(f,packet,/OUTLOOK_REFRESH_LEASE_REQUIRED/)
  await f.release(); await f.acquire()
  await f.owner.query("update public.outlook_exchange_sync_lock set expires_at=clock_timestamp()-interval '1 second';")
  await rejectProof(f,packet,/OUTLOOK_REFRESH_LEASE_REQUIRED/)
  assert.deepEqual(await f.proofState(),before)
}))

test("actual full validators reject malformed scope, counts and source snapshots",async()=>withFixture(async f=>{
  await f.acquire()
  const packet=await f.packet(), before=await f.proofState()
  await rejectProof(f,{...packet,summary:{...packet.summary,readOnlyVerification:"true"}},/OUTLOOK_REFRESH_SCOPE_INVALID/)
  await rejectProof(f,{...packet,summary:{...packet.summary,executionMode:"full"}},/OUTLOOK_REFRESH_SCOPE_INVALID/)
  await rejectProof(f,{...packet,counts:{...packet.counts,contacts:100}},/immutable staged Exchange projection/)
  await rejectProof(f,{...packet,summary:{...packet.summary,mismatchCount:1}},/does not certify the immutable staged projection/)
  await rejectProof(f,{...packet,rawHash:"b".repeat(64)},/immutable staged raw FCUNO source/)
  assert.deepEqual(await f.proofState(),before)
}))

test("source and queue drift after full reads prevents certification even when later delivery settles",async()=>withFixture(async f=>{
  await f.acquire()
  const packet=await f.packet()
  await f.owner.query("insert into public.shared_addressbook_contacts(id,source_book,source_card,display_name,primary_email) values ('late','SYNTHETIC','late','Late','late@example.invalid');")
  await rejectProof(f,packet,/OUTLOOK_REFRESH_QUEUE_NOT_SETTLED/)
  await f.settle()
  const result=await f.commitProof(packet)
  assert.equal(result.certified,false); assert.match(result.reason,/high-water changed/)
  assert.equal((await f.proofState()).certifications.length,0)
}))

test("identical full verification replay works after release; different replay cannot refresh evidence",async()=>withFixture(async f=>{
  await f.acquire()
  const packet=await f.packet(), first=await f.commitProof(packet)
  await f.release()
  const before=await f.proofState(), replay=await f.commitProof(packet)
  assert.equal(replay.idempotent,true); assert.equal(replay.certifiedAt,first.certifiedAt)
  assert.equal(replay.atomicTemplateActivation,true); assert.deepEqual(replay.templateReconciliation,first.templateReconciliation)
  assert.deepEqual(await f.proofState(),before)
  await rejectProof(f,{...packet,summary:{...packet.summary,extra:"different"}},/OUTLOOK_REFRESH_REPLAY_CONFLICT/)
  assert.deepEqual(await f.proofState(),before)
}))

test("same-run concurrent ambiguous retry waits for one atomic commit and returns its original immutable activation",async()=>withFixture(async f=>{
  await f.baseline({templates:[bound("template")]})
  await f.owner.query("update public.shared_addressbook_contacts set primary_email='new@example.invalid' where id='one';")
  await f.settle(randomUUID()); f.run=randomUUID(); await f.acquire()
  const packet=await f.packet(), oldTemplate=await f.template("template"), duplicate=await f.session("duplicate-activation")
  await f.worker.query("begin;")
  const first=await f.commitProof(packet)
  const secondResult=f.commitProof(packet,{session:duplicate})
  await waitForBlock(f.owner,duplicate,f.worker,"advisory")
  assert.deepEqual(await f.template("template"),oldTemplate)
  await f.worker.query("commit;")
  const second=await secondResult
  assert.equal(first.idempotent,false); assert.equal(second.idempotent,true)
  assert.equal(second.certifiedAt,first.certifiedAt)
  assert.deepEqual(second.templateReconciliation,first.templateReconciliation)
  const proof=await f.proofState()
  assert.equal(proof.certifications.filter(c=>c.run_id===f.run).length,1)
  assert.equal(proof.ledger.filter(l=>l.event_key===`template-activation:${f.run}`).length,1)
}))

test("late template reconciliation failure rolls back the new certificate, all template versions, audits and ledger",async()=>withFixture(async f=>{
  await f.baseline({templates:[bound("a"),bound("z")]})
  await f.owner.query("update public.shared_addressbook_contacts set primary_email='new@example.invalid' where id='one';")
  await f.settle(randomUUID()); await f.acquire()
  const packet=await f.packet(), before=await f.state(), beforeProof=await f.proofState()
  await f.owner.query(`create function private.synthetic_reject_late_activation() returns trigger language plpgsql as $$
    begin if new.id='z' and new.recipient_resolution->>'certificationRunId'=${literal(f.run)} then
      if not exists(select 1 from public.email_templates where id='a' and recipient_resolution->>'certificationRunId'=${literal(f.run)}) then
        raise exception 'SYNTHETIC_FAILURE_WAS_NOT_AFTER_FIRST_TEMPLATE';
      end if;
      raise exception 'SYNTHETIC_LAST_TEMPLATE_ACTIVATION_REJECTED';
    end if;return new;end;$$;
    create trigger zz_synthetic_reject_activation after update on public.email_templates for each row execute function private.synthetic_reject_late_activation();`)
  await rejectProof(f,packet,/SYNTHETIC_LAST_TEMPLATE_ACTIVATION_REJECTED/)
  assert.deepEqual(await f.state(),before); assert.deepEqual(await f.proofState(),beforeProof)
  assert.equal((await f.refresh()).mode,"full")
  await f.owner.query("drop trigger zz_synthetic_reject_activation on public.email_templates;")
  const result=await f.commitProof(packet)
  assert.equal(result.atomicTemplateActivation,true); assert.equal(result.templateReconciliation.updatedTemplates,2)
  assert.equal((await f.refresh()).mode,"none")
}))

test("old proof replay after a later certification returns its immutable receipt without rewriting any current template",async()=>withFixture(async f=>{
  await f.baseline({templates:[bound("template")]})
  await f.owner.query("update public.shared_addressbook_contacts set primary_email='first@example.invalid' where id='one';")
  await f.settle(randomUUID()); await f.acquire()
  const firstPacket=await f.packet(), first=await f.commitProof(firstPacket)
  await f.release()
  await f.owner.query("update public.shared_addressbook_contacts set primary_email='second@example.invalid' where id='one';")
  await f.settle(randomUUID()); f.run=randomUUID(); await f.acquire()
  const second=await f.commitProof(await f.packet())
  assert.notEqual(second.runId,first.runId); await f.release()
  const before=await f.state(), beforeProof=await f.proofState(), replay=await f.commitProof(firstPacket)
  assert.equal(replay.idempotent,true); assert.equal(replay.certifiedAt,first.certifiedAt)
  assert.deepEqual(replay.templateReconciliation,first.templateReconciliation)
  assert.deepEqual(await f.state(),before); assert.deepEqual(await f.proofState(),beforeProof)
  const row=await f.template("template")
  assert.equal(row.recipient_resolution.certificationRunId,second.runId)
  assert.equal(row.recipient_resolution.refs.to[0].resolvedAddress,"second@example.invalid")
}))

test("group rename and membership edits retain the bound group through genuine atomic recertification",async()=>withFixture(async f=>{
  await f.baseline({contacts:[{id:"one",name:"One",email:"one@example.invalid"},{id:"two",name:"Two",email:"two@example.invalid"}],groups:[{id:"crew",name:"Crew"}],members:[{group:"crew",contact:"one"}],templates:[{id:"group-template",refs:{to:[ref("crew",{kind:"group",name:"Crew",address:"crew@cosulich1.onmicrosoft.com",literal:'"Crew"'})]}}]})
  await f.owner.query("update public.shared_addressbook_groups set name='New Crew' where id='crew'; insert into public.shared_addressbook_group_members(group_id,contact_id,source_book) values('crew','two','SYNTHETIC');")
  const pending=await f.template("group-template")
  assert.equal(pending.recipient_resolution.refs.to[0].sourceId,"crew")
  assert.equal(pending.recipient_resolution.refs.to[0].status,"missing")
  await f.settle(randomUUID()); await f.acquire()
  assert.ok((await f.refresh()).reasons.includes("source-updated"))
  const result=await f.commitProof(await f.packet())
  assert.equal(result.atomicTemplateActivation,true)
  const row=await f.template("group-template")
  assert.equal(row.recipient_resolution.refs.to[0].sourceId,"crew")
  assert.equal(row.recipient_resolution.refs.to[0].displayName,"New Crew")
  assert.equal(row.recipient_resolution.refs.to[0].status,"resolved")
  assert.equal(row.recipient_resolution.refs.to[0].resolvedAddress,"crew@cosulich1.onmicrosoft.com")
  assert.equal((await f.refresh()).mode,"none")
}))

test("canonical lock contention rejects within its local lock budget without publishing and permits a clean retry",async()=>withFixture(async f=>{
  await f.baseline({templates:[bound("template")]})
  await f.owner.query("update public.shared_addressbook_contacts set primary_email='new@example.invalid' where id='one';")
  await f.settle(randomUUID()); await f.acquire()
  const packet=await f.packet(), before=await f.state(), beforeProof=await f.proofState()
  const blocker=await f.session("canonical-lock-holder")
  await blocker.query("begin; select pg_advisory_xact_lock(hashtextextended('email_templates_canonical_write',0));")
  await rejectProof(f,packet,/lock timeout/)
  assert.deepEqual(await f.state(),before); assert.deepEqual(await f.proofState(),beforeProof)
  await blocker.query("rollback;")
  assert.equal((await f.commitProof(packet)).atomicTemplateActivation,true)
}))

test("lease expiry during template activation rolls back the certificate and every derived write",async()=>withFixture(async f=>{
  await f.baseline({templates:[bound("template")]})
  await f.owner.query("update public.shared_addressbook_contacts set primary_email='new@example.invalid' where id='one';")
  await f.settle(randomUUID()); await f.acquire()
  const packet=await f.packet(), before=await f.state(), beforeProof=await f.proofState()
  await f.owner.query(`create function private.synthetic_slow_template_activation() returns trigger language plpgsql as $$ begin
    if new.recipient_resolution->>'certificationRunId'=${literal(f.run)} then perform pg_sleep(0.3);end if;return new;end;$$;
    create trigger zz_synthetic_slow_activation after update on public.email_templates for each row execute function private.synthetic_slow_template_activation();
    update public.outlook_exchange_sync_lock set expires_at=clock_timestamp()+interval '0.2 second';`)
  await rejectProof(f,packet,/OUTLOOK_REFRESH_LEASE_REQUIRED/)
  assert.deepEqual(await f.state(),before); assert.deepEqual(await f.proofState(),beforeProof)
}))

test("activation cannot commit beyond its elapsed budget even if the caller starts without a statement timer",async()=>withFixture(async f=>{
  await f.baseline({templates:[bound("template")]})
  await f.owner.query("update public.shared_addressbook_contacts set primary_email='new@example.invalid' where id='one';")
  await f.settle(randomUUID()); await f.acquire()
  const packet=await f.packet(), before=await f.state(), beforeProof=await f.proofState()
  await f.owner.query(`create function private.synthetic_over_budget_activation() returns trigger language plpgsql as $$ begin
    if new.recipient_resolution->>'certificationRunId'=${literal(f.run)} then perform pg_sleep(10.05);end if;return new;end;$$;
    create trigger zz_synthetic_over_budget_activation after update on public.email_templates for each row execute function private.synthetic_over_budget_activation();`)
  await rejectProof(f,packet,/OUTLOOK_REFRESH_ACTIVATION_TIMEOUT|statement timeout/)
  assert.deepEqual(await f.state(),before); assert.deepEqual(await f.proofState(),beforeProof)
}))

test("lease expiry during a full-proof transaction rolls the entire certificate and ledger back",async()=>withFixture(async f=>{
  await f.acquire()
  const packet=await f.packet(), before=await f.proofState()
  await f.owner.query(`create function private.synthetic_delay_certificate() returns trigger language plpgsql as $$ begin perform pg_sleep(0.3); return new; end $$;
    create trigger synthetic_delay after insert on public.outlook_exchange_sync_certifications for each row execute function private.synthetic_delay_certificate();
    update public.outlook_exchange_sync_lock set expires_at=clock_timestamp()+interval '0.2 second';`)
  await rejectProof(f,packet,/OUTLOOK_REFRESH_LEASE_REQUIRED/)
  assert.deepEqual(await f.proofState(),before)
}))

test("expired full certificate requests verification rather than silently refreshing its timestamp",async()=>withFixture(async f=>{
  const baseline=await f.baseline()
  const expired="2000-01-01T00:00:00Z"
  await f.owner.query(`update public.outlook_exchange_sync_certifications set certified_at=${literal(expired)}::timestamptz where run_id=${literal(baseline.result.runId)}::uuid;`)
  await f.setCurrentTruth({...baseline.result,certifiedAt:expired})
  await f.acquire()
  const before=await f.proofState(),state=await f.refresh()
  assert.equal(state.mode,"full"); assert.ok(state.reasons.includes("certification-expired"))
  assert.deepEqual(await f.proofState(),before)
}))

test("refresh state and certification RPCs are server-only and require the exact live run",async()=>withFixture(async f=>{
  const rights=await f.owner.one(`select jsonb_build_object(
    'anonState',has_function_privilege('anon','public.get_outlook_template_recipient_refresh_state(uuid)','EXECUTE'),
    'authState',has_function_privilege('authenticated','public.get_outlook_template_recipient_refresh_state(uuid)','EXECUTE'),
    'serviceState',has_function_privilege('service_role','public.get_outlook_template_recipient_refresh_state(uuid)','EXECUTE'),
    'anonCert',has_function_privilege('anon','public.certify_staged_read_only_outlook_exchange_truth(uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text)','EXECUTE'),
    'serviceCert',has_function_privilege('service_role','public.certify_staged_read_only_outlook_exchange_truth(uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text)','EXECUTE'),
    'anonFull',has_function_privilege('anon','public.certify_staged_full_outlook_truth_and_activate_templates(uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text)','EXECUTE'),
    'authFull',has_function_privilege('authenticated','public.certify_staged_full_outlook_truth_and_activate_templates(uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text)','EXECUTE'),
    'serviceFull',has_function_privilege('service_role','public.certify_staged_full_outlook_truth_and_activate_templates(uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text)','EXECUTE'),
    'serviceHelper',has_function_privilege('service_role','private.certify_staged_outlook_truth_and_activate(text,uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text)','EXECUTE'));
  `)
  assert.deepEqual(rights,{anonState:false,authState:false,serviceState:true,anonCert:false,serviceCert:true,anonFull:false,authFull:false,serviceFull:true,serviceHelper:false})
  await f.acquire()
  await assert.rejects(f.refresh(randomUUID(),await f.session("wrong-run-state")),/OUTLOOK_REFRESH_LEASE_REQUIRED/)
}))
