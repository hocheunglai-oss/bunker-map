// Keep the real page and route guard. Replace only auth, navigation, and the
// remote API boundary; all fixture writes are in-memory and explicitly fake.
import { ADMIN_PAGE_DEFINITIONS } from "../../lib/adminPages"

type Permission = "view" | "edit" | "none"
type Row = Record<string, unknown>
type Harness = {
  permission: Permission
  currentYear: number
  currentMonth: number
  requests: Array<{ method: string; url: string; body: Row | null }>
  confirmations: Record<string, Row>
  failNextConfirmation: boolean
  holdNextConfirmation: boolean
  releaseConfirmation: (() => void) | null
}
declare global { interface Window { __attendanceConfirmationHarness: Harness } }

const ownPersonId = "11111111-1111-4111-8111-111111111111"
const otherPersonId = "22222222-2222-4222-8222-222222222222"
const people = [
  { id: ownPersonId, staffCode: "AT", displayName: "Alice Test", adminUserId: "33333333-3333-4333-8333-333333333333", adminUsername: "alice@example.invalid", team: "BT", isActive: true, dingTalkUserId: null, employmentStartDate: null, employmentEndDate: null },
  { id: otherPersonId, staffCode: "BT", displayName: "Bob Test", adminUserId: "44444444-4444-4444-8444-444444444444", adminUsername: "bob@example.invalid", team: "BT", isActive: true, dingTalkUserId: null, employmentStartDate: null, employmentEndDate: null },
]
const permissions = { "attendance-record": "view" as Permission }
const router = { push: () => undefined, replace: () => undefined, refresh: () => undefined }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const closed = (year: number, month: number) => {
  const state = window.__attendanceConfirmationHarness
  return year < state.currentYear || (year === state.currentYear && month < state.currentMonth)
}

function summary(year: number, month: number, person: typeof people[number]) {
  const state = window.__attendanceConfirmationHarness
  return {
    person, codeTotals: {}, records: [], attendedDays: 20, lateDays: 0,
    confirmation: state.confirmations[`${person.id}:${year}:${month}`] || null,
    canConfirm: closed(year, month) && (state.permission === "edit" || person.id === ownPersonId),
    isCurrentUser: person.id === ownPersonId,
  }
}

export function installAttendanceConfirmationHarness() {
  const dateParts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "numeric" }).formatToParts(new Date()).map((part) => [part.type, part.value]))
  const requested = new URLSearchParams(window.location.search).get("permission")
  const permission: Permission = requested === "edit" || requested === "none" ? requested : "view"
  permissions["attendance-record"] = permission
  const state: Harness = {
    permission, currentYear: Number(dateParts.year), currentMonth: Number(dateParts.month),
    requests: [], confirmations: {}, failNextConfirmation: false,
    holdNextConfirmation: false, releaseConfirmation: null,
  }
  window.__attendanceConfirmationHarness = state
  window.fetch = async (input, init) => {
    const request = new Request(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin), init)
    const url = new URL(request.url)
    const body = request.method === "GET" ? null : await request.json() as Row
    state.requests.push({ method: request.method, url: url.pathname + url.search, body })
    if (url.origin !== window.location.origin || url.pathname !== "/api/admin/attendance") {
      throw new Error(`Unexpected synthetic request: ${request.method} ${url.href}`)
    }
    if (state.permission === "none") return json({ message: "Forbidden" }, 403)
    if (request.method === "POST") {
      if (body?.action !== "save-confirmation") return json({ message: "Forbidden" }, 403)
      const confirmation = body.confirmation as Row
      if (confirmation.status !== "confirmed" || (state.permission !== "edit" && confirmation.personId !== ownPersonId)) return json({ message: "Forbidden" }, 403)
      if (!closed(Number(confirmation.year), Number(confirmation.month))) return json({ message: "Attendance month must be closed." }, 400)
      if (state.holdNextConfirmation) {
        state.holdNextConfirmation = false
        await new Promise<void>((resolve) => { state.releaseConfirmation = resolve })
        state.releaseConfirmation = null
      }
      if (state.failNextConfirmation) {
        state.failNextConfirmation = false
        return json({ message: "Synthetic confirmation failure. Please retry." }, 503)
      }
      const saved = { ...confirmation, id: "synthetic-confirmation", confirmedAt: new Date().toISOString(), confirmedBy: "alice@example.invalid" }
      state.confirmations[`${confirmation.personId}:${confirmation.year}:${confirmation.month}`] = saved
      return json({ success: true, confirmation: saved })
    }
    const year = Number(url.searchParams.get("year") || state.currentYear)
    const month = Number(url.searchParams.get("month") || state.currentMonth)
    const common = { year, people, staffOrder: ["AT", "BT"], availableYears: [state.currentYear, state.currentYear - 1] }
    if (url.searchParams.get("view") === "all-time") return json({
      ...common, view: "all-time", schedules: [], syncRuns: [], availableUsers: [], allTimeSummaries: [], entitlements: [], monthlyAdjustments: [],
      annualSummaries: people.map((person) => ({ personId: person.id, codeTotals: {}, canConfirm: closed(year, 12) && (permission === "edit" || person.id === ownPersonId), confirmation: state.confirmations[`${person.id}:${year}:12`] || null })),
    })
    if (url.searchParams.get("scope") === "year") return json({
      ...common, months: Array.from({ length: month }, (_, index) => ({ month: index + 1, periodClosed: closed(year, index + 1), summaries: people.map((person) => summary(year, index + 1, person)) })),
    })
    return json({ ...common, month, periodClosed: closed(year, month), summaries: people.map((person) => summary(year, month, person)), calendarDays: [] })
  }
}

export function usePathname() { return "/admin/attendancerecord" }
export function useRouter() { return router }
export function useSimpleAdminAuth() {
  return { loading: false, authenticated: true, resetRequired: false, role: "VIEW", permissions, pages: ADMIN_PAGE_DEFINITIONS }
}
