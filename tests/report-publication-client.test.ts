import assert from "node:assert/strict"
import test from "node:test"
import { parsePublicationBaseline } from "../lib/reportPublicationClient"
import type { ReportSnapshotKey } from "../lib/reportSnapshots"

function data(report: ReportSnapshotKey) {
  const nested = report === "hongkong" ? { today: 0, last1: 20, last2: null } : { today: 0, last: 20, change: -20 }
  const row = (port: string) => ({ port, hsfo: nested, vlsfo: nested, mgo: nested,
    ...(report === "hongkong" ? { todayDate: "2026-10-08T23:30:00.000002", last1Date: "2026-10-07T23:30:00", last2Date: null } : {}) })
  return { report, sourceVersion: "a".repeat(64), publicationVersion: "b".repeat(64), publishedReportDate: null,
    preview: { reportDate: "08 Oct 2026", ...(report === "china" || report === "compact"
      ? { sections: [{ title: "Prices", rows: [{ port: "Dalian", hsfo: 0, vlsfo: null, mgo: 20 }] }] }
      : { rows: (report === "hongkong" ? ["Hong Kong"] : ["Kaohsiung", "Keelung", "Taichung", "Suao", "Hualien"]).map(row) }),
    ...(report === "taiwan" ? { remark: "ONE\nTWO", specialNotice: "THREE\nFOUR" } : {}) } }
}

test("all four complete publication previews accept zero, blank prices, negative changes and notice line breaks", () => {
  for (const report of ["hongkong", "taiwan", "china", "compact"] as const) {
    const input = data(report)
    assert.deepEqual(parsePublicationBaseline(input, report), input)
  }
})

test("repair warning metadata is explicit and cannot claim a damaged report has a valid published date", () => {
  const input = data("china")
  assert.equal(parsePublicationBaseline({ ...input, publishedReportDamaged: true }, "china").publishedReportDamaged, true)
  for (const flag of ["false", null, 1, {}]) assert.throws(() => parsePublicationBaseline({ ...input, publishedReportDamaged: flag }, "china"))
  assert.throws(() => parsePublicationBaseline({ ...input, publishedReportDamaged: true, publishedReportDate: "08 Oct 2026" }, "china"))
})

test("invalid versions, report/date mismatches and malformed preview containers never become ready", () => {
  for (const report of ["hongkong", "taiwan", "china", "compact"] as const) {
    const input = data(report)
    for (const bad of [null, [], {}, { ...input, report: "other" }, { ...input, sourceVersion: undefined },
      { ...input, publicationVersion: 123 }, { ...input, publishedReportDate: undefined }, { ...input, preview: null },
      { ...input, preview: { ...input.preview, reportDate: "31 Feb 2026" } },
      { ...input, preview: { ...input.preview, reportDate: "NaN Invalid Date" } },
      { ...input, preview: { reportDate: "08 Oct 2026" } }]) assert.throws(() => parsePublicationBaseline(bad, report))
  }
})

test("partial/malformed rows and notices fail closed instead of crashing the review panel or omitting ports", () => {
  for (const report of ["hongkong", "taiwan", "china", "compact"] as const) {
    const input = data(report), preview = input.preview as Record<string, unknown>
    const nested = report === "hongkong" || report === "taiwan"
    const rows = nested ? preview.rows as Array<Record<string, unknown>> : (preview.sections as Array<{ rows: Array<Record<string, unknown>> }>)[0].rows
    function withRows(value: unknown) { return { ...input, preview: { ...preview, ...(nested ? { rows: value } : { sections: [{ title: "Prices", rows: value }] }) } } }
    for (const value of [null, [], [null], ["port"], [{ port: "" }], [{ ...rows[0], hsfo: undefined }],
      [{ ...rows[0], hsfo: nested ? { today: -1, last: 1, change: -2, last1: 1, last2: null } : -1 }],
      [...rows, rows[0]]]) assert.throws(() => parsePublicationBaseline(withRows(value), report))
    if (report === "taiwan") {
      assert.throws(() => parsePublicationBaseline(withRows(rows.slice(0, 4)), report))
      for (const key of ["remark", "specialNotice"]) assert.throws(() => parsePublicationBaseline({ ...input, preview: { ...preview, [key]: null } }, report))
    }
    if (report === "hongkong") assert.throws(() => parsePublicationBaseline(withRows([{ ...rows[0], todayDate: 123 }]), report))
    if (!nested) for (const sections of [null, [], [null], [{ title: "", rows }]]) assert.throws(() => parsePublicationBaseline({ ...input, preview: { ...preview, sections } }, report))
  }
})
