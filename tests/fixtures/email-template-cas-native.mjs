import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { setupNativeCcinfo, literal } from "./native-postgres-ccinfo.mjs"
export { literal }

export const migrationPath = "supabase/migrations/20261022103219_nonretryable_email_template_conflicts.sql"
export const source = file => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
export const json = value => `${literal(JSON.stringify(value))}::jsonb`
export const signatures = [
  "public.save_email_template_canonical(jsonb,bigint,timestamptz)",
  "public.delete_email_template_canonical(text,bigint,timestamptz)",
  "public.replace_email_template_library_canonical(jsonb,text)",
  "public.repair_email_templates_canonical(jsonb)",
]
export const inputTemplate = (changes = {}) => ({ id: "target", title: "Synthetic target", slug: "target", subject: "Subject", body_html: "<p>Body</p>", body_text: "Body", ...changes })
export const saveSql = (row, revision = "null", timestamp = "null") => `select public.save_email_template_canonical(${json(row)},${revision},${timestamp});`
export const deleteSql = (id = "target", revision = "null", timestamp = "null") => `select public.delete_email_template_canonical(${literal(id)},${revision},${timestamp});`

export async function setupTemplateCas({ repaired = process.env.TEMPLATE_CAS_TEST_BASELINE !== "1" } = {}) {
  const audit = source("supabase/audit_log.sql")
  const auditEnd = audit.indexOf("$$;", audit.indexOf("create or replace function public.audit_enable_table(")) + 3
  const backup = source("supabase/migrations/20260723101257_add_backup_export_epoch.sql")
  const f = await setupNativeCcinfo(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema private; create schema extensions;
    grant usage on schema public,private,extensions to service_role;
    -- This fixture's native runtime lacks pgcrypto. Only its SHA-256 call is
    -- bridged to the genuine PostgreSQL built-in, not claimed as pgcrypto QA.
    create function extensions.digest(bytea,text) returns bytea language sql immutable as $$ select case when $2='sha256' then pg_catalog.sha256($1) else null end $$;
    ${audit.slice(audit.indexOf("create table if not exists public.audit_logs ("), auditEnd)}
    ${source("supabase/email_templates.sql").replace('create extension if not exists "pgcrypto";', "")}
    create table public.office_calendar_store(key text primary key);
    ${source("supabase/migrations/20260723120428_outlook_template_canonical_writes.sql")}
    alter function public.save_email_template_canonical(jsonb,bigint,timestamptz) set statement_timeout='20s';
    alter function public.replace_email_template_library_canonical(jsonb,text) set statement_timeout='20s';
    alter function public.repair_email_templates_canonical(jsonb) set statement_timeout='20s';
    ${source("supabase/migrations/20260723123443_guard_email_template_library_nonempty.sql")}
    ${backup.slice(0, backup.indexOf("\ndo $$"))}
    select public.audit_enable_table('public.email_templates');
    create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.email_templates for each statement execute function private.record_bunker_map_backup_mutation();
    create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.audit_logs for each statement execute function private.record_bunker_map_backup_mutation();
    insert into public.email_templates(id,title,slug) values ('target','Synthetic target','target'),('remaining','Synthetic remaining','remaining');
  `)
  try {
    f.identities = () => f.owner.one(`select jsonb_agg(jsonb_build_object('oid',p.oid,'name',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),'invoker',not p.prosecdef,'config',p.proconfig,'volatility',p.provolatile,'parallel',p.proparallel,'defaults',pg_get_expr(p.proargdefaults,0),'acl',p.proacl::text,'anon',has_function_privilege('anon',p.oid,'execute'),'authenticated',has_function_privilege('authenticated',p.oid,'execute'),'service',has_function_privilege('service_role',p.oid,'execute')) order by p.oid) from pg_proc p where p.oid=any(array[${signatures.map(s => `${literal(s)}::regprocedure::oid`).join(",")}]);`)
    f.beforeIdentities = await f.identities()
    f.beforeBodies = await f.owner.one(`select jsonb_object_agg(proname,prosrc) from pg_proc where oid=any(array[${signatures.map(s => `${literal(s)}::regprocedure::oid`).join(",")}]);`)
    if (repaired) await f.owner.query(`begin; ${source(migrationPath)} commit;`)
    f.snapshot = () => f.owner.one(`select jsonb_build_object('templates',(select jsonb_agg(to_jsonb(t) order by id) from public.email_templates t),'audit',(select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from public.audit_logs a),'fence',public.get_bunker_map_backup_export_fence());`)
    f.execute = async sql => {
      const session = await f.session("template-cas")
      try {
        await session.begin("synthetic-template-editor")
        const rows = await session.query(sql)
        await session.query("commit;")
        return rows.length ? JSON.parse(rows.at(-1)) : null
      } finally { await session.close() }
    }
    f.libraryRevision = () => f.owner.one("select to_jsonb(public.email_template_library_revision());")
    assert.ok(f.root && f.socket)
    return f
  } catch (error) { await f.close(); throw error }
}
