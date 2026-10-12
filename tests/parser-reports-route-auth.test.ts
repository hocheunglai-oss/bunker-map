import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import ts from "typescript"
import { NextResponse } from "next/server"
import { parserReportAccessPage } from "../lib/parserReportAccess"
import * as parserReports from "../lib/parserReports"
import { spcPrivateJson } from "../lib/spcResponse"

type Permission = "anonymous" | "none" | "view" | "edit"
type Route = {
  GET: (request: Request) => Promise<Response>
  POST: (request: Request) => Promise<Response>
}

const fixture: parserReports.ParserReportRow = {
  id: "synthetic-report",
  fingerprint: "synthetic-fingerprint",
  source: "enquiryworksheet",
  context: "shortened-enquiry",
  raw_text: "PRIVATE ENQUIRY FIXTURE / VLSFO 100MT",
  cleaned_text: "PRIVATE ENQUIRY FIXTURE / VLSFO 100MT",
  parser_output: "private enquiry fixture / vlsfo 100mts",
  corrected_output: "private enquiry fixture / vlsfo 100mts",
  note: "PRIVATE REVIEW NOTE",
  page_url: "/admin/enquiryworksheet",
  metadata: parserReports.pendingParserReportMetadata({ aiFixOutput: "AI FIXTURE" }),
  status: "new",
  duplicate_count: 1,
  created_at: "2026-10-09T00:00:00.000Z",
  last_reported_at: "2026-10-09T00:00:00.000Z",
  created_by_username: "synthetic-user",
  created_by_display_name: "Synthetic User",
  app_commit: "synthetic-commit",
  updated_at: "2026-10-09T00:00:00.000Z",
}

