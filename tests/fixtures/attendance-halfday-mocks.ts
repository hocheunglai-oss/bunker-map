// Synthetic daily ledger only; never connects to a real attendance service.
import { installAttendanceConfirmationHarness } from "./attendance-confirmation-mocks"
export { useSimpleAdminAuth, useRouter, usePathname } from "./attendance-confirmation-mocks"
type Entry = { id: string; groupId: string; personId: string; leaveDate: string; portion: string; code: string; units: number; note: string | null }
declare global { interface Window { __halfday: { entries: Entry[]; posts: Record<string, unknown>[]; failNext: boolean; date: string } } }
const id = "11111111-1111-4111-8111-111111111111"
const person = { id, staffCode: "AT", displayName: "Alice Test", team: "BT", isActive: true, dingTalkUserId: null, employmentStartDate: null, employmentEndDate: null }
// Representative multi-staff roster, matching the production daily matrix.
const people = [person, ...Array.from({ length: 7 }, (_, index) => ({ ...person, id: `synthetic-peer-${index}`, staffCode: `T${index}`, displayName: `Test Colleague ${index}` }))]
export function installHalfdayHarness() {
  installAttendanceConfirmationHarness()
  const original = window.fetch
  const h = window.__attendanceConfirmationHarness
  const date = `${h.currentYear}-${String(h.currentMonth).padStart(2, "0")}-02`
  const state = { entries: [] as Entry[], posts: [] as Record<string, unknown>[], failNext: false, date }
  const params = new URLSearchParams(location.search)
  let manualMode = params.get("manualMode") === "home-office" ? "home-office" : null
  let signOut = params.get("morningOut") === "13:00" ? `${date}T13:00:00+08:00` : null
  if (params.get("pmLeave") === "1") state.entries.push({ id: "synthetic-existing-pm", groupId: "synthetic", personId: id, leaveDate: date, portion: "pm", code: "ALS", units: 0.5, note: null })
  window.__halfday = state
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  window.fetch = async (input, init) => {
    const request = new Request(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin), init)
    const url = new URL(request.url)
    if (url.origin !== location.origin || url.pathname !== "/api/admin/attendance") throw new Error("Unexpected fixture destination")
    if (request.method === "POST") {
      const body = await request.json()
      state.posts.push(body)
      if (!h.signedIn || h.permission !== "edit" || body.action !== "save-day-edit") return json({ message: "Forbidden" }, 403)
      if (state.failNext) { state.failNext = false; return json({ message: "Synthetic save failed; original records preserved." }, 503) }
      const edit = body.dayEdit
      if (edit.personId !== id || edit.workDate !== date) throw new Error("Unexpected fixture record")
      if (edit.existingLeaveEntryId && !state.entries.some(entry => entry.id === edit.existingLeaveEntryId)) return json({ message: "Attendance entry no longer exists." }, 400)
      const remaining = state.entries.filter(entry => entry.id !== edit.existingLeaveEntryId)
      if (edit.leaveEnabled) {
        if (remaining.some(entry => entry.portion === "full" || edit.leavePortion === "full" || entry.portion === edit.leavePortion)) return json({ message: "Attendance entries overlap." }, 400)
        remaining.push({ id: `synthetic-${state.posts.length}`, groupId: "synthetic", personId: id, leaveDate: date,
          portion: edit.leavePortion, code: edit.leaveCode, units: edit.leavePortion === "full" ? 1 : 0.5, note: edit.leaveNote || null })
      }
      state.entries = remaining
      manualMode = edit.workMode === "default" ? null : edit.workMode
      if (edit.updateSignOut) signOut = `${date}T${edit.signOutTime}:00+08:00`
      return json({ success: true })
    }
    if (url.searchParams.get("view") === "all-time" || url.searchParams.get("scope") === "year" || !h.signedIn || h.permission === "none") return original(input, init)
    const mode = manualMode || (state.entries.some(entry => entry.code === "HO") ? "home-office" : state.entries.some(entry => entry.code === "OS") ? "business-trip" : "office")
    const record = { person, workDate: date, date, leave: state.entries, punches: [], overrides: [], effectiveSignIn: signOut ? `${date}T10:00:00+08:00` : null, effectiveSignOut: signOut,
      workMode: mode, defaultWorkMode: "office", workModeSource: manualMode ? "manual" : mode === "office" ? "default" : "leave",
      workModeOverride: manualMode ? { id: "synthetic-manual-mode", mode: manualMode } : null, status: mode, late: false, early: false,
      schedule: { team: "BT", workStart: "10:00", workEnd: "19:00", amCutoff: "13:00", pmCutoff: "14:00" } }
    return json({ year: h.currentYear, month: h.currentMonth, people, staffOrder: people.map(p => p.staffCode), summaries: [], calendarDays: [{ date, records: [record] }] })
  }
}
