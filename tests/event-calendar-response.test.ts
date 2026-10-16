import assert from "node:assert/strict"
import test from "node:test"
import { performance } from "node:perf_hooks"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { validateEventCalendarPayload, parseEventCalendarResponse, eventCalendarResponseVersion } from "../lib/eventCalendarResponse"
import { getEventCalendarEventVersions, getEventCalendarSettingVersions, getEventCalendarStoreVersion, applyEventCalendarMutation } from "../lib/eventCalendarStore"
import { EVENT_CALENDAR_PROTOCOL_VERSION } from "../lib/eventCalendarProtocol"

const event = { id: "synthetic", title: "SYNTHETIC EVENT", startDate: "2026-10-16", endDate: "2026-10-17", people: ["OL"], tags: [], eventType: "Meeting" as const }
const requireModule = createRequire(import.meta.url)
const payload = () => ({ events: [event], people: ["OL", "CY"], emailRecipientsText: "office@example.test", deletedEventIds: [] })
export const envelope = (data: unknown) => ({ payload: data, protocolVersion: EVENT_CALENDAR_PROTOCOL_VERSION,
  eventVersions: getEventCalendarEventVersions(data), settingVersions: getEventCalendarSettingVersions(data), storeVersion: getEventCalendarStoreVersion(data) })

test("canonical calendar decoder matches exact server SHA for events/settings/store, Unicode and ordered nested JSON", async () => {
  for (const value of [null, {}, payload(), { events: [], people: [], emailRecipientsText: "" }, { events: [event], extra: { z: "中文 😀\\\r\n", a: [0, null] } }]) {
    const result = await parseEventCalendarResponse(envelope(value))
    assert.deepEqual(result.payload, value)
    assert.equal(result.storeVersion, getEventCalendarStoreVersion(value))
  }
  assert.equal(await eventCalendarResponseVersion({ b: 1, a: 2 }), getEventCalendarStoreVersion({ a: 2, b: 1 }))
  const absent = await parseEventCalendarResponse(envelope({ events: [] }))
  const empty = await parseEventCalendarResponse(envelope({ events: [], emailRecipientsText: "" }))
  assert.notEqual(absent.settingVersions.emailRecipientsText, empty.settingVersions.emailRecipientsText)
})

test("malformed existing payloads never become an empty/default calendar", async () => {
  for (const value of [undefined, false, 0, [], "", { people: [] }, { events: "BROKEN", people: "BROKEN", emailRecipientsText: {} },
    { events: [event, event] }, { events: [{ ...event, people: [null] }] }, { events: [{ ...event, endDate: "2026-02-31" }] },
    { events: [{ ...event, eventType: ["Meeting"] }] }, { events: [{ ...event, eventType: { toString: () => "Meeting" } }] },
    { events: [], people: null }, { events: [], emailRecipientsText: null }, { events: [], deletedEventIds: [1] }]) {
    assert.throws(() => validateEventCalendarPayload(value))
    await assert.rejects(parseEventCalendarResponse(envelope(value)))
  }
})

test("all version maps and payload fingerprint must match canonical content, not merely look like hashes", async () => {
  const good = envelope(payload())
  for (const value of [{ ...good, protocolVersion: 1 }, { ...good, eventVersions: {} }, { ...good, eventVersions: { synthetic: "a".repeat(64) } },
    { ...good, eventVersions: { ...good.eventVersions, unexpected: "a".repeat(64) } }, { ...good, settingVersions: { ...good.settingVersions, people: "a".repeat(64) } },
    { ...good, settingVersions: {} }, { ...good, storeVersion: "a".repeat(64) }, { ...good, payload: { ...payload(), people: [] } }]) await assert.rejects(parseEventCalendarResponse(value))
})

test("successful save ACK verifies exact requested settings, intentional clear and requested event/deletion result", async () => {
  const input = { operation: "settings" as const, events: [], eventIds: [], settings: { emailRecipientsText: "" } }
  await parseEventCalendarResponse({ success: true, ...envelope({ ...payload(), emailRecipientsText: "" }) }, input)
  for (const value of [{ success: true, ...envelope(payload()) }, envelope({ ...payload(), emailRecipientsText: "" }), { success: true, ...envelope(null) }]) await assert.rejects(parseEventCalendarResponse(value, input))
  const people = { ...input, operation: "people" as const, settings: { people: ["CY", "OL"] } }
  await assert.rejects(parseEventCalendarResponse({ success: true, ...envelope(payload()) }, people))
  await parseEventCalendarResponse({ success: true, ...envelope({ ...payload(), people: ["CY", "OL"] }) }, people)
  const update = { operation: "update" as const, events: [{ ...event, title: "NEW" }], eventIds: [], settings: {} }
  await assert.rejects(parseEventCalendarResponse({ success: true, ...envelope(payload()) }, update))
  await parseEventCalendarResponse({ success: true, ...envelope({ ...payload(), events: update.events }) }, update)
  const remove = { operation: "delete" as const, events: [], eventIds: [event.id], settings: {} }
  await assert.rejects(parseEventCalendarResponse({ success: true, ...envelope({ events: [] }) }, remove))
  await parseEventCalendarResponse({ success: true, ...envelope({ events: [], deletedEventIds: [event.id] }) }, remove)
})

