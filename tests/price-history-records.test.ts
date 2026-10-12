import assert from "node:assert/strict"
import test from "node:test"
import { getMarketDateKey, savePriceHistoryForMarketDate, type StoredPriceHistoryRecord } from "@/lib/priceHistoryRecords"

function historyClient(rows: StoredPriceHistoryRecord[] = [], failAction = "") {
  const calls: Array<{ action: string; payload?: any; filters: Array<[string, unknown]> }> = []
  const client = { from(table: string) {
    assert.equal(table, "price_history")
    const call: typeof calls[number] = { action: "read", filters: [] }
    const query = {
      select() { return query }, single() { return query }, order() { return query },
      eq(key: string, value: unknown) { call.filters.push([key, value]); return query },
      gte(key: string, value: unknown) { call.filters.push([`gte:${key}`, value]); return query },
      lt(key: string, value: unknown) { call.filters.push([`lt:${key}`, value]); return query },
      in(key: string, value: unknown) { call.filters.push([key, value]); return query },
      insert(payload: unknown) { call.action = "insert"; call.payload = payload; return query },
      update(payload: unknown) { call.action = "update"; call.payload = payload; return query },
      delete() { call.action = "delete"; return query },
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        calls.push(structuredClone(call))
        const result = call.action === failAction ? { data: null, error: { message: "Synthetic failure" } }
          : { data: call.action === "read" ? rows : { id: rows[0]?.id || "new", ...call.payload }, error: null }
        return Promise.resolve(result).then(resolve, reject)
      },
    }
    return query
  } }
  return { client, calls }
}

const values = { hsfo: 0, vlsfo: 800, mgo: null }
const cases = [
  ["2026-10-08T18:30:00.123Z", "2026-10-09T02:30:00.123"],
  ["2026-08-31T16:00:00Z", "2026-09-01T00:00:00.000"],
  ["2026-12-31T16:30:00Z", "2027-01-01T00:30:00.000"],
  ["2026-10-08T12:00:00+08:00", "2026-10-08T12:00:00.000"],
  ["2026-10-08T12:00:00-04:00", "2026-10-09T00:00:00.000"],
  ["2026-10-08T12:00:00", "2026-10-08T12:00:00"],
] as const

for (const [recordedAt, expected] of cases) {
  test(`history write and daily lookup agree for ${recordedAt}`, async () => {
    const { client, calls } = historyClient()
    const saved = await savePriceHistoryForMarketDate(client, { portId: "port", recordedAt, values })
    assert.equal(saved.recorded_at, expected)
    assert.equal(saved.hsfo, 0, "zero must not be converted to an empty price")
    assert.equal(getMarketDateKey(saved.recorded_at), getMarketDateKey(recordedAt))
    assert.deepEqual(calls[0].filters.slice(0, 2), [["port_id", "port"], ["gte:recorded_at", `${getMarketDateKey(recordedAt)}T00:00:00`]])
    assert.equal(calls[1].payload.recorded_at, expected)
  })
}

test("same market date updates the existing record and removes only its known duplicates", async () => {
  const rows = [
    { id: "retained", port_id: "port", recorded_at: "2026-10-09T02:00:00", ...values },
    { id: "duplicate", port_id: "port", recorded_at: "2026-10-09T01:00:00", ...values },
  ]
  const { client, calls } = historyClient(rows)
  await savePriceHistoryForMarketDate(client, { portId: "port", recordedAt: "2026-10-08T18:30:00Z", values })
  assert.deepEqual(calls.map(call => call.action), ["read", "update", "delete"])
  assert.deepEqual(calls[1].filters, [["id", "retained"]])
  assert.deepEqual(calls[2].filters, [["id", ["duplicate"]]])
  assert.equal(calls[1].payload.recorded_at, "2026-10-09T02:30:00.000")
})

for (const failAction of ["read", "insert", "update", "delete"]) {
  test(`history ${failAction} failure is never reported as saved`, async () => {
    const rows = failAction === "update" || failAction === "delete" ? [
      { id: "existing", port_id: "port", recorded_at: "2026-10-09T02:00:00", ...values },
      { id: "duplicate", port_id: "port", recorded_at: "2026-10-09T01:00:00", ...values },
    ] : []
    const { client } = historyClient(rows, failAction)
    await assert.rejects(savePriceHistoryForMarketDate(client, { portId: "port", recordedAt: "2026-10-08T18:30:00Z", values }), /Synthetic failure/)
  })
}

test("invalid dates and non-finite prices are rejected before any database operation", async () => {
  const { client, calls } = historyClient()
  for (const recordedAt of ["not-a-date", "2026-02-31T12:00:00+08:00", "2026-13-01T12:00:00Z", "2026-10-08T25:00:00Z"]) {
    await assert.rejects(savePriceHistoryForMarketDate(client, { portId: "port", recordedAt, values }))
  }
  for (const hsfo of [NaN, Infinity, -Infinity]) {
    await assert.rejects(savePriceHistoryForMarketDate(client, { portId: "port", recordedAt: "2026-10-08T12:00:00Z", values: { ...values, hsfo } }))
  }
  assert.deepEqual(calls, [])
})
