import assert from "node:assert/strict"
import test from "node:test"
import { calendarDeliveryKey, deliverCalendarReminder } from "../lib/calendarDelivery"

const message = { kind: "task" as const, occurrenceDate: "2026-10-07", recordId: "task-1", to: ["a@example.com"], cc: ["a@example.com", "b@example.com"], subject: "Synthetic", html: "Synthetic only" }
function fakeStore() {
  const rows = new Map<string, { key: string; payload: Record<string, unknown>; updated_at: string }>()
  let failInsert = false, failUpdate = false
  return {
    rows,
    failInsert: () => { failInsert = true }, failUpdate: () => { failUpdate = true },
    client: { from() {
      let operation = "read", values: Record<string, unknown> = {}
      const filters: Array<[string, unknown]> = []
      const run = async () => {
        if (operation === "insert") {
          if (failInsert) return { data: null, error: { code: "08006" } }
          const key = String(values.key)
          if (rows.has(key)) return { data: null, error: { code: "23505" } }
          rows.set(key, structuredClone(values) as never)
          return { data: null, error: null }
        }
        const row = [...rows.values()].find((candidate) => filters.every(([field, expected]) => (field.startsWith("payload->>") ? candidate.payload[field.slice(10)] : candidate[field as "key"]) === expected))
        if (operation === "update" && failUpdate) return { data: null, error: { code: "08006" } }
        if (operation === "update" && row) Object.assign(row, structuredClone(values))
        return { data: row ? structuredClone(row) : null, error: null }
      }
      const query = {
        insert(value: Record<string, unknown>) { operation = "insert"; values = value; return query },
        update(value: Record<string, unknown>) { operation = "update"; values = value; return query },
        select() { return query }, eq(field: string, value: unknown) { filters.push([field, value]); return query },
        maybeSingle: run,
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) { return run().then(resolve, reject) },
      }
      return query
    } } as never,
  }
}

test("concurrent runs and retries submit only one email; TO and CC overlap is removed", async () => {
  const store = fakeStore(); let calls = 0
  const send = async (input: { to: string[]; cc?: string[] }) => {
    calls += 1; assert.deepEqual(input.cc, ["b@example.com"])
    await new Promise((resolve) => setTimeout(resolve, 5))
    return { id: "synthetic", accepted: [...input.to, ...(input.cc || [])], rejected: [] }
  }
  const results = await Promise.all(Array.from({ length: 20 }, () => deliverCalendarReminder(message, { supabase: store.client, send })))
  assert.equal(calls, 1)
  assert.equal(results.filter((r) => r.status === "delivered").length, 1)
  assert.equal((await deliverCalendarReminder(message, { supabase: store.client, send })).status, "already_delivered")
  assert.equal(calls, 1)
})

test("task edits do not resend the same occurrence; new day and event version have separate identities", () => {
  assert.equal(calendarDeliveryKey(message), calendarDeliveryKey({ ...message, recordVersion: "changed", to: ["new@example.com"] }))
  assert.notEqual(calendarDeliveryKey(message), calendarDeliveryKey({ ...message, occurrenceDate: "2026-10-08" }))
  assert.notEqual(calendarDeliveryKey({ ...message, kind: "event-change", recordVersion: "a" }), calendarDeliveryKey({ ...message, kind: "event-change", recordVersion: "b" }))
})

test("uncertain SMTP result blocks automatic resend and stores no private message content", async () => {
  const store = fakeStore(); let calls = 0
  const send = async () => { calls += 1; throw new Error("socket failed after DATA with private detail") }
  await assert.rejects(deliverCalendarReminder(message, { supabase: store.client, send }), /not fully confirmed/)
  await assert.rejects(deliverCalendarReminder(message, { supabase: store.client, send }), /could not be confirmed/)
  assert.equal(calls, 1)
  const receipt = [...store.rows.values()][0]
  assert.equal(receipt.payload.status, "uncertain")
  assert.doesNotMatch(JSON.stringify(receipt), /example.com|Synthetic|private detail/)
})

test("partial recipient acceptance is not reported as complete delivery", async () => {
  const store = fakeStore()
  await assert.rejects(deliverCalendarReminder(message, { supabase: store.client, send: async () => ({ id: "synthetic", accepted: ["a@example.com"], rejected: ["b@example.com"] }) }), /not fully confirmed/)
  assert.equal([...store.rows.values()][0].payload.status, "uncertain")
})

test("claim storage failure cannot send; missing acknowledgement cannot silently resend", async () => {
  const store = fakeStore(); store.failInsert(); let calls = 0
  const send = async () => { calls += 1; return { id: "synthetic", accepted: ["a@example.com", "b@example.com"], rejected: [] } }
  await assert.rejects(deliverCalendarReminder(message, { supabase: store.client, send }), /No email was sent/)
  assert.equal(calls, 0)
  const second = fakeStore(); second.failUpdate()
  await assert.rejects(deliverCalendarReminder(message, { supabase: second.client, send }), /Do not resend/)
  assert.equal(calls, 1)
  await assert.rejects(deliverCalendarReminder(message, { supabase: second.client, send, now: () => new Date(Date.now() + 180000) }), /could not be confirmed/)
  assert.equal(calls, 1)
})

test("invalid recipients and configuration failure occur before claiming or sending", async () => {
  const store = fakeStore()
  const send = async () => { throw new Error("must not send") }
  await assert.rejects(deliverCalendarReminder({ ...message, to: [] }, { supabase: store.client, send }), /recipients/)
  await assert.rejects(deliverCalendarReminder(message, { supabase: store.client, send, preflight: () => { throw new Error("missing config") } }), /missing config/)
  assert.equal(store.rows.size, 0)
})
