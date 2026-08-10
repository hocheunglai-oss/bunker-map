import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { OfficeCalendarEvent } from "../data/eventCalendar"
import {
  DEFAULT_ATTENDANCE_STAFF_ORDER,
  loadAttendanceCalendarContext,
} from "../lib/attendanceCalendar"
import { mergeImportedEvents } from "../lib/eventCalendarImport"

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

function calendarClient(result: { data: unknown; error: { message: string } | null }) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => result,
              }
            },
          }
        },
      }
    },
  } as unknown as SupabaseClient
}

test("attendance calendar surfaces persisted-store query failures", async () => {
  await assert.rejects(
    loadAttendanceCalendarContext(
      calendarClient({
        data: null,
        error: { message: "permission denied" },
      }),
    ),
    /Could not load persisted Event Calendar: permission denied/,
  )
})

test("attendance calendar bootstraps only an absent or empty store", async () => {
  const absent = await loadAttendanceCalendarContext(
    calendarClient({ data: null, error: null }),
  )
  assert.deepEqual(absent.staffOrder, [...DEFAULT_ATTENDANCE_STAFF_ORDER])
  assert.ok(absent.holidaysByDate.size > 0)

  const emptyStore = await loadAttendanceCalendarContext(
    calendarClient({ data: { payload: {} }, error: null }),
  )
  assert.deepEqual(emptyStore.staffOrder, [...DEFAULT_ATTENDANCE_STAFF_ORDER])
  assert.equal(emptyStore.holidaysByDate.size, absent.holidaysByDate.size)

  const explicitEmptyCalendar = await loadAttendanceCalendarContext(
    calendarClient({
      data: { payload: { events: [], people: ["SC", "VL"] } },
      error: null,
    }),
  )
  assert.deepEqual(explicitEmptyCalendar.staffOrder, ["SC", "VL"])
  assert.equal(explicitEmptyCalendar.holidaysByDate.size, 0)

  await assert.rejects(
    loadAttendanceCalendarContext(
      calendarClient({
        data: { payload: { people: ["SC", "VL"] } },
        error: null,
      }),
    ),
    /Persisted Event Calendar payload is invalid/,
  )
})

test("HK import backfills missing dates without replacing legacy attendees", () => {
  const legacy: OfficeCalendarEvent = {
    id: "fc-2026-099",
    startDate: "2026-10-01",
    endDate: "2026-10-01",
    title: "HOLIDAY ATTENDANCE - NATIONAL DAY (BT X 3)",
    people: ["VL", "SC", "KZ"],
    tags: [],
  }
  const imported: OfficeCalendarEvent[] = [
    {
      id: "public-holiday-hk-2026-10-01",
      startDate: "2026-10-01",
      endDate: "2026-10-01",
      title: "HOLIDAY ATTENDANCE - NATIONAL DAY",
      people: [],
      tags: ["public-holiday", "HK"],
    },
    {
      id: "public-holiday-hk-2026-12-26",
      startDate: "2026-12-26",
      endDate: "2026-12-26",
      title: "HOLIDAY ATTENDANCE - THE FIRST WEEKDAY AFTER CHRISTMAS DAY",
      people: [],
      tags: ["public-holiday", "HK"],
    },
  ]

  const merged = mergeImportedEvents([legacy], imported)

  assert.equal(merged.length, 2)
  assert.strictEqual(merged[0], legacy)
  assert.deepEqual(merged[0].people, ["VL", "SC", "KZ"])
  assert.equal(merged[1].id, "public-holiday-hk-2026-12-26")
})

test("foreign public holidays never receive the HK attendance title", () => {
  const route = source("../app/api/event-calendar/public-holidays/route.ts")
  assert.match(route, /country\.code === "HK"/)
  assert.doesNotMatch(route, /titleStyle === "holiday-attendance"/)
})
