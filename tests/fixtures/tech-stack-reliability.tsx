import React from "react"
import { createRoot } from "react-dom/client"
import Page from "../../app/admin/techstack/page"
import { AdminNavigationShell } from "../../components/AdminNavigationShell"
import { ADMIN_PAGE_DEFINITIONS } from "../../lib/adminPages"
import { fcunoConnectionPolicy } from "../../config/fcunoConnections"

const response = (commit = "a".repeat(40)) => ({
  generatedAt: "2026-10-16T03:00:00.000Z",
  deployment: {
    platform: "VERCEL", project: fcunoConnectionPolicy.vercel.project,
    productionUrl: fcunoConnectionPolicy.vercel.productionOrigins[0],
    gitRepository: fcunoConnectionPolicy.github.repository,
    environment: "synthetic", branch: "synthetic", commit,
    functionRegion: "synthetic", configuredRegions: ["synthetic"],
  },
  databaseInventory: {
    schema: "bunker-map.backup-inventory/v1", migrationHead: "20261027035525",
    tables: ["attendance_annual_confirmations", "attendance_monthly_confirmations", "email_templates", "office_calendar_store"], checkedAt: "2026-10-27T04:00:00.000Z",
  },
  verification: { responseTimeOnly: true, externalServices: "Synthetic only", environmentValues: "Presence only; not validated." },
  schedules: [{ path: "/api/backups/bunker-map-drive", schedule: "2 19 * * *" }],
  secrets: [{ name: "SYNTHETIC_KEY", configured: true, status: "PRESENT — NOT VALIDATED", storage: "SYNTHETIC", value: "MASKED" }],
})
const harness = {
  mode: "network", reads: 0, routes: [] as string[],
  pending: [] as { resolve: (value: Response) => void; signal: AbortSignal | null }[],
  response,
  configurationMode: "ok", configurationReads: 0, configurationHostname: "server.example.test",
  configurationPending: [] as { resolve: (value: Response) => void; signal: AbortSignal | null }[],
  configuration: (hostname = "server.example.test") => ({ hostname,
    deployment: { environment: "production", commit: "c".repeat(40) },
    connectivity: "not_checked", checkedAt: "2026-10-26T06:00:00.000Z" }),
  auth: {
    loading: false, authenticated: true, resetRequired: false, role: "USER",
    actorKey: "a".repeat(64), username: "synthetic@example.invalid", displayName: "Synthetic Viewer",
    permissions: { "tech-stack": "view" }, pages: ADMIN_PAGE_DEFINITIONS,
  },
  render: () => {},
}
declare global { interface Window { __techStackHarness: typeof harness } }
window.__techStackHarness = harness
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin)
  if (url.origin !== location.origin || (init.method || "GET") !== "GET") throw Error("Unexpected synthetic request.")
  if (url.pathname === "/api/parser-reports") return Response.json({ readyForUserReview: 0 })
  if (url.pathname === "/api/phonebook/carddav-sync") {
    harness.configurationReads += 1
    if (url.search !== "?configuration=1" || init.cache !== "no-store" || !init.signal) throw Error("Unexpected configuration request.")
    if (harness.configurationMode === "defer") return new Promise<Response>(resolve => harness.configurationPending.push({ resolve, signal: init.signal || null }))
    if (harness.configurationMode === "defer-body") return {
      ok: true, json: () => new Promise(resolve => harness.configurationPending.push({ resolve: value => value.json().then(resolve), signal: init.signal || null })),
    } as Response
    if (harness.configurationMode === "http") return Response.json({ message: "private-server-error-never-render" }, { status: 403 })
    if (harness.configurationMode === "invalid") return Response.json({ ...harness.configuration(), hostname: "https://name:password@private-server.example.test/addressbook" })
    return Response.json(harness.configuration(harness.configurationHostname))
  }
  if (url.pathname !== "/api/admin/tech-stack") throw Error("Unexpected synthetic API.")
  harness.reads += 1
  if (harness.mode === "network") throw new Error("Synthetic network outage — must not become an unhandled rejection.")
  if (harness.mode === "http") return Response.json({ message: "Synthetic upstream outage." }, { status: 503 })
  if (harness.mode === "invalid") return Response.json({ generatedAt: "invalid", deployment: null })
  if (harness.mode === "defer") return new Promise<Response>(resolve => harness.pending.push({ resolve, signal: init.signal || null }))
  return Response.json(response())
}
const app = createRoot(document.getElementById("root")!)
harness.render = () => app.render(<div className="fc-admin-scope"><AdminNavigationShell><Page /></AdminNavigationShell></div>)
harness.render()