test("actual CAS mutation envelopes remain compatible, including independently merged setting and exact no-op", async () => {
  let current = payload()
  const versions = getEventCalendarSettingVersions(current)
  current = applyEventCalendarMutation(current, { operation: "people", settings: { people: ["CY"] }, expectedSettingVersions: versions }) as typeof current
  const next = applyEventCalendarMutation(current, { operation: "settings", settings: { emailRecipientsText: "new@example.test" }, expectedSettingVersions: versions })
  await parseEventCalendarResponse({ success: true, ...envelope(next) }, { operation: "settings", events: [], eventIds: [], settings: { emailRecipientsText: "new@example.test" } })
  assert.deepEqual((next as typeof current).people, ["CY"])
})

test("1001-event SHA verification is parallel and measured locally without a hosted latency claim", async t => {
  const value = { ...payload(), events: Array.from({ length: 1001 }, (_, index) => ({ ...event, id: `synthetic-${index}`, title: `SYNTHETIC EVENT ${index} 中文` })) }
  const start = performance.now(), result = await parseEventCalendarResponse(envelope(value))
  assert.equal(Object.keys(result.eventVersions).length, 1001)
  t.diagnostic(`1001 complete event/setting/store SHA checks: ${(performance.now() - start).toFixed(1)} ms`)
})

export async function calendarReadApi(value: unknown, access = "edit", readError = false) {
  let reads = 0, writes = 0
  const client = { from: () => ({ select() { return this }, eq() { return this }, async maybeSingle() { reads++; return { data: value === undefined ? null : { payload: value, updated_at: "2026-10-16T00:00:00Z" }, error: readError ? new Error("Synthetic read failure") : null } }, update() { writes++; throw Error("No writes allowed") } }) }
  const modules: Record<string, unknown> = { "next/server": { NextResponse: { json: Response.json } }, "@supabase/supabase-js": { createClient: () => client },
    "@/lib/adminAuth": { getAdminSession: async () => ({ authenticated: access !== "signedout" }), hasAdminPagePermission: () => ["edit", "view"].includes(access) },
    "@/lib/adminAudit": { createAdminAuditContext: () => ({}), createAdminAuditedSupabaseClient: () => { writes++; throw Error("No audited writes allowed") } },
    "@/lib/calendarStaff": { loadCalendarStaffDirectory: async () => [], resolveCalendarStaffRecipients: () => ({ recipients: [] }) } }
  const bundle = await build({ absWorkingDir: process.cwd(), entryPoints: ["app/api/office-calendar-store/[key]/route.ts"], bundle: true, write: false, platform: "node", format: "cjs", target: "node24", logLevel: "silent", plugins: [{ name: "readonly-transports", setup(b) { b.onResolve({ filter: /^(next\/server|@supabase\/supabase-js|@\/lib\/(adminAuth|adminAudit|calendarStaff))$/ }, args => ({ path: args.path, external: true })) } }] })
  const mod = { exports: {} as { GET: (request: Request, context: { params: Promise<{ key: string }> }) => Promise<Response> } }
  new Function("require", "module", "exports", "process", bundle.outputFiles[0].text)((name: string) => modules[name] ?? requireModule(name), mod, mod.exports, { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" } })
  const response = await mod.exports.GET(new Request("https://synthetic.invalid/api/office-calendar-store/event-calendar"), { params: Promise.resolve({ key: "event-calendar" }) })
  return { response, reads, writes }
}

test("actual GET refuses malformed shared JSON before200, keeps null/empty legacy and explicit clears, no writes", async () => {
  for (const value of [undefined, null, {}, payload(), { events: [], people: [], emailRecipientsText: "" }, { events: [] }]) {
    const { response, reads, writes } = await calendarReadApi(value)
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store")
    await parseEventCalendarResponse(await response.json()); assert.equal(reads, 1); assert.equal(writes, 0)
  }
  for (const value of [false, 0, [], { events: "BROKEN", people: "BROKEN", emailRecipientsText: {} }, { events: [], people: [null] }]) {
    const { response, writes } = await calendarReadApi(value)
    assert.equal(response.status, 500); assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(writes, 0)
    assert.equal(Object.hasOwn(await response.json(), "payload"), false)
  }
  for (const [access, status] of [["view", 200], ["none", 403], ["signedout", 401]] as const) {
    const f = await calendarReadApi(payload(), access)
    assert.equal(f.response.status, status); assert.equal(f.reads, status === 200 ? 1 : 0); assert.equal(f.writes, 0)
  }
  assert.equal((await calendarReadApi(payload(), "edit", true)).response.status, 500)
})

test("client applies only decoded canonical replies and keeps refresh ownership guards after async hashes", () => {
  const source = readFileSync(new URL("../app/admin/eventcalendar/page.tsx", import.meta.url), "utf8")
  assert.match(source, /await parseEventCalendarResponse\(payload, \{ operation, events: mutationEvents, eventIds, settings \}\)/)
  assert.match(source, /const canonical = await parseEventCalendarResponse\(data\)[\s\S]*?requestSequence !== refreshRequestSequenceRef.current[\s\S]*?applyCanonicalCalendarPayload\(canonical\)/)
  assert.match(source, /Calendar refresh unavailable\. Showing the last verified calendar; your unsaved changes have been kept/)
})
