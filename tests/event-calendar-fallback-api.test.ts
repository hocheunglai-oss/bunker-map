import assert from "node:assert/strict"
import test from "node:test"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { parseEventCalendarResponse } from "../lib/eventCalendarResponse"
import { getEventCalendarEventVersions } from "../lib/eventCalendarStore"
import { EVENT_CALENDAR_PROTOCOL_VERSION } from "../lib/eventCalendarProtocol"

const requireModule = createRequire(import.meta.url)
const bundled = build({ absWorkingDir: process.cwd(), entryPoints: ["app/api/office-calendar-store/[key]/route.ts"], bundle: true, write: false, platform: "node", format: "cjs", target: "node24", logLevel: "silent", plugins: [{ name: "synthetic-service-boundaries", setup(b) { b.onResolve({ filter: /^(next\/server|@supabase\/supabase-js|@\/lib\/(adminAuth|adminAudit|calendarStaff))$/ }, args => ({ path: args.path, external: true })) } }] })
const event = { id: "fallback", title: "SYNTHETIC FALLBACK", startDate: "2026-06-01", endDate: "2026-06-30", people: ["OL"], tags: [] }
function current() { return { events: [], people: ["OL"], emailRecipientsText: "keep@example.test", deletedEventIds: ["keep-general"], deletedRequiredSeedIds: ["keep-required"], unrelated: { keep: true } } }
type Route = (request: Request, context: { params: Promise<{ key: string }> }) => Promise<Response>

async function api(payload: unknown, method: "GET" | "PATCH", body: Record<string, unknown> = {}, access = "edit") {
  let row = payload === null ? null : { payload: structuredClone(payload), updated_at: "2026-10-21T00:00:00.000Z" }
  let reads = 0, writes = 0
  const client = { from() {
    let mode = "read", values: NonNullable<typeof row>, expected = ""
    const q = { select() { return q }, eq(key: string, value: unknown) { if (key === "updated_at") expected = String(value); return q }, insert(value: typeof values) { mode = "insert"; values = value; return q }, update(value: typeof values) { mode = "update"; values = value; return q }, async maybeSingle() {
      if (mode === "read") { reads += 1; return { data: structuredClone(row), error: null } }
      if (mode === "insert" && row) return { data: null, error: { code: "23505" } }
      if (mode === "update" && (!row || row.updated_at !== expected)) return { data: null, error: null }
      row = structuredClone(values); writes += 1; return { data: { payload: row.payload }, error: null }
    } }; return q
  } }
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: { json: Response.json } },
    "@supabase/supabase-js": { createClient: () => client },
    "@/lib/adminAuth": { getAdminSession: async () => ({ authenticated: access !== "signedout" }), hasAdminPagePermission: (_session: unknown, _page: string, level: string) => access === "edit" || level === "view" && access === "view" },
    "@/lib/adminAudit": { createAdminAuditContext: () => ({}), createAdminAuditedSupabaseClient: () => client },
    "@/lib/calendarStaff": { loadCalendarStaffDirectory: async () => [], resolveCalendarStaffRecipients: () => ({ recipients: [], unresolved: [] }) },
  }
  const mod = { exports: {} as Record<"GET" | "PATCH", Route> }
  new Function("require", "module", "exports", "process", (await bundled).outputFiles[0].text)((name: string) => modules[name] ?? requireModule(name), mod, mod.exports, { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" } })
  const request = new Request("https://synthetic.invalid/api/office-calendar-store/event-calendar", { method, ...(method === "PATCH" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ protocolVersion: EVENT_CALENDAR_PROTOCOL_VERSION, ...body }) } : {}) })
  const response = await mod.exports[method](request, { params: Promise.resolve({ key: "event-calendar" }) })
  return { status: response.status, response: await response.json(), reads, writes, saved: row?.payload }
}

test("actual GET remains read-only for absent, legacy-empty and authoritative-empty calendars", async () => {
  for (const payload of [null, {}, current()]) {
    const result = await api(payload, "GET")
    assert.equal(result.status, 200)
    assert.equal(result.reads, 1)
    assert.equal(result.writes, 0)
    assert.deepEqual((await parseEventCalendarResponse(result.response)).payload, payload)
  }
})

