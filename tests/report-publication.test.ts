import assert from "node:assert/strict"
import test from "node:test"
import { buildReportPublication, inspectSavedReportPublication, isReportDay, parseReportPublicationInput, parseReportPublicationSource, parseReportPublicationTarget, REPORT_PUBLICATIONS } from "../lib/reportPublication"

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const port = (name: string, n: number) => ({ id: id(n), name, type: "port", hsfo: 600, vlsfo: 800, mgo: 1000, hsfo_formula: null, vlsfo_formula: null, mgo_formula: null, updated_at: "2026-10-08" })
function source(report: "taiwan" | "hongkong" = "taiwan") {
  const ports = REPORT_PUBLICATIONS[report].names.map((name, index) => port(name, index + 1))
  return { report, ports, history: ports.flatMap((p, index) => [
    { id: id(index + 100), port_id: p.id, hsfo: 500, vlsfo: 700, mgo: 900, recorded_at: "2026-10-08T23:59:59.999999" },
    { id: id(index + 200), port_id: p.id, hsfo: 600, vlsfo: 800, mgo: 1000, recorded_at: "2026-10-07T23:59:59.999998" },
  ]), notices: report === "taiwan" ? [{ id: 1, content: "Keep\nnewlines" }, { id: 2, content: "Notice" }] : [], publication: null }
}

test("publication contexts pin all four reports to real page permissions, never caller-supplied identities", () => {
  assert.equal(parseReportPublicationTarget("hongkong", "hongkong-price-history").page, "hongkong-price-history")
  for (const report of Object.keys(REPORT_PUBLICATIONS)) assert.equal(parseReportPublicationTarget(report, "pricesetter").page, "pricesetter")
  for (const [report, page] of [["china", "hongkong-price-history"], ["taiwan", "hongkong-price-history"], ["unknown", "pricesetter"], ["taiwan", "users"], [null, null]]) assert.throws(() => parseReportPublicationTarget(report, page))
})

test("publication input has an exact bounded contract and calendar-valid override dates", () => {
  const input = { sourceVersion: "a".repeat(64), publicationVersion: "b".repeat(64), dateOverride: "" }
  assert.deepEqual(parseReportPublicationInput(input), input)
  for (const date of ["2026-02-30", "2026-13-01", "2026-10-08T00:00:00Z", "08/10/2026", "1899-12-31", null, 20261008]) assert.equal(isReportDay(date), false)
  for (const date of ["1900-01-01", "2028-02-29", "9999-12-31"]) assert.equal(isReportDay(date), true)
  for (const value of [null, [], {}, { ...input, payload: {} }, { ...input, sourceVersion: "" }, { ...input, publicationVersion: "A".repeat(64) }, { ...input, dateOverride: "2026-02-30" }]) assert.throws(() => parseReportPublicationInput(value))
})

test("report payload preserves notices, accepts falling prices and keeps database market dates", () => {
  const parsed = parseReportPublicationSource(source(), "taiwan")
  const payload = buildReportPublication(parsed)
  assert.equal(payload.reportDate, "08 Oct 2026")
  assert.equal(payload.remark, "Keep\nnewlines")
  const rows = payload.rows as Array<{ port: string; hsfo: { change: number }; vlsfo: { today: number; last: number; change: number } }>
  assert.equal(rows[0].hsfo.change, -100)
  assert.equal(rows.find(row => row.port === "Suao")?.vlsfo.change, -100)
  assert.equal(buildReportPublication(parsed, "2026-10-10").reportDate, "10 Oct 2026")
})

test("malformed, ambiguous, negative and incomplete stored sources fail closed", () => {
  type MutableSource = { ports: Record<string, unknown>[]; history: Record<string, unknown>[]; notices: Record<string, unknown>[]; publication: unknown }
  const cases: Array<(s: MutableSource) => void> = [
    s => { s.ports.push({ ...s.ports[0], id: id(50) }) },
    s => { s.ports[0].type = "divider" },
    s => { s.ports[0].hsfo = -1 },
    s => { s.ports[0].hsfo = "600" },
    s => { s.ports[0].updated_at = "2026-02-30" },
    s => { s.history.push({ ...s.history[0], id: id(55) }) },
    s => { s.history[0].recorded_at = "2026-10-08T12:00:00Z" },
    s => { s.notices.push({ id: 1, content: "Duplicate" }) },
    s => { s.publication = { id: 101, content: {} } },
  ]
  for (const mutate of cases) { const raw = source(); mutate(raw); assert.throws(() => parseReportPublicationSource(raw, "taiwan")) }
  const raw = source(); raw.ports.shift()
  assert.throws(() => buildReportPublication(parseReportPublicationSource(raw, "taiwan")))
})

test("damaged publication content is a versioned repair baseline, not invalid source prices", () => {
  for (const content of ["{broken", "[]", '{"reportDate":"08 Oct 2026","rows":{}}']) {
    const raw = { ...source(), publication: { id: 101, content } }
    assert.equal(parseReportPublicationSource(raw, "taiwan").publication?.content, content)
    assert.deepEqual(inspectSavedReportPublication(content, "taiwan"), { damaged: true, snapshot: null })
    assert.equal(buildReportPublication(parseReportPublicationSource(raw, "taiwan")).reportDate, "08 Oct 2026")
  }
  assert.deepEqual(inspectSavedReportPublication(null, "taiwan"), { damaged: false, snapshot: null })
  const snapshot = buildReportPublication(parseReportPublicationSource(source(), "taiwan"))
  assert.deepEqual(inspectSavedReportPublication(JSON.stringify(snapshot), "taiwan"), { damaged: false, snapshot })
})

test("negative calculated prices and invalid formulas cannot become unavailable/blank quotes", () => {
  const raw = source()
  for (const formula of ["Taichung - 9999", "Missing + 1", "Kaohsiung + 1", "Taichung * 2"]) {
    const draft = structuredClone(raw)
    Object.assign(draft.ports[0], { vlsfo_formula: formula })
    assert.throws(() => buildReportPublication(parseReportPublicationSource(draft, "taiwan")))
  }
})
