import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { combineTaiwanPriceHistory, compareAdminPriceHistoryRows, formatPriceHistoryDate, getPriceHistoryDateParts, sortAdminPriceHistoryRows } from "../lib/adminPriceHistory"

const row = (id: string, port_id: string, recorded_at: string, price = 100) => ({ id, port_id, recorded_at, hsfo: price, vlsfo: price, mgo: price })

test("admin history dates and month/year filters use market dates, not the browser timezone", () => {
  for (const tz of ["Asia/Hong_Kong", "America/Los_Angeles", "Pacific/Kiritimati"]) {
    const code = `import {formatPriceHistoryDate,getPriceHistoryDateParts} from './lib/adminPriceHistory.ts'; console.log(JSON.stringify(['2026-09-30T23:30:00','2026-10-01T00:30:00','2026-12-31T23:30:00','2026-09-30T18:30:00Z'].map(value=>[formatPriceHistoryDate(value),getPriceHistoryDateParts(value)])))`
    const actual = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: new URL("..", import.meta.url), env: { ...process.env, TZ: tz }, encoding: "utf8" }))
    assert.deepEqual(actual, [
      ["30 Sept 2026", { dateKey: "2026-09-30", year: "2026", month: "09", day: "30" }],
      ["01 Oct 2026", { dateKey: "2026-10-01", year: "2026", month: "10", day: "01" }],
      ["31 Dec 2026", { dateKey: "2026-12-31", year: "2026", month: "12", day: "31" }],
      ["01 Oct 2026", { dateKey: "2026-10-01", year: "2026", month: "10", day: "01" }],
    ])
  }
  assert.equal(formatPriceHistoryDate("2026-02-30T12:00:00"), "-")
  assert.equal(getPriceHistoryDateParts("invalid").dateKey, "")
})

test("duplicate ranking is immutable, deterministic and retains database microsecond precision", () => {
  const rows = [row("c", "K", "2026-10-01T12:00:00.000001"), row("a", "K", "2026-10-01T12:00:00.000002"), row("b", "K", "2026-10-01T12:00:00.000002"), row("d", "K", "2026-10-01T04:00:01Z"), row("e", "K", "invalid")]
  assert.deepEqual(sortAdminPriceHistoryRows(rows).map(row => row.id), ["d", "b", "a", "c", "e"])
  assert.deepEqual(rows.map(row => row.id), ["c", "a", "b", "d", "e"])
  assert.ok(compareAdminPriceHistoryRows({ id: 2, recorded_at: "2026-10-01" }, { id: 10, recorded_at: "2026-10-01" }) > 0)
})

test("Taiwan daily grouping keeps the newest record per port, independent of incoming order", () => {
  const older = row("1", "K", "2026-10-01T12:00:00", 100), latest = row("2", "K", "2026-10-01T23:30:00.000001", 0)
  const txg = row("3", "T", "2026-10-01T22:00:00", 300)
  for (const rows of [[older, latest, txg], [latest, txg, older], [txg, older, latest]]) {
    const result = combineTaiwanPriceHistory(rows, "K", "T")
    assert.equal(result.length, 1); assert.equal(result[0].dateKey, "2026-10-01")
    assert.equal(result[0].kaohsiungRow?.id, "2"); assert.equal(result[0].hsfo, 0)
    assert.equal(result[0].vlsfoTaichung, 300); assert.equal(result[0].recorded_at, latest.recorded_at)
  }
})

test("Taiwan historical split defaults do not leak into newer days or unrelated/invalid records", () => {
  const rows = [row("1", "K", "2026-04-20T23:30:00", 0), row("2", "K", "2026-04-21T23:30:00", 200), row("3", "OTHER", "2026-04-22T12:00:00", 999), row("4", "K", "invalid")]
  const result = combineTaiwanPriceHistory(rows, "K", "T")
  assert.deepEqual(result.map(row => row.dateKey), ["2026-04-21", "2026-04-20"])
  assert.equal(result[0].vlsfoTaichung, null); assert.equal(result[0].mgoTaichung, null)
  assert.equal(result[1].vlsfoTaichung, 0); assert.equal(result[1].mgoTaichung, 0)
})

test("an explicit unavailable Taichung quote is preserved before and after the historical split", () => {
  for (const day of ["2026-04-20", "2026-04-21"]) {
    const khh = { ...row("K", "K", `${day}T12:00:00`, 700), mgo: 900 }
    for (const quotes of [
      { vlsfo: null, mgo: null },
      { vlsfo: null, mgo: 0 },
      { vlsfo: 0, mgo: null },
    ]) {
      const txg = { ...row("T", "T", `${day}T12:00:00`), ...quotes }
      const [result] = combineTaiwanPriceHistory([khh, txg], "K", "T")
      assert.equal(result.vlsfoTaichung, quotes.vlsfo)
      assert.equal(result.mgoTaichung, quotes.mgo)
      assert.equal(result.vlsfoKaohsiung, 700)
      assert.equal(result.mgoKaohsiung, 900)
      assert.equal(result.taichungRow, txg)
    }
  }
})

test("legacy basis fallback is used only when the pre-split Taichung record is absent", () => {
  const khh = { ...row("K", "K", "2026-04-20T12:00:00", 700), mgo: 900 }
  const [legacy] = combineTaiwanPriceHistory([khh], "K", "T")
  assert.equal(legacy.taichungRow, null)
  assert.equal(legacy.vlsfoTaichung, 700)
  assert.equal(legacy.mgoTaichung, 900)
  const [modern] = combineTaiwanPriceHistory([{ ...khh, recorded_at: "2026-04-21T12:00:00" }], "K", "T")
  assert.equal(modern.vlsfoTaichung, null)
  assert.equal(modern.mgoTaichung, null)
})