function harness(options: {
  route?: "direct" | "canonical"
  admin?: Permission
  spc?: Permission
  worksheet?: Permission
  databaseError?: string
  rows?: parserReports.ParserReportRow[]
} = {}) {
  let clients = 0
  let reads = 0
  let writes = 0
  const permissions: string[] = []
  const rows = options.rows || [fixture, { ...fixture, id: "synthetic-spc-report", source: "spc" as const }]

  function guard(kind: "admin" | "spc", page: string, access: "view" | "edit") {
    permissions.push(`${kind}:${page}:${access}`)
    const permission = kind === "spc"
      ? options.spc || "view"
      : page === "enquiry-worksheet"
        ? options.worksheet || "view"
        : options.admin || "view"
    if (permission === "anonymous") throw new Error("Unauthorized")
    if (permission === "none" || (access === "edit" && permission !== "edit")) {
      throw new Error("Forbidden")
    }
    return { username: "synthetic-user", displayName: "Synthetic User" }
  }

  function createClient() {
    clients += 1
    return {
      from(table: string) {
        assert.equal(table, "parser_reports")
        const filters: Record<string, unknown> = {}
        let update: Record<string, unknown> | null = null
        const query = {
          select() { return query },
          eq(key: string, value: unknown) { filters[key] = value; return query },
          order() { return query },
          update(value: Record<string, unknown>) { update = value; return query },
          async limit() {
            reads += 1
            return {
              data: rows.filter((row) => !filters.source || row.source === filters.source),
              error: options.databaseError ? new Error(options.databaseError) : null,
            }
          },
          async maybeSingle() { reads += 1; return { data: fixture, error: null } },
          async single() { writes += 1; return { data: { ...fixture, ...update }, error: null } },
        }
        return query
      },
      async rpc(name: string, args: Record<string, unknown>) {
        assert.equal(name, "upsert_parser_report")
        writes += 1
        return {
          data: [{ ...fixture, raw_text: args.p_raw_text, parser_output: args.p_parser_output,
            corrected_output: args.p_corrected_output, metadata: args.p_metadata }],
          error: null,
        }
      },
    }
  }

  const stubs: Record<string, unknown> = {
    crypto: { createHash: () => ({ update() { return this }, digest: () => "synthetic-fingerprint" }) },
    "@supabase/supabase-js": { createClient },
    "next/server": { NextResponse },
    "@/lib/adminAuth": { requireAdminPagePermission: async (page: string, access: "view" | "edit") => guard("admin", page, access) },
    "@/lib/spcAuth": { requireSpcPagePermission: async (page: string, access: "view" | "edit") => guard("spc", page, access) },
    "@/lib/spcResponse": { spcPrivateJson },
    "@/lib/adminAudit": { createAdminAuditContext: () => ({}), createAdminAuditedSupabaseClient: createClient },
    "@/lib/spcAudit": { createSpcAuditContext: () => ({}), createSpcAuditedSupabaseClient: createClient },
    "@/lib/parserReportAccess": { parserReportAccessPage },
    "@/lib/parserReports": parserReports,
    "@/lib/serverTiming": { timedJson: (_path: string, _startedAt: number, data: unknown) => NextResponse.json(data) },
  }
  const routePath = options.route === "canonical"
    ? "../app/api/parser-reports/route.ts"
    : "../app/api/parser-reports/direct/route.ts"
  const code = ts.transpileModule(readFileSync(new URL(routePath, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const apiModule = { exports: {} as Route }
  new Function("require", "module", "exports", "process", "console", code)((name: string) => {
    if (!(name in stubs)) throw new Error(`Unexpected route dependency: ${name}`)
    return stubs[name]
  }, apiModule, apiModule.exports, {
    env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" },
  }, { error() {} })

  return { route: apiModule.exports, permissions, clients: () => clients, reads: () => reads, writes: () => writes }
}

function request(query = "", body?: Record<string, unknown>) {
  return new Request(`https://example.test/api/parser-reports${query}`, body ? {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } : undefined)
}

test("direct report reader denies each authorization boundary before constructing a privileged client", async () => {
  for (const query of ["/direct", "/direct?source=all", "/direct?source=", "/direct?source=enquiryworksheet", "/direct?source=spc", "/direct?source=unknown", "/direct?source=spc&includeResolved=1", "/direct?source=spc&summary=1&queue=0", "/direct?source=spc&source=enquiryworksheet"]) {
    for (const boundary of ["admin", "spc"] as const) {
      for (const [permission, expectedStatus] of [["anonymous", 401], ["none", 403]] as const) {
        const h = harness({ [boundary]: permission })
        const response = await h.route.GET(request(query))
        assert.equal(response.status, expectedStatus, `${query} ${boundary} ${permission}`)
        assert.equal(response.headers.get("Cache-Control"), "private, no-store")
        assert.deepEqual(await response.json(), { message: expectedStatus === 401 ? "Unauthorized" : "Forbidden" })
        assert.equal(h.clients(), 0)
        assert.equal(h.reads(), 0)
        assert.equal(h.writes(), 0)
      }
    }
  }
})

test("direct diagnostic/export reader permits dual View and preserves its response schema and source modes", async () => {
  for (const source of ["all", "enquiryworksheet", "spc", "unknown"]) {
    for (const includeResolved of [false, true]) {
      const h = harness({ admin: "view", spc: "view" })
      const response = await h.route.GET(request(`/direct?source=${source}&includeResolved=${includeResolved ? 1 : 0}`))
      assert.equal(response.status, 200)
      assert.equal(response.headers.get("Cache-Control"), "private, no-store")
      const body = await response.json()
      assert.deepEqual(h.permissions, ["admin:parser-reports:view", "spc:spc-parser-reports:view"])
      assert.deepEqual(Object.keys(body).sort(), ["source", "reports", "pendingAiReports", "readyForUserReports", "counts", "updatedAt", "includeResolved"].sort())
      assert.equal(body.source, source === "unknown" ? "all" : source)
      assert.equal(body.counts.all.total, 2)
      assert.equal(body.counts.enquiryworksheet.total, 1)
      assert.equal(body.counts.spc.total, 1)
      assert.equal(body.readyForUserReports.length, source === "all" || source === "unknown" ? 2 : 1)
      assert.equal(body.readyForUserReports[0].rawText, fixture.raw_text)
      assert.equal(body.readyForUserReports[0].note, fixture.note)
      assert.equal(body.readyForUserReports[0].metadata.aiFixOutput, "AI FIXTURE")
      assert.equal(body.reports.length, includeResolved ? body.readyForUserReports.length : 0)
      assert.equal(h.clients(), 1)
      assert.equal(h.reads(), 1)
      assert.equal(h.writes(), 0)
    }
  }
})

test("direct reader preserves pending-AI default, includeResolved, and empty-result behavior", async () => {
  const queued: parserReports.ParserReportRow = {
    ...fixture,
    id: "synthetic-queued-report",
    metadata: parserReports.queuedAiParserReportMetadata(fixture.metadata, fixture.updated_at, fixture.corrected_output),
  }
  const completed: parserReports.ParserReportRow = {
    ...fixture,
    id: "synthetic-complete-report",
    status: "reviewed",
    metadata: parserReports.completedParserReportMetadata(fixture.metadata, fixture.updated_at),
  }
  for (const includeResolved of ["0", "1", "true"]) {
    const h = harness({ rows: [fixture, queued, completed] })
    const body = await (await h.route.GET(request(`/direct?includeResolved=${includeResolved}`))).json()
    assert.deepEqual(body.pendingAiReports.map((report: { id: string }) => report.id), [queued.id])
    assert.deepEqual(body.readyForUserReports.map((report: { id: string }) => report.id), [fixture.id])
    assert.equal(body.reports.length, includeResolved === "1" ? 3 : 1)
    assert.equal(body.includeResolved, includeResolved === "1")
  }
  const h = harness({ rows: [] })
  const body = await (await h.route.GET(request("/direct"))).json()
  assert.deepEqual(body.reports, [])
  assert.deepEqual(body.pendingAiReports, [])
  assert.deepEqual(body.readyForUserReports, [])
  assert.equal(body.counts.all.total, 0)
  assert.equal(body.updatedAt, null)
})

test("direct reader does not expose database error details", async () => {
  const h = harness({ databaseError: "PRIVATE DATABASE DETAIL" })
  const response = await h.route.GET(request("/direct"))
  assert.equal(response.status, 500)
  assert.equal(response.headers.get("Cache-Control"), "private, no-store")
  assert.deepEqual(await response.json(), { message: "Failed to load parser reports." })
})

test("canonical review reads still use the source-specific View permission", async () => {
  for (const [source, expected] of [["enquiryworksheet", "admin:parser-reports:view"], ["spc", "spc:spc-parser-reports:view"]]) {
    const h = harness({ route: "canonical" })
    assert.equal((await h.route.GET(request(`?source=${source}`))).status, 200)
    assert.deepEqual(h.permissions, [expected])
    assert.equal(h.writes(), 0)
  }
})

test("View cannot edit stored corrections or notes, while normal worksheet reporting keeps worksheet Edit access", async () => {
  for (const action of ["submit-ai", "review", "acknowledge"]) {
    for (const source of ["enquiryworksheet", "spc"]) {
      const h = harness({ route: "canonical" })
      const response = await h.route.POST(request("", { source, action, id: fixture.id, correctedOutput: "changed", note: "changed" }))
      assert.equal(response.status, 403)
      assert.equal(h.clients(), 0)
      assert.equal(h.reads(), 0)
      assert.equal(h.writes(), 0)
    }
  }

  const h = harness({ route: "canonical", admin: "none", worksheet: "edit" })
  const response = await h.route.POST(request("", { source: "enquiryworksheet", rawText: "normal enquiry", parserOutput: "parser result", correctedOutput: "current draft", note: "", metadata: { aiFixOutput: "AI result" } }))
  assert.equal(response.status, 200)
  assert.deepEqual(h.permissions, ["admin:enquiry-worksheet:edit"])
  assert.equal(h.writes(), 1)
  const body = await response.json()
  assert.equal(body.report.rawText, "normal enquiry")
  assert.equal(body.report.parserOutput, "parser result")
  assert.equal(body.report.metadata.aiFixOutput, "AI result")
})
