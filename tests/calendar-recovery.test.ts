import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { afterEach, beforeEach, mock, test } from "node:test"
import { transformSync } from "esbuild"
import { createClient } from "@supabase/supabase-js"
import { loadEventCalendarHistory, type CalendarAuditRow } from "../lib/eventCalendarRecovery"
import * as eventStore from "../lib/eventCalendarStore"
import { EVENT_CALENDAR_PROTOCOL_VERSION } from "../lib/eventCalendarProtocol"

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
function recoveryRoute(options: { permissionFailure?: string; auditPermissionFailure?: boolean; historyComplete?: boolean; historyError?: boolean } = {}) {
  let payload: Record<string, unknown> = { events: [event("keep", "LATEST SAVED TITLE")], deletedEventIds: ["deleted"], people: ["OL"], emailRecipientsText: "office@example.test" }
  const permissions: string[] = [], writes: unknown[] = []
  let historyReads = 0, clients = 0
  const history: CalendarAuditRow[] = [{ ...audit(1), after_row: { key: "event-calendar", payload: { events: [event("keep", "STALE TITLE"), event("deleted"), event("recover"), { ...event("past"), startDate: "2026-10-01", endDate: "2026-10-01" }] } } }]
  const db = { from() { const query = { select() { return query }, eq() { return query }, async maybeSingle() { return { data: { payload }, error: null } } }; return query } }
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@/lib/adminAuth": { async requireAdminPagePermission(page: string, permission: string) { permissions.push(`${page}:${permission}`); if (options.permissionFailure) throw new Error(options.permissionFailure); if (page === "audit-log" && options.auditPermissionFailure) throw new Error("Forbidden"); return { username: "synthetic" } } },
    "@/lib/adminAudit": { createAdminAuditContext() { return {} }, createAdminAuditedSupabaseClient(_context: unknown, settings: unknown) { assert.deepEqual(settings, { useServiceRole: true }); return db } },
    "@/lib/eventCalendarStore": { ...eventStore, async mutateEventCalendarStore(_db: unknown, mutation: eventStore.CalendarMutation) { writes.push(mutation); payload = eventStore.applyEventCalendarMutation(payload, mutation); return payload } },
    "@/lib/eventCalendarProtocol": { EVENT_CALENDAR_PROTOCOL_VERSION },
    "@/lib/calendarServiceClient": { createCalendarServiceClient() { clients += 1; return db } },
    "@/lib/eventCalendarRecovery": { async loadEventCalendarHistory() { historyReads += 1; if (options.historyError) throw new Error("History unavailable"); return { rows: history, historyComplete: options.historyComplete !== false, historyScanned: 1, oldestChecked: history[0].occurred_at } } },
  }
  const loaded = { exports: {} as { GET(): Promise<Response>; POST(request: Request): Promise<Response> } }
  new Function("require", "module", "exports", routeCode)((name: string) => { assert.ok(Object.hasOwn(modules, name), `Unexpected dependency ${name}`); return modules[name] }, loaded, loaded.exports)
  return { permissions, writes, reads: () => ({ historyReads, clients }), async request(method = "POST", body: unknown = {}) { const response = method === "GET" ? await loaded.exports.GET() : await loaded.exports.POST(new Request("https://synthetic.test/recover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })); return { status: response.status, body: await response.json() } } }
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
