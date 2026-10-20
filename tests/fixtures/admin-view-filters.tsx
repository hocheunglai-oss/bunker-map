import React from "react"
import { createRoot } from "react-dom/client"
import AdminLayout from "../../app/admin/layout"
import OpenAiUsagePage from "../../app/admin/openaiusage/page"
import HongKongPriceHistoryPage from "../../app/admin/hongkongpricehistory/page"
import TaiwanPriceHistoryPage from "../../app/admin/taiwanpricehistory/page"
import OutlookAddressBookPage from "../../app/admin/outlookaddressbook/page"
import { ADMIN_PAGE_DEFINITIONS } from "../../lib/adminPages"
import { reportPublicationBaseline } from "./report-publication-baseline.cjs"

// The runner provides only framework navigation/image shims and synthetic public
// environment values. Auth, layout, route guard, page hooks and SDK stay real.
type Mode = "view" | "edit" | "none" | "signed-out"
type PageKey = "usage" | "hongkong" | "taiwan" | "outlook"
type RequestTrace = { method: string; path: string; query: string; body: unknown }
type Harness = {
  mode: Mode
  pageKey: PageKey
  requests: RequestTrace[]
  forwardedWrites: RequestTrace[]
  routes: string[]
  holdNextGroupRead: boolean
  pendingGroupRead: boolean
  releaseGroupRead: () => void
  unmount: () => void
}

const targets = {
  "/admin/openaiusage": { key: "usage", permission: "openai-usage", Page: OpenAiUsagePage },
  "/admin/hongkongpricehistory": { key: "hongkong", permission: "hongkong-price-history", Page: HongKongPriceHistoryPage },
  "/admin/taiwanpricehistory": { key: "taiwan", permission: "taiwan-price-history", Page: TaiwanPriceHistoryPage },
  "/admin/outlookaddressbook": { key: "outlook", permission: "outlook-addressbook", Page: OutlookAddressBookPage },
} as const

const target = targets[location.pathname as keyof typeof targets]
if (!target) throw new Error("Unexpected View-filter fixture pathname: " + location.pathname)
const rawMode = new URLSearchParams(location.search).get("mode") || "view"
if (!["view", "edit", "none", "signed-out"].includes(rawMode)) throw new Error("Unexpected fixture session mode")
const mode = rawMode as Mode
const harness: Harness = { mode, pageKey: target.key, requests: [], forwardedWrites: [], routes: [],
  holdNextGroupRead: false, pendingGroupRead: false, releaseGroupRead: () => {}, unmount: () => {} }
declare global { interface Window { __viewFilterHarness: Harness } }
window.__viewFilterHarness = harness

const session = mode === "signed-out" ? { authenticated: false } : {
  authenticated: true,
  actorKey: "a".repeat(64),
  username: "synthetic-view-filter@example.invalid",
  displayName: "Synthetic View Filter User",
  role: "USER",
  resetRequired: false,
  mustChangePassword: false,
  permissions: { [target.permission]: mode },
  pages: ADMIN_PAGE_DEFINITIONS,
}

function usageReport(days: 7 | 30 | 90) {
  const generatedAt = "2026-10-20T03:00:00.000Z"
  const totals = { requests: 1, errors: 0, inputTokens: days * 100, cachedInputTokens: 0,
    outputTokens: 0, reasoningTokens: 0, totalTokens: days * 100, webSearchCalls: 0 }
  return {
    generatedAt, since: new Date(Date.parse(generatedAt) - days * 86_400_000).toISOString(), days, totals,
    pages: [{ pageId: "synthetic-view-filter", pagePath: "/spc/enquiries", ...totals, durationMs: 150,
      averageDurationMs: 150, tokenPercentage: 100, requestPercentage: 100,
      features: ["Synthetic filter fixture"], models: ["synthetic-only"] }],
    recent: [{ occurred_at: "2026-10-20T02:59:59.000Z", page_id: "synthetic-view-filter", page_path: "/spc/enquiries",
      feature: "Synthetic filter fixture", model: "synthetic-only", status: "success",
      input_tokens: days * 100, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
      total_tokens: days * 100, web_search_calls: 0, duration_ms: 150 }],
  }
}

