import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { transformSync } from "esbuild"
import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server.js"

const { PGlite } = await import(process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite")
const source = file => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
function load(file, modules, env = {}) {
  const module = { exports: {} }
  const code = transformSync(source(file), { loader: "ts", format: "cjs", target: "node24" }).code
  new Function("require", "module", "exports", "process", code)(name => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected fixture dependency: ${name}`)
    return modules[name]
  }, module, module.exports, { env })
  return module.exports
}

export async function templateDeletionFixture() {
  const db = new PGlite()
  const canonical = source("supabase/migrations/20260723120428_outlook_template_canonical_writes.sql")
  const start = canonical.indexOf("create or replace function public.delete_email_template_canonical(")
  const end = canonical.indexOf("create or replace function public.replace_email_template_library_canonical(", start)
  const audit = source("supabase/audit_log.sql")
  const auditStart = audit.indexOf("create table if not exists public.audit_logs (")
  const enableStart = audit.indexOf("create or replace function public.audit_enable_table(p_table regclass)")
  const auditEnd = audit.indexOf("$$;", enableStart) + 3
  assert.ok(start >= 0 && end > start && auditStart >= 0 && auditEnd > auditStart)
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    ${audit.slice(auditStart, auditEnd)}
    grant usage on schema public, private to service_role;
    ${source("supabase/email_templates.sql").replace('create extension if not exists "pgcrypto";', "")}
    ${canonical.slice(start, end)}
    revoke execute on function public.delete_email_template_canonical(text,bigint,timestamptz) from public,anon,authenticated;
    grant execute on function public.delete_email_template_canonical(text,bigint,timestamptz) to service_role;
    ${source("supabase/migrations/20260723123443_guard_email_template_library_nonempty.sql")}
    ${source("supabase/migrations/20260723101257_add_backup_export_epoch.sql").split("do $$")[0]}
    select public.audit_enable_table('public.email_templates'::regclass);
    create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.email_templates for each statement execute function private.record_bunker_map_backup_mutation();
    create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.audit_logs for each statement execute function private.record_bunker_map_backup_mutation();
    insert into public.email_templates(id,title,slug,updated_at) values ('target','Synthetic target','synthetic-target','2026-10-14T00:00:00Z'),('remaining','Synthetic remaining','synthetic-remaining','2026-10-14T00:00:00Z');
    set role service_role;
    select set_config('request.headers','{"x-bunker-admin-user":"SC","x-bunker-admin-page-id":"email-templates"}',false);
  `)
  const requests = [], permissions = []
  const controls = { permission: "edit", rpcError: null }
  let recipientLoads = 0
  const syntheticFetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    assert.equal(url.origin, "https://synthetic-database.invalid", "no hosted network request is allowed")
    requests.push({ method: request.method, path: url.pathname, body: request.method === "POST" ? await request.clone().json() : null })
    try {
      if (url.pathname === "/rest/v1/rpc/delete_email_template_canonical") {
        if (controls.rpcError) throw controls.rpcError
        const body = await request.json()
        const result = await db.query("select public.delete_email_template_canonical($1,$2::bigint,$3::timestamptz) as result", [body.p_id, body.p_expected_revision, body.p_expected_updated_at])
        return Response.json(result.rows[0].result)
      }
      if (url.pathname === "/rest/v1/email_templates" && request.method === "GET") {
        const id = url.searchParams.get("id")?.slice(3)
        const result = await db.query("select to_jsonb(t) as result from public.email_templates t where id=$1", [id])
        return Response.json(result.rows[0]?.result ?? null)
      }
      throw Error(`Unexpected fixture request: ${url.pathname}`)
    } catch (error) { return Response.json({ code: error.code, message: error.message, details: null, hint: null }, { status: 400 }) }
  }
  const client = () => createClient("https://synthetic-database.invalid", "synthetic-only-key", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: syntheticFetch } })
  const canonicalUtils = load("lib/emailTemplateCanonicalUtils.ts", { "node:crypto": { createHash }, crypto: { createHash } })
  const library = load("lib/emailTemplates.ts", {
    "@supabase/supabase-js": { createClient: client },
    "@/lib/adminAuth": { requireAdminSession: async () => ({ username: "SC" }) },
    "@/lib/adminAudit": { createAdminAuditedSupabaseClient: client },
    "@/lib/emailTemplateSanitizer": { sanitizeEmailTemplate: template => template, findTemplateFormattingIssues: () => [] },
    "@/lib/outlookTemplateRecipientResolver": { loadOutlookTemplateRecipientResolver: async () => { recipientLoads += 1; throw Error("Synthetic unavailable certification must not prevent deletion") } },
    "@/lib/emailTemplateCanonicalUtils": canonicalUtils,
    "@/lib/emailTemplateSlug": { slugifyEmailTemplate: value => value },
  }, { SUPABASE_SERVICE_ROLE_KEY: "synthetic-only-key", NEXT_PUBLIC_SUPABASE_URL: "https://synthetic-database.invalid" })
  const api = load("app/api/admin/email-templates/route.ts", {
    "next/server": { NextResponse }, "@/lib/emailTemplates": library,
    "@/lib/adminAudit": { createAdminAuditContext: () => ({ username: "SC" }) },
    "@/lib/adminAuth": { requireAdminPagePermission: async (page, access) => { permissions.push({ page, access }); if (controls.permission === "anonymous") throw Error("Unauthorized"); if (access === "edit" && controls.permission !== "edit") throw Error("Forbidden"); return { username: "SC" } } },
    "@/lib/sharedAddressBookServer": { loadSharedAddressBookRecipients: async () => { throw Error("Deletion must not load recipients") } },
  })
  async function request(body = {}) {
    const response = await api.POST(new Request("https://synthetic-app.invalid/api/admin/email-templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete-template", id: "target", expectedRevision: 1, ...body }) }))
    return { status: response.status, body: await response.json() }
  }
  async function get(id) { const response = await api.GET(new Request(`https://synthetic-app.invalid/api/admin/email-templates?id=${id}`)); return { status: response.status, body: await response.json() } }
  async function state() { return (await db.query("select (select jsonb_agg(to_jsonb(t) order by id) from public.email_templates t) templates,(select coalesce(jsonb_agg(to_jsonb(a) order by occurred_at,id),'[]') from public.audit_logs a) audit,public.get_bunker_map_backup_export_fence() fence")).rows[0] }
  return { db, request, get, state, controls, requests, permissions, recipientLoads: () => recipientLoads, close: () => db.close() }
}
