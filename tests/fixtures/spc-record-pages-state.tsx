import React from "react"
import { createRoot } from "react-dom/client"
import Lost from "../../app/spc/lost-record/page"
import Today from "../../app/spc/today-enquiries/page"
import { SpcNavigationShell } from "../../components/SpcNavigationShell"
import { SPC_PAGE_DEFINITIONS } from "../../lib/spcPages"

const version = "2026-10-16T01:02:03.123456Z"
const params = new URLSearchParams(location.search)
const kind = params.get("kind") === "today" ? "today" : "lost"
const mode = params.get("mode") || "edit"
const h = {
  kind, readMode: params.get("read") || "ok", reasonReadMode: params.get("reasons") || "ok", writeMode: "defer", total: 2, revision: "a".repeat(64), day: "2026-10-16", checkedAt: version, routes: [] as string[],
  outcomeDate: null as string | null,
  requests: [] as { path: string; method: string; cursor: Record<string, unknown> | null; body: Record<string, unknown> | null }[],
  pending: [] as { type: string; resolve: (value: Response) => void; body: Record<string, unknown> | null }[],
  auth: { loading: false, authenticated: mode !== "signed-out", actorKey: "a".repeat(64),
    username: "first@example.invalid", displayName: "Synthetic User", mustChangePassword: false,
    role: mode === "view" && kind === "lost" ? "BUYER TRADER" : "ADMIN", office: "HONG KONG",
    permissions: { "spc-lost-record": mode === "none" ? "none" : mode === "view" ? "view" : "edit",
      "spc-today-enquiries": mode === "none" ? "none" : mode === "view" ? "view" : "edit" }, pages: SPC_PAGE_DEFINITIONS },
  render: () => {},
  row(index = 1) {
    const id = "00000000-0000-4000-8000-" + String(index).padStart(12, "0")
    const vessel = (this.auth.username.startsWith("first") ? "FIRST" : "SECOND") + " VESSEL " + index
    const common = { id, vesselName: vessel, createdByDisplayName: "SYNTHETIC BUYER", createdAt: version,
      formattedText: vessel + " / SINGAPORE / VLSFO 500MTS", meta: { lostReason: "PRICE", ...(this.outcomeDate ? { outcomeAt: this.outcomeDate } : {}) } }
    return kind === "lost" ? { ...common, title: vessel, deliveryDate: "2026-10-20", updatedAt: version } :
      { ...common, enquiryNumber: "SPC-" + index, status: "open", previousFixture: null, previousLost: null }
  },
  page(cursor: Record<string, unknown> | null = null) {
    const start = cursor ? Number(String(cursor.id).slice(-12)) : 0
    const rows = Array.from({ length: Math.min(250, this.total - start) }, (_, i) => this.row(start + i + 1))
    return { schema: "spc.record-page/v1", kind, day: kind === "today" ? this.day : null,
      checkedAt: this.checkedAt, pageSize: 250, totalCount: this.total, pageCount: Math.ceil(this.total / 250),
      pageIndex: this.total ? Math.floor(start / 250) + 1 : 0, mainRevision: this.revision,
      nextCursor: start + rows.length < this.total ? { kind, day: kind === "today" ? this.day : null,
        createdAt: version, id: rows.at(-1)!.id, revision: this.revision } : null, enquiries: rows }
  },
}
declare global { interface Window { __spcRecordPagesHarness: typeof h } }
window.__spcRecordPagesHarness = h
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin)
  if (url.origin !== location.origin) throw Error("External fixture request denied.")
  if (url.pathname === "/api/parser-reports") return Response.json({ readyForUserReview: 0 })
  if (url.pathname === "/api/spc/mobile-mode") return Response.json({ eligible: false, enabled: false, expiresAt: null, maskedPhone: "" })
  const method = init.method || "GET", body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null
  const cursor = url.searchParams.has("cursor") ? JSON.parse(url.searchParams.get("cursor")!) as Record<string, unknown> : null
  h.requests.push({ path: url.pathname, method, body, cursor })
  const isReasons = url.pathname === "/api/spc/lost-reasons"
  const readMode = method === "GET" ? isReasons ? h.reasonReadMode : h.readMode : h.writeMode
  if (readMode === "network") throw Error("Synthetic offline.")
  if (readMode === "invalid") return Response.json({})
  if (readMode === "json") return new Response("{")
  if (readMode === "denied") return new Response("Forbidden", { status: 403 })
  if (readMode === "unauthorized") return new Response("Sign in", { status: 401 })
  if (readMode === "conflict") return Response.json({ message: "Synthetic changed record." }, { status: 409 })
  if (readMode === "http") return Response.json({ message: "Private database failure must not appear." }, { status: 500 })
  if (readMode === "defer" || readMode === "body-defer") return new Promise<Response>(resolve => {
    if (readMode === "body-defer") resolve({ ok: true, status: 200, text: () => new Promise<string>(done => h.pending.push({ type: "body", body, resolve: response => { void response.text().then(done) } })) } as Response)
    else h.pending.push({ type: method, body, resolve })
  })
  if (method === "GET" && isReasons) return Response.json({ buyerReasons: ["PRICE"], supplierReasons: ["OTHER", "SUPPLIER NO AVAILS"] })
  if (method === "GET") return Response.json(url.pathname === "/api/spc/enquiries" ? { enquiries: h.page().enquiries } : h.page(cursor))
  if (url.pathname === "/api/spc/lost-reasons") return Response.json({ success: true, reasons: body!.reasons })
  return Response.json({ success: true, review: { id: body!.id, updatedAt: "2026-10-16T01:02:03.123457Z",
    meta: { lostReason: "PRICE", supplierLostReason: body!.supplierLostReason, supplierLostReasonDetails: body!.supplierLostReasonDetails, spcComments: body!.spcComments } } })
}
const root = createRoot(document.getElementById("root")!)
h.render = () => root.render(<React.StrictMode><div className="fc-admin-scope spc-scope"><SpcNavigationShell>{kind === "lost" ? <Lost /> : <Today />}</SpcNavigationShell></div></React.StrictMode>)
h.render()
