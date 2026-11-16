import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { transformSync } from "esbuild"
import { getEventCalendarRecordVersion } from "../lib/eventCalendarStore"
import { collectCalendarPages, googleMeetingRoomDates } from "../lib/eventCalendarMeeting"

const requireNative = createRequire(import.meta.url)
const source = readFileSync(new URL("../app/api/event-calendar/google-sync/route.ts", import.meta.url), "utf8")
const route = transformSync(source, { loader: "ts", format: "cjs", target: "node24" }).code

test("the Google worker releases only the cancelled event's room without emailing and retains failed work", async () => {
  const cancelled = { id: "booking", title: "SYNTHETIC MEETING", startDate: "2026-11-16", endDate: "2026-11-16", people: ["OL"], tags: [], eventType: "Meeting Room", cancelled: true }
  const job = { event_id: cancelled.id, attempts: 0, requested_at: "2026-11-16T00:00:00Z" }
  const room = "synthetic-room@example.test"
  let jobs = [job], transportFailed = true
  const bookings = new Map([["owned-1", "booking"], ["owned-2", "booking"], ["unrelated", "other"]])
  const providerCalls: unknown[] = []
  const queueWrites: unknown[] = []
  const client = {
    async rpc(name: string, args: { p_event_ids: string[] }) {
      assert.equal(name, "claim_event_calendar_google_sync_jobs")
      assert.deepEqual(args.p_event_ids, ["booking"])
      return { data: jobs, error: null }
    },
    from(table: string) {
      let action = "", values: unknown
      const filters: Record<string, string> = {}
      const q = {
        select(_key: string, options?: { head?: boolean }) {
          if (options?.head) return { count: jobs.length, error: null }
          if (!action) return q
          assert.equal(table, "event_calendar_google_sync_jobs")
          assert.deepEqual(filters, { event_id: job.event_id, requested_at: job.requested_at })
          queueWrites.push({ action, values })
          if (action === "delete") jobs = []
          return { data: [{ event_id: job.event_id }], error: null }
        },
        eq(key: string, value: string) { filters[key] = value; return q },
        maybeSingle() {
          assert.equal(table, "office_calendar_store")
          assert.deepEqual(filters, { key: "event-calendar" })
          return { data: { payload: { events: [cancelled] } }, error: null }
        },
        delete() { action = "delete"; return q },
        update(next: unknown) { action = "update"; values = next; return q },
      }
      return q
    },
  }
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: { json: Response.json } },
    "@supabase/supabase-js": { createClient: () => client },
    "@/lib/adminAuth": { requireAdminPagePermission: async () => undefined },
    "@/lib/eventCalendarStore": { getEventCalendarRecordVersion },
    "@/lib/eventCalendarMeeting": { collectCalendarPages, googleMeetingRoomDates },
    "@/lib/backupMaintenance": {},
    "@/lib/googleApis": { loadGoogleApis: async () => ({ google: {
      auth: { OAuth2: class { setCredentials() {} } },
      calendar: () => ({ events: {
        async list(input: { calendarId: string; privateExtendedProperty: string[] }) {
          assert.equal(input.calendarId, room)
          assert.deepEqual(input.privateExtendedProperty, ["bunkerMapEventId=booking"])
          return { data: { items: [...bookings].filter(([, id]) => id === "booking").map(([id]) => ({ id })) } }
        },
        async delete(input: { calendarId: string; eventId: string; sendUpdates: string }) {
          providerCalls.push(input)
          if (transportFailed) throw new Error("Synthetic Google outage")
          assert.equal(bookings.get(input.eventId), "booking")
          bookings.delete(input.eventId)
        },
        insert() { assert.fail("Cancelled event must not reserve a room") },
        update() { assert.fail("Cancelled event must not update a room reservation") },
      } }),
    } }) },
  }
  const loaded = { exports: {} as { POST: (request: Request) => Promise<Response> } }
  new Function("require", "module", "exports", "process", route)((name: string) => modules[name] ?? requireNative(name), loaded, loaded.exports, {
    cwd: () => process.cwd(),
    env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "test", GOOGLE_OAUTH_CLIENT_ID: "test", GOOGLE_OAUTH_CLIENT_SECRET: "test", GOOGLE_CALENDAR_REFRESH_TOKEN: "test", GOOGLE_CALENDAR_ID: room },
  })
  const run = async () => (await loaded.exports.POST(new Request("https://synthetic.test", { method: "POST", body: JSON.stringify({ eventIds: ["booking"] }) }))).json()
  const failure = await run()
  assert.equal(failure.success, false)
  assert.equal(failure.queued, 1)
  assert.match(failure.message, /queued for automatic retry/)
  assert.match(JSON.stringify(queueWrites), /"attempts":1/)
  providerCalls.length = 0
  transportFailed = false
  const success = await run()
  assert.equal(success.deleted, 2)
  assert.equal(success.queued, 0)
  assert.deepEqual(providerCalls, ["owned-1", "owned-2"].map((eventId) => ({ calendarId: room, eventId, sendUpdates: "none" })))
  assert.deepEqual([...bookings], [["unrelated", "other"]])
  assert.equal(cancelled.cancelled, true)
})
