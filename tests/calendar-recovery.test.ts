import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { afterEach, beforeEach, mock, test } from "node:test"
import { transformSync } from "esbuild"
import { createClient } from "@supabase/supabase-js"
import { loadEventCalendarHistory, readRecoverableHolidaySource, type CalendarAuditRow } from "../lib/eventCalendarRecovery"
import * as eventStore from "../lib/eventCalendarStore"
import { EVENT_CALENDAR_PROTOCOL_VERSION } from "../lib/eventCalendarProtocol"
import { getVerifiedPublicHolidays, holidayBaseline } from "../lib/holidayCalendar"
import { planHolidayReconciliation } from "../lib/eventCalendarImport"

const at = "2026-10-07T02:00:00.000Z"
const event = (id: string, title = id) => ({ id, title, startDate: "2026-10-08", endDate: "2026-10-08", people: ["OL"], uncertainPeople: [], tags: [], eventType: "Unclassified" })
const audit = (id: number, key = "event-calendar", occurred_at = "2026-10-06T02:00:00.000Z"): CalendarAuditRow => ({ id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`, occurred_at, actor_id: "synthetic", actor_name: "Synthetic", before_row: null, after_row: { key, payload: { events: [event(`old-${id}`)] } } })

beforeEach(() => mock.timers.enable({ apis: ["Date"], now: new Date(at) }))
afterEach(() => mock.timers.reset())

function historyClient(rows: CalendarAuditRow[], options: { failPage?: number; appendAfterFirst?: CalendarAuditRow } = {}) {
  const requests: URL[] = []
  const client = createClient("https://synthetic-calendar.supabase.test", "synthetic-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      assert.equal(url.hostname, "synthetic-calendar.supabase.test")
      assert.equal(url.pathname, "/rest/v1/audit_logs")
      requests.push(url)
      if (requests.length === options.failPage) return new Response(JSON.stringify({ message: "Synthetic read failure" }), { status: 500, headers: { "Content-Type": "application/json" } })
      assert.equal(url.searchParams.get("table_schema"), "eq.public")
      assert.equal(url.searchParams.get("table_name"), "eq.office_calendar_store")
      assert.equal(url.searchParams.get("order"), "occurred_at.desc,id.desc")
      assert.equal(url.searchParams.get("limit"), "200")
      const ors = url.searchParams.getAll("or")
      assert.equal(ors[0], "(before_row->>key.eq.event-calendar,after_row->>key.eq.event-calendar)", "key filter is sent to the DB before pagination")
      if (requests.length === 2 && options.appendAfterFirst) rows.push(options.appendAfterFirst)
      const cutoff = url.searchParams.get("occurred_at")!.slice(4)
      let selected = rows.filter((row) => row.occurred_at <= cutoff && [row.before_row, row.after_row].some((value) => (value as { key?: string } | null)?.key === "event-calendar"))
      if (ors.length > 1) {
        const match = ors[1].match(/^\(occurred_at\.lt\.([^,]+),and\(occurred_at\.eq\.[^,]+,id\.lt\.([^)]*)\)\)$/)
        assert.ok(match, "next page uses the stable timestamp+ID keyset")
        selected = selected.filter((row) => row.occurred_at < match[1] || row.occurred_at === match[1] && row.id < match[2])
      }
      selected.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || b.id.localeCompare(a.id))
      return new Response(JSON.stringify(selected.slice(0, 200)), { status: 200, headers: { "Content-Type": "application/json" } })
    } },
  })
  return { client, requests }
}

test("recovery paginates beyond 500 relevant rows without unrelated calendar/email history consuming the limit", async () => {
  const rows = [...Array.from({ length: 625 }, (_, i) => audit(i + 1)), ...Array.from({ length: 1200 }, (_, i) => audit(i + 10000, "task-calendar", "2026-10-07T01:00:00.000Z"))]
  const app = historyClient(rows)
  const result = await loadEventCalendarHistory(app.client, at)
  assert.equal(result.rows.length, 625)
  assert.equal(result.historyScanned, 625)
  assert.equal(result.historyComplete, true)
  assert.equal(app.requests.length, 4)
  assert.equal(new Set(result.rows.map((row) => row.id)).size, 625, "equal timestamps cannot duplicate or skip IDs")
})

test("recovery snapshot excludes later arrivals and labels bounded histories as incomplete", async () => {
  const app = historyClient(Array.from({ length: 201 }, (_, i) => audit(i)), { appendAfterFirst: audit(99999, "event-calendar", "2026-10-07T03:00:00.000Z") })
  const first = await loadEventCalendarHistory(app.client, at)
  assert.equal(first.rows.length, 201)
  assert.ok(!first.rows.some((row) => row.id.endsWith("99999")))
  const bounded = historyClient(Array.from({ length: 10001 }, (_, i) => audit(i)))
  const result = await loadEventCalendarHistory(bounded.client, at)
  assert.equal(result.rows.length, 10000)
  assert.equal(result.historyComplete, false)
  assert.equal(bounded.requests.length, 50)
  assert.equal(result.oldestChecked, "2026-10-06T02:00:00.000Z")
})

test("history read errors fail closed instead of passing a partial recovery set", async () => {
  const app = historyClient(Array.from({ length: 300 }, (_, i) => audit(i)), { failPage: 2 })
  await assert.rejects(() => loadEventCalendarHistory(app.client, at), /Nothing was restored/)
})

const routeCode = transformSync(readFileSync(new URL("../app/api/event-calendar/recover-missing/route.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
function recoveryRoute(options: { permissionFailure?: string; auditPermissionFailure?: boolean; historyComplete?: boolean; historyError?: boolean; historyEvents?: unknown[]; previousHistoryEvents?: unknown[]; failWrites?: boolean; concurrentChange?: (payload: Record<string, unknown>) => Record<string, unknown> } = {}) {
  let payload: Record<string, unknown> = { events: [event("keep", "LATEST SAVED TITLE")], deletedEventIds: ["deleted"], people: ["OL"], emailRecipientsText: "office@example.test" }
  const permissions: string[] = [], writes: unknown[] = []
  const batches: eventStore.CalendarMutation[][] = []
  let updatedAt = "2026-10-07T00:00:00.000Z", raced = false
  let historyReads = 0, clients = 0
  const history: CalendarAuditRow[] = [{ ...audit(1), after_row: { key: "event-calendar", payload: { events: options.historyEvents || [event("keep", "STALE TITLE"), event("deleted"), event("recover"), { ...event("past"), startDate: "2026-10-01", endDate: "2026-10-01" }] } }, before_row: options.previousHistoryEvents ? { key: "event-calendar", payload: { events: options.previousHistoryEvents } } : null }]
  const db = { from(table: string) {
    assert.equal(table, "office_calendar_store")
    let change: Record<string, unknown> | undefined, expected = ""
    const query = {
      select() { return query },
      eq(key: string, value: unknown) { if (key === "key") assert.equal(value, "event-calendar"); if (key === "updated_at") expected = String(value); return query },
      update(value: Record<string, unknown>) { change = value; return query },
      async maybeSingle() {
        if (!change) return { data: { payload: structuredClone(payload), updated_at: updatedAt }, error: null }
        if (options.failWrites) return { data: null, error: Error("Synthetic recovery write failure") }
        if (options.concurrentChange && !raced) { raced = true; payload = options.concurrentChange(payload); updatedAt = "2026-10-07T00:00:01.000Z" }
        if (expected !== updatedAt) return { data: null, error: null }
        payload = structuredClone(change.payload as Record<string, unknown>); updatedAt = String(change.updated_at)
        writes.push(structuredClone(payload))
        return { data: { payload: structuredClone(payload) }, error: null }
      },
    }
    return query
  } }
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@/lib/adminAuth": { async requireAdminPagePermission(page: string, permission: string) { permissions.push(`${page}:${permission}`); if (options.permissionFailure) throw new Error(options.permissionFailure); if (page === "audit-log" && options.auditPermissionFailure) throw new Error("Forbidden"); return { username: "synthetic" } } },
    "@/lib/adminAudit": { createAdminAuditContext() { return {} }, createAdminAuditedSupabaseClient(_context: unknown, settings: unknown) { assert.deepEqual(settings, { useServiceRole: true }); return db } },
    "@/lib/eventCalendarStore": { ...eventStore, async mutateEventCalendarStoreBatch(client: unknown, mutations: eventStore.CalendarMutation[]) { batches.push(structuredClone(mutations)); return eventStore.mutateEventCalendarStoreBatch(client as never, mutations) } },
    "@/lib/eventCalendarProtocol": { EVENT_CALENDAR_PROTOCOL_VERSION },
    "@/lib/calendarServiceClient": { createCalendarServiceClient() { clients += 1; return db } },
    "@/lib/eventCalendarRecovery": { readRecoverableHolidaySource, async loadEventCalendarHistory() { historyReads += 1; if (options.historyError) throw new Error("History unavailable"); return { rows: history, historyComplete: options.historyComplete !== false, historyScanned: 1, oldestChecked: history[0].occurred_at } } },
  }
  const loaded = { exports: {} as { GET(): Promise<Response>; POST(request: Request): Promise<Response> } }
  new Function("require", "module", "exports", routeCode)((name: string) => { assert.ok(Object.hasOwn(modules, name), `Unexpected dependency ${name}`); return modules[name] }, loaded, loaded.exports)
  return { permissions, writes, batches, payload: () => structuredClone(payload), reads: () => ({ historyReads, clients }), async request(method = "POST", body: unknown = {}) { const response = method === "GET" ? await loaded.exports.GET() : await loaded.exports.POST(new Request("https://synthetic.test/recover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })); return { status: response.status, body: await response.json() } } }
}

test("recovery requires Event Edit and Audit View before reading or writing history", async () => {
  for (const options of [{ permissionFailure: "Unauthorized" }, { permissionFailure: "Forbidden" }, { auditPermissionFailure: true }]) {
    for (const method of ["GET", "POST"]) {
      const app = recoveryRoute(options)
      assert.equal((await app.request(method)).status, options.permissionFailure === "Unauthorized" ? 401 : 403)
      assert.deepEqual(app.reads(), { historyReads: 0, clients: 0 })
      assert.deepEqual(app.writes, [])
    }
  }
})

test("recovery restores missing future events only, preserves saved edits/deletions and reports history scope", async () => {
  const app = recoveryRoute({ historyComplete: false })
  const first = await app.request()
  assert.equal(first.status, 200)
  assert.equal(first.body.restoredCount, 1)
  assert.deepEqual(first.body.restoredEvents.map((entry: { id: string }) => entry.id), ["recover"])
  assert.equal(first.body.payload.events.find((entry: { id: string }) => entry.id === "keep").title, "LATEST SAVED TITLE")
  assert.deepEqual(first.body.payload.deletedEventIds, ["deleted"])
  assert.equal(first.body.historyComplete, false)
  assert.equal(first.body.historyScanned, 1)
  assert.equal(first.body.oldestChecked, "2026-10-06T02:00:00.000Z")
  assert.equal((await app.request()).body.restoredCount, 0)
  assert.equal(app.writes.length, 1, "repeat recovery cannot reinsert events")
})

test("recovery stops on history failure with no writes", async () => {
  const app = recoveryRoute({ historyError: true })
  assert.equal((await app.request()).status, 500)
  assert.deepEqual(app.writes, [])
})

test("malformed historical rows are counted once and cannot poison valid recovery or revive an older version", async () => {
  const malformed = { ...event("bad"), startDate: "not-a-date", endDate: "not-a-date" }
  const noId = { ...event(""), id: "", title: "INVALID MISSING ID" }
  const app = recoveryRoute({ historyEvents: [event("valid"), malformed, malformed, noId, noId], previousHistoryEvents: [event("bad", "OLDER VALID VERSION")] })
  const preview = await app.request("GET")
  assert.equal(preview.status, 200)
  assert.equal(preview.body.count, 1)
  assert.equal(preview.body.skippedInvalidCount, 2)
  assert.equal(app.writes.length, 0)
  const result = await app.request()
  assert.equal(result.status, 200)
  assert.equal(result.body.restoredCount, 1)
  assert.equal(result.body.skippedInvalidCount, 2)
  assert.equal(result.body.remainingCount, 0)
  assert.deepEqual(result.body.restoredEvents.map((entry: { id: string }) => entry.id), ["valid"])
  assert.ok(!result.body.payload.events.some((entry: { id: string }) => entry.id === "bad"))
  assert.equal(app.writes.length, 1)
  assert.equal((await app.request()).body.restoredCount, 0)
  assert.equal(app.writes.length, 1)
})

test("recovery reuses incoming event validation for invalid titles, IDs, arrays, event types and date ranges", async () => {
  for (const change of [{ title: "" }, { id: " padded " }, { people: [42] }, { tags: "bad" }, { eventType: "Unknown" }, { startDate: "2026-10-09", endDate: "2026-10-08" }]) {
    const app = recoveryRoute({ historyEvents: [event("valid"), { ...event("invalid"), ...change }] })
    const result = await app.request()
    assert.equal(result.status, 200)
    assert.equal(result.body.restoredCount, 1)
    assert.equal(result.body.skippedInvalidCount, 1)
    assert.equal(app.writes.length, 1)
  }
})

test("a malformed newest past-dated row cannot revive an older future version, while valid past-date policy is unchanged", async () => {
  const past = { ...event("past"), startDate: "2026-10-01", endDate: "2026-10-01" }
  const app = recoveryRoute({ historyEvents: [{ ...past, title: "" }, { ...past, id: "valid-past" }], previousHistoryEvents: [event("past"), event("valid-past")] })
  const result = await app.request()
  assert.equal(result.status, 200)
  assert.equal(result.body.skippedInvalidCount, 1)
  assert.deepEqual(result.body.restoredEvents.map((entry: { id: string }) => entry.id), ["valid-past"])
})

test("501 missing events use two bounded inserts and one atomic CAS commit", async () => {
  const app = recoveryRoute({ historyEvents: Array.from({ length: 501 }, (_, i) => event(`recover-${i}`)) })
  const result = await app.request()
  assert.equal(result.status, 200)
  assert.equal(result.body.restoredCount, 501)
  assert.equal(result.body.remainingCount, 0)
  assert.equal(app.writes.length, 1)
  assert.deepEqual(app.batches[0].map((mutation) => mutation.events?.length), [500, 1])
  assert.equal(result.body.payload.emailRecipientsText, "office@example.test")
  assert.deepEqual(result.body.payload.deletedEventIds, ["deleted"])
  assert.equal((await app.request()).body.restoredCount, 0)
  assert.equal(app.writes.length, 1)
})

test("5001 missing events restore at most ten bounded inserts and report the remaining event", async () => {
  const app = recoveryRoute({ historyEvents: Array.from({ length: 5001 }, (_, i) => event(`recover-${i}`)) })
  const first = await app.request()
  assert.equal(first.status, 200)
  assert.equal(first.body.restoredCount, 5000)
  assert.equal(first.body.remainingCount, 1)
  assert.equal(app.writes.length, 1)
  assert.equal(app.batches[0].length, 10)
  assert.ok(app.batches[0].every((mutation) => mutation.events?.length === 500))
  const second = await app.request()
  assert.equal(second.body.restoredCount, 1)
  assert.equal(second.body.remainingCount, 0)
  assert.equal(app.writes.length, 2)
  assert.equal(new Set(second.body.payload.events.map((entry: { id: string }) => entry.id)).size, 5002)
  assert.equal((await app.request()).body.restoredCount, 0)
  assert.equal(app.writes.length, 2)
})

test("a concurrent deletion and edit survive recovery CAS retry and are not claimed as restored", async () => {
  const app = recoveryRoute({ historyEvents: [event("recover"), event("concurrent-delete")], concurrentChange: (payload) => ({
    ...payload, events: [event("keep", "CONCURRENT EDIT")], deletedEventIds: ["deleted", "concurrent-delete"], emailRecipientsText: "current@example.test",
  }) })
  const result = await app.request()
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.restoredEvents.map((entry: { id: string }) => entry.id), ["recover"])
  assert.equal(result.body.remainingCount, 0)
  assert.equal(result.body.payload.events.find((entry: { id: string }) => entry.id === "keep").title, "CONCURRENT EDIT")
  assert.equal(result.body.payload.emailRecipientsText, "current@example.test")
  assert.deepEqual(result.body.payload.deletedEventIds, ["deleted", "concurrent-delete"])
  assert.equal(app.writes.length, 1)
})

test("a failed large recovery batch commits no partial events or settings", async () => {
  const app = recoveryRoute({ historyEvents: Array.from({ length: 501 }, (_, i) => event(`recover-${i}`)), failWrites: true })
  const before = app.payload()
  assert.equal((await app.request()).status, 500)
  assert.equal(app.writes.length, 0)
  assert.deepEqual(app.payload(), before)
})

test("a concurrently saved malformed row still owns its ID and is not reported as pending recovery", async () => {
  const malformed = { ...event("recover"), title: "", startDate: "invalid" }
  const app = recoveryRoute({ historyEvents: [event("recover")], concurrentChange: (payload) => ({ ...payload, events: [...payload.events as unknown[], malformed] }) })
  const result = await app.request()
  assert.equal(result.status, 200)
  assert.equal(result.body.restoredCount, 0)
  assert.equal(result.body.remainingCount, 0)
  assert.deepEqual(result.body.payload.events.find((entry: { id: string }) => entry.id === "recover"), malformed)
  const preview = await app.request("GET")
  assert.equal(preview.body.count, 0)
  assert.equal(preview.body.skippedInvalidCount, 0, "an existing current row is never offered as a missing historical record")
})

test("recovery preserves valid holiday provenance so an unchanged recovered import needs no manual review", async () => {
  const reference = getVerifiedPublicHolidays([2027], ["US"])
  const original = reference.events[0]
  const app = recoveryRoute({ historyEvents: [original] })
  const result = await app.request()
  assert.equal(result.status, 200)
  assert.equal(result.body.restoredCount, 1)
  const recovered = result.body.payload.events.find((entry: { id: string }) => entry.id === original.id)
  assert.deepEqual(recovered.holidaySource, original.holidaySource)
  const plan = planHolidayReconciliation([recovered], [original], { coverage: reference.coverage })
  assert.deepEqual(plan, { additions: [], updates: [], removals: [], preserved: [], complete: true })
  assert.equal((await app.request()).body.restoredCount, 0)
})

test("recovering a manually changed holiday keeps its original baseline and requires review", async () => {
  const reference = getVerifiedPublicHolidays([2027], ["HK"])
  const original = reference.events[0]
  const changed = { ...original, title: "MANUAL HOLIDAY WORDING", people: ["OL"] }
  const app = recoveryRoute({ historyEvents: [changed] })
  const result = await app.request()
  assert.equal(result.status, 200)
  const recovered = result.body.restoredEvents[0]
  assert.deepEqual(recovered.holidaySource, original.holidaySource)
  assert.equal(recovered.title, changed.title)
  assert.deepEqual(recovered.people, ["OL"])
  const plan = planHolidayReconciliation([recovered], [original], { coverage: reference.coverage })
  assert.deepEqual(plan.updates, [])
  assert.deepEqual(plan.removals, [])
  assert.equal(plan.complete, false)
  assert.equal(plan.preserved[0].reviewRequired, true)
})

test("recovery whitelists recognized holiday metadata and never treats invalid metadata as verified", async () => {
  const original = getVerifiedPublicHolidays([2027], ["US"]).events[0]
  const safe = recoveryRoute({ historyEvents: [{ ...original, holidaySource: { ...original.holidaySource, unrelated: "not provenance" } }] })
  const result = await safe.request()
  assert.deepEqual(result.body.restoredEvents[0].holidaySource, original.holidaySource)
  for (const change of [
    { country: "XX" }, { year: 2099 }, { identity: "tw-2027-new-year" },
    { sourceUrls: ["https://unverified.example.test/holidays"] },
    { deletionIds: ["public-holiday-hk-2027-01-01"] },
    { baseline: "not-json" }, { baseline: JSON.stringify({ startDate: "2027-02-30" }) },
  ]) {
    const app = recoveryRoute({ historyEvents: [{ ...original, holidaySource: { ...original.holidaySource, ...change } }] })
    const recovered = await app.request()
    assert.equal(recovered.status, 200)
    assert.equal(recovered.body.restoredCount, 1)
    assert.equal(Object.hasOwn(recovered.body.restoredEvents[0], "holidaySource"), false)
  }
})

test("recovering a retired holiday retains the older provenance needed for safe reconciliation", async () => {
  const reference = getVerifiedPublicHolidays([2027], ["US"])
  const original = reference.events[0]
  const retired = {
    ...original, id: "public-holiday-us-2027-next-new-year-observed", startDate: "2027-12-31", endDate: "2027-12-31",
    title: "PUBLIC HOLIDAY - USA (FEDERAL) - NEW YEAR'S DAY 2028 (OBSERVED)",
    holidaySource: { ...original.holidaySource, identity: "us-2027-next-new-year-observed", revision: "2026-10-07.1",
      deletionIds: ["public-holiday-us-2027-next-new-year-observed", "public-holiday-us-2027-12-31"], baseline: "" },
  }
  retired.holidaySource.baseline = holidayBaseline(retired)
  const app = recoveryRoute({ historyEvents: [retired] })
  const result = await app.request()
  assert.equal(result.status, 200)
  const recovered = result.body.restoredEvents[0]
  assert.deepEqual(recovered.holidaySource, retired.holidaySource)
  const plan = planHolidayReconciliation([recovered], reference.events, { coverage: reference.coverage })
  assert.deepEqual(plan.removals, [retired.id])
  assert.deepEqual(plan.preserved, [])
})
