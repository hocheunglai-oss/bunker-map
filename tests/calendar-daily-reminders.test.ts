import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { afterEach, beforeEach, mock, test } from "node:test"
import { transformSync } from "esbuild"
import * as taskData from "../data/taskCalendar"
import { validateCalendarEmailList } from "../lib/calendarRecipients"
import { resolveCalendarStaffRecipients } from "../lib/calendarStaff"
import { deliverCalendarReminder, getCalendarReminderDelivery } from "../lib/calendarDelivery"
import { getHongKongDateKey } from "../lib/eventCalendarDates"
import { fcunoConnectionPolicy } from "../config/fcunoConnections"

beforeEach(() => mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-14T00:00:00Z") }))
afterEach(() => mock.timers.reset())

type Kind = "event" | "task"
const task = () => ({ id: "synthetic-task", sourceRow: 0, scheduleType: "Monthly", daysOfMonth: Array.from({ length: 31 }, (_, i) => i + 1), months: [], notify: ["OL"], cc: [], task: "Synthetic reminder", remark: "Synthetic only" })

function harness(kind: Kind) {
  const receipts = new Map<string, Record<string, unknown>>()
  const sends: Array<{ to: string[]; cc?: string[]; subject: string; html: string }> = []
  const env = { CRON_SECRET: "synthetic-cron-only", NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.test", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only", EVENT_CALENDAR_EMAIL_RECIPIENTS: "synthetic@example.test" }
  let tasks = [task()]
  let configured = true, failStaff = false, failCalendarRead = false, failClaim = false, failSend = false, staffReads = 0
  let sendBarrier: Promise<void> | undefined
  const db = { from(table: string) {
    assert.equal(table, "office_calendar_store")
    const filters: Record<string, unknown> = {}
    let updated: Record<string, unknown> | undefined
    const query = {
      select() { return query }, eq(key: string, value: unknown) { filters[key] = value; return query },
      async insert(value: Record<string, unknown>) {
        if (failClaim) return { error: { code: "08006" } }
        const key = String(value.key)
        if (receipts.has(key)) return { error: { code: "23505" } }
        receipts.set(key, structuredClone(value))
        return { error: null }
      },
      update(value: Record<string, unknown>) { updated = value; return query },
      async maybeSingle() {
        const key = String(filters.key)
        if (key === "task-calendar") return failCalendarRead
          ? { data: null, error: new Error("Synthetic calendar read failed") }
          : { data: { payload: { tasks: structuredClone(tasks) } }, error: null }
        const stored = receipts.get(key)
        if (updated) {
          const payload = stored?.payload as Record<string, unknown> | undefined
          if (!stored || payload?.claimId !== filters["payload->>claimId"] || payload?.status !== filters["payload->>status"]) return { data: null, error: null }
          receipts.set(key, { ...stored, ...structuredClone(updated) })
          return { data: { key }, error: null }
        }
        return { data: stored ? structuredClone(stored) : null, error: null }
      },
    }
    return query
  } }
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@supabase/supabase-js": { createClient: () => db },
    "@/data/taskCalendar": taskData,
    "@/lib/calendarRecipients": { validateCalendarEmailList },
    "@/lib/eventCalendarDates": { getHongKongDateKey },
    "@/config/fcunoConnections": { fcunoConnectionPolicy },
    "@/lib/adminAuth": { async requireAdminPagePermission() { throw new Error("Unauthorized") } },
    "@/lib/calendarStaff": { resolveCalendarStaffRecipients, async loadCalendarStaffDirectory() {
      staffReads += 1
      if (failStaff) throw new Error("Synthetic staff directory unavailable")
      return [{ code: "OL", name: "Synthetic", email: "synthetic@example.test" }]
    } },
    "@/lib/calendarDelivery": {
      getCalendarReminderDelivery: (identity: Parameters<typeof getCalendarReminderDelivery>[0]) => getCalendarReminderDelivery(identity, { supabase: db as never }),
      deliverCalendarReminder: (input: Parameters<typeof deliverCalendarReminder>[0]) => deliverCalendarReminder(input, {
        supabase: db as never,
        preflight() { if (!configured) throw new Error("Synthetic email configuration missing. No email was sent.") },
        async send(input) {
          sends.push(input)
          if (sendBarrier) await sendBarrier
          if (failSend) throw new Error("Synthetic SMTP uncertainty")
          return { id: "synthetic-mail", accepted: [...input.to, ...(input.cc || [])], rejected: [] }
        },
      }),
    },
  }
  const route = `../app/api/${kind === "event" ? "event-calendar" : "task-calendar"}/daily-reminder/route.ts`
  const code = transformSync(readFileSync(new URL(route, import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
  const loaded = { exports: {} as { GET(request: Request): Promise<Response> } }
  new Function("require", "module", "exports", "process", code)((name: string) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected route dependency ${name}`)
    return modules[name]
  }, loaded, loaded.exports, { env })
  return {
    sends, receipts, staffReads: () => staffReads,
    configure(value: boolean) { configured = value },
    breakRecipients() { env.EVENT_CALENDAR_EMAIL_RECIPIENTS = "invalid"; tasks = [{ ...task(), notify: ["UNKNOWN"] }] },
    failStaff(value: boolean) { failStaff = value },
    failCalendarRead(value: boolean) { failCalendarRead = value },
    failClaim(value: boolean) { failClaim = value },
    failSend(value: boolean) { failSend = value },
    holdSend(barrier: Promise<void>) { sendBarrier = barrier },
    async run(options: { unsigned?: boolean; dryRun?: boolean } = {}) {
      const response = await loaded.exports.GET(new Request(`https://synthetic.test/api/${kind}-calendar/daily-reminder${options.dryRun ? "?dryRun=1" : ""}`, { headers: options.unsigned ? {} : { authorization: `Bearer ${env.CRON_SECRET}` } }))
      return { status: response.status, body: await response.json() }
    },
  }
}

test("calendar retry schedules are bounded to 08:00, 08:15 and 08:30 HKT; event remains weekdays only", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"))
  for (const kind of ["event", "task"] as const) {
    const schedules = config.crons.filter((cron: { path: string }) => cron.path === `/api/${kind}-calendar/daily-reminder`).map((cron: { schedule: string }) => cron.schedule)
    assert.deepEqual(schedules, kind === "event" ? ["0 0 * * 1-5", "15 0 * * 1-5", "30 0 * * 1-5"] : ["0 0 * * *", "15 0 * * *", "30 0 * * *"])
  }
})

test("delivered retry runs quietly succeed before changed recipients, staff or SMTP configuration can cause a false failure", async () => {
  for (const kind of ["event", "task"] as const) {
    const app = harness(kind)
    assert.equal((await app.run()).status, 200)
    app.configure(false); app.failStaff(true); app.breakRecipients()
    for (const minute of [15, 30]) {
      mock.timers.setTime(new Date(`2026-10-14T00:${minute}:00Z`).getTime())
      const result = await app.run()
      assert.equal(result.status, 200)
      assert.equal(result.body.success, true)
      if (kind === "event") assert.equal(result.body.status, "already_delivered")
      else { assert.deepEqual(result.body.failed, []); assert.equal(result.body.skipped[0].reason, "Already sent for this date.") }
    }
    assert.equal(app.sends.length, 1)
    assert.equal(app.receipts.size, 1)
    assert.equal(app.staffReads(), kind === "task" ? 1 : 0)
  }
})

test("definite pre-send configuration or claim failures retry once later that morning without duplicates", async () => {
  for (const kind of ["event", "task"] as const) for (const failure of ["config", "claim"] as const) {
    const app = harness(kind)
    if (failure === "config") app.configure(false); else app.failClaim(true)
    assert.equal((await app.run()).status, 500)
    assert.equal(app.sends.length, 0)
    assert.equal(app.receipts.size, 0)
    app.configure(true); app.failClaim(false)
    mock.timers.setTime(new Date("2026-10-14T00:15:00Z").getTime())
    assert.equal((await app.run()).status, 200)
    mock.timers.setTime(new Date("2026-10-14T00:30:00Z").getTime())
    assert.equal((await app.run()).status, 200)
    assert.equal(app.sends.length, 1)
    assert.equal(app.receipts.size, 1)
  }
})

test("task calendar and staff-directory outages before delivery recover on a later scheduled run", async () => {
  for (const failure of ["calendar", "staff"] as const) {
    const app = harness("task")
    if (failure === "calendar") app.failCalendarRead(true); else app.failStaff(true)
    assert.equal((await app.run()).status, 500)
    assert.equal(app.sends.length, 0)
    assert.equal(app.receipts.size, 0)
    app.failCalendarRead(false); app.failStaff(false)
    mock.timers.setTime(new Date("2026-10-14T00:15:00Z").getTime())
    assert.equal((await app.run()).status, 200)
    mock.timers.setTime(new Date("2026-10-14T00:30:00Z").getTime())
    assert.equal((await app.run()).status, 200)
    assert.equal(app.sends.length, 1)
  }
})

test("uncertain SMTP submissions stay blocked across retry slots instead of sending a duplicate", async () => {
  for (const kind of ["event", "task"] as const) {
    const app = harness(kind); app.failSend(true)
    assert.equal((await app.run()).status, 500)
    app.failSend(false)
    for (const minute of [15, 30]) {
      mock.timers.setTime(new Date(`2026-10-14T00:${minute}:00Z`).getTime())
      const result = await app.run()
      assert.equal(result.status, 500)
      assert.match(kind === "event" ? result.body.message : result.body.failed[0].reason, /resend is paused/)
    }
    assert.equal(app.sends.length, 1)
    assert.equal(app.receipts.size, 1)
  }
})

test("overlapping scheduled invocations share the durable claim and submit one message", async () => {
  for (const kind of ["event", "task"] as const) {
    const app = harness(kind)
    let release!: () => void
    app.holdSend(new Promise<void>((resolve) => { release = resolve }))
    const first = app.run()
    while (!app.sends.length) await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      const second = await app.run()
      if (kind === "event") { assert.equal(second.status, 202); assert.equal(second.body.success, false) }
      else { assert.equal(second.status, 200); assert.deepEqual(second.body.failed, []); assert.match(second.body.skipped[0].reason, /Another run/) }
      assert.equal(app.sends.length, 1)
    } finally { release() }
    assert.equal((await first).status, 200)
    assert.equal((await app.run()).status, 200)
    assert.equal(app.sends.length, 1)
  }
})

test("the next date has its own occurrence; event weekend runs and unsigned requests do not send", async () => {
  for (const kind of ["event", "task"] as const) {
    mock.timers.setTime(new Date("2026-10-14T00:00:00Z").getTime())
    const app = harness(kind)
    assert.equal((await app.run({ unsigned: true })).status, 401)
    assert.equal((await app.run({ dryRun: true })).status, 200)
    assert.equal(app.receipts.size, 0)
    assert.equal(app.sends.length, 0)
    assert.equal((await app.run()).status, 200)
    mock.timers.setTime(new Date("2026-10-15T00:00:00Z").getTime())
    assert.equal((await app.run()).status, 200)
    assert.equal(app.sends.length, 2)
    mock.timers.setTime(new Date("2026-10-17T00:00:00Z").getTime())
    const weekend = await app.run()
    assert.equal(weekend.status, 200)
    assert.equal(app.sends.length, kind === "event" ? 2 : 3)
    if (kind === "event") assert.equal(weekend.body.skipped, true)
  }
})
