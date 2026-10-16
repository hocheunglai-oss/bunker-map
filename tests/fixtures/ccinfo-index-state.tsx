import React from "react"
import { createRoot } from "react-dom/client"
import Companies from "../../app/admin/ccinfo/companies/page"
import Countries from "../../app/admin/ccinfo/countries/page"
import Ports from "../../app/admin/ccinfo/ports/page"
import { AdminNavigationShell } from "../../components/AdminNavigationShell"
import { AdminRouteGuard } from "../../components/AdminRouteGuard"
import { ADMIN_PAGE_DEFINITIONS, normaliseAdminPagePermissions } from "../../lib/adminPages"
import { writeClientStorage, removeClientStorage } from "../../lib/clientStorage"

type Kind = "companies" | "countries" | "ports"
type Pending = {
  id: number; method: string; target: string; table: string; search: string | null
  offset: number; limit: number; headers: Record<string, string>; body: unknown; done: boolean
  signal: AbortSignal | null; resolve: (response: Response) => void; reject: (error: Error) => void
}
type Body = { requestId: number; done: boolean; resolve: (body: string) => void }
type Reply = { data?: unknown; count?: number | string | null; status?: number; raw?: string }
const auth = {
  loading: false, authenticated: true, resetRequired: false,
  username: "synthetic-editor-a@example.invalid", displayName: "Synthetic Editor", role: "STAFF",
  permissions: normaliseAdminPagePermissions({ ccinfo: "edit" }), pages: ADMIN_PAGE_DEFINITIONS,
}
const harness = {
  kind: location.pathname.split("/").at(-1) as Kind,
  auth, requests: [] as Pending[], bodies: [] as Body[], routes: [] as string[],
  unexpected: [] as string[], alerts: [] as string[], confirmations: [] as string[],
  confirmResult: true, networkFailure: false, render: () => {},
  row(name: string, id?: string) {
    let hash = 2166136261
    for (const character of name) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
    return { id: id || `00000000-0000-4000-8000-${hash.toString(16).padStart(12, "0")}`, name,
      notes: "Synthetic complete information with punctuation & long reference text", country_name: "Synthetic Country",
      created_at: "2026-10-16T00:00:00.000Z", updated_at: "2026-10-16T00:00:00.123456Z" }
  },
  setAuth(options: { username?: string; permission?: "none" | "view" | "edit"; authenticated?: boolean }) {
    const { permission, ...identity } = options
    harness.auth = { ...harness.auth, ...identity, permissions: permission ? normaliseAdminPagePermissions({ ccinfo: permission }) : harness.auth.permissions }
    if (harness.auth.authenticated) writeClientStorage("bunker_admin_actor", JSON.stringify(harness.auth))
    else removeClientStorage("bunker_admin_actor")
    harness.render()
  },
  release(id: number, reply: Reply = {}) {
    const request = harness.requests.find(item => item.id === id)
    if (!request || request.done) throw new Error("Missing pending synthetic request " + id)
    request.done = true
    request.resolve(makeResponse(reply))
  },
  deferBody(id: number, reply: Reply = {}) {
    const request = harness.requests.find(item => item.id === id)
    if (!request || request.done) throw new Error("Missing pending synthetic body request " + id)
    request.done = true
    const response = makeResponse(reply)
    // The real PostgREST SDK reads text before JSON parsing. Do not honor abort:
    // ownership must survive a response whose body has already begun decoding.
    response.text = () => new Promise<string>(resolve => harness.bodies.push({ requestId: id, done: false, resolve }))
    response.json = async () => JSON.parse(await response.text()) as unknown
    request.resolve(response)
  },
  releaseBody(id: number, data: unknown) {
    const body = harness.bodies.find(item => item.requestId === id && !item.done)
    if (!body) throw new Error("Missing deferred synthetic response body " + id)
    body.done = true
    body.resolve(JSON.stringify(data))
  },
  reject(id: number) {
    const request = harness.requests.find(item => item.id === id)
    if (!request || request.done) throw new Error("Missing rejected synthetic request " + id)
    request.done = true
    request.reject(new TypeError("Synthetic network unavailable"))
  },
}
declare global { interface Window { __ccinfoIndexHarness: typeof harness } }
window.__ccinfoIndexHarness = harness
function makeResponse({ data = [], count = 0, status = 200, raw }: Reply) {
  const headers = new Headers({ "Content-Type": "application/json" })
  if (count !== null) headers.set("Content-Range", `0-${Array.isArray(data) ? Math.max(0, data.length - 1) : 0}/${count}`)
  if (status === 204) return new Response(null, { status, headers })
  return new Response(raw ?? JSON.stringify(status >= 400 ? { code: "SYNTHETIC_ERROR", message: "Private diagnostic must not leak to the page" } : data), { status, headers })
}
window.confirm = message => { harness.confirmations.push(String(message)); return harness.confirmResult }
window.alert = message => harness.alerts.push(String(message))
writeClientStorage("bunker_admin_actor", JSON.stringify(harness.auth))
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin)
  if (url.origin !== location.origin) { harness.unexpected.push(url.toString()); throw new Error("External request blocked") }
  if (url.pathname === "/api/parser-reports") return Response.json({ readyForUserReview: 0 })
  if (url.pathname === "/api/ccinfo/delete-record" && init.method === "POST") {
    const body = typeof init.body === "string" ? JSON.parse(init.body) as unknown : null
    return new Promise<Response>((resolve, reject) => harness.requests.push({ id: harness.requests.length, method: "POST", target: url.toString(),
      table: "atomic-delete-record", search: null, offset: 0, limit: 0, body, headers: Object.fromEntries(new Headers(init.headers).entries()),
      done: false, signal: init.signal || null, resolve, reject }))
  }
  if (url.pathname !== "/api/admin/supabase") { harness.unexpected.push(url.toString()); throw new Error("Unexpected API blocked") }
  if (harness.networkFailure) throw new TypeError("Synthetic network unavailable")
  const target = new URL(url.searchParams.get("target") || "https://invalid.example.invalid")
  const method = init.method || (input instanceof Request ? input.method : "GET")
  if (target.origin !== "https://synthetic-supabase.invalid" || !/^\/rest\/v1\/cc_(companies|countries|ports)$/.test(target.pathname) || !["GET", "DELETE"].includes(method)) {
    harness.unexpected.push(target.toString()); throw new Error("Unexpected synthetic database request")
  }
  return new Promise<Response>((resolve, reject) => harness.requests.push({
    id: harness.requests.length, method, target: target.toString(), table: target.pathname.split("/").at(-1)!,
    search: target.searchParams.get("or"), offset: Number(target.searchParams.get("offset") || 0), limit: Number(target.searchParams.get("limit") || 0),
    headers: Object.fromEntries(new Headers(init.headers).entries()), body: null, done: false, signal: init.signal || null, resolve, reject,
  }))
}
const app = createRoot(document.getElementById("root")!)
harness.render = () => {
  const Page = harness.kind === "companies" ? Companies : harness.kind === "countries" ? Countries : Ports
  app.render(<div className="fc-admin-scope"><AdminNavigationShell><AdminRouteGuard><Page /></AdminRouteGuard></AdminNavigationShell></div>)
}
harness.render()
