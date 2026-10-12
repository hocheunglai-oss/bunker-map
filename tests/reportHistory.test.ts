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

test("Taiwan preserves an explicit missing history quote instead of reviving a stale port price", () => {
  const ports = [
    { id: "khh", name: "Kaohsiung", hsfo: 638, vlsfo: 700, mgo: 990 },
    { id: "txg", name: "Taichung", hsfo: null, vlsfo: 710, mgo: 990 },
    { id: "kln", name: "Keelung", hsfo: null, vlsfo: 999, mgo: 999 },
  ]
  const history = [
    { port_id: "khh", hsfo: null, vlsfo: null, mgo: 0, recorded_at: "2026-10-09T12:00:00" },
    { port_id: "khh", hsfo: 620, vlsfo: 690, mgo: 980, recorded_at: "2026-10-08T12:00:00" },
    { port_id: "txg", hsfo: null, vlsfo: null, mgo: null, recorded_at: "2026-10-09T12:00:00" },
    { port_id: "txg", hsfo: null, vlsfo: 700, mgo: 980, recorded_at: "2026-10-08T12:00:00" },
  ]
  const rows = buildTaiwanReportRows(ports, history, ["Kaohsiung", "Keelung", "Taichung"])
  assert.deepEqual(rows[0].hsfo, { today: null, last: 620, change: null })
  assert.deepEqual(rows[0].vlsfo, { today: null, last: 690, change: null })
  assert.deepEqual(rows[0].mgo, { today: 0, last: 980, change: -980 })
  for (const row of rows.slice(1)) {
    assert.deepEqual(row.vlsfo, { today: null, last: 700, change: null })
    assert.deepEqual(row.mgo, { today: null, last: 980, change: null })
  }
})

test("Taiwan formula chains propagate missing history but keep zero and no-history direct fallbacks", () => {
  const ports = [
    { id: "khh", name: "Kaohsiung", hsfo: 600, vlsfo: 800, mgo: 1000 },
    { id: "txg", name: "Taichung", hsfo: null, vlsfo: 888, mgo: 999, vlsfo_formula: "External + 5", mgo_formula: "External - -5" },
    { id: "kln", name: "Keelung", hsfo: null, vlsfo: 777, mgo: 777 },
    { id: "external", name: "External", hsfo: null, vlsfo: 20, mgo: 30 },
  ]
  const noHistory = buildTaiwanReportRows(ports.slice(0, 3), [], ["Kaohsiung", "Keelung", "Taichung"], ports)
  assert.equal(noHistory[0].hsfo.today, 600)
  for (const row of noHistory.slice(1)) {
    assert.deepEqual(row.vlsfo, { today: 25, last: null, change: null })
    assert.deepEqual(row.mgo, { today: 35, last: null, change: null })
  }
  const history = [
    { port_id: "external", hsfo: null, vlsfo: null, mgo: 0, recorded_at: "2026-10-09T12:00:00" },
    { port_id: "external", hsfo: null, vlsfo: 0, mgo: null, recorded_at: "2026-10-08T12:00:00" },
  ]
  for (const row of buildTaiwanReportRows(ports.slice(0, 3), history, ["Kaohsiung", "Keelung", "Taichung"], ports).slice(1)) {
    assert.deepEqual(row.vlsfo, { today: null, last: 5, change: null })
    assert.deepEqual(row.mgo, { today: 5, last: null, change: null })
  }
})

test("the newest microsecond-ranked missing quote remains authoritative in both historical reports", () => {
  const ports = [{ id: "khh", name: "Kaohsiung", hsfo: 999, vlsfo: 999, mgo: 999 }]
  const history = [
    { port_id: "khh", hsfo: 600, vlsfo: 800, mgo: 1000, recorded_at: "2026-10-09T12:00:00.000001" },
    { port_id: "khh", hsfo: null, vlsfo: 0, mgo: null, recorded_at: "2026-10-09T12:00:00.000002" },
    { port_id: "khh", hsfo: null, vlsfo: 700, mgo: 900, recorded_at: "2026-10-08T12:00:00" },
  ]
  for (const entries of [history, [...history].reverse()]) {
    const taiwan = buildTaiwanReportRows(ports, entries, ["Kaohsiung"])[0]
    assert.deepEqual(taiwan.hsfo, { today: null, last: null, change: null })
    assert.deepEqual(taiwan.vlsfo, { today: 0, last: 700, change: -700 })
    assert.deepEqual(taiwan.mgo, { today: null, last: 900, change: null })
    const hongkong = buildHongKongReportRows([{ id: "khh", name: "Hong Kong" }], entries, ["Hong Kong"])[0]
    assert.deepEqual(hongkong.hsfo, { today: null, last1: null, last2: null })
    assert.deepEqual(hongkong.vlsfo, { today: 0, last1: 700, last2: null })
    assert.deepEqual(hongkong.mgo, { today: null, last1: 900, last2: null })
  }
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
