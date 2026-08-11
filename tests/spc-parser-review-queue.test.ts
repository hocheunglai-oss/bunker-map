import assert from "node:assert/strict"
import test from "node:test"
import { ADMIN_PAGE_DEFINITIONS, getAdminPageByPath } from "../lib/adminPages"
import { parserReportAccessPage } from "../lib/parserReportAccess"
import {
  acknowledgedParserReportMetadata,
  pendingParserReportMetadata,
  parserReportCounts,
  parserReportWithState,
  readyParserReportMetadata,
  type ParserReportRecord,
} from "../lib/parserReports"
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
  const report = parserReportWithState(pendingReport)
  assert.equal(report.resolved, false)
  assert.equal(report.pendingAiReview, true)
  assert.equal(report.readyForUserReview, false)
})

test("an AI-completed report remains visible until the user confirms it", () => {
  const readyReport = parserReportWithState({
    ...pendingReport,
    metadata: { pendingReview: false, pendingUserReview: true },
    status: "reviewed",
  })
  const counts = parserReportCounts([readyReport])

  assert.equal(readyReport.pendingAiReview, false)
  assert.equal(readyReport.readyForUserReview, true)
  assert.equal(counts.pendingAiReview, 0)
  assert.equal(counts.readyForUserReview, 1)
})

test("report workflow metadata moves through pending, ready, and acknowledged states", () => {
  const pending = pendingParserReportMetadata({ draft: { vesselName: "TEST" } })
  const ready = readyParserReportMetadata(pending, "2026-08-11T01:00:00.000Z")
  const acknowledged = acknowledgedParserReportMetadata(ready, "2026-08-11T02:00:00.000Z")

  assert.deepEqual(pending, {
    draft: { vesselName: "TEST" },
    pendingReview: true,
    pendingUserReview: false,
    aiReviewState: "pending",
    aiReviewedAt: null,
    userReviewedAt: null,
  })
  assert.equal(ready.pendingReview, false)
  assert.equal(ready.pendingUserReview, true)
  assert.equal(ready.aiReviewState, "ready")
  assert.equal(ready.aiReviewedAt, "2026-08-11T01:00:00.000Z")
  assert.equal(acknowledged.pendingUserReview, false)
  assert.equal(acknowledged.aiReviewState, "acknowledged")
  assert.equal(acknowledged.userReviewedAt, "2026-08-11T02:00:00.000Z")
})

test("Parser Report is a management page restricted to admins by default", () => {
  const page = SPC_PAGE_DEFINITIONS.find((item) => item.id === "spc-parser-reports")
  assert.equal(page?.group, "management")
  assert.equal(getDefaultSpcPermissionsForRole("ADMIN")["spc-parser-reports"], "edit")
  assert.equal(getDefaultSpcPermissionsForRole("BUYER TRADER")["spc-parser-reports"], "none")
  assert.equal(getDefaultSpcPermissionsForRole("SUPPLIER TRADER")["spc-parser-reports"], "none")
})

test("FCUNO exposes its own Parser Report management page", () => {
  const page = ADMIN_PAGE_DEFINITIONS.find((item) => item.id === "parser-reports")
  assert.deepEqual(page, {
    id: "parser-reports",
    label: "PARSER REPORT",
    group: "management",
    path: "/admin/parser-reports",
  })
  assert.equal(getAdminPageByPath("/admin/parser-reports")?.id, "parser-reports")
})

test("review queues use source-specific permissions without changing report submission access", () => {
  assert.equal(parserReportAccessPage("enquiryworksheet", true), "parser-reports")
  assert.equal(parserReportAccessPage("enquiryworksheet", false), "enquiry-worksheet")
  assert.equal(parserReportAccessPage("spc", true), "spc-parser-reports")
  assert.equal(parserReportAccessPage("spc", false), "spc-buyer-enquiries")
})