const portIds = {
  kaohsiung: "11111111-1111-4111-8111-111111111111",
  taichung: "22222222-2222-4222-8222-222222222222",
  hongkong: "33333333-3333-4333-8333-333333333333",
}
function historyPort(id: string, name: string) {
  return { id, name, lat: null, lng: null, hsfo: null, vlsfo: null, mgo: null,
    hsfo_formula: null, vlsfo_formula: null, mgo_formula: null, updated_at: null }
}
const historyPorts = {
  hongkong: [historyPort(portIds.hongkong, "Hong Kong")],
  taiwan: [historyPort(portIds.kaohsiung, "Kaohsiung"), historyPort(portIds.taichung, "Taichung")],
}
const historyDays = [
  { day: "2025-10-10", price: 100 },
  { day: "2026-09-10", price: 200 },
  { day: "2026-10-10", price: 300 },
]
function historySnapshot(market: "hongkong" | "taiwan") {
  let sequence = 0
  const rows = historyDays.flatMap(({ day, price }) => historyPorts[market].map((port) => ({
    id: `44444444-4444-4444-8444-${String(++sequence).padStart(12, "0")}`,
    port_id: port.id,
    recorded_at: `${day}T12:00:00`,
    hsfo: port.id === portIds.taichung ? null : price,
    vlsfo: price + (port.id === portIds.taichung ? 30 : 10),
    mgo: price + (port.id === portIds.taichung ? 40 : 20),
  })))
  return { market, ports: historyPorts[market], rows }
}

const contactIds = {
  alpha: "55555555-5555-4555-8555-555555555551",
  beta: "55555555-5555-4555-8555-555555555552",
}
const groupIds = {
  alpha: "66666666-6666-4666-8666-666666666661",
  beta: "66666666-6666-4666-8666-666666666662",
}
const addressBook = {
  contacts: [
    { id: contactIds.alpha, source_book: "BOOK-ALPHA", source_card: "synthetic-alpha-card", display_name: "ALPHA CONTACT",
      primary_email: "alpha@example.invalid", nickname: null, first_name: "Alpha", last_name: "Contact", vcard: null, properties: {} },
    { id: contactIds.beta, source_book: "BOOK-BETA", source_card: "synthetic-beta-card", display_name: "BETA CONTACT",
      primary_email: "beta@example.invalid", nickname: null, first_name: "Beta", last_name: "Contact", vcard: null, properties: {} },
  ],
  groups: [
    { id: groupIds.alpha, source_book: "BOOK-ALPHA", source_uid: "synthetic-alpha-group", name: "ALPHA GROUP",
      nickname: null, description: null, member_count: 1, updated_at: "2026-10-20T00:00:00.123456+00:00" },
    { id: groupIds.beta, source_book: "BOOK-BETA", source_uid: "synthetic-beta-group", name: "BETA GROUP",
      nickname: null, description: null, member_count: 1, updated_at: "2026-10-20T00:00:00.123456+00:00" },
  ],
  members: [
    { group_id: groupIds.alpha, contact_id: contactIds.alpha, source_book: "BOOK-ALPHA" },
    { group_id: groupIds.beta, contact_id: contactIds.beta, source_book: "BOOK-BETA" },
  ],
}

async function requestBody(input: RequestInfo | URL, init: RequestInit): Promise<unknown> {
  const raw = init.body === undefined
    ? input instanceof Request && input.body !== null ? await input.clone().text() : null
    : init.body
  if (typeof raw !== "string") return raw === null || raw === undefined ? null : String(raw)
  try { return JSON.parse(raw) as unknown } catch { return raw }
}

