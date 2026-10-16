import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { createRequire } from "node:module"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const require = createRequire(join(root, "package.json"))
const { transformSync } = require("esbuild")
export const feedbackId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
export const feedbackActorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
export const feedbackActor = { authenticated: true, userId: feedbackActorId, username: "admin-a@example.invalid",
  displayName: "Synthetic Admin A", role: "ADMIN", permissions: { "spc-feedback": "edit" }, mustChangePassword: false }
export function feedbackSchemaSql() {
  const schema = readFileSync(join(root, "supabase/spc_schema.sql"), "utf8")
  const trigger = schema.match(/create or replace function public\.set_spc_updated_at\(\)[\s\S]*?\$\$;/)?.[0]
  assert.ok(trigger)
  // Actual table and timestamp-trigger definitions. Audit installer is a no-op:
  // these fixtures certify CAS/permissions, not the independent audit subsystem.
  return "set time zone 'UTC';create role anon;create role authenticated;create role service_role bypassrls;" +
    "grant usage on schema public to service_role;create table public.spc_users(id uuid primary key);" +
    "create function public.audit_enable_table(regclass) returns void language sql as $$ select $$;" +
    trigger + readFileSync(join(root, "supabase/migrations/20260812095000_create_spc_feedback.sql"), "utf8")
}
export const feedbackSeedSql = "insert into public.spc_users values('" + feedbackActorId + "');" +
  "insert into public.spc_feedback(id,category,title,message,created_by_user_id,created_by_username,created_by_display_name,created_at,updated_at)" +
  "values('" + feedbackId + "','PROBLEM','Synthetic issue','Synthetic details','" + feedbackActorId +
  "','submitter@example.invalid','Synthetic Submitter','2026-10-16T00:00:00.123456Z','2026-10-16T00:00:00.123456Z');"
export const feedbackStateSql = "select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') as rows from public.spc_feedback t"

export function feedbackRuntime(query) {
  const controls = { actor: { ...feedbackActor }, fault: "", transformRow: null, beforeExecute: null }
  const writes = [], calls = [], auditHeaders = [], cache = new Map()
  const client = { from(table) {
    assert.equal(table, "spc_feedback")
    let payload, limit = 250, mode = "read"
    const filters = []
    const q = { select() { return q }, order() { return q }, limit(value) { limit = value; return q },
      eq(key, value) { assert.match(key, /^[a-z_]+$/); filters.push([key, value]); return q },
      update(value) { payload = value; mode = "update"; return q },
      insert(value) { payload = value; mode = "insert"; return q },
      single() { return execute("one") }, maybeSingle() { return execute("optional") },
      then(resolve, reject) { return execute("many").then(resolve, reject) } }
    async function execute(shape) {
      calls.push({ mode, filters })
      if (controls.beforeExecute) await controls.beforeExecute({ mode, filters, payload })
      if (controls.fault === "database") return { data: null, error: { message: "Synthetic database failure" } }
      if (controls.fault === "null-read") return { data: null, error: null }
      const params = [], bind = value => { params.push(value); return "$" + params.length }
      let sql
      if (mode === "insert") {
        const entries = Object.entries(payload)
        sql = "insert into public.spc_feedback(" + entries.map(([key]) => key).join(",") + ") values(" + entries.map(([, value]) => bind(value)).join(",") + ") returning *"
      } else {
        const set = mode === "update" ? Object.entries(payload).map(([key, value]) => {
          assert.match(key, /^[a-z_]+$/); return key + "=" + bind(value)
        }).join(",") : ""
        const where = filters.length ? " where " + filters.map(([key, value]) => key + "=" + bind(value)).join(" and ") : ""
        sql = mode === "update" ? "update public.spc_feedback set " + set + where + " returning *" :
          "select * from public.spc_feedback" + where + " order by created_at desc limit " + limit
      }
      try {
        // JSON in PostgreSQL retains raw timestamp microseconds even when the
        // fixture driver's ordinary timestamp decoder returns a JS Date.
        const result = await query(mode === "read" ? "select to_jsonb(t) as record from (" + sql + ") t" :
          "with changed as (" + sql + ") select to_jsonb(t) as record from changed t", params)
        let rows = result.rows.map(row => row.record)
        if (mode !== "read") writes.push({ mode, filters, payload, affected: rows.length })
        if (controls.transformRow) rows = rows.map(controls.transformRow)
        return { data: shape === "many" ? rows : rows[0] || null,
          error: shape === "one" && rows.length !== 1 ? { code: "PGRST116", message: "Singular response required" } : null }
      } catch (error) { return { data: null, error } }
    }
    return q
  } }
  const mocked = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@supabase/supabase-js": { createClient(_url, _key, options) { auditHeaders.push(options.global.headers); return client } },
    "@/lib/spcAuth": { async requireSpcSession() { if (!controls.actor) throw Error("Unauthorized"); return controls.actor },
      hasSpcPagePermission(session, page, access) { return session.authenticated && !session.mustChangePassword &&
        load("@/lib/spcPages").canAccessSpcPage(session.permissions, page, access) } },
  }
  function load(name, parent = root) {
    if (Object.hasOwn(mocked, name)) return mocked[name]
    if (!name.startsWith("@/") && !name.startsWith(".")) return require(name)
    const unresolved = name.startsWith("@/") ? join(root, name.slice(2)) : join(parent, name)
    const file = ["", ".ts", ".json", ".js"].map(ext => unresolved + ext).find(existsSync)
    assert.ok(file, name)
    if (file.endsWith(".json")) return JSON.parse(readFileSync(file, "utf8"))
    if (cache.has(file)) return cache.get(file).exports
    const mod = { exports: {} }; cache.set(file, mod)
    const code = transformSync(readFileSync(file, "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
    new Function("require", "module", "exports", "process", code)(request => load(request, dirname(file)), mod, mod.exports,
      { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only-no-remote" } })
    return mod.exports
  }
  const route = load("@/app/api/spc/feedback/route")
  async function send(method = "GET", body) {
    const response = await route[method](new Request("https://synthetic.invalid/api/spc/feedback", { method,
      ...(method === "GET" ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) }))
    return { status: response.status, headers: response.headers, body: await response.json() }
  }
  return { send, controls, calls, writes, auditHeaders }
}
