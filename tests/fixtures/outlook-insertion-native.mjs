import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { setupNativeCcinfo } from "./native-postgres-ccinfo.mjs"

export const migrationPath = "supabase/migrations/20261022024949_bound_outlook_insertion_reservation_verification.sql"
export const source = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")
export const literal = value => `'${String(value).replaceAll("'", "''")}'`
export const json = value => `${literal(JSON.stringify(value))}::jsonb`
export const certification = "11111111-1111-4111-8111-111111111111"
export const fingerprint = "a".repeat(64)
export function fn(sql, name) {
  const start = sql.indexOf(`create or replace function ${name}(`)
  const end = sql.indexOf("$$;", start) + 3
  assert.ok(start >= 0 && end > start, `Missing exact production function ${name}`)
  return sql.slice(start, end)
}
export const truth = changes => ({ valid: true, integrityValid: true, ledgerValid: true,
  snapshotsValid: true, referencesValid: true, operationallyConsistent: false,
  latestCertificationHasProjectionEvidence: true, latestCertificationRunId: certification,
  latestCertificationAt: new Date(Date.now() - 60000).toISOString(),
  latestSourceFingerprint: fingerprint, latestProjectionSnapshotSha256: fingerprint,
  queue: { pending: 2, processing: 1, failed: 0, terminalFailed: 0 }, ...changes })
export const resolution = value => ({ schema: "fcuno.outlook-template-recipient-resolution/v1",
  certificationRunId: value.latestCertificationRunId, certifiedAt: value.latestCertificationAt,
  sourceFingerprint: value.latestSourceFingerprint, resolvedAt: new Date().toISOString(),
  reconciliationRequired: false, refs: { to: [], cc: [], bcc: [] },
  counts: { total: 0, resolved: 0, external: 0, ambiguous: 0, missing: 0 } })
export const reserveSql = (operation, changes = {}) => {
  const values = { template: "synthetic-template", revision: 1, certification,
    fingerprint, actor: "synthetic-user", actorName: "Synthetic User", age: 129600, ...changes }
  return `select public.reserve_outlook_template_insertion(${literal(operation)}::uuid,
    ${literal(values.template)},${values.revision},${literal(values.certification)}::uuid,
    ${literal(values.fingerprint)},${literal(values.actor)},${literal(values.actorName)},${values.age});`
}

export async function setupInsertion({ repaired = true, delay = 0 } = {}) {
  const audit = source("supabase/audit_log.sql")
  const auditEnd = audit.indexOf("$$;", audit.indexOf("create or replace function public.audit_enable_table(")) + 3
  const state = source("supabase/migrations/20260723141044_outlook_insertion_audit_state_machine.sql")
  const stateStart = state.indexOf("drop index if exists")
  const reserveStart = state.indexOf("create or replace function public.reserve_outlook_template_insertion(")
  const hardening = source("supabase/migrations/20260723124045_harden_outlook_template_truth_writes.sql")
  const verified = truth()
  const f = await setupNativeCcinfo(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema private;
    grant usage on schema public,private to service_role;
    ${audit.slice(audit.indexOf("create table if not exists public.audit_logs ("), auditEnd)}
    ${source("supabase/email_templates.sql").replace('create extension if not exists "pgcrypto";', "")}
    ${state.slice(stateStart, reserveStart)}
    ${fn(hardening, "public.is_valid_outlook_template_recipient_resolution")}
    create table private.synthetic_exchange_truth(value jsonb not null);
    insert into private.synthetic_exchange_truth values (${json(verified)});
    create sequence private.synthetic_full_verifier_calls;
    create function public.verify_outlook_exchange_truth_ledger() returns jsonb
      language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
      begin
        perform pg_catalog.nextval('private.synthetic_full_verifier_calls');
        perform pg_catalog.pg_sleep(${Number(delay)});
        return (select value from private.synthetic_exchange_truth);
      end; $$;
    revoke all on function public.verify_outlook_exchange_truth_ledger() from public,anon,authenticated;
    grant execute on function public.verify_outlook_exchange_truth_ledger() to service_role;
    ${fn(hardening, "public.verify_outlook_template_recipient_truth")}
    revoke all on function public.verify_outlook_template_recipient_truth() from public,anon,authenticated;
    grant execute on function public.verify_outlook_template_recipient_truth() to service_role;
    ${source("supabase/migrations/20260825045312_keep_outlook_templates_available_during_sync.sql")}
    ${fn(state, "public.complete_outlook_template_insertion")}
    revoke all on function public.complete_outlook_template_insertion(uuid,text,bigint,uuid,text,text,text,text) from public,anon,authenticated;
    grant execute on function public.complete_outlook_template_insertion(uuid,text,bigint,uuid,text,text,text,text) to service_role;
    alter function public.verify_outlook_template_recipient_truth() set statement_timeout='20s';
    alter function public.reserve_outlook_template_insertion(uuid,text,bigint,uuid,text,text,text,integer) set statement_timeout='20s';
    grant select,insert on public.audit_logs to service_role;
    grant select on public.email_templates to service_role;
    insert into public.email_templates(id,title,subject,folder,body_html,body_text,slug,is_active,revision,recipient_resolution)
      values ('synthetic-template','Synthetic template','Synthetic subject','Synthetic','<p>Body</p>','Body','synthetic-template',true,1,${json(resolution(verified))});
  `)
  try {
    if (repaired) await f.owner.query(`begin; ${source(migrationPath)} commit;`)
    f.verified = verified
    f.audit = () => f.owner.one("select jsonb_build_object('count',count(*),'rows',coalesce(jsonb_agg(to_jsonb(t) order by id),'[]')) from public.audit_logs t;")
    f.calls = () => f.owner.one("select jsonb_build_object('count',case when is_called then last_value else 0 end) from private.synthetic_full_verifier_calls;")
    return f
  } catch (error) { await f.close(); throw error }
}
