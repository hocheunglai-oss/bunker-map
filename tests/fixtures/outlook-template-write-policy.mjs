import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { transformSync } from "esbuild"
export const source = file => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
export const policyMigration = "supabase/migrations/20261016021744_keep_certified_template_writes_available_during_sync.sql"
function between(raw, start, end) { const a=raw.indexOf(start),b=raw.indexOf(end,a);assert.ok(a>=0&&b>a);return raw.slice(a,b) }
export function templateWritePolicySql({ repaired = true } = {}) {
  const hardening=source("supabase/migrations/20260723124045_harden_outlook_template_truth_writes.sql")
  const canonical=source("supabase/migrations/20260723120428_outlook_template_canonical_writes.sql")
  const audit=source("supabase/audit_log.sql")
  const auditEnd=audit.indexOf("$$;",audit.indexOf("create or replace function public.audit_enable_table("))+3
  const backup=source("supabase/migrations/20260723101257_add_backup_export_epoch.sql")
  return `
    create schema if not exists private;
    create role anon; create role authenticated; create role service_role bypassrls;
    ${audit.slice(audit.indexOf("create table if not exists public.audit_logs ("),auditEnd)}
    grant usage on schema public,private to service_role;
    ${source("supabase/email_templates.sql").replace('create extension if not exists "pgcrypto";',"")}
    create table private.synthetic_exchange_truth(value jsonb not null);
    create function public.verify_outlook_exchange_truth_ledger() returns jsonb language sql stable security definer set search_path='' as $$ select value from private.synthetic_exchange_truth $$;
    ${between(hardening,"create or replace function public.is_valid_outlook_template_recipient_resolution(","alter table public.email_templates")}
    ${between(canonical,"create or replace function public.email_templates_manage_version()","create or replace function public.email_template_library_revision()")}
    ${between(canonical,"create or replace function public.save_email_template_canonical(","create or replace function public.delete_email_template_canonical(")}
    ${between(hardening,"create or replace function private.prepare_outlook_template_truth_write()","create or replace function public.verify_outlook_template_recipient_truth()")}
    ${repaired ? `begin; ${source(policyMigration)} commit;` : ""}
    revoke all on function public.save_email_template_canonical(jsonb,bigint,timestamptz) from public,anon,authenticated;
    grant execute on function public.save_email_template_canonical(jsonb,bigint,timestamptz) to service_role;
    select public.audit_enable_table('public.email_templates');
    ${backup.slice(0,backup.indexOf("\ndo $$"))}
    create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.email_templates for each statement execute function private.record_bunker_map_backup_mutation();
    create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.audit_logs for each statement execute function private.record_bunker_map_backup_mutation();
    set request.headers='{"x-bunker-admin-user":"synthetic","x-bunker-admin-page-id":"email-templates"}';
  `
}
export function verifiedTruth(changes={}) {
  return {valid:true,integrityValid:true,ledgerValid:true,snapshotsValid:true,referencesValid:true,operationallyConsistent:false,latestCertificationHasProjectionEvidence:true,
    latestCertificationRunId:"11111111-1111-4111-8111-111111111111",latestCertificationAt:new Date(Date.now()-60000).toISOString(),latestSourceFingerprint:"a".repeat(64),latestProjectionSnapshotSha256:"a".repeat(64),queue:{pending:2,processing:1,failed:0,terminalFailed:0},...changes}
}
export const inputTemplate = (resolution,changes={}) => ({id:"synthetic-template",title:"Synthetic template",subject:"Synthetic subject",folder:"Synthetic",source_path:"",sender:"",to_recipients:"synthetic@example.invalid",cc_recipients:"",bcc_recipients:"",body_html:"<p>Body</p>",body_text:"Body",tags:[],slug:"synthetic-template",is_active:true,placeholders:[],recipient_resolution:resolution,...changes})
export const emptyResolution = truth => ({schema:"fcuno.outlook-template-recipient-resolution/v1",certificationRunId:truth.latestCertificationRunId,certifiedAt:truth.latestCertificationAt,sourceFingerprint:truth.latestSourceFingerprint,resolvedAt:new Date().toISOString(),refs:{to:[],cc:[],bcc:[]},counts:{total:0,resolved:0,external:0,ambiguous:0,missing:0}})
export function loadSource(file,modules,env={}) {
  const module={exports:{}};const code=transformSync(source(file),{loader:"ts",format:"cjs",target:"node24"}).code
  new Function("require","module","exports","process",code)(name=>{assert.ok(Object.hasOwn(modules,name),`Unexpected fixture dependency: ${name}`);return modules[name]},module,module.exports,{env});return module.exports
}
