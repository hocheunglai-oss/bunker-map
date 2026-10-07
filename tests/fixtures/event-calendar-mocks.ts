import type { OfficeCalendarEvent } from "../../data/eventCalendar"
import { ADMIN_PAGE_DEFINITIONS } from "../../lib/adminPages"
import { addCalendarDays, getHongKongDateKey } from "../../lib/eventCalendarDates"
import { EVENT_CALENDAR_PROTOCOL_VERSION } from "../../lib/eventCalendarProtocol"
import { googleMeetingRoomDates, normalizeMeetingRoomGoogleEvent } from "../../lib/eventCalendarMeeting"

type Harness = { requests: Array<{ method: string; path: string; body: Record<string, unknown> | null }>; events: OfficeCalendarEvent[]; viewOnly: boolean; today: string; emailStatus: string }
declare global { interface Window { __eventCalendarHarness: Harness } }

const version = "a".repeat(64)
function state() {
  const events = window.__eventCalendarHarness.events
  return { payload: { events, people: ["OL", "VL"], emailRecipientsText: "synthetic@example.test", deletedEventIds: [] }, protocolVersion: EVENT_CALENDAR_PROTOCOL_VERSION,
    eventVersions: Object.fromEntries(events.map((event) => [event.id, version])), settingVersions: { people: version, emailRecipientsText: version }, storeVersion: version }
}

export function installEventCalendarHarness() {
  window.localStorage.clear()
  const today = getHongKongDateKey()
  const holiday: OfficeCalendarEvent = { id: "synthetic-holiday", startDate: addCalendarDays(today, 15), endDate: addCalendarDays(today, 15), title: "SYNTHETIC VERIFIED HOLIDAY", people: [], tags: ["public-holiday", "HK"], eventType: "Public Holiday" }
  window.__eventCalendarHarness = {
    requests: [], viewOnly: new URLSearchParams(window.location.search).get("access") === "view", today, emailStatus: "delivered",
    events: [{ id: "synthetic-event", startDate: today, endDate: addCalendarDays(today, 10), title: "MULTI DAY SYNTHETIC EVENT", people: ["OL"], tags: [], eventType: "Unclassified" }],
  }
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin)
    if (url.origin !== window.location.origin) throw new Error("External request blocked by event test fixture")
    const method = init?.method || (input instanceof Request ? input.method : "GET")
    const body = init?.body ? JSON.parse(String(init.body)) : null
    const h = window.__eventCalendarHarness
    h.requests.push({ method, path: url.pathname, body })
    const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } })
    if (h.viewOnly && method !== "GET") return json({ message: "Forbidden" }, 403)
    if (url.pathname === "/api/office-calendar-store/event-calendar") {
      if (method === "GET") return json(state())
      if (method === "PATCH") {
        if (body.operation === "update") h.events = h.events.map((event) => body.events.find((next: OfficeCalendarEvent) => next.id === event.id) || event)
        if (body.operation === "create") h.events.push(...body.events)
        return json({ success: true, ...state() })
      }
    }
    if (url.pathname === "/api/event-calendar/public-holidays") {
      const coverage = { complete: true, coverage: [{ country: "HK", year: Number(today.slice(0, 4)), status: "verified" }], revision: "synthetic-revision" }
      if (method === "GET") return json({ events: [holiday], ...coverage })
      const plan = { additions: [holiday], updates: [], removals: [], preserved: [], complete: true }
      if (body.action === "preview") return json({ plan, storeVersion: version, ...coverage })
      if (body.action === "apply") { h.events.push(holiday); return json({ plan, ...coverage, ...state() }) }
    }
    if (url.pathname === "/api/event-calendar/google-sync") return json({ success: true, updated: 0, inserted: 0, deleted: 0, queued: 0 })
    if (url.pathname === "/api/event-calendar/google-events") {
      const dates = googleMeetingRoomDates({ startDate: addCalendarDays(today, -1), endDate: addCalendarDays(today, -1), title: "23:30-01:00 EXISTING OVERNIGHT BOOKING" })
      return json({ events: [normalizeMeetingRoomGoogleEvent({ id: "external-booking", summary: "EXISTING OVERNIGHT BOOKING", ...dates }, "synthetic")] })
    }
    if (["/api/event-calendar/email-notify", "/api/event-calendar/leave-request"].includes(url.pathname)) return json({ success: h.emailStatus !== "in_progress", status: h.emailStatus, sent: 1 }, h.emailStatus === "in_progress" ? 202 : 200)
    throw new Error(`Unexpected event fixture request: ${method} ${url.pathname}`)
  }
}
export function useSimpleAdminAuth() {
  return { loading: false, authenticated: true, resetRequired: false, username: "synthetic-user", displayName: "Synthetic user", role: "user",
    permissions: { "event-calendar": window.__eventCalendarHarness.viewOnly ? "view" as const : "edit" as const }, pages: ADMIN_PAGE_DEFINITIONS }
}
const router = { replace: () => {}, push: () => {} }
export function usePathname() { return "/admin/eventcalendar" }
export function useRouter() { return router }
