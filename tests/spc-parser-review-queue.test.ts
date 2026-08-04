import assert from "node:assert/strict"
import test from "node:test"
import { parserReportWithState, type ParserReportRecord } from "../lib/parserReports"
import { SPC_PAGE_DEFINITIONS, getDefaultSpcPermissionsForRole } from "../lib/spcPages"

const pendingReport: ParserReportRecord = {
  id: "report-1",
  fingerprint: "fingerprint",
  source: "spc",
  context: "new-enquiry",
  rawText: "chan ming / 12 aug / RMK 500mts",
  cleanedText: "",
  parserOutput: "chan ming / 12 aug / RMK 500mts",
  correctedOutput: "chan ming / 12 aug / RMK 500mts",
  note: "",
  pageUrl: "/enquiries",
  metadata: { pendingReview: true },
  status: "new",
  duplicateCount: 1,
  createdAt: "2026-08-04T00:00:00.000Z",
  lastReportedAt: "2026-08-04T00:00:00.000Z",
  createdByUsername: "trader",
  createdByDisplayName: "Trader",
  appCommit: "test",
  updatedAt: "2026-08-04T00:00:00.000Z",
}

test("a queued parser report remains unresolved until manual review", () => {
  assert.equal(parserReportWithState(pendingReport).resolved, false)
})

test("Parser Report is a management page restricted to admins by default", () => {
  const page = SPC_PAGE_DEFINITIONS.find((item) => item.id === "spc-parser-reports")
  assert.equal(page?.group, "management")
  assert.equal(getDefaultSpcPermissionsForRole("ADMIN")["spc-parser-reports"], "edit")
  assert.equal(getDefaultSpcPermissionsForRole("BUYER TRADER")["spc-parser-reports"], "none")
  assert.equal(getDefaultSpcPermissionsForRole("SUPPLIER TRADER")["spc-parser-reports"], "none")
})
