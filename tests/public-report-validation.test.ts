import assert from "node:assert/strict"
import test from "node:test"
import { parsePublicReportJson, parsePublicReportPayload, readPublicOperationalNotice, validatePublicFallbacks, validatePublicReportSnapshot } from "../lib/publicReportValidation"
import type { PublicReportPayloadByKey } from "../lib/publicMarketData"

const keys = ["china", "compact", "taiwan", "hongkong"] as const
function snapshot<Key extends typeof keys[number]>(key: Key): NonNullable<PublicReportPayloadByKey[Key]["snapshot"]> {
  const section = { reportDate: "01 Sept 2026", sections: [{ title: "CHINA (NORTH)", rows: [{ port: "Dalian", hsfo: 0, vlsfo: null, mgo: 100 }] }] }
  const hk = { today: 0, last1: 10, last2: null }, tw = { today: 0, last: 10, change: -10 }
  const snapshots: { [K in typeof keys[number]]: NonNullable<PublicReportPayloadByKey[K]["snapshot"]> } = {
    china: section, compact: structuredClone(section),
    hongkong: { reportDate: "01 Sept 2026", rows: [{ port: "Hong Kong", todayDate: "2026-09-01T23:30:00.000003", last1Date: "2026-08-31T18:00:00Z", last2Date: null, hsfo: { ...hk }, vlsfo: { ...hk }, mgo: { ...hk } }] },
    taiwan: { reportDate: "01 Sept 2026", remark: "Line one\nLine two", rows: ["Kaohsiung", "Keelung", "Taichung", "Suao", "Hualien"].map(port => ({ port, hsfo: { ...tw }, vlsfo: { ...tw }, mgo: { ...tw } })) },
  }
  return snapshots[key]
}
function payload(key: typeof keys[number]) {
  return { key, snapshot: snapshot(key), fallbacks: { "dalian::vlsfo": "NA" }, ...(key === "taiwan" ? { specialNotice: "Notice one\nNotice two", operationalNotice: { active: false, typhoonName: "", expectedReopenDate: "" } } : {}) }
}
for (const key of keys) {
  test(`${key}: complete legacy/current public reports preserve zeros, nulls, negative changes and saved wording`, () => {
    const data = payload(key)
    assert.deepEqual(parsePublicReportPayload(data, key), data)
    assert.deepEqual(validatePublicReportSnapshot(data.snapshot, key), data.snapshot)
    assert.equal(parsePublicReportPayload({ ...data, snapshot: null }, key).snapshot, null)
    assert.doesNotThrow(() => validatePublicReportSnapshot({ ...data.snapshot, reportDate: "01 Sep 2026" }, key))
  })
  test(`${key}: malformed shapes/dates/values are rejected before rendering`, () => {
    for (const value of [false, [], {}, { ...snapshot(key), reportDate: "31 Feb 2026" }, { ...snapshot(key), reportDate: "01 Foo 2026" }, { ...snapshot(key), reportDate: "Invalid Date" }, { ...snapshot(key), rows: {}, sections: {} }]) assert.throws(() => validatePublicReportSnapshot(value, key))
    for (const value of [{ ...payload(key), key: "wrong" }, { ...payload(key), snapshot: undefined }, { ...payload(key), fallbacks: [] }, { ...payload(key), fallbacks: { "dalian::hsfo": {} } }]) assert.throws(() => parsePublicReportPayload(value, key))
    for (const price of [undefined, "0", {}, [], Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const bad = structuredClone(snapshot(key))
      if ("sections" in bad) bad.sections[0].rows[0].hsfo = price as number
      else bad.rows[0].hsfo.today = price as number
      assert.throws(() => validatePublicReportSnapshot(bad, key))
    }
    const duplicates = structuredClone(snapshot(key))
    const duplicateRows = "sections" in duplicates
      ? { ...duplicates, sections: [{ ...duplicates.sections[0], rows: [...duplicates.sections[0].rows, duplicates.sections[0].rows[0]] }] }
      : { ...duplicates, rows: [...duplicates.rows, duplicates.rows[0]] }
    assert.throws(() => validatePublicReportSnapshot(duplicateRows, key))
  })
}
test("stored JSON distinguishes absent/unpublished from damaged JSON and bounds input", () => {
  for (const empty of [undefined, null, "", "  "]) assert.equal(parsePublicReportJson(empty), null)
  assert.deepEqual(parsePublicReportJson('{"reportDate":"01 Sept 2026"}'), { reportDate: "01 Sept 2026" })
  assert.throws(() => parsePublicReportJson("{broken"))
  assert.throws(() => parsePublicReportJson(" ".repeat(4_194_304) + "{}"))
})
test("fallbacks are only supported display markers, not renderable objects or arbitrary strings", () => {
  const valid = { "dalian::hsfo": "-", "hong kong::vlsfo": "NA", "kaohsiung::mgo": "SE" }
  assert.deepEqual(validatePublicFallbacks(valid), valid)
  for (const bad of [null, [], { "dalian::hsfo": "123" }, { "dalian::hsfo": true }, { "dalian::bad": "NA" }, JSON.parse('{"__proto__":"NA"}')]) assert.throws(() => validatePublicFallbacks(bad))
})
test("operational notices retain legacy message parsing without coercing false strings into a price suspension", () => {
  const notice = readPublicOperationalNotice(JSON.stringify({ active: true, message: "Due to Typhoon Bavi and CPC office closure. CPC is expected to reopen Monday. Delivery may resume." }))
  assert.equal(notice.typhoonName, "Bavi"); assert.equal(notice.expectedReopenDate, "Monday"); assert.equal(notice.active, true)
  const data = payload("taiwan")
  assert.throws(() => parsePublicReportPayload({ ...data, operationalNotice: { active: "false" } }, "taiwan"))
  assert.throws(() => readPublicOperationalNotice('{"active":"false"}'))
  assert.throws(() => readPublicOperationalNotice('{"active":true,"typhoonName":{}}'))
  assert.equal(readPublicOperationalNotice(null).active, false)
})
test("row and section limits reject unbounded/ambiguous reports and invalid history calendars", () => {
  const section = snapshot("china")
  assert.throws(() => validatePublicReportSnapshot({ ...section, sections: [section.sections[0], section.sections[0]] }, "china"))
  assert.throws(() => validatePublicReportSnapshot({ ...section, sections: [{ ...section.sections[0], rows: [] }] }, "china"))
  assert.throws(() => validatePublicReportSnapshot({ ...section, sections: Array.from({ length: 201 }, (_, i) => ({ ...section.sections[0], title: String(i) })) }, "china"))
  const hk = snapshot("hongkong")
  for (const value of ["2026-02-30T12:00:00", "2026-09-01T24:00:00", "not a date"]) {
    assert.throws(() => validatePublicReportSnapshot({ ...hk, rows: [{ ...hk.rows[0], todayDate: value }] }, "hongkong"))
  }
})
