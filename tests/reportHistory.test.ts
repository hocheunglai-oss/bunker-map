import assert from "node:assert/strict"
import test from "node:test"
import { buildHongKongReportRows } from "@/lib/hongKongReport"
import {
  formatMarketDateNumeric,
  getMarketDateKey,
} from "@/lib/priceHistoryRecords"
import { buildTaiwanReportRows, formatReportDate } from "@/lib/taiwanReport"

test("Taiwan compares the newest market date with the previous distinct date", () => {
  const ports = [
    { id: "khh", name: "Kaohsiung", hsfo: 638, vlsfo: 700, mgo: 990 },
    { id: "txg", name: "Taichung", hsfo: null, vlsfo: 710, mgo: 990 },
    { id: "kln", name: "Keelung", hsfo: null, vlsfo: null, mgo: null },
  ]
  const history = [
    { port_id: "khh", hsfo: 623, vlsfo: 685, mgo: 985, recorded_at: "2026-07-09T12:00:00" },
    { port_id: "txg", hsfo: null, vlsfo: 710, mgo: 990, recorded_at: "2026-07-13T12:00:00" },
    { port_id: "khh", hsfo: 638, vlsfo: 700, mgo: 990, recorded_at: "2026-07-13T12:00:00" },
    { port_id: "txg", hsfo: null, vlsfo: 695, mgo: 985, recorded_at: "2026-07-09T12:00:00" },
    { port_id: "khh", hsfo: 638, vlsfo: 700, mgo: 990, recorded_at: "2026-07-13T12:00:00" },
    { port_id: "txg", hsfo: null, vlsfo: 710, mgo: 990, recorded_at: "2026-07-13T12:00:00" },
  ]

  const rows = buildTaiwanReportRows(
    ports,
    history,
    ["Kaohsiung", "Keelung", "Taichung"],
  )

  assert.deepEqual(rows[0].hsfo, { today: 638, last: 623, change: 15 })
  assert.deepEqual(rows[0].vlsfo, { today: 700, last: 685, change: 15 })
  assert.deepEqual(rows[0].mgo, { today: 990, last: 985, change: 5 })
  assert.deepEqual(rows[1].vlsfo, { today: 710, last: 695, change: 15 })
  assert.deepEqual(rows[2].vlsfo, { today: 710, last: 695, change: 15 })
})

test("Hong Kong uses three distinct market dates even when the newest date is duplicated", () => {
  const rows = buildHongKongReportRows(
    [{ id: "hkg", name: "Hong Kong" }],
    [
      { port_id: "hkg", hsfo: 520, vlsfo: 725, mgo: 1050, recorded_at: "2026-07-10T12:00:00" },
      { port_id: "hkg", hsfo: 530, vlsfo: 735, mgo: 1060, recorded_at: "2026-07-13T12:00:00" },
      { port_id: "hkg", hsfo: 510, vlsfo: 715, mgo: 1040, recorded_at: "2026-07-09T12:00:00" },
      { port_id: "hkg", hsfo: 530, vlsfo: 735, mgo: 1060, recorded_at: "2026-07-13T12:00:00" },
    ],
    ["Hong Kong"],
  )

  assert.equal(rows[0].todayDate, "2026-07-13T12:00:00")
  assert.equal(rows[0].last1Date, "2026-07-10T12:00:00")
  assert.equal(rows[0].last2Date, "2026-07-09T12:00:00")
  assert.deepEqual(rows[0].vlsfo, { today: 735, last1: 725, last2: 715 })
})

test("market dates are stable for database timestamps and timezone-aware input", () => {
  assert.equal(getMarketDateKey("2026-07-13T12:00:00"), "2026-07-13")
  assert.equal(getMarketDateKey("2026-07-12T16:30:00.000Z"), "2026-07-13")
  assert.equal(formatReportDate("2026-07-12T16:30:00.000Z"), "13 Jul 2026")
})

test("market history dates always use numeric day/month/year formatting", () => {
  for (let month = 1; month <= 12; month += 1) {
    const monthText = String(month).padStart(2, "0")
    assert.equal(
      formatMarketDateNumeric(`2026-${monthText}-15T12:00:00`),
      `15/${monthText}/2026`,
    )
  }

  assert.equal(formatMarketDateNumeric("2026-08-31T16:30:00.000Z"), "01/09/2026")
  assert.equal(formatMarketDateNumeric(null), "-")
  assert.equal(formatMarketDateNumeric("not-a-date"), "-")
})
