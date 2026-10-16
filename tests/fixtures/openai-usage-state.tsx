import React from "react"
import { createRoot } from "react-dom/client"
import Page from "../../app/admin/openaiusage/page"
import { AdminNavigationShell } from "../../components/AdminNavigationShell"
import { ADMIN_PAGE_DEFINITIONS } from "../../lib/adminPages"

// Full existing API shape, including measured reasoning and duration counters.
const response = (days = 30, tokens = days * 100, empty = false, pagePath = "/spc/enquiries") => {
  const generatedAt = "2026-10-16T03:00:00.000Z"
  const totals = { requests: empty ? 0 : 1, errors: 0, inputTokens: empty ? 0 : tokens,
    cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: empty ? 0 : tokens, webSearchCalls: 0 }
  return {
    generatedAt, since: new Date(Date.parse(generatedAt) - days * 86400000).toISOString(), days, totals,
    pages: empty ? [] : [{ pageId: "synthetic-usage", pagePath, ...totals, durationMs: 150,
      averageDurationMs: 150, tokenPercentage: tokens ? 100 : 0, requestPercentage: 100,
      features: ["synthetic feature"], models: ["synthetic model"] }],
    recent: empty ? [] : [{ occurred_at: "2026-10-16T02:59:59.000Z", page_id: "synthetic-usage", page_path: pagePath,
      feature: "synthetic feature", model: "synthetic model", status: "success", input_tokens: tokens,
      cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: tokens, web_search_calls: 0, duration_ms: 150 }],
  }
}
const harness = {
  mode: new URLSearchParams(location.search).get("mode") || "network", routes: [] as string[], reads: [] as number[],
  pending: [] as { days: number; resolve: (value: Response) => void; signal: AbortSignal | null }[],
  response,
  auth: { loading: false, authenticated: true, resetRequired: false, role: "USER",
    username: "viewer-a@example.invalid", displayName: "Synthetic Viewer",
    permissions: { "openai-usage": "view" }, pages: ADMIN_PAGE_DEFINITIONS },
  render: () => {},
}
declare global { interface Window { __openAiUsageHarness: typeof harness } }
window.__openAiUsageHarness = harness
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin)
  if (url.origin !== location.origin || (init.method || "GET") !== "GET") throw Error("Unexpected synthetic request.")
  if (url.pathname === "/api/parser-reports") return Response.json({ readyForUserReview: 0 })
  if (url.pathname !== "/api/admin/openai-usage") throw Error("Unexpected synthetic API.")
  const days = Number(url.searchParams.get("days"))
  harness.reads.push(days)
  if (harness.mode === "network") throw Error("Synthetic network outage.")
  if (harness.mode === "http") return Response.json({ message: "Private upstream detail must not be displayed." }, { status: 503 })
  if (harness.mode === "unauthorized" || harness.mode === "forbidden") return Response.json({ message: "Private authorization detail." }, { status: harness.mode === "unauthorized" ? 401 : 403 })
  if (harness.mode === "invalid") return Response.json({ generatedAt: "invalid", totals: { requests: 0 } })
  if (harness.mode === "invalid-json") return new Response("{", { headers: { "Content-Type": "application/json" } })
  if (harness.mode === "wrong-period") return Response.json(response(days === 7 ? 30 : 7))
  if (harness.mode === "unsafe-link") return Response.json(response(days, days * 100, false, "//example.invalid/private"))
  if (harness.mode === "api-path") return Response.json(response(days, days * 100, false, "/api/ecosystem/knowledge-extract"))
  if (harness.mode === "high-counter") return Response.json(response(days, Number.MAX_SAFE_INTEGER))
  // Deliberately do not honor abort: stale-response protection must also work
  // when the transport or already-completed JSON decoding ignores cancellation.
  if (harness.mode === "defer") return new Promise<Response>(resolve => harness.pending.push({ days, resolve, signal: init.signal || null }))
  return Response.json(response(days, days * 100, harness.mode === "empty"))
}
const app = createRoot(document.getElementById("root")!)
harness.render = () => app.render(<div className="fc-admin-scope"><AdminNavigationShell><Page /></AdminNavigationShell></div>)
harness.render()
