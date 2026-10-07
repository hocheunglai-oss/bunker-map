import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { afterEach, beforeEach, mock, test } from "node:test"
import { transformSync } from "esbuild"
import { deliverCalendarReminder, calendarDeliveryKey } from "../lib/calendarDelivery"
import { getEventCalendarRecordVersion } from "../lib/eventCalendarStore"
import { buildChangedEventsEmail } from "../lib/eventCalendarEmail"
import { resolveEventCalendarRecipients } from "../lib/calendarRecipients"
import { resolveCalendarStaffRecipients } from "../lib/calendarStaff"
import { getHongKongDateKey, isValidCalendarDate } from "../lib/eventCalendarDates"

const event = (id = "a", title = "SYNTHETIC EVENT") => ({ id, title, startDate: "2026-10-07", endDate: "2026-10-08", people: ["JZ"], tags: [] })
const snapshot = (events = [event()], settings: Record<string, unknown> = {}) => ({ events, emailRecipientsText: "office@example.test", ...settings })
const routes = new Map<string, string>()
function routeSource(name: string) {
  if (!routes.has(name)) routes.set(name, transformSync(readFileSync(new URL(`../app/api/event-calendar/${name}/route.ts`, import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code)
  return routes.get(name)!
}

beforeEach(() => mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-07T02:00:00Z") }))
afterEach(() => mock.timers.reset())

function harness(options: {
  snapshots?: Record<string, unknown>[]; permission?: "edit" | "view" | "none"; unsigned?: boolean
  canonicalError?: boolean; missingConfiguration?: boolean; sendError?: boolean; partialDelivery?: boolean; receiptError?: boolean
  staff?: Array<{ code: string; email: string | null; name: string }>; holdSend?: Promise<void>
} = {}) {
  const records = new Map<string, Record<string, unknown>>()
  const sends: Array<{ to: string[]; cc?: string[]; subject: string; html: string }> = []
  let canonicalReads = 0, staffReads = 0, clients = 0
  const permissions: string[] = []
  const db = {
    from(table: string) {
      assert.equal(table, "office_calendar_store")
      const filters: Record<string, unknown> = {}
      let update: Record<string, unknown> | undefined
      const query = {
        select() { return query },
        eq(key: string, value: unknown) { filters[key] = value; return query },
        async insert(value: Record<string, unknown>) {
          const key = String(value.key)
          if (records.has(key)) return { error: { code: "23505" } }
          records.set(key, structuredClone(value))
          return { error: null }
        },
        update(value: Record<string, unknown>) { update = value; return query },
        async maybeSingle() {
          const key = String(filters.key)
          if (key === "event-calendar") {
            canonicalReads += 1
            if (options.canonicalError) return { data: null, error: { message: "Synthetic read failed" } }
            const snapshots = options.snapshots || [snapshot()]
            return { data: { payload: structuredClone(snapshots[Math.min(canonicalReads - 1, snapshots.length - 1)]) }, error: null }
          }
          const stored = records.get(key)
          if (update) {
            if (options.receiptError) return { data: null, error: { message: "Synthetic receipt failure" } }
            const payload = stored?.payload as Record<string, unknown> | undefined
            if (!stored || payload?.claimId !== filters["payload->>claimId"] || payload?.status !== filters["payload->>status"]) return { data: null, error: null }
            records.set(key, { ...stored, ...structuredClone(update) })
            return { data: { key }, error: null }
          }
          return { data: stored ? structuredClone(stored) : null, error: null }
        },
      }
      return query
    },
  }
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@/lib/adminAuth": { async requireAdminPagePermission(page: string, permission: string) {
      permissions.push(`${page}:${permission}`)
      if (options.unsigned) throw new Error("Unauthorized")
      if ((options.permission || "edit") !== "edit") throw new Error("Forbidden")
      return { username: "synthetic-editor" }
    } },
    "@/lib/eventCalendarEmail": { buildChangedEventsEmail },
    "@/lib/eventCalendarStore": { getEventCalendarRecordVersion },
    "@/lib/calendarServiceClient": { createCalendarServiceClient() { clients += 1; return db } },
    "@/lib/calendarRecipients": { resolveEventCalendarRecipients },
    "@/lib/eventCalendarDates": { getHongKongDateKey, isValidCalendarDate },
    "@/lib/calendarStaff": {
      resolveCalendarStaffRecipients,
      async loadCalendarStaffDirectory() { staffReads += 1; return options.staff || [{ code: "JZ", name: "Synthetic JZ", email: "jz@example.test" }] },
    },
    "@/lib/calendarDelivery": {
      async deliverCalendarReminder(input: Parameters<typeof deliverCalendarReminder>[0]) {
        return deliverCalendarReminder(input, {
          supabase: db as never,
          preflight() { if (options.missingConfiguration) throw new Error("Calendar email delivery is not configured. No email was sent.") },
          async send(input) {
            sends.push(input)
            if (options.holdSend) await options.holdSend
            if (options.sendError) throw new Error("Synthetic SMTP uncertainty")
            const recipients = [...input.to, ...(input.cc || [])]
            return { id: "synthetic-mail", accepted: options.partialDelivery ? recipients.slice(1) : recipients, rejected: options.partialDelivery ? recipients.slice(0, 1) : [] }
          },
        })
      },
    },
  }
  function load(name: string) {
    const loaded = { exports: {} as { POST: (request: Request) => Promise<Response> } }
    new Function("require", "module", "exports", routeSource(name))((name: string) => { assert.ok(Object.hasOwn(modules, name), `Unexpected dependency ${name}`); return modules[name] }, loaded, loaded.exports)
    return loaded.exports.POST
  }
  return {
    sends, records, permissions, reads: () => ({ canonicalReads, staffReads, clients }),
    async rawRequest(text: string, name = "leave-request") {
      const response = await load(name)(new Request(`https://synthetic.test/api/event-calendar/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: text }))
      return { status: response.status, body: await response.json() }
    },
    async request(payload: unknown, name = "email-notify") {
      const response = await load(name)(new Request(`https://synthetic.test/api/event-calendar/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }))
      return { status: response.status, body: await response.json() }
    },
  }
}

const eventRequest = (events = [event()]) => ({ action: "updated", events, eventVersions: Object.fromEntries(events.map((entry) => [entry.id, getEventCalendarRecordVersion(entry)])) })
const leaveRequest = (overrides: Record<string, unknown> = {}) => ({ from: "2026-10-08", to: "2026-10-09", type: "Annual Leave", person: "JZ", reason: "Synthetic request", ...overrides })

test("event/leave email requires Edit before looking up data or claiming delivery", async () => {
  for (const options of [{ permission: "view" as const }, { permission: "none" as const }, { unsigned: true }]) {
    for (const route of ["email-notify", "leave-request"]) {
      const app = harness(options)
      const result = await app.request(route === "email-notify" ? eventRequest() : leaveRequest(), route)
      assert.equal(result.status, options.unsigned ? 401 : 403)
      assert.deepEqual(app.reads(), { canonicalReads: 0, staffReads: 0, clients: 0 })
      assert.equal(app.records.size, 0)
      assert.deepEqual(app.sends, [])
    }
  }
})

test("one batched message uses canonical events, escapes text, and retries do not send twice", async () => {
  const events = [event("a", "GUEST NAME <NOT AN EMAIL>"), event("b", "SECOND EVENT")]
  const app = harness({ snapshots: [snapshot(events)] })
  const first = await app.request(eventRequest(events))
  assert.equal(first.status, 200)
  assert.equal(first.body.status, "delivered")
  assert.equal(app.sends.length, 1)
  assert.deepEqual(app.sends[0].to, ["office@example.test"])
  assert.match(app.sends[0].html, /GUEST NAME &lt;NOT AN EMAIL&gt;/)
  assert.match(app.sends[0].html, /SECOND EVENT/)
  assert.equal((await app.request(eventRequest(events))).body.status, "already_delivered")
  assert.equal(app.sends.length, 1)
})

test("any missing or stale batch event rejects the whole notification before delivery", async () => {
  const events = [event(), event("b")]
  for (const snapshots of [[snapshot([events[0]])], [snapshot([event("a", "CHANGED"), events[1]])], [snapshot(events), snapshot([events[0], event("b", "CHANGED DURING PREPARATION")])]]) {
    const app = harness({ snapshots })
    const result = await app.request(eventRequest(events))
    assert.equal(result.status, 409)
    assert.equal(app.sends.length, 0)
    assert.equal(app.records.size, 0)
  }
})

test("canonical read failure, invalid/empty recipients, and unavailable SMTP config never claim delivery", async () => {
  for (const options of [{ canonicalError: true }, { snapshots: [snapshot([event()], { emailRecipientsText: "" })] }, { snapshots: [snapshot([event()], { emailRecipientsText: "office@example.test; not-an-email" })] }, { missingConfiguration: true }]) {
    const app = harness(options)
    const result = await app.request(eventRequest())
    assert.ok([400, 500].includes(result.status))
    assert.equal(app.records.size, 0)
    assert.equal(app.sends.length, 0)
  }
})

test("invalid batches fail without data reads or sends", async () => {
  for (const request of [eventRequest([]), eventRequest([event(), event()]), eventRequest(Array.from({ length: 101 }, (_, i) => event(String(i)))), { action: "other", event: event() }]) {
    const app = harness()
    assert.equal((await app.request(request)).status, 400)
    assert.equal(app.reads().canonicalReads, 0)
    assert.equal(app.records.size, 0)
  }
})

test("leave dates, type and staff resolution fail safely; JZ receives the validated applicant copy", async () => {
  for (const bad of [{ from: "2026-02-30" }, { to: "2026-10-07" }, { type: "Unknown leave" }, { person: "MISSING" }]) {
    const app = harness()
    assert.equal((await app.request(leaveRequest(bad), "leave-request")).status, 400)
    assert.equal(app.records.size, 0)
    assert.equal(app.sends.length, 0)
  }
  const app = harness()
  assert.equal((await app.request(leaveRequest(), "leave-request")).status, 200)
  assert.ok(app.sends[0].to.includes("jz@example.test"))
  assert.equal((await app.request(leaveRequest(), "leave-request")).body.status, "already_delivered")
  assert.equal(app.sends.length, 1)
})

test("null and malformed leave requests return a validation response without sending", async () => {
  for (const raw of ["null", "[]", "true", "{not-json}"]) {
    const app = harness()
    assert.equal((await app.rawRequest(raw)).status, 400)
    assert.equal(app.reads().staffReads, 0)
    assert.equal(app.records.size, 0)
    assert.deepEqual(app.sends, [])
  }
})

test("concurrent attempts send once and expose pending without falsely saying success", async () => {
  let release!: () => void
  const app = harness({ holdSend: new Promise<void>((resolve) => { release = resolve }) })
  const first = app.request(eventRequest())
  while (!app.sends.length) await new Promise<void>((resolve) => setImmediate(resolve))
  const second = await app.request(eventRequest())
  assert.equal(second.status, 202)
  assert.equal(second.body.success, false)
  assert.equal(second.body.status, "in_progress")
  assert.equal(app.sends.length, 1)
  release()
  assert.equal((await first).body.status, "delivered")
})

test("uncertain/partial SMTP delivery and receipt failures cannot cause automatic resend", async () => {
  for (const options of [{ sendError: true }, { partialDelivery: true }, { receiptError: true }]) {
    const app = harness(options)
    const result = await app.request(eventRequest())
    assert.equal(result.status, 500)
    assert.match(result.body.message, /check Sent Items/i)
    await app.request(eventRequest())
    assert.equal(app.sends.length, 1)
    assert.equal(app.records.size, 1)
  }
})

test("event version receipt is stable across batch order and days but changes for a new saved version", () => {
  const base = { kind: "event-change" as const, occurrenceDate: "2026-10-07", recordId: "same-events", recordVersion: "saved-version-a", to: ["office@example.test"], subject: "update", html: "" }
  assert.equal(calendarDeliveryKey(base), calendarDeliveryKey({ ...base, occurrenceDate: "2026-10-08" }))
  assert.notEqual(calendarDeliveryKey(base), calendarDeliveryKey({ ...base, recordVersion: "saved-version-b" }))
})
