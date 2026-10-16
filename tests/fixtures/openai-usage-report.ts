import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { transformSync } from "esbuild"
import * as contract from "../../lib/openAiUsageReport"

export function usageReportFixture(days: contract.OpenAiUsageDays = 30): contract.OpenAiUsageReport {
  const generatedAt = "2026-10-16T05:00:00.000Z"
  const counts = { inputTokens: 3, cachedInputTokens: 1, outputTokens: 2, reasoningTokens: 1, totalTokens: 5, webSearchCalls: 1 }
  return { generatedAt, since: new Date(Date.parse(generatedAt) - days * 86400000).toISOString(), days,
    totals: { requests: 1, errors: 0, ...counts },
    pages: [{ pageId: "synthetic", pagePath: "/admin", requests: 1, errors: 0, ...counts, durationMs: 7,
      averageDurationMs: 7, tokenPercentage: 100, requestPercentage: 100, features: ["synthetic"], models: ["test"] }],
    recent: [{ occurred_at: "2026-10-16T04:59:59Z", page_id: "synthetic", page_path: "/admin", feature: "synthetic", model: "test", status: "success",
      input_tokens: 3, cached_input_tokens: 1, output_tokens: 2, reasoning_tokens: 1, total_tokens: 5, web_search_calls: 1, duration_ms: 7 }] }
}

export function usageRouteHarness(rpc?: (days: number) => Promise<{ data: unknown; error: unknown }>) {
  const controls = { auth: "", configured: true, throw: false }
  const calls: Array<{ name: string; args: unknown }> = [], permissions: Array<{ page: string; access: string }> = []
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@/lib/openAiUsageReport": contract,
    "@/lib/adminAuth": { async requireAdminPagePermission(page: string, access: string) { permissions.push({ page, access }); if (controls.auth) throw Error(controls.auth) } },
    "@supabase/supabase-js": { createClient(url: string, key: string, options: unknown) {
      assert.equal(url, "https://synthetic.invalid"); assert.equal(key, "synthetic-only")
      assert.deepEqual(options, { auth: { persistSession: false, autoRefreshToken: false } })
      calls.push({ name: "createClient", args: null })
      return { async rpc(name: string, args: { p_days: number }) {
        calls.push({ name, args }); if (controls.throw) throw Error("PRIVATE TRANSPORT DETAIL")
        return rpc ? rpc(args.p_days) : { data: usageReportFixture(args.p_days as contract.OpenAiUsageDays), error: null }
      } }
    } },
  }
  const loaded = { exports: {} as { GET: (request: Request) => Promise<Response> } }
  const code = transformSync(readFileSync(new URL("../../app/api/admin/openai-usage/route.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
  const environment = { get NEXT_PUBLIC_SUPABASE_URL() { return controls.configured ? "https://synthetic.invalid" : "" }, SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" }
  new Function("require", "module", "exports", "process", code)((name: string) => { assert.ok(Object.hasOwn(modules, name), name); return modules[name] }, loaded, loaded.exports, { env: environment })
  return { controls, calls, permissions, send: (days: string | number = 30) => loaded.exports.GET(new Request(`https://synthetic.invalid/api/admin/openai-usage?days=${days}`)) }
}
