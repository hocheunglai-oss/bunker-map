import React from "react"
import { createRoot } from "react-dom/client"
import HealthPage from "../../app/spc/systemhealth/page"
import TechPage from "../../app/spc/techstack/page"
import { fcunoConnectionPolicy } from "../../config/fcunoConnections"

const kind = location.pathname.includes("systemhealth") ? "health" : "tech"
const health = (commit = "a".repeat(40), stale = false) => ({
  status: "ok", checkedAt: "2026-10-16T12:00:00.000Z",
  deployment: { commit, shortCommit: commit.slice(0, 7), branch: "synthetic", environment: "synthetic", deployedAt: "unknown" },
  freshness: { state: stale ? "stale" : "fresh", attemptedAt: "2026-10-16T12:01:30.000Z" },
  checks: [{ id: "synthetic-check", label: "SYNTHETIC DATABASE", status: "ok", message: "Synthetic table is reachable", checkedAt: "2026-10-16T12:00:00.000Z", details: { records: 12, longValue: "synthetic/".repeat(20) } }],
})
const tech = (commit = "a".repeat(40)) => ({
  generatedAt: "2026-10-16T12:00:00.000Z",
  deployment: { platform: "VERCEL", project: fcunoConnectionPolicy.vercel.project, productionUrl: fcunoConnectionPolicy.vercel.productionOrigins[1], gitRepository: fcunoConnectionPolicy.github.repository, branch: "synthetic", commit },
  secrets: [{ name: "SYNTHETIC_LONG_ENVIRONMENT_NAME_WITHOUT_A_REAL_SECRET", configured: true, status: "PRESENT — NOT VALIDATED", storage: "SYNTHETIC ENVIRONMENT", value: "MASKED" }],
  verification: { environmentValues: "Presence only; credentials and external services are not checked." },
})
const nativeSetTimeout = window.setTimeout.bind(window)
// Exercise the shipped 30-second deadline in a bounded fixture without altering
// the runtime constant or any other browser timer.
window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => nativeSetTimeout(callback, delay === 30_000 ? 250 : delay, ...args)) as typeof window.setTimeout
type Pending = { resolve: (value: Response) => void; reject: (reason: Error) => void; signal: AbortSignal | null }
const harness = {
  kind, auth: { loading: false, authenticated: true, actorKey: "a".repeat(64), username: "viewer@example.invalid", displayName: "Synthetic Viewer", role: "VIEWER", office: "HONG KONG", permissions: { "spc-system-health": "view", "spc-tech-stack": "view" } },
  routes: [] as string[], pending: [] as Pending[], bodies: [] as ((value: unknown) => void)[], requests: [] as string[], render: () => {}, health, tech,
  release(index = 0, status = 200, value?: unknown) { harness.pending.splice(index, 1)[0].resolve(Response.json(value === undefined ? (kind === "health" ? health() : tech()) : value, { status })) },
  raw(status = 200, value = "<html>Not JSON</html>") { harness.pending.shift()!.resolve(new Response(value, { status })) },
  reject() { harness.pending.shift()!.reject(new Error("Synthetic network unavailable")) },
  deferBody() { harness.pending.shift()!.resolve({ status: 200, ok: true, json: () => new Promise(resolve => harness.bodies.push(resolve)) } as Response) },
}
declare global { interface Window { __operationalHarness: typeof harness } }
window.__operationalHarness = harness
window.fetch = (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin)
  if (url.origin !== location.origin || (init.method || "GET") !== "GET" || url.pathname !== (kind === "health" ? "/api/spc/system-health" : "/api/spc/tech-stack")) throw new Error("Unexpected synthetic request")
  harness.requests.push(url.pathname + url.search)
  // Intentionally ignore abort: late success/failure must be fenced by runtime.
  return new Promise<Response>((resolve, reject) => harness.pending.push({ resolve, reject, signal: init.signal || null }))
}
const root = createRoot(document.getElementById("root")!)
harness.render = () => root.render(<div className="fc-admin-scope"><div className="spc-app">{kind === "health" ? <HealthPage /> : <TechPage />}</div></div>)
harness.render()
