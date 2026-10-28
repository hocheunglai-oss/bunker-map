import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {setupNativeCcinfo,literal} from "./native-postgres-ccinfo.mjs"

export const migrationPath="supabase/migrations/20261028054420_compact_outlook_certification_refresh_audit.sql"
export const source=path=>readFileSync(new URL(`../../${path}`,import.meta.url),"utf8")
export const json=value=>`${literal(JSON.stringify(value))}::jsonb`
export {literal}
const fn=(sql,name)=>{const start=sql.indexOf(`create or replace function ${name}(`),end=sql.indexOf("$$;",start)+3;assert.ok(start>=0&&end>start,name);return sql.slice(start,end)}
const audit=source("supabase/audit_log.sql")
const auditEnd=audit.indexOf("$$;",audit.indexOf("create or replace function public.audit_enable_table("))+3
const hardening=source("supabase/migrations/20260806110014_harden_spc_user_management_audit.sql")
const undo=source("supabase/migrations/20260806202000_complete_spc_audit_enforcement.sql")
export const originalAudit=fn(hardening,"public.audit_table_changes")
export const originalVersion=fn(source("supabase/migrations/20260723120428_outlook_template_canonical_writes.sql"),"public.email_templates_manage_version")
export const auditSupportSql=[fn(hardening,"public.audit_uuid_text"),fn(undo,"public.audit_undo_context"),fn(undo,"public.undo_audit_log_noncredential"),fn(undo,"public.undo_audit_log")].join("\n")
export const signatures=["public.audit_table_changes()","public.email_templates_manage_version()","public.undo_audit_log_noncredential(uuid,text,text)"]
export const identitySql=`select jsonb_object_agg(p.oid::regprocedure::text,to_jsonb(p)-array['prosrc']) from pg_proc p where p.oid in (${signatures.map(s=>`${literal(s)}::regprocedure`).join(",")});`
export async function setupCertificationAudit(){
  const f=await setupNativeCcinfo(`
    create role anon;create role authenticated;create role service_role bypassrls;
    create schema private;revoke all on schema private from public,anon,authenticated;
    ${audit.slice(audit.indexOf("create table if not exists public.audit_logs ("),auditEnd)}
    ${fn(hardening,"public.audit_uuid_text")}
    ${originalAudit}
    ${source("supabase/email_templates.sql").replace('create extension if not exists "pgcrypto";',"")}
    ${originalVersion}
    create trigger email_templates_manage_version before insert or update on public.email_templates for each row execute function public.email_templates_manage_version();
    select public.audit_enable_table('public.email_templates');
    ${fn(undo,"public.audit_undo_context")}
    ${fn(undo,"public.undo_audit_log_noncredential")}
    ${fn(undo,"public.undo_audit_log")}
    revoke all on function public.undo_audit_log_noncredential(uuid,text,text),public.audit_undo_context(uuid) from public,anon,authenticated,service_role;
    revoke all on function public.undo_audit_log(uuid,text,text) from public,anon,authenticated;
    grant execute on function public.undo_audit_log(uuid,text,text) to service_role;
  `)
  f.metadata=()=>f.owner.one(identitySql)
  f.apply=()=>f.owner.query(`begin;${source(migrationPath)}commit;`)
  f.audit=()=>f.owner.one("select coalesce(jsonb_agg(to_jsonb(a)order by occurred_at,id),'[]')from public.audit_logs a;")
  return f
}
export const runId="00000000-0000-4000-8000-000000000001"
export const fingerprint="a".repeat(64)
export const resolution=(run=runId)=>({schemaVersion:1,certificationRunId:run,sourceFingerprint:fingerprint,certifiedAt:"2026-10-28T01:00:00.000Z",refs:{to:[{kind:"contact",sourceId:"synthetic",status:"resolved",resolvedAddress:"test@example.invalid"}],cc:[],bcc:[]}})
export const context=(run=runId)=>({action:"certified-projection-reconcile",pageId:"email-templates",pagePath:"/admin/outlooktemplates",certificationRunId:run,sourceFingerprint:fingerprint})
export const setActor=(actor="system:outlook-template-recipient-truth",ctx=context())=>`do $$begin perform set_config('app.audit_actor_id',${literal(actor)},true);perform set_config('app.audit_actor_name','Synthetic Actor',true);perform set_config('app.audit_context',${literal(JSON.stringify(ctx))},true);end;$$;`
