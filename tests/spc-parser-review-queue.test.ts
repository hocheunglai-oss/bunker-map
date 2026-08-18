import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { ADMIN_PAGE_DEFINITIONS, getAdminPageByPath } from "../lib/adminPages"
import { parserReportAccessPage } from "../lib/parserReportAccess"
import {
  completedParserReportMetadata,
  pendingParserReportMetadata,
  parserReportCounts,
  parserReportReviewStage,
  parserReportWithState,
  queuedAiParserReportMetadata,
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

test("legacy reports in the old inverted queue return to pending user review", () => {
  const report = parserReportWithState(pendingReport)
  assert.equal(report.resolved, false)
  assert.equal(report.pendingAiReview, false)
  assert.equal(report.readyForUserReview, true)
})

test("a user-corrected report moves to AI review and closes after AI completion", () => {
  const queuedMetadata = queuedAiParserReportMetadata(
    pendingParserReportMetadata(pendingReport.metadata),
    "2026-08-11T01:00:00.000Z",
    pendingReport.correctedOutput,
  )
  const queuedReport = parserReportWithState({
    ...pendingReport,
    metadata: queuedMetadata,
  })
  const completedReport = parserReportWithState({
    ...pendingReport,
    metadata: completedParserReportMetadata(queuedMetadata, "2026-08-11T02:00:00.000Z"),
    status: "reviewed",
  })
  const counts = parserReportCounts([completedReport])

  assert.equal(queuedReport.pendingAiReview, true)
  assert.equal(queuedReport.readyForUserReview, false)
  assert.equal(completedReport.pendingAiReview, false)
  assert.equal(completedReport.readyForUserReview, false)
  assert.equal(counts.pendingAiReview, 0)
  assert.equal(counts.readyForUserReview, 0)
  assert.equal(counts.unresolved, 0)
})

test("report metadata follows user review, AI review, and complete states", () => {
  const pending = pendingParserReportMetadata({ draft: { vesselName: "TEST" } })
  const queued = queuedAiParserReportMetadata(
    { ...pending, manualVlsfoMaxRemarks: ["80cst max", "180cst max"] },
    "2026-08-11T01:00:00.000Z",
    "test / vlsfo 180CST MAX 100mts",
  )
  const completed = completedParserReportMetadata(queued, "2026-08-11T02:00:00.000Z")

  assert.deepEqual(pending, {
    draft: { vesselName: "TEST" },
    reviewWorkflowVersion: 2,
    pendingReview: false,
    pendingUserReview: true,
    aiReviewState: "pending-user",
    aiReviewedAt: null,
    userReviewedAt: null,
  })
  assert.equal(parserReportReviewStage(pending, "new"), "pending-user")
  assert.equal(queued.pendingReview, true)
  assert.equal(queued.pendingUserReview, false)
  assert.equal(queued.aiReviewState, "pending-ai")
  assert.equal(queued.userReviewedAt, "2026-08-11T01:00:00.000Z")
  assert.deepEqual(queued.manualVlsfoMaxRemarks, ["180cst max"])
  assert.equal(parserReportReviewStage(queued, "new"), "pending-ai")
  assert.equal(completed.pendingReview, false)
  assert.equal(completed.pendingUserReview, false)
  assert.equal(completed.aiReviewState, "complete")
  assert.equal(completed.aiReviewedAt, "2026-08-11T02:00:00.000Z")
  assert.equal(parserReportReviewStage(completed, "reviewed"), "complete")
})

test("review UI moves the human correction to AI and closes after AI review", () => {
  const panelSource = readFileSync(
    new URL("../components/ParserReportReviewPanel.tsx", import.meta.url),
    "utf8",
  )
  const pendingAiPosition = panelSource.indexOf(">Pending AI Review<")
  const pendingUserPosition = panelSource.indexOf(">Pending Your Review<")

  assert.ok(pendingUserPosition >= 0)
  assert.ok(pendingAiPosition > pendingUserPosition)
  assert.doesNotMatch(panelSource, /Confirm Reviewed/)
  assert.doesNotMatch(panelSource, /Completed Parser Fix/)
  assert.match(panelSource, /openReport\(report, "pending-user"\)/)
  assert.match(panelSource, /action: "submit-ai"/)
  assert.match(panelSource, /Pass To AI Review/)
  assert.match(panelSource, /Complete AI Review/)
  assert.doesNotMatch(panelSource, /Mark Ready For Review/)
  assert.doesNotMatch(panelSource, /correctedOutput: data\.correctedOutput/)
  assert.match(panelSource, /aiOutput: draft\.aiOutput/)
  assert.match(panelSource, /aiSources: draft\.aiSources/)
})

test("enquiry worksheet report dialog leaves correction and notes to the admin review page", () => {
  const worksheetSource = readFileSync(
    new URL("../app/admin/enquiryworksheet/page.tsx", import.meta.url),
    "utf8",
  )
  const reviewSource = readFileSync(
    new URL("../components/ParserReportReviewPanel.tsx", import.meta.url),
    "utf8",
  )

  const dialogStart = worksheetSource.indexOf("parser-report-title")
  const dialogSource = worksheetSource.slice(dialogStart)
  assert.doesNotMatch(dialogSource, /CORRECT VERSION/)
  assert.doesNotMatch(dialogSource, /<span>NOTE<\/span>/)
  assert.match(reviewSource, /<span>Correct Version<\/span>/)
  assert.match(reviewSource, /<span>Note<\/span>/)
})

test("enquiry worksheet generator follows the requested parser-first layout", () => {
  const worksheetSource = readFileSync(
    new URL("../app/admin/enquiryworksheet/page.tsx", import.meta.url),
    "utf8",
  )
  const enquiry = worksheetSource.indexOf('aria-label="Enquiry text"')
  const generate = worksheetSource.indexOf(">\n              Generate\n")
  const shortened = worksheetSource.indexOf('aria-label="Shortened enquiry"')
  const parserTools = worksheetSource.indexOf("styles.parserToolButtons")

  assert.ok(enquiry >= 0)
  assert.ok(generate > enquiry)
  assert.ok(shortened > generate)
  assert.ok(parserTools > shortened)
  assert.doesNotMatch(worksheetSource, /REPORTED \(\{parserReportCount\}\)/)
  assert.match(worksheetSource, /value=\{guesses\.port\}[\s\S]*?className=\{styles\.capsInput\}/)
})

test("sidebar displays only the number of reports pending user review", () => {
  const badgeSource = readFileSync(
    new URL("../components/ParserReportSidebarBadge.tsx", import.meta.url),
    "utf8",
  )

  assert.match(badgeSource, /Number\(payload\.readyForUserReview\)/)
  assert.doesNotMatch(badgeSource, />\s*YOU\s/)
  assert.doesNotMatch(badgeSource, />\s*AI\s/)
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
