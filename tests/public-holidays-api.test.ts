import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import ts from "typescript"
import { NextResponse } from "next/server"
import * as holidayCalendar from "../lib/holidayCalendar"
import * as calendarImport from "../lib/eventCalendarImport"
import * as calendarStore from "../lib/eventCalendarStore"
import { EVENT_CALENDAR_PROTOCOL_VERSION } from "../lib/eventCalendarProtocol"

function harness(authError?: string) {
  let payload: Record<string, unknown> = { events: [{ id: "public-holiday-us-2026-02-12", startDate: "2026-02-12", endDate: "2026-02-12", title: "PUBLIC HOLIDAY - USA", people: [], tags: ["public-holiday", "US"], eventType: "Public Holiday" }], people: ["SC"], deletedEventIds: [] }
  let writes = 0
  const permissions: string[] = []
  const client = { from(name: string) {
    assert.equal(name, "office_calendar_store")
    return { select() { return { eq(key: string, value: string) {
      assert.equal(key, "key"); assert.equal(value, "event-calendar")
      return { maybeSingle: async () => ({ data: { payload }, error: null }) }
    } } } }
  } }
  const stubs: Record<string, unknown> = {
    "next/server": { NextResponse },
    "@/lib/adminAuth": { requireAdminPagePermission: async (page: string, access: string) => {
      assert.equal(page, "event-calendar"); permissions.push(access)
      if (authError) throw new Error(authError)
      return { username: "synthetic-test" }
    } },
    "@/lib/adminAudit": { createAdminAuditContext: () => ({ username: "synthetic-test" }), createAdminAuditedSupabaseClient: () => client },
    "@/lib/holidayCalendar": holidayCalendar,
    "@/lib/eventCalendarImport": calendarImport,
    "@/lib/eventCalendarProtocol": { EVENT_CALENDAR_PROTOCOL_VERSION },
    "@/lib/eventCalendarStore": { ...calendarStore, mutateEventCalendarStoreBatch: async (_client: unknown, mutations: calendarStore.CalendarMutation[], version: string) => {
      assert.equal(_client, client)
      assert.equal(version, calendarStore.getEventCalendarStoreVersion(payload))
      writes += 1
      payload = mutations.reduce((current, mutation) => calendarStore.applyEventCalendarMutation(current, mutation), payload)
      return payload
    } },
  }
  const code = ts.transpileModule(readFileSync(new URL("../app/api/event-calendar/public-holidays/route.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const apiModule = { exports: {} as { GET: (request: Request) => Promise<Response>; POST: (request: Request) => Promise<Response> } }
  new Function("require", "module", "exports", code)((name: string) => {
    if (!(name in stubs)) throw new Error(`Unexpected route dependency: ${name}`)
    return stubs[name]
  }, apiModule, apiModule.exports)
  return { route: apiModule.exports, writes: () => writes, payload: () => payload, permissions,
    change: () => { payload = { ...payload, people: ["SC", "VL"] } } }
}
function request(body: Record<string, unknown>) {
  return new Request("https://example.test/api/event-calendar/public-holidays", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
}

test("GET is read-only and reports unsupported coverage honestly", async () => {
  const h = harness()
  const response = await h.route.GET(new Request("https://example.test/api/event-calendar/public-holidays?years=2027,2028&countries=TW"))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.complete, false)
  assert.equal(body.coverage[1].status, "unavailable")
  assert.equal(h.writes(), 0)
  assert.deepEqual(h.permissions, ["view"])
})

test("both mutation actions require Edit; failed authentication does not access or mutate the store", async () => {
  for (const [error, status] of [["Unauthorized", 401], ["Forbidden", 403]] as const) {
    const h = harness(error)
    for (const action of ["preview", "apply"]) assert.equal((await h.route.POST(request({ action, years: [2026], countries: ["US"] }))).status, status)
    assert.equal(h.writes(), 0)
    assert.deepEqual(h.permissions, ["edit", "edit"])
  }
})

test("preview then apply commits one server-generated batch and retains unrelated settings", async () => {
  const h = harness()
  const selection = { years: [2026], countries: ["US"] }
  const preview = await (await h.route.POST(request({ action: "preview", ...selection }))).json()
  assert.equal(h.writes(), 0)
  assert.equal(preview.counts.removals, 1)
  const response = await h.route.POST(request({ action: "apply", ...selection, expectedStoreVersion: preview.storeVersion, revision: preview.revision,
    events: [{ id: "malicious-client-event" }], removals: ["arbitrary-row"] }))
  assert.equal(response.status, 200)
  const saved = await response.json()
  assert.equal(h.writes(), 1)
  assert.equal(saved.payload.events.length, 11)
  assert.deepEqual(saved.payload.people, ["SC"])
  assert.ok(saved.payload.deletedEventIds.includes("public-holiday-us-2026-02-12"))
  assert.ok(!saved.payload.events.some((event: { id: string }) => event.id === "malicious-client-event"))
  assert.equal(saved.storeVersion, calendarStore.getEventCalendarStoreVersion(h.payload()))
})

test("stale previews and missing revision never write", async () => {
  const h = harness()
  const selection = { years: [2026], countries: ["US"] }
  const preview = await (await h.route.POST(request({ action: "preview", ...selection }))).json()
  h.change()
  const conflict = await h.route.POST(request({ action: "apply", ...selection, expectedStoreVersion: preview.storeVersion, revision: preview.revision }))
  assert.equal(conflict.status, 409)
  assert.equal(h.writes(), 0)
  const invalid = await h.route.POST(request({ action: "apply", ...selection, expectedStoreVersion: calendarStore.getEventCalendarStoreVersion(h.payload()) }))
  assert.equal(invalid.status, 400)
  assert.equal(h.writes(), 0)
})

test("invalid years/countries and malformed JSON fail closed", async () => {
  const h = harness()
  assert.equal((await h.route.GET(new Request("https://example.test/?years=2026&countries=BAD"))).status, 400)
  assert.equal((await h.route.POST(request({ action: "preview", years: [], countries: ["US"] }))).status, 400)
  assert.equal((await h.route.POST(new Request("https://example.test/", { method: "POST", body: "{" }))).status, 400)
  assert.equal(h.writes(), 0)
})
