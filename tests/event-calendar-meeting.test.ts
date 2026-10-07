import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { addCalendarDays, getHongKongDateKey, isValidCalendarDate, preserveCalendarEndDate } from "../lib/eventCalendarDates"
import { calendarIntervalsOverlap, collectCalendarPages, googleMeetingRoomDates, meetingRoomInterval, normalizeMeetingRoomGoogleEvent } from "../lib/eventCalendarMeeting"

const booking = (startDate: string, endDate: string, title: string) => ({ startDate, endDate, title })

test("Hong Kong today and calendar arithmetic are independent of machine timezone", () => {
  assert.equal(getHongKongDateKey(new Date("2026-10-06T16:00:00Z")), "2026-10-07")
  assert.equal(getHongKongDateKey(new Date("2026-12-31T16:00:00Z")), "2027-01-01")
  assert.equal(addCalendarDays("2028-02-28", 1), "2028-02-29")
  assert.equal(addCalendarDays("2026-12-31", 1), "2027-01-01")
  assert.equal(isValidCalendarDate("2026-02-29"), false)
  assert.equal(isValidCalendarDate(undefined), false)
  assert.throws(() => addCalendarDays("2026-02-30", 1))
})

test("changing From preserves an existing valid later To in all forms", () => {
  assert.equal(preserveCalendarEndDate("2026-08-12", "2026-08-21"), "2026-08-21")
  assert.equal(preserveCalendarEndDate("2026-08-22", "2026-08-21"), "2026-08-22")
  assert.equal(preserveCalendarEndDate("2026-08-12", ""), "2026-08-12")
  const page = readFileSync(new URL("../app/admin/eventcalendar/page.tsx", import.meta.url), "utf8")
  assert.equal((page.match(/preserveCalendarEndDate\(event.target.value, current.endDate\)/g) || []).length, 2)
  assert.match(page, /preserveCalendarEndDate\(event.target.value, current.to\)/)
})

test("overnight and multi-day room conflicts use complete intervals, allowing touching boundaries", () => {
  const overnight = meetingRoomInterval(booking("2026-10-07", "2026-10-07", "23:30-01:00 meeting"))
  const followingMorning = meetingRoomInterval(booking("2026-10-08", "2026-10-08", "00:15-00:45 meeting"))
  assert.equal(calendarIntervalsOverlap(overnight, followingMorning), true)
  assert.equal(calendarIntervalsOverlap(overnight, meetingRoomInterval(booking("2026-10-08", "2026-10-08", "01:00-02:00 next"))), false)
  const multiDay = meetingRoomInterval(booking("2026-10-07", "2026-10-09", "14:00 room"))
  assert.equal(multiDay.allDay, true, "times embedded in multi-day titles do not change their all-day semantics")
  assert.equal(calendarIntervalsOverlap(multiDay, meetingRoomInterval(booking("2026-10-09", "2026-10-09", "17:00 last day"))), true)
  assert.equal(calendarIntervalsOverlap(multiDay, meetingRoomInterval(booking("2026-10-10", "2026-10-10", "00:00 next day"))), false)
})

test("Google publishing and availability checks share the same interval for timed and all-day entries", () => {
  for (const input of [
    booking("2026-10-07", "2026-10-07", "23:30 meeting"),
    booking("2026-10-07", "2026-10-07", "23:30-01:00 meeting"),
    booking("2026-10-07", "2026-10-07", "all day"),
    booking("2026-10-07", "2026-10-09", "14:00 multiple dates"),
  ]) {
    const expected = meetingRoomInterval(input)
    const actual = normalizeMeetingRoomGoogleEvent({ id: "test", ...googleMeetingRoomDates(input) }, "calendar")!
    assert.deepEqual({ startMs: actual.startMs, endMs: actual.endMs, allDay: actual.allDay }, expected)
    assert.equal(actual.startDate, input.startDate)
    if (expected.allDay) assert.equal(actual.endDate, input.endDate)
  }
})

test("Google all-day end is display-inclusive but calculation-exclusive", () => {
  const event = normalizeMeetingRoomGoogleEvent({ id: "all-day", start: { date: "2026-10-07" }, end: { date: "2026-10-08" } }, "calendar")!
  assert.equal(event.startDate, "2026-10-07")
  assert.equal(event.endDate, "2026-10-07")
  assert.equal(event.endMs - event.startMs, 86_400_000)
  assert.equal(event.startTime, "")
  assert.equal(event.endTime, "")
  assert.equal(normalizeMeetingRoomGoogleEvent({ status: "cancelled" }, "calendar"), null)
  assert.throws(() => normalizeMeetingRoomGoogleEvent({ start: { dateTime: "not a date" }, end: { dateTime: "not a date" } }, "calendar"))
})

test("Google event pagination includes every page and fails closed on incomplete or repeated cursors", async () => {
  const requested: Array<string | undefined> = []
  const records = await collectCalendarPages(async (token) => {
    requested.push(token)
    return token ? { items: [251], nextPageToken: null } : { items: Array.from({ length: 250 }, (_, i) => i + 1), nextPageToken: "second" }
  })
  assert.deepEqual(requested, [undefined, "second"])
  assert.equal(records.length, 251)
  assert.equal(records[250], 251)
  await assert.rejects(() => collectCalendarPages(async () => ({ items: [], nextPageToken: "same" })), /incomplete listing/)
  await assert.rejects(() => collectCalendarPages(async () => { throw new Error("Provider unavailable") }), /Provider unavailable/)
})

test("page loads are read-only, conflict checks use actual bounds, and recurrent saves ask once", () => {
  const page = readFileSync(new URL("../app/admin/eventcalendar/page.tsx", import.meta.url), "utf8")
  const holidayCheck = page.slice(page.indexOf("async function checkPublicHolidays"), page.indexOf("async function syncCanonicalGoogleCalendar"))
  assert.doesNotMatch(holidayCheck, /mutateCalendar|persistImportedEvents|method: "POST"/)
  assert.match(page, /if \(!canEdit\) throw new Error\("You have view-only access/)
  assert.match(page, /new Date\(booking.startMs\).toISOString\(\)/)
  assert.match(page, /new Date\(booking.endMs\).toISOString\(\)/)
  assert.match(page, /calendarIntervalsOverlap\(booking, googleEvent\)/)
  assert.doesNotMatch(page, /googleEvent.startDate !== event.startDate/)
  const recurrent = page.slice(page.indexOf("async function saveRecurrentEvents"), page.indexOf("async function sendLeaveRequest"))
  assert.match(recurrent, /occurrenceDates.length > 100/)
  assert.match(recurrent, /setEmailPrompt/)
  assert.match(recurrent, /normalizeEventVersions\(result.eventVersions\)/)
})
