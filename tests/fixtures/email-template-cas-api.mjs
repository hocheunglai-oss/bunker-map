import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { transformSync } from "esbuild"
import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server.js"
import { source, json, literal } from "./email-template-cas-native.mjs"

function load(file, modules, env = {}) {
  const fixtureModule = { exports: {} }
  const code = transformSync(source(file), { loader: "ts", format: "cjs", target: "node24" }).code
  Function("require", "module", "exports", "process", code)(name => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected fixture import: ${name}`)
    return modules[name]
  }, fixtureModule, fixtureModule.exports, { env })
  return fixtureModule.exports
}

export function templateCasApi(f) {
  const controls = { permission: "edit", rpcError: null, beforeRpc: null }
  const requests = [], permissions = [], databaseStates = []
  let recipientLoads = 0
  const syntheticFetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    assert.equal(url.origin, "https://synthetic-template-db.invalid", "all SDK requests must be intercepted")
    requests.push({ method: request.method, path: url.pathname })
    if (url.pathname === "/rest/v1/email_templates" && request.method === "GET") {
      assert.ok(f, "native fixture required for a table read")
      const rows = (await f.snapshot()).templates
      return Response.json(rows)
    }
    assert.equal(request.method, "POST")
    const args = await request.json()
    const paths = {
      "/rest/v1/rpc/save_email_template_canonical": () => `select public.save_email_template_canonical(${json(args.p_template)},${args.p_expected_revision ?? "null"},${args.p_expected_updated_at ? `${literal(args.p_expected_updated_at)}::timestamptz` : "null"});`,
      "/rest/v1/rpc/delete_email_template_canonical": () => `select public.delete_email_template_canonical(${literal(args.p_id)},${args.p_expected_revision ?? "null"},${args.p_expected_updated_at ? `${literal(args.p_expected_updated_at)}::timestamptz` : "null"});`,
      "/rest/v1/rpc/replace_email_template_library_canonical": () => `select public.replace_email_template_library_canonical(${json(args.p_templates)},${literal(args.p_expected_library_revision)});`,
      "/rest/v1/rpc/repair_email_templates_canonical": () => `select public.repair_email_templates_canonical(${json(args.p_repairs)});`,
    }
    assert.ok(Object.hasOwn(paths, url.pathname), url.pathname)
    if (controls.beforeRpc) await controls.beforeRpc(url.pathname)
    const before = f ? await f.snapshot() : null
    try {
      if (controls.rpcError) throw controls.rpcError
      assert.ok(f, "native fixture required for a real SQL call")
      const result = await f.execute(paths[url.pathname]())
      databaseStates.push({ before, after: await f.snapshot(), success: true })
      return Response.json(result)
    } catch (error) {
      const message = error.message.match?.(/ERROR:\s+[A-Z0-9]{5}: ([^\n]*)/)?.[1] ?? error.message
      databaseStates.push({ before, after: f ? await f.snapshot() : null, success: false, code: error.code, message })
      return Response.json({ code: error.code, message, details: error.details ?? "private synthetic diagnostic", hint: null }, { status: 400 })
    }
  }
  const client = () => createClient("https://synthetic-template-db.invalid", "synthetic-only-key", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: syntheticFetch } })
  const utils = load("lib/emailTemplateCanonicalUtils.ts", { "node:crypto": { createHash } })
  const library = load("lib/emailTemplates.ts", {
    "@supabase/supabase-js": { createClient: client },
    "@/lib/adminAuth": { requireAdminSession: async () => ({ username: "synthetic" }) },
    "@/lib/adminAudit": { createAdminAuditedSupabaseClient: client },
    "@/lib/emailTemplateSanitizer": { sanitizeEmailTemplate: value => ({ ...value, bodyText: value.bodyText?.trim() }), findTemplateFormattingIssues: () => ["synthetic-whitespace"] },
    "@/lib/outlookTemplateRecipientResolver": { loadOutlookTemplateRecipientResolver: async () => { recipientLoads += 1; return { resolve: () => ({}) } } },
    "@/lib/emailTemplateCanonicalUtils": utils,
    "@/lib/emailTemplateSlug": { slugifyEmailTemplate: value => value },
  }, { SUPABASE_SERVICE_ROLE_KEY: "synthetic-only-key", NEXT_PUBLIC_SUPABASE_URL: "https://synthetic-template-db.invalid" })
  const api = load("app/api/admin/email-templates/route.ts", {
    "next/server": { NextResponse }, "@/lib/emailTemplates": library,
    "@/lib/adminAudit": { createAdminAuditContext: () => ({ username: "synthetic" }) },
    "@/lib/adminAuth": { requireAdminPagePermission: async (page, access) => {
      permissions.push({ page, access })
      if (controls.permission === "anonymous") throw Error("Unauthorized")
      if (controls.permission !== "edit") throw Error("Forbidden")
      return { username: "synthetic" }
    } },
    "@/lib/sharedAddressBookServer": {},
  })
  const template = { id: "target", title: "Synthetic target", slug: "target", subject: "Subject", folder: "", from: "", to: "", cc: "", bcc: "", bodyHtml: "<p>Body</p>", bodyText: "Body", tags: [], placeholders: [], recipientResolution: {}, revision: 1 }
  async function request(body) {
    const response = await api.POST(new Request("https://synthetic-app.invalid/api/admin/email-templates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))
    return { status: response.status, body: await response.json() }
  }
  return { controls, requests, permissions, databaseStates, request, template, recipientLoads: () => recipientLoads }
}
