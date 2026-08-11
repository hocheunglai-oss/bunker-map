import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { applyEventCalendarMutation } from "../lib/eventCalendarStore"

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

test("stale whole-calendar PUTs cannot replace Event Calendar records", () => {
  const route = source("../app/api/office-calendar-store/[key]/route.ts")
  const putStart = route.indexOf("export async function PUT")
  const patchStart = route.indexOf("export async function PATCH", putStart)
  const put = route.slice(putStart, patchStart)

  assert.match(put, /operation: "settings"/)
  assert.match(put, /mutateEventCalendarStore\(supabase/)
  assert.doesNotMatch(put, /p_settings:[\s\S]*events:/)
})

test("event edits use the atomic mutation endpoint before updating the UI", () => {
  const page = source("../app/admin/eventcalendar/page.tsx")

  assert.match(page, /method: "PATCH"/)
  assert.match(page, /await mutateCalendar\("upsert", \[nextEvent\]\)/)
  assert.match(page, /await mutateCalendar\("delete", \[\], \[draftEvent\.id\]/)
  assert.match(page, /await mutateCalendar\("upsert", nextEvents\)/)
})

test("per-event mutations preserve unrelated concurrent records", () => {
  const original = {
    events: [
      { id: "a", title: "OLD A" },
      { id: "b", title: "KEEP B" },
    ],
    deletedEventIds: ["old-delete"],
  }

  const updated = applyEventCalendarMutation(original, {
    operation: "upsert",
    events: [{ id: "a", title: "NEW A" }],
  })
  assert.deepEqual(updated.events, [
    { id: "b", title: "KEEP B" },
    { id: "a", title: "NEW A" },
  ])
  assert.deepEqual(updated.deletedEventIds, ["old-delete"])
})

test("recovery and AI inserts use atomic Event Calendar mutations", () => {
  const recovery = source("../app/api/event-calendar/recover-missing/route.ts")
  const aiWorkbench = source("../app/api/admin/ai-workbench/route.ts")

  assert.match(recovery, /mutateEventCalendarStore\(supabase/)
  assert.match(aiWorkbench, /mutateEventCalendarStore\(supabase/)
  assert.doesNotMatch(recovery, /from\("office_calendar_store"\)\.upsert/)
})