// Install before rendering the real provider/guard. The guard must wrap this
// transport, so blocked View writes cannot appear in forwardedWrites.
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin)
  if (url.origin !== location.origin) throw new Error("External request forbidden in View-filter fixture")
  const method = (init.method || (input instanceof Request ? input.method : "GET")).toUpperCase()
  const trace: RequestTrace = { method, path: url.pathname, query: url.search, body: await requestBody(input, init) }
  harness.requests.push(trace)
  if (method !== "GET") {
    harness.forwardedWrites.push(trace)
    return Response.json({ syntheticOnly: true, method, path: url.pathname })
  }
  if (url.pathname === "/api/admin/session") return Response.json(session)
  if (url.pathname === "/api/parser-reports") return Response.json({ readyForUserReview: 0 })
  if (url.pathname === "/api/admin/openai-usage") {
    const days = Number(url.searchParams.get("days"))
    if (days !== 7 && days !== 30 && days !== 90) throw new Error("Unexpected synthetic usage period")
    return Response.json(usageReport(days))
  }
  if (url.pathname === "/api/admin/price-history") {
    const market = url.searchParams.get("market")
    if (market !== "hongkong" && market !== "taiwan") throw new Error("Unexpected synthetic price-history market")
    return Response.json(historySnapshot(market))
  }
  if (url.pathname === "/api/admin/report-publication") {
    const report = url.searchParams.get("report")
    if (report !== "hongkong" && report !== "taiwan") throw new Error("Unexpected synthetic publication report")
    return Response.json(reportPublicationBaseline(report))
  }
  if (url.pathname === "/api/outlook-addressbook/bootstrap") return Response.json(addressBook)
  if (url.pathname === "/api/outlook-addressbook/exchange-sync") {
    return Response.json({ webhookConfigured: true, status: { status: "completed", message: "Synthetic fixture only", requestedAt: null } })
  }
  if (url.pathname === "/api/admin/audit-logs") return Response.json({ logs: [] })
  if (url.pathname === "/api/admin/supabase") {
    const proxy = new URL(url.searchParams.get("target") || "")
    if (proxy.origin !== "http://127.0.0.1:65535") throw new Error("Unexpected synthetic SDK target")
    if (proxy.pathname === "/rest/v1/shared_addressbook_groups") {
      const group = addressBook.groups.find(row => proxy.searchParams.get("id") === "eq." + row.id)
      if (!group || proxy.searchParams.get("select") !== "*") throw new Error("Unexpected synthetic group read")
      if (harness.holdNextGroupRead) {
        harness.holdNextGroupRead = false
        harness.pendingGroupRead = true
        await new Promise<void>(resolve => { harness.releaseGroupRead = resolve })
        harness.pendingGroupRead = false
      }
      // .single() requires the same object shape as the real PostgREST reply.
      return Response.json({ ...group, description: "RELOADED SYNTHETIC GROUP" })
    }
    if (proxy.pathname === "/rest/v1/shared_addressbook_group_members") {
      const id = proxy.searchParams.get("group_id")?.replace(/^eq\./, "")
      if (!addressBook.groups.some(group => group.id === id) ||
          proxy.searchParams.get("select") !== "group_id,contact_id,source_book" ||
          proxy.searchParams.get("order") !== "contact_id.asc" ||
          proxy.searchParams.get("offset") !== "0" || proxy.searchParams.get("limit") !== "1000") {
        throw new Error("Unexpected synthetic group-members read")
      }
      return Response.json(addressBook.members.filter(member => member.group_id === id))
    }
    throw new Error("Unexpected synthetic SDK table")
  }
  throw new Error(`Unexpected synthetic read: ${url.pathname}${url.search}`)
}

function UnsafeControls() {
  return <section aria-label="Unsafe guard fixture">
    <select aria-label="Unsafe fixture" defaultValue="unsafe"><option value="unsafe">Unsafe</option></select>
    <input aria-label="Unsafe editor" defaultValue="Fixture editor" />
    <textarea aria-label="Unsafe textarea" defaultValue="Fixture textarea" />
    <input aria-label="Unsafe checkbox" type="checkbox" />
    <button type="button">Save fixture</button>
    <button type="button">Delete fixture</button>
    <button type="button">Publish fixture</button>
  </section>
}

const mount = document.getElementById("root")
if (!mount) throw new Error("Missing View-filter fixture root")
const app = createRoot(mount)
harness.unmount = () => app.unmount()
const Page = target.Page
app.render(<AdminLayout><UnsafeControls /><Page /></AdminLayout>)
