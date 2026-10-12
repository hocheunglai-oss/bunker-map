import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"
import ts from "typescript"
import * as calendarStore from "../lib/eventCalendarStore"
import { EVENT_CALENDAR_PROTOCOL_VERSION } from "../lib/eventCalendarProtocol"
import { validateCalendarEmailList, resolveEventCalendarRecipients } from "../lib/calendarRecipients"

const syntheticEvent = (title = "KEEP EVENT") => ({ id: "synthetic", title, startDate: "2026-10-12", endDate: "2026-10-12", people: ["OL"], tags: [] })
const initialPayload = () => ({ events: [syntheticEvent()], people: ["OL"], emailRecipientsText: "office@example.test", deletedEventIds: ["keep-tombstone"] })
type Handler = (request: Request, context: { params: Promise<{ key: string }> }) => Promise<Response>

function apiHarness(options: { payload?: Record<string, unknown>; permission?: "edit" | "view"; signedIn?: boolean; failWrites?: boolean } = {}) {
  let row = { payload: structuredClone(options.payload ?? initialPayload()), updated_at: "2026-10-12T00:00:00.000Z" }
  let writes = 0
  const client = { from(table: string) {
    assert.equal(table, "office_calendar_store")
    let changed: Record<string, unknown> | null = null
    let expected = ""
    const query = {
      select() { return query },
      eq(field: string, value: unknown) { if (field === "key") assert.equal(value, "event-calendar"); if (field === "updated_at") expected = String(value); return query },
      update(value: Record<string, unknown>) { changed = value; return query },
      async maybeSingle() {
        await new Promise<void>((resolve) => setImmediate(resolve))
        if (!changed) return { data: structuredClone(row), error: null }
        if (options.failWrites) return { data: null, error: new Error("Synthetic write failed") }
        if (expected !== row.updated_at) return { data: null, error: null }
        writes += 1
        row = structuredClone(changed) as typeof row
        return { data: { payload: row.payload }, error: null }
      },
    }
    return query
  } }
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@supabase/supabase-js": { createClient: () => client },
    "@/lib/adminAuth": { getAdminSession: async () => ({ authenticated: options.signedIn !== false }), hasAdminPagePermission: (_session: unknown, page: string, access: string) => { assert.equal(page, "event-calendar"); return options.permission !== "view" || access === "view" } },
    "@/lib/adminAudit": { createAdminAuditContext: () => ({}), createAdminAuditedSupabaseClient: () => client },
    "@/lib/eventCalendarStore": calendarStore,
    "@/lib/eventCalendarProtocol": { EVENT_CALENDAR_PROTOCOL_VERSION },
    "@/data/taskCalendar": {},
    "@/lib/taskCalendarStore": {},
    "@/lib/calendarStaff": {},
  }
  const code = transformSync(readFileSync(new URL("../app/api/office-calendar-store/[key]/route.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
  const loaded: { exports: Record<string, Handler> } = { exports: {} }
  new Function("require", "module", "exports", "process", code)((name: string) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected API dependency: ${name}`)
    return modules[name]
  }, loaded, loaded.exports, { env: { NEXT_PUBLIC_SUPABASE_URL: "https://example.test", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" } })
  return {
    writes: () => writes,
    payload: () => structuredClone(row.payload),
    async request(method: string, body?: Record<string, unknown>) {
      const response = await loaded.exports[method](new Request("https://example.test/api/office-calendar-store/event-calendar", { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) }), { params: Promise.resolve({ key: "event-calendar" }) })
      return { status: response.status, body: await response.json() }
    },
  }
}

function settingsRequest(payload: Record<string, unknown>, text: string, confirmation?: unknown) {
  return { protocolVersion: EVENT_CALENDAR_PROTOCOL_VERSION, operation: "settings", settings: { emailRecipientsText: text }, expectedSettingVersions: calendarStore.getEventCalendarSettingVersions(payload), ...(confirmation === undefined ? {} : { confirmEmailRecipientsClear: confirmation }) }
}

test("actual settings API rejects an unconfirmed empty list, including whitespace and nonboolean flags", async () => {
  for (const [text, flag] of [["", undefined], [" \n,; ", undefined], ["", "true"], ["", 1], ["", false]]) {
    const app = apiHarness()
    const before = app.payload()
    const result = await app.request("PATCH", settingsRequest(before, String(text), flag))
    assert.equal(result.status, 400)
    assert.match(result.body.message, /Confirm.*disable event-update emails/)
    assert.equal(app.writes(), 0)
    assert.deepEqual(app.payload(), before)
  }
})

test("confirmed empty settings save requires the current version and never persists the confirmation flag", async () => {
  const app = apiHarness()
  const before = app.payload()
  const result = await app.request("PATCH", settingsRequest(before, "", true))
  assert.equal(result.status, 200)
  assert.equal(app.writes(), 1)
  assert.deepEqual(app.payload(), { ...before, emailRecipientsText: "" })
  assert.equal(Object.hasOwn(app.payload(), "confirmEmailRecipientsClear"), false)
  assert.deepEqual(resolveEventCalendarRecipients(app.payload(), "fallback@example.test"), [])
})

test("confirmation cannot bypass missing or stale email-list versions", async () => {
  for (const versions of [{}, { emailRecipientsText: "a".repeat(64) }]) {
    const app = apiHarness()
    const before = app.payload()
    const result = await app.request("PATCH", { ...settingsRequest(before, "", true), expectedSettingVersions: versions })
    assert.equal(result.status, 409)
    assert.equal(app.writes(), 0)
    assert.deepEqual(app.payload(), before)
  }
  const app = apiHarness()
  const before = app.payload()
  assert.equal((await app.request("PATCH", settingsRequest(before, "new@example.test"))).status, 200)
  assert.equal((await app.request("PATCH", settingsRequest(before, "", true))).status, 409)
  assert.equal(app.payload().emailRecipientsText, "new@example.test")
})

test("a missing list cannot silently become an explicit disabled list", async () => {
  const absent: Record<string, unknown> = { events: [syntheticEvent()], people: ["OL"] }
  const app = apiHarness({ payload: absent })
  assert.deepEqual(resolveEventCalendarRecipients(absent, "fallback@example.test"), ["fallback@example.test"])
  assert.equal((await app.request("PATCH", settingsRequest(absent, ""))).status, 400)
  assert.equal(Object.hasOwn(app.payload(), "emailRecipientsText"), false)
  assert.equal(app.writes(), 0)
  assert.equal((await app.request("PATCH", settingsRequest(absent, "", true))).status, 200)
  assert.deepEqual(resolveEventCalendarRecipients(app.payload(), "fallback@example.test"), [])
})

test("missing and disabled lists have distinct versions without changing present-string versions", async () => {
  const absent: Record<string, unknown> = { events: [syntheticEvent()], people: ["OL"] }
  const app = apiHarness({ payload: absent })
  const oldEditorVersion = calendarStore.getEventCalendarSettingVersions(absent).emailRecipientsText
  assert.equal((await app.request("PATCH", settingsRequest(absent, "", true))).status, 200)
  const stale = await app.request("PATCH", { ...settingsRequest(absent, "stale@example.test"), expectedSettingVersions: { emailRecipientsText: oldEditorVersion } })
  assert.equal(stale.status, 409, "an old fallback-mode editor cannot undo a newer explicit disable")
  assert.equal(app.payload().emailRecipientsText, "")
  assert.equal(app.writes(), 1)
  assert.equal(calendarStore.getEventCalendarSettingVersions(absent).emailRecipientsText, calendarStore.getEventCalendarRecordVersion(null))
  for (const text of ["", "office@example.test"]) {
    assert.equal(calendarStore.getEventCalendarSettingVersions({ ...absent, emailRecipientsText: text }).emailRecipientsText, calendarStore.getEventCalendarRecordVersion(text))
  }
})

test("competing clear and list edits keep exactly one winner in either order", async () => {
  for (const clearFirst of [true, false]) {
    const app = apiHarness()
    const before = app.payload()
    const clear = settingsRequest(before, "", true)
    const edit = settingsRequest(before, "new@example.test")
    const changes = clearFirst ? [clear, edit] : [edit, clear]
    const results = await Promise.all(changes.map((change) => app.request("PATCH", change)))
    assert.deepEqual(results.map((result) => result.status), [200, 409])
    assert.equal(app.payload().emailRecipientsText, clearFirst ? "" : "new@example.test")
    assert.equal(app.writes(), 1)
  }
})

test("an already disabled list accepts an identical API no-op without confirmation or a write", async () => {
  const before = { ...initialPayload(), emailRecipientsText: "" }
  const app = apiHarness({ payload: before })
  const result = await app.request("PATCH", { protocolVersion: EVENT_CALENDAR_PROTOCOL_VERSION, operation: "settings", settings: { emailRecipientsText: "" } })
  assert.equal(result.status, 200)
  assert.equal(app.writes(), 0)
  assert.deepEqual(app.payload(), before)
})

test("concurrent event edit and confirmed list clearing preserve each other", async () => {
  const app = apiHarness()
  const before = app.payload()
  const results = await Promise.all([
    app.request("PATCH", settingsRequest(before, "", true)),
    app.request("PATCH", { protocolVersion: EVENT_CALENDAR_PROTOCOL_VERSION, operation: "update", events: [syntheticEvent("NEW EVENT TITLE")], expectedEventVersions: calendarStore.getEventCalendarEventVersions(before) }),
  ])
  assert.deepEqual(results.map((result) => result.status), [200, 200])
  assert.deepEqual(app.payload(), { ...before, emailRecipientsText: "", events: [syntheticEvent("NEW EVENT TITLE")] })
})

test("clear protection retains API permissions, old-client fencing and failure atomicity", async () => {
  for (const options of [{ signedIn: false }, { permission: "view" as const }]) {
    const app = apiHarness(options)
    assert.equal((await app.request("PATCH", settingsRequest(app.payload(), "", true))).status, options.signedIn === false ? 401 : 403)
    assert.equal(app.writes(), 0)
  }
  const app = apiHarness({ failWrites: true })
  const before = app.payload()
  assert.equal((await app.request("PUT", { ...before, emailRecipientsText: "" })).status, 409)
  assert.equal((await app.request("PATCH", settingsRequest(before, "", true))).status, 500)
  assert.equal(app.writes(), 0)
  assert.deepEqual(app.payload(), before)
})

// Execute the page's actual handlers with synthetic boundaries; no DOM,
// browser, production session, SMTP or hosted database is involved.
function editorHarness(options: { initial?: string; draft?: string; confirm?: boolean; status?: number; missing?: boolean } = {}) {
  const initial = options.initial ?? "office@example.test"
  const draft = options.draft ?? initial
  const calls: Record<string, unknown>[] = [], confirmations: string[] = [], alerts: string[] = []
  const state = { open: true, draft, initialDraft: "not-captured", draftVersion: "not-captured", saved: initial, canonicalApplied: false }
  const payload: Record<string, unknown> = { ...initialPayload(), emailRecipientsText: initial }
  if (options.missing) delete payload.emailRecipientsText
  const version = calendarStore.getEventCalendarSettingVersions(payload).emailRecipientsText
  const bindings: Record<string, unknown> = {
    draftEmailRecipientsText: draft, draftEmailRecipientsInitialText: initial, draftEmailRecipientsVersion: version,
    emailRecipientsText: initial, settingVersions: { emailRecipientsText: version },
    validateCalendarEmailList, canEdit: true, SHARED_STORE_KEY: "event-calendar", EVENT_CALENDAR_PROTOCOL_VERSION,
    calendarMutationPendingRef: { current: false }, calendarStateSequenceRef: { current: 0 },
    setCalendarMutationPending() {}, setSaveStatus() {}, setCalendarLoadError() {},
    setEmailModalOpen(value: boolean) { state.open = value }, setEmailRecipientsText(value: string) { state.saved = value },
    setDraftEmailRecipientsText(value: string) { state.draft = value },
    setDraftEmailRecipientsInitialText(value: string) { state.initialDraft = value },
    setDraftEmailRecipientsVersion(value: string) { state.draftVersion = value }, setToolsMenuOpen() {},
    applyCanonicalCalendarPayload() { state.canonicalApplied = true; return true }, syncCanonicalGoogleCalendar() { throw new Error("Settings must not sync events") },
    window: { confirm(message: string) { confirmations.push(message); return options.confirm ?? false }, alert(message: string) { alerts.push(message) } },
    async fetch(_url: string, request: RequestInit) {
      const body = JSON.parse(String(request.body))
      calls.push(body)
      const status = options.status ?? 200
      return Response.json({ payload: { ...payload, ...body.settings }, eventVersions: {}, settingVersions: { emailRecipientsText: version }, ...(status === 200 ? {} : { message: "Synthetic conflict or save failure" }) }, { status })
    },
  }
  const page = readFileSync(new URL("../app/admin/eventcalendar/page.tsx", import.meta.url), "utf8")
  const parsed = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const handlers: string[] = []
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && ["mutateCalendar", "saveEmailRecipients", "openEmailModal"].includes(node.name?.text || "")) handlers.push(`export ${node.getText(parsed)}`)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.equal(handlers.length, 3)
  const code = transformSync(handlers.join("\n"), { loader: "ts", format: "cjs", target: "node24" }).code
  const loaded: { exports: { saveEmailRecipients?: () => Promise<void>; openEmailModal?: () => void } } = { exports: {} }
  new Function("module", "exports", ...Object.keys(bindings), code)(loaded, loaded.exports, ...Object.values(bindings))
  return { state, calls, confirmations, alerts, save: () => loaded.exports.saveEmailRecipients!(), open: () => loaded.exports.openEmailModal!() }
}

test("actual open-email handler captures the loaded draft, initial text and exact presence-aware version", () => {
  for (const missing of [true, false]) {
    const editor = editorHarness({ initial: "", draft: "stale@example.test", missing })
    editor.open()
    assert.equal(editor.state.open, true)
    assert.equal(editor.state.draft, "")
    assert.equal(editor.state.initialDraft, "")
    assert.equal(editor.state.draftVersion, calendarStore.getEventCalendarRecordVersion(missing ? null : ""))
    assert.deepEqual(editor.calls, [])
  }
})

test("actual editor unchanged Save is read-only even when the list is absent/blank", async () => {
  for (const options of [{ initial: "", missing: true }, { initial: "" }, { initial: "office@example.test" }]) {
    const editor = editorHarness(options)
    await editor.save()
    assert.equal(editor.state.open, false)
    assert.deepEqual(editor.calls, [])
    assert.deepEqual(editor.confirmations, [])
    assert.equal(editor.state.canonicalApplied, false)
  }
})

test("actual editor cancel keeps the empty draft open without a request", async () => {
  const editor = editorHarness({ draft: "", confirm: false })
  await editor.save()
  assert.equal(editor.state.open, true)
  assert.equal(editor.state.draft, "")
  assert.equal(editor.state.saved, "office@example.test")
  assert.deepEqual(editor.calls, [])
  assert.match(editor.confirmations[0], /disable event-update emails.*daily reminders are not affected/i)
})

test("actual editor sends dedicated confirmation and captured base version only after acceptance", async () => {
  const editor = editorHarness({ draft: " \n; ", confirm: true })
  await editor.save()
  assert.equal(editor.calls.length, 1)
  assert.equal(editor.calls[0].confirmEmailRecipientsClear, true)
  assert.deepEqual(editor.calls[0].settings, { emailRecipientsText: " \n; " })
  assert.match((editor.calls[0].expectedSettingVersions as Record<string, string>).emailRecipientsText, /^[a-f0-9]{64}$/)
  assert.equal(editor.state.open, false)
})

test("actual editor retains failed/conflicting drafts and ordinary edits do not ask to disable emails", async () => {
  for (const status of [409, 500]) {
    const editor = editorHarness({ draft: "", confirm: true, status })
    await editor.save()
    assert.equal(editor.state.open, true)
    assert.equal(editor.state.draft, "")
    assert.equal(editor.state.saved, "office@example.test")
    assert.match(editor.alerts[0], /Synthetic conflict or save failure/)
  }
  const ordinary = editorHarness({ draft: "new@example.test" })
  await ordinary.save()
  assert.deepEqual(ordinary.confirmations, [])
  assert.equal(Object.hasOwn(ordinary.calls[0], "confirmEmailRecipientsClear"), false)
  assert.equal(ordinary.state.saved, "new@example.test")
  const invalid = editorHarness({ draft: "not-an-address" })
  await invalid.save()
  assert.deepEqual(invalid.calls, [])
  assert.equal(invalid.state.open, true)
})
