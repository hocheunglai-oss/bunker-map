// Keep the real page and route guard. Replace only auth, navigation, and the
// remote API boundary; all fixture writes are in-memory and explicitly fake.
import { ADMIN_PAGE_DEFINITIONS } from "../../lib/adminPages"

type Permission = "view" | "edit" | "none"
type Row = Record<string, unknown>
type Harness = {
  permission: Permission
  signedIn: boolean
  currentYear: number
  currentMonth: number
  requests: Array<{ method: string; url: string; body: Row | null }>
  confirmations: Record<string, Row>
  annualConfirmations: Record<string, Row>
  annualConfirmationAvailable: boolean
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
    permission, signedIn: requested !== "signed-out", currentYear: Number(dateParts.year), currentMonth: Number(dateParts.month),
    requests: [], confirmations: {}, annualConfirmations: {}, annualConfirmationAvailable: true, failNextConfirmation: false,
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
      if (body?.action !== "save-confirmation" && body?.action !== "save-annual-confirmation") return json({ message: "Forbidden" }, 403)
      const annual = body.action === "save-annual-confirmation"
      if (annual && !state.annualConfirmationAvailable) return json({ message: "Year-end confirmation is not available yet while an update finishes." }, 400)
      const confirmation = body.confirmation as Row
      if (state.permission !== "edit" && (confirmation.status !== "confirmed" || confirmation.personId !== ownPersonId)) return json({ message: "Forbidden" }, 403)
      if (annual && Object.hasOwn(confirmation, "month")) return json({ message: "Annual confirmation must not include a month." }, 400)
      if (confirmation.status === "confirmed" && !(annual ? Number(confirmation.year) < state.currentYear : closed(Number(confirmation.year), Number(confirmation.month)))) return json({ message: "Attendance period must be closed." }, 400)
      if (confirmation.status === "confirmed" && confirmation.sourceRevision !== 7) return json({ message: "Reload the attendance statement before confirming it." }, 409)
      if (state.holdNextConfirmation) {
        state.holdNextConfirmation = false
        await new Promise<void>((resolve) => { state.releaseConfirmation = resolve })
        state.releaseConfirmation = null
      }
      if (state.failNextConfirmation) {
        state.failNextConfirmation = false
        return json({ message: "Synthetic confirmation failure. Please retry." }, 503)
      }
      const saved = { ...confirmation, id: "synthetic-confirmation", confirmedAt: confirmation.status === "confirmed" ? new Date().toISOString() : null,
        confirmedBy: confirmation.status === "confirmed" ? "alice@example.invalid" : null,
        ...(annual ? { confirmedSourceRevision: confirmation.status === "confirmed" ? 7 : null } : {}) }
      if (annual) {
        state.annualConfirmations[`${confirmation.personId}:${confirmation.year}`] = saved
        return json({ success: true, annualConfirmation: saved })
      }
      state.confirmations[`${confirmation.personId}:${confirmation.year}:${confirmation.month}`] = saved
      return json({ success: true, confirmation: saved })
    }
    const year = Number(url.searchParams.get("year") || state.currentYear)
    const month = Number(url.searchParams.get("month") || state.currentMonth)
    const common = { year, sourceRevision: 7, people, staffOrder: ["AT", "BT"], availableYears: [state.currentYear, state.currentYear - 1] }
    if (url.searchParams.get("view") === "all-time") return json({
      ...common, view: "all-time", annualConfirmationAvailable: state.annualConfirmationAvailable, schedules: [], syncRuns: [], availableUsers: [], allTimeSummaries: [], entitlements: [], monthlyAdjustments: [],
      annualSummaries: people.map((person) => ({ personId: person.id, codeTotals: {}, canConfirm: state.annualConfirmationAvailable && year < state.currentYear && (permission === "edit" || person.id === ownPersonId), confirmation: state.annualConfirmationAvailable ? state.annualConfirmations[`${person.id}:${year}`] || null : null })),
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
  return { loading: false, authenticated: window.__attendanceConfirmationHarness.signedIn, resetRequired: false, role: "VIEW", permissions, pages: ADMIN_PAGE_DEFINITIONS }
}
