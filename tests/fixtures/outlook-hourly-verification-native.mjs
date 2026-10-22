import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { setupSourcePolicy, source, json, literal } from "./outlook-template-source-policy.mjs"
import { fn } from "./outlook-insertion-native.mjs"

export { json, literal, randomUUID }
export const migrationPath = "supabase/migrations/20261022080348_verify_hourly_outlook_recipient_projection.sql"
export const renameMigrationPath = "supabase/migrations/20261022092342_fix_atomic_outlook_full_rpc_name.sql"
export const publicRefreshRpcNames = Object.freeze({
  state: "get_outlook_template_recipient_refresh_state",
  hourly: "certify_staged_read_only_outlook_exchange_truth",
  daily: "certify_staged_full_outlook_truth_and_activate_templates",
})
export const workerVersion = "fcuno-exchange-runbook/2026-10-22.2"
const section = (text, start, end) => {
  const a = text.indexOf(start), b = text.indexOf(end, a)
  assert.ok(a >= 0 && b > a)
  return text.slice(a, b)
}

// Real native PostgreSQL, source/outbox triggers, immutable snapshot/SHA writer,
// projection validation, raw-source fencing, full certificate, lease and batch
// functions. Only the external Exchange/global expensive verifier remains the
// explicit synthetic truth boundary inherited from setupSourcePolicy. This is
// not proof that a Microsoft tenant was read or that its data matched.
export async function setupHourlyVerification() {
  const f = await setupSourcePolicy()
  try {
    const queue = source("supabase/outlook_exchange_sync_queue.sql")
    const outbox = source("supabase/migrations/20260722045125_exchange_sync_transactional_outbox.sql")
    const hardened = source("supabase/migrations/20260722082522_harden_exchange_queue_stale_claims.sql")
    const ledger = source("supabase/migrations/20260723080326_exchange_truth_ledger.sql")
    const group = source("supabase/migrations/20260723141037_certify_outlook_group_smtp_truth.sql")
    const staged = source("supabase/migrations/20260724063054_stage_outlook_exchange_certification_evidence.sql")
    const split = source("supabase/migrations/20260724054502_split_outlook_certification_template_reconciliation.sql")
    await f.owner.query(`
      ${section(queue, "create table if not exists public.outlook_exchange_sync_certifications (", "-- Queue triggers, audit correlation")}
      -- Explicit synthetic full-proof boundary follows the real latest certificate
      -- in this fixture; the performance/concurrency case installs the real SHA
      -- ledger/snapshot/reference verifier instead, without this fixture override.
      create or replace function public.verify_outlook_exchange_truth_ledger()
      returns jsonb language sql stable security definer set search_path=pg_catalog,pg_temp as $$
        select value || coalesce((select jsonb_build_object(
          'latestCertificationRunId',run_id,'latestCertificationAt',certified_at,
          'latestSourceFingerprint',source_fingerprint,'latestProjectionSnapshotSha256',source_fingerprint,
          'latestCertificationHasProjectionEvidence',true)
          from public.outlook_exchange_sync_certifications order by certified_at desc,run_id desc limit 1),'{}'::jsonb)
        from private.synthetic_exchange_truth;
      $$;
      ${fn(outbox, "public.acquire_outlook_exchange_sync_lock")}
      ${fn(outbox, "public.renew_outlook_exchange_sync_lock")}
      ${fn(outbox, "public.release_outlook_exchange_sync_lock")}
      ${fn(hardened, "public.complete_verified_outlook_exchange_sync_queue_row")}
      ${fn(hardened, "public.certify_full_outlook_exchange_sync_queue")}
      ${fn(ledger, "public.outlook_exchange_raw_source_snapshot")}
      ${fn(group, "public.outlook_exchange_projection_has_exact_group_smtp")}
      ${fn(group, "public.outlook_exchange_worker_supports_group_smtp")}
      ${fn(staged, "public.stage_outlook_exchange_projection_snapshot")}
      ${fn(staged, "public.stage_outlook_exchange_raw_source_snapshot")}
      ${fn(staged, "public.certify_staged_full_outlook_exchange_truth")}
      ${fn(staged, "public.reconcile_outlook_templates_with_certification_batch")}
      ${fn(split, "public.reconcile_outlook_templates_with_certification")}
      grant select on public.outlook_exchange_sync_certifications to service_role;
      grant execute on function public.acquire_outlook_exchange_sync_lock(uuid,text,integer),
        public.renew_outlook_exchange_sync_lock(uuid,integer),public.release_outlook_exchange_sync_lock(uuid),
        public.complete_verified_outlook_exchange_sync_queue_row(uuid,uuid),
        public.stage_outlook_exchange_projection_snapshot(text,text,jsonb,jsonb,text),
        public.stage_outlook_exchange_raw_source_snapshot(uuid,bigint,timestamptz,text),
        public.certify_staged_full_outlook_exchange_truth(uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text),
        public.reconcile_outlook_templates_with_certification_batch(uuid,text,integer) to service_role;
      begin; ${source(migrationPath)} ${source(renameMigrationPath)} commit;
    `)
    f.run = randomUUID()
    f.worker = await f.session("hourly-worker")
    f.acquire = (run = f.run, mode = "incremental", session = f.worker) => session.one(`select to_jsonb(public.acquire_outlook_exchange_sync_lock(${literal(run)}::uuid,${literal(mode)},30));`)
    f.release = (run = f.run) => f.worker.one(`select to_jsonb(public.release_outlook_exchange_sync_lock(${literal(run)}::uuid));`)
    f.refresh = (run = f.run, session = f.worker) => session.one(`select public.get_outlook_template_recipient_refresh_state(${literal(run)}::uuid);`)
    f.settle = async (run = f.run) => {
      const ids = await f.owner.one("select coalesce(jsonb_agg(id),'[]') from public.outlook_exchange_sync_queue where status in ('pending','processing','failed');")
      for (const id of ids) {
        await f.owner.query(`update public.outlook_exchange_sync_queue set status='processing',run_id=${literal(run)}::uuid where id=${literal(id)}::uuid;`)
        assert.equal((await f.worker.one(`select public.complete_verified_outlook_exchange_sync_queue_row(${literal(id)}::uuid,${literal(run)}::uuid);`)).completed, true)
      }
    }
    f.fence = () => f.owner.one("select jsonb_build_object('sequence',coalesce((select queue_sequence from public.outlook_exchange_sync_queue order by updated_at desc,queue_sequence desc limit 1),0),'updatedAt',(select updated_at from public.outlook_exchange_sync_queue order by updated_at desc,queue_sequence desc limit 1));")
    f.packet = async (run = f.run, executionMode = "incremental") => {
      const raw = await f.owner.one("select public.outlook_exchange_raw_source_snapshot();")
      const contacts = raw.contacts.map(c => ({ sourceContactId:c.id,displayName:c.display_name,directoryName:c.display_name,externalEmailAddress:c.primary_email }))
      const groups = raw.groups.filter(g => raw.members.some(m => m.group_id === g.id)).map(g => ({ sourceGroupId:g.id,groupName:g.name,directoryName:g.name,alias:g.id,smtpAddress:`${g.id}@cosulich1.onmicrosoft.com`,memberCount:raw.members.filter(m=>m.group_id===g.id).length }))
      const members = raw.members.map(m => ({ sourceGroupId:m.group_id,sourceContactId:m.contact_id,memberEmail:raw.contacts.find(c=>c.id===m.contact_id).primary_email }))
      const projection = {contacts,groups,members,invalidContacts:[],skippedInvalidContacts:[],duplicateContacts:[]}
      const canonical = JSON.stringify(projection), fingerprint = createHash("sha256").update(canonical).digest("hex")
      const counts = Object.fromEntries(Object.entries(projection).map(([k,v])=>[k,v.length]))
      const fence = await f.fence()
      const summary = {status:"match",mismatchCount:0,sourceFenceStable:true,sourceFingerprint:fingerprint,verifiedManagedContacts:contacts.length,verifiedManagedGroups:groups.length,verifiedMembershipGroups:groups.length,verifiedMemberships:members.length,verificationScope:"full",executionMode,readOnlyVerification:executionMode==="incremental"}
      assert.equal((await f.worker.one(`select public.stage_outlook_exchange_projection_snapshot(${literal(fingerprint)},${literal(canonical)},${json(counts)},${json(summary)},${literal(workerVersion)});`)).staged,true)
      const stagedRaw = await f.worker.one(`select public.stage_outlook_exchange_raw_source_snapshot(${literal(run)}::uuid,${fence.sequence},${fence.updatedAt ? `${literal(fence.updatedAt)}::timestamptz` : "null"},${literal(fingerprint)});`)
      assert.equal(stagedRaw.staged,true)
      return {run,fence,fingerprint,counts,rawHash:stagedRaw.rawSourceSnapshotHash,rawCounts:stagedRaw.rawSourceCounts,summary}
    }
    f.commitProof = (packet, {hourly=true, atomicFull=false, session=f.worker}={}) => session.one(`select public.${atomicFull ? publicRefreshRpcNames.daily : hourly ? publicRefreshRpcNames.hourly : "certify_staged_full_outlook_exchange_truth"}(${literal(packet.run)}::uuid,${packet.fence.sequence},${packet.fence.updatedAt ? `${literal(packet.fence.updatedAt)}::timestamptz` : "null"},${literal(packet.fingerprint)},${literal(packet.rawHash)},${json(packet.counts)},${json(packet.rawCounts)},${json(packet.summary)},${literal(workerVersion)});`)
    f.setCurrentTruth = async result => {
      f.verified = {...f.verified,latestCertificationRunId:result.runId,latestCertificationAt:result.certifiedAt,latestSourceFingerprint:result.sourceFingerprint,latestProjectionSnapshotSha256:result.sourceFingerprint,queue:{pending:0,processing:0,failed:0,terminalFailed:0}}
      await f.owner.query(`update private.synthetic_exchange_truth set value=${json(f.verified)};`)
    }
    f.reconcile = (run, fingerprint, limit=25) => f.worker.one(`select public.reconcile_outlook_templates_with_certification_batch(${literal(run)}::uuid,${literal(fingerprint)},${limit});`)
    f.baseline = async ({contacts=[{id:"one",name:"One",email:"one@example.invalid"}],templates=[],groups=[],members=[]}={}) => {
      await f.seed({contacts,templates,groups,members})
      await f.settle()
      const packet = await f.packet(randomUUID(),"full")
      const result = await f.commitProof(packet,{hourly:false})
      assert.equal(result.certified,true)
      await f.setCurrentTruth(result)
      if (templates.length) await f.reconcile(result.runId,result.sourceFingerprint)
      return {packet,result}
    }
    f.proofState = () => f.owner.one("select jsonb_build_object('certifications',(select coalesce(jsonb_agg(to_jsonb(c) order by certified_at,run_id),'[]') from public.outlook_exchange_sync_certifications c),'ledger',(select coalesce(jsonb_agg(to_jsonb(l) order by ledger_sequence),'[]') from public.outlook_exchange_truth_ledger l));")
    return f
  } catch(error) { await f.close(); throw error }
}
