import assert from "node:assert/strict"
import test from "node:test"
import { parseIceBrentMarketData } from "../lib/brentMarketData"

const now = Date.parse("2026-07-23T08:50:00.000Z")
const contracts = [
  {
    marketId: 6018448,
    marketStrip: "Sep26",
    lastPrice: 98.02,
    lastTime: "07/23/2026 08:40 AM GMT",
    change: 4.199000744126717,
    volume: 104421,
  },
  {
    marketId: 6018445,
    marketStrip: "Oct26",
    lastPrice: 92.72,
    lastTime: "07/23/2026 08:40 AM GMT",
    change: 2.8,
    volume: 125268,
  },
]
const chart = {
  marketId: 6018448,
  bars: [
    ["Thu Jul 23 08:38:00 2026", 97.94],
    ["Thu Jul 23 08:39:00 2026", 97.93],
    ["Thu Jul 23 08:40:00 2026", 98.12],
    ["Thu Jul 23 08:41:00 2026", 98.09],
  ],
}

test("parses and verifies the official ICE front-month Brent quote", () => {
  const result = parseIceBrentMarketData(contracts, chart, now)

  assert.equal(result.source, "ICE")
  assert.equal(result.verified, true)
  assert.equal(result.contract, "Sep26")
  assert.equal(result.marketId, 6018448)
  assert.equal(result.price, 98.02)
  assert.equal(result.previousClose.toFixed(2), "94.07")
  assert.equal(result.change.toFixed(2), "3.95")
  assert.equal(result.changePercent.toFixed(3), "4.199")
  assert.deepEqual(result.points, [97.94, 97.93, 98.12, 98.09])
  assert.equal(result.updatedAt, "2026-07-23T08:40:00.000Z")
})

test("rejects stale contract data", () => {
  assert.throws(
    () =>
      parseIceBrentMarketData(
        [{ ...contracts[0], lastTime: "07/23/2026 07:00 AM GMT" }],
        chart,
        now,
      ),
    /stale/,
  )
})

test("rejects a chart for a different contract", () => {
  assert.throws(
    () => parseIceBrentMarketData(contracts, { ...chart, marketId: 6018445 }, now),
    /does not match/,
  )
})

test("rejects a quote that disagrees with the official ICE chart", () => {
  assert.throws(
    () =>
      parseIceBrentMarketData(
        [{ ...contracts[0], lastPrice: 86.06 }],
        chart,
        now,
      ),
    /agreement check/,
  )
})
