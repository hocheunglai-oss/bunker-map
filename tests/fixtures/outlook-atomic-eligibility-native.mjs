import assert from "node:assert/strict"
import { setupHourlyVerification, randomUUID, literal, json } from "./outlook-hourly-verification-native.mjs"
import { source, ref } from "./outlook-template-source-policy.mjs"
import { fn, resolution } from "./outlook-insertion-native.mjs"

export { randomUUID, literal, json, source }
export const migrationPath = "supabase/migrations/20261023060030_avoid_duplicate_atomic_outlook_eligibility_verification.sql"
export const atomicSignature = "private.certify_staged_outlook_truth_and_activate(text,uuid,bigint,timestamptz,text,text,jsonb,jsonb,jsonb,text)"
export const helperSignature = "private.outlook_atomic_refresh_requires_full(uuid)"
export const installActualVerifier = async f => {
  const ledger = source("supabase/migrations/20260723080326_exchange_truth_ledger.sql")
  const group = source("supabase/migrations/20260723141037_certify_outlook_group_smtp_truth.sql")
  await f.owner.query(`
    ${fn(ledger,"public.outlook_exchange_truth_snapshot_is_valid")}
    ${fn(ledger,"public.verify_outlook_exchange_truth_ledger").replace("function public.verify_outlook_exchange_truth_ledger()","function public.verify_outlook_exchange_truth_ledger_without_group_smtp_guard()")}
    ${fn(group,"public.verify_outlook_exchange_truth_ledger")}
    ${fn(source("supabase/migrations/20261023041904_refresh_outlook_certification_before_expiry.sql"),"public.get_outlook_template_recipient_refresh_state")}
    alter function public.verify_outlook_exchange_truth_ledger() set statement_timeout='20s';
    create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.email_templates
      for each statement execute function private.record_bunker_map_backup_mutation();
  `)
  assert.deepEqual(await f.owner.one(`select jsonb_object_agg(p.proname,md5(p.prosrc))from pg_proc p where p.oid in(
    'public.outlook_exchange_truth_snapshot_is_valid(text,text,integer,text,bigint,jsonb)'::regprocedure,
    'public.verify_outlook_exchange_truth_ledger()'::regprocedure,
    'public.verify_outlook_exchange_truth_ledger_without_group_smtp_guard()'::regprocedure);`),{
    outlook_exchange_truth_snapshot_is_valid:"eb58b625c2483e093d60422dd498a1b3",
    verify_outlook_exchange_truth_ledger:"2b7f4e4c505d047449accb9c090537d1",
    verify_outlook_exchange_truth_ledger_without_group_smtp_guard:"be2ff9edc1446e32a6afa6374e4bc4aa",
  })
}

// Genuine isolated PostgreSQL17.6. Unlike the tiny legacy hourly fixture, every
// measured/rejected operation uses the actual whole SHA/ledger/snapshot/reference
// and group-SMTP verifier. extensions.digest delegates to PostgreSQL's built-in
// SHA256 with identical bytes; no Microsoft tenant, external values or production
// hardware throughput is claimed. Synthetic setup does not certify fake rows.
export async function setupAtomicEligibility({ apply = process.env.OUTLOOK_ATOMIC_ELIGIBILITY_TEST_BASELINE !== "1", baseline = true } = {}) {
  const f = await setupHourlyVerification()
  try {
    await installActualVerifier(f)
    f.metadata = () => f.owner.one(`select jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object(
      'oid',p.oid,'body',md5(p.prosrc),'owner',p.proowner,'acl',p.proacl,'config',p.proconfig,
      'securityDefiner',p.prosecdef,'volatility',p.provolatile,'strict',p.proisstrict,'parallel',p.proparallel))
      from pg_proc p where p.oid in ('${atomicSignature}'::regprocedure,
      'public.get_outlook_template_recipient_refresh_state(uuid)'::regprocedure,
      'private.prepare_outlook_template_truth_write()'::regprocedure,
      'public.verify_outlook_template_recipient_truth()'::regprocedure,
      'public.verify_outlook_exchange_truth_ledger()'::regprocedure);`)
    f.beforeMetadata = await f.metadata()
    f.atomicMetadataKey = await f.owner.one(`select to_jsonb('${atomicSignature}'::regprocedure::text);`)
    assert.equal(f.beforeMetadata[f.atomicMetadataKey].body,"b6b34be74a2be8b4bfbbaa690bed1394")
    if (apply) await f.owner.query(`begin;${source(migrationPath)}commit;`)
    f.hint = (run=f.run,session=f.owner) => session.one(`select to_jsonb(private.outlook_atomic_refresh_requires_full(${literal(run)}::uuid));`)
    f.completeState = () => f.owner.one(`select jsonb_build_object(
      'templates',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]')from public.email_templates t),
      'certifications',(select coalesce(jsonb_agg(to_jsonb(t) order by run_id),'[]')from public.outlook_exchange_sync_certifications t),
      'ledger',(select coalesce(jsonb_agg(to_jsonb(t) order by ledger_sequence),'[]')from public.outlook_exchange_truth_ledger t),
      'snapshots',(select coalesce(jsonb_agg(to_jsonb(t) order by snapshot_sha256),'[]')from public.outlook_exchange_truth_snapshots t),
      'queue',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]')from public.outlook_exchange_sync_queue t),
      'audit',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]')from public.audit_logs t),
      'epochs',(select coalesce(jsonb_agg(to_jsonb(t) order by mutation_id),'[]')from private.bunker_map_backup_mutations t));`)
    f.rejectUnchanged = async (packet,pattern) => {
      const before=await f.completeState()
      await assert.rejects(f.commitProof(packet,{session:await f.session("rejected-atomic-proof")}),pattern)
      assert.deepEqual(await f.completeState(),before)
    }
    if (baseline) {
      await f.owner.query("insert into public.shared_addressbook_contacts(id,source_book,source_card,display_name,primary_email)values('one','SYNTHETIC','one','One','one@example.invalid');")
      await f.settle()
      const packet=await f.packet(randomUUID(),"full")
      const result=await f.commitProof(packet,{hourly:false})
      await f.setCurrentTruth(result)
      const evidence={...resolution(f.verified),refs:{to:[ref("one")],cc:[],bcc:[]},counts:{total:1,resolved:1,external:0,missing:0,ambiguous:0}}
      await f.owner.query(`insert into public.email_templates(id,title,subject,folder,body_html,body_text,slug,is_active,to_recipients,recipient_resolution)
        values('template','Unchanged title','Unchanged subject','Synthetic','<p>Unchanged body</p>','Unchanged body','template',true,'one <one@example.invalid>',${json(evidence)});`)
      f.baselineProof={packet,result}
    }
    f.changed = async () => {
      await f.owner.query("update public.shared_addressbook_contacts set primary_email='changed@example.invalid'where id='one';")
      await f.settle(randomUUID());assert.equal(await f.acquire(),true)
      return f.packet()
    }
    return f
  } catch(error) { await f.close();throw error }
}
