import React from "react"
import { createRoot } from "react-dom/client"
import Page from "../../app/spc/feedback/page"
import { SpcNavigationShell } from "../../components/SpcNavigationShell"
import { SPC_PAGE_DEFINITIONS } from "../../lib/spcPages"

const record = (patch: Record<string, unknown> = {}) => ({
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", category: "PROBLEM", title: "Synthetic private issue",
  message: "Synthetic feedback details.", area: "ENQUIRIES", status: "NEW", adminResponse: "Original response",
  createdByUsername: "submitter@example.invalid", createdByDisplayName: "Synthetic Submitter",
  reviewedByDisplayName: "", createdAt: "2026-10-16T07:00:00.123456+00:00",
  updatedAt: "2026-10-16T07:00:00.123456+00:00", ...patch,
})
const harness = {
  mode: "ok", readMode: "ok", routes: [] as string[], reads: 0, writes: [] as { method: string; body: Record<string, unknown> }[],
  pending: [] as { method: string; body: Record<string, unknown>; resolve: (value: Response) => void; signal: AbortSignal | null }[],
  record,
  auth: { loading: false, authenticated: true, mustChangePassword: false, role: "ADMIN",
    username: "admin-a@example.invalid", displayName: "Synthetic Administrator", office: "HK",
    permissions: { "spc-feedback": "edit" }, pages: SPC_PAGE_DEFINITIONS },
  render: () => {},
}
declare global { interface Window { __spcFeedbackHarness: typeof harness } }
window.__spcFeedbackHarness = harness
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin)
  if (url.origin !== location.origin) throw Error("Unexpected external synthetic request.")
  const method = init.method || "GET"
  if (url.pathname === "/api/parser-reports") return Response.json({ readyForUserReview: 0 })
  if (url.pathname === "/api/spc/mobile-mode") return Response.json({ eligible: false, enabled: false, expiresAt: null, maskedPhone: "" })
  if (url.pathname !== "/api/spc/feedback") throw Error("Unexpected synthetic API.")
  const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {}
  const mode = method === "GET" ? harness.readMode : harness.mode
  if (method === "GET") harness.reads++
  else harness.writes.push({ method, body })
  if (mode === "network") throw Error("Synthetic network outage.")
  if (mode === "http") return Response.json({ message: "Private database exception must not be displayed." }, { status: 500 })
  if (mode === "invalid-json") return new Response("{", { headers: { "Content-Type": "application/json" } })
  if (mode === "invalid") return Response.json({ records: {}, record: { id: "incorrect" } })
  if (mode === "denied") return Response.json({ message: "Forbidden" }, { status: 403 })
  if (mode === "unauthorized") return Response.json({ message: "Unauthorized" }, { status: 401 })
  if (mode === "conflict") return Response.json({ message: "This feedback has changed. Refresh before saving." }, { status: 409 })
  // Deliberately ignore abort so response ownership, not cancellation alone, is tested.
  if (mode === "defer") return new Promise<Response>(resolve => harness.pending.push({ method, body, resolve, signal: init.signal || null }))
  if (method === "GET") return Response.json({ records: mode === "empty" ? [] : [record(), record({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", title: "Second synthetic issue" })] })
  const invalid = mode === "wrong-id" ? { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } :
    mode === "same-version" ? { updatedAt: body.expectedUpdatedAt } :
    mode === "backward-version" ? { updatedAt: "2026-10-16T07:00:00.123455+00:00" } :
    mode === "wrong-response" ? { adminResponse: "Different response" } : {}
  return Response.json({ record: record({ ...body, updatedAt: "2026-10-16T07:00:00.123457+00:00",
    reviewedByDisplayName: "Synthetic Administrator", ...(method === "POST" ? {
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff", createdByUsername: harness.auth.username, adminResponse: "", status: "NEW",
    } : {}), ...invalid }) }, { status: method === "POST" ? 201 : 200 })
}
const app = createRoot(document.getElementById("root")!)
harness.render = () => app.render(<div className="fc-admin-scope spc-scope"><SpcNavigationShell><Page /></SpcNavigationShell></div>)
harness.render()
