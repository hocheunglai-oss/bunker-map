// Actual parser schema, audit/undo, backup marker and review SQL. All data is
// synthetic and the PostgreSQL-compatible engine is private and in memory.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { transformSync } from "esbuild"
import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server"
import * as parserReports from "../../lib/parserReports.ts"
import { parserReportAccessPage } from "../../lib/parserReportAccess.ts"

const { PGlite } = await import(process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite")
const source = file => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
export const reviewMigrationPath = "supabase/migrations/20261012095521_atomic_parser_report_review.sql"
export const originalVersion = "2099-10-12T00:00:00.123456+00:00"
export const reportId = "11111111-1111-4111-8111-111111111111"

export async function parserReviewFixture({ source: reportSource = "enquiryworksheet", metadata = {}, status = "new", migration = true } = {}) {
  const db = new PGlite()
  const auditSource = source("supabase/audit_log.sql")
  const auditStart = auditSource.indexOf("create table if not exists public.audit_logs (")
  const enableStart = auditSource.indexOf("create or replace function public.audit_enable_table(p_table regclass)")
  const auditEnd = auditSource.indexOf("$$;", enableStart) + 3
  assert.ok(auditStart >= 0 && enableStart > auditStart && auditEnd > enableStart)
  await db.exec(`
    set time zone 'UTC';
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to service_role;
    create table public.office_calendar_store(key text primary key,payload jsonb);
    ${auditSource.slice(auditStart, auditEnd)}
    ${source("supabase/migrations/20260713050709_parser_reports.sql")}
    ${source("supabase/migrations/20260723101257_add_backup_export_epoch.sql").split("\ndo $$")[0]}
    create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.parser_reports for each statement execute function private.record_bunker_map_backup_mutation();
    create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.audit_logs for each statement execute function private.record_bunker_map_backup_mutation();
    ${migration ? source(reviewMigrationPath) : ""}
    set role service_role;
  `)
  await db.query(`insert into public.parser_reports(id,fingerprint,source,raw_text,parser_output,corrected_output,note,metadata,status,created_at,last_reported_at,updated_at)
    values($1::uuid,'synthetic-fingerprint',$2,'SYNTHETIC RAW ENQUIRY','SYNTHETIC PARSER OUTPUT','ORIGINAL CORRECTION','ORIGINAL NOTE',$3::jsonb,$4,$5::timestamptz,$5::timestamptz,$5::timestamptz)`,
  [reportId, reportSource, JSON.stringify(metadata), status, originalVersion])

  const controls = { permission: "edit", holdReads: 0, beforeRpc: null, damage: false, rpcError: null }
  const requests = [], permissions = [], readWaiters = []
  let clients = 0
  async function row() {
    return (await db.query("select to_jsonb(report) as row from public.parser_reports report where id=$1::uuid", [reportId])).rows[0]?.row ?? null
  }
  async function state() {
    return (await db.query(`select
      (select to_jsonb(report) from public.parser_reports report where id=$1::uuid) as report,
      (select coalesce(jsonb_agg(to_jsonb(audit) order by occurred_at,id),'[]'::jsonb) from public.audit_logs audit) as audit,
      public.get_bunker_map_backup_export_fence() as fence`, [reportId])).rows[0]
  }
  async function rpc(name, args) {
    if (name === "save_parser_report_review") {
      return (await db.query("select to_jsonb(saved) as row from public.save_parser_report_review($1::uuid,$2,$3::timestamptz,$4,$5,$6,$7::jsonb) saved",
        [args.p_id,args.p_source,args.p_expected_updated_at,args.p_action,args.p_corrected_output,args.p_note,JSON.stringify(args.p_metadata)])).rows.map(result => result.row)
    }
    assert.equal(name, "upsert_parser_report")
    return (await db.query("select to_jsonb(saved) as row from public.upsert_parser_report($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14::timestamptz) saved",
      [args.p_fingerprint,args.p_source,args.p_context,args.p_raw_text,args.p_cleaned_text,args.p_parser_output,args.p_corrected_output,args.p_note,args.p_page_url,JSON.stringify(args.p_metadata),args.p_created_by_username,args.p_created_by_display_name,args.p_app_commit,args.p_reported_at])).rows.map(result => result.row)
  }
  async function upsert() {
    return (await rpc("upsert_parser_report", {
      p_fingerprint: "synthetic-fingerprint", p_source: reportSource, p_context: "shortened-enquiry",
      p_raw_text: "SYNTHETIC RAW ENQUIRY", p_cleaned_text: "", p_parser_output: "SYNTHETIC PARSER OUTPUT",
      p_corrected_output: "ORIGINAL CORRECTION", p_note: "", p_page_url: "/synthetic",
      p_metadata: parserReports.pendingParserReportMetadata({}), p_created_by_username: "SYNTHETIC REPORTER",
      p_created_by_display_name: "Synthetic Reporter", p_app_commit: "synthetic", p_reported_at: originalVersion,
    }))[0]
  }
  const syntheticFetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    assert.equal(url.origin, "https://synthetic-database.invalid")
    requests.push({ method: request.method, url: request.url, body: request.method === "POST" ? await request.clone().json() : null })
    await db.query("select set_config('request.headers',$1,false)", [JSON.stringify({ "x-bunker-admin-user": "SYNTHETIC EDITOR", "x-bunker-admin-page-id": parserReportAccessPage(reportSource, true) })])
    if (url.pathname === "/rest/v1/parser_reports") {
      assert.equal(request.method, "GET", "review writes must use the bounded atomic RPC, not URL predicates")
      assert.ok(request.url.length < 1000, "large report content must not be encoded in a database URL")
      const id = url.searchParams.get("id")?.slice(3), selectedSource = url.searchParams.get("source")?.slice(3)
      const rows = (await db.query("select to_jsonb(report) as row from public.parser_reports report where ($1::uuid is null or id=$1::uuid) and source=$2 order by last_reported_at desc", [id ?? null, selectedSource])).rows.map(result => result.row)
      const response = Response.json(rows)
      if (controls.holdReads) {
        return new Promise(resolve => {
          readWaiters.push(() => resolve(response))
          if (readWaiters.length === controls.holdReads) { controls.holdReads = 0; readWaiters.splice(0).forEach(release => release()) }
        })
      }
      return response
    }
    const name = url.pathname.split("/rest/v1/rpc/")[1]
    assert.ok(name, `Unexpected synthetic database path: ${url.pathname}`)
    if (controls.beforeRpc) { const before = controls.beforeRpc; controls.beforeRpc = null; await before() }
    try {
      if (controls.rpcError) throw controls.rpcError
      const data = await rpc(name, await request.json())
      return Response.json(controls.damage ? [] : data)
    } catch (error) {
      return Response.json({ code: error.code, message: error.message, details: null, hint: null }, { status: 400 })
    }
  }
  function client() {
    clients += 1
    return createClient("https://synthetic-database.invalid", "synthetic-only-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: syntheticFetch },
    })
  }
  const modules = {
    crypto: { createHash }, "next/server": { NextResponse },
    "@/lib/parserReports": parserReports,
    "@/lib/parserReportAccess": { parserReportAccessPage },
    "@/lib/adminAuth": { requireAdminPagePermission: async (page, access) => guard("admin", page, access) },
    "@/lib/spcAuth": { requireSpcPagePermission: async (page, access) => guard("spc", page, access) },
    "@/lib/adminAudit": { createAdminAuditContext: () => ({}), createAdminAuditedSupabaseClient: client },
    "@/lib/spcAudit": { createSpcAuditContext: () => ({}), createSpcAuditedSupabaseClient: client },
    "@/lib/serverTiming": { timedJson: (_route, _start, data) => NextResponse.json(data) },
  }
  function guard(kind, page, access) {
    permissions.push({ kind, page, access })
    if (controls.permission === "anonymous") throw Error("Unauthorized")
    if (controls.permission !== "edit" && access === "edit") throw Error("Forbidden")
    return { username: "SYNTHETIC EDITOR", displayName: "Synthetic Editor" }
  }
  const api = { exports: {} }
  const code = transformSync(source("app/api/parser-reports/route.ts"), { loader: "ts", format: "cjs", target: "node24" }).code
  new Function("require", "module", "exports", "process", code)(name => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected route dependency: ${name}`)
    return modules[name]
  }, api, api.exports, { env: {} })
  async function request(body) {
    const response = await api.exports.POST(new Request("https://synthetic-app.invalid/api/parser-reports", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: reportSource, id: reportId, ...body }),
    }))
    return { status: response.status, body: await response.json() }
  }
  return { db, row, state, rpc, upsert, request, controls, requests, permissions, clients: () => clients, source: reportSource, close: () => db.close(),
    async input(action = "submit-ai") { return { action, expectedUpdatedAt: (await row()).updated_at, correctedOutput: "MY CORRECTION", note: "MY NOTE" } },
  }
}