test("actual PATCH accepts an explicit absent deletion with exact canonical decoder acknowledgement", async () => {
  for (const payload of [null, {}, current()]) {
    const result = await api(payload, "PATCH", { operation: "delete", eventIds: ["fallback"], expectedAbsentEventIds: ["fallback"] })
    assert.equal(result.status, 200)
    assert.equal(result.writes, 1)
    const decoded = await parseEventCalendarResponse(result.response, { operation: "delete", events: [], eventIds: ["fallback"], settings: {} })
    assert.ok(decoded.payload?.deletedEventIds?.includes("fallback"))
    assert.equal(decoded.payload?.events?.length, 0)
    if (payload && "people" in payload) assert.deepEqual(decoded.payload?.people, payload.people)
    else assert.equal(Object.hasOwn(decoded.payload ?? {}, "people"), false)
  }
})

test("actual PATCH refuses malformed, oversized, unknown-target and cross-operation absence flags before writing", async () => {
  for (const expectedAbsentEventIds of [null, false, "fallback", {}, [null], [1], ["fallback", "fallback"], ["unknown"], [" fallback "], Array.from({ length: 501 }, (_, i) => `id-${i}`)]) {
    const result = await api(current(), "PATCH", { operation: "delete", eventIds: ["fallback"], expectedAbsentEventIds })
    assert.equal(result.status, 400)
    assert.equal(result.writes, 0)
    assert.deepEqual(result.saved, current())
  }
  for (const operation of ["create", "update", "upsert", "insert", "settings", "people"]) {
    const result = await api(current(), "PATCH", { operation, events: [event], settings: operation === "people" ? { people: ["OL"] } : {}, expectedAbsentEventIds: [] })
    assert.equal(result.status, 400)
    assert.equal(result.writes, 0)
  }
})

test("actual PATCH does not reinterpret a present raw version or an unknown flag spelling as reviewed absence", async () => {
  for (const value of ["", "bad", null, "a".repeat(64)]) {
    const result = await api(current(), "PATCH", { operation: "delete", eventIds: ["fallback"], expectedAbsentEventIds: ["fallback"], expectedEventVersions: { fallback: value } })
    assert.equal(result.status, 400)
    assert.equal(result.writes, 0)
  }
  const typo = await api(current(), "PATCH", { operation: "delete", eventIds: ["fallback"], expectedAbsentEventIDs: ["fallback"] })
  assert.equal(typo.status, 409)
  assert.equal(typo.writes, 0)
})

test("actual PATCH refuses deletion of a concurrent canonical record and keeps strict ordinary controls", async () => {
  const payload = { ...current(), events: [event] }
  const conflict = await api(payload, "PATCH", { operation: "delete", eventIds: [event.id], expectedAbsentEventIds: [event.id] })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.writes, 0)
  assert.deepEqual(conflict.saved, payload)
  const versioned = await api(payload, "PATCH", { operation: "delete", eventIds: [event.id], expectedEventVersions: getEventCalendarEventVersions(payload) })
  assert.equal(versioned.status, 200)
  assert.equal(versioned.writes, 1)
  for (const operation of ["update", "delete"]) {
    const missing = await api(current(), "PATCH", { operation, events: operation === "update" ? [event] : [], eventIds: [event.id], expectedEventVersions: { [event.id]: "a".repeat(64) } })
    assert.equal(missing.status, 409)
    assert.equal(missing.writes, 0)
  }
})

test("actual PATCH rejects normalized version-key aliases with status400 and zero writes for every raw value", async () => {
  const observed: { state: number; key: string; value: unknown; status: number; writes: number; unchanged: boolean }[] = []
  for (const [state, payload] of [null, {}, current()].entries()) {
    for (const key of [" fallback", "fallback ", "\t fallback \n"]) {
      for (const value of ["a".repeat(64), "", "invalid", null, 0]) {
        const result = await api(payload, "PATCH", { operation: "delete", eventIds: ["fallback"], expectedAbsentEventIds: ["fallback"], expectedEventVersions: { [key]: value } })
        observed.push({ state, key, value, status: result.status, writes: result.writes, unchanged: JSON.stringify(result.saved ?? null) === JSON.stringify(payload) })
      }
    }
  }
  assert.deepEqual(observed, observed.map(row => ({ ...row, status: 400, writes: 0, unchanged: true })))
})

test("actual route retains Edit authorization before absence-flag processing or database reads", async () => {
  for (const [access, status] of [["view", 403], ["none", 403], ["signedout", 401]] as const) {
    const result = await api(current(), "PATCH", { operation: "delete", eventIds: [event.id], expectedAbsentEventIds: [event.id] }, access)
    assert.equal(result.status, status)
    assert.equal(result.reads, 0)
    assert.equal(result.writes, 0)
  }
})
