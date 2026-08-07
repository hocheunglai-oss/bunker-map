import assert from "node:assert/strict"
import test from "node:test"
import * as XLSX from "xlsx"
import {
  ATTENDANCE_LEGACY_CATEGORIES,
  emptyAttendanceCategoryTotals,
  type LegacyAttendanceMonthlyAggregate,
  type LegacyAttendanceStaffOpening,
} from "../lib/attendanceWorkbook"
import { createAttendanceMonthlyWorkbook } from "../lib/attendanceWorkbookExport"
import { parseLegacyAttendanceWorkbook } from "../lib/attendanceWorkbookImport"

function workbookBuffer(
  sheets: Array<{ name: string; rows: unknown[][] }>,
  bookType: "xls" | "xlsx" = "xlsx",
) {
  const workbook = XLSX.utils.book_new()
  for (const { name, rows } of sheets) {
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(rows, { cellDates: true, dateNF: "yyyy-mm-dd" }),
      name,
    )
  }
  return XLSX.write(workbook, {
    type: "buffer",
    bookType: bookType === "xls" ? "biff8" : "xlsx",
    cellDates: true,
  }) as Buffer
}

function annualFixture() {
  const rows: unknown[][] = Array.from({ length: 32 }, () => [])
  rows[0] = ["ATTENDANCE MONTHLY STATEMENT"]
  rows[6] = [
    "CURRENT YEAR ALLOWANCE",
    "STAFF",
    "ABSENT ALS",
    "ABSENT ALU",
    "ABSENT SLM",
    "ABSENT SLR",
    "ABSENT SLX",
    "ATTEND SAT",
    "ATTEND HOL",
    "SPECIAL LEAVE",
    "MATERNITY LEAVE",
    "NO PAY LEAVE",
    "ATTEND HM",
    "ATTEND OS",
    "LAST YEAR BAL B/F (2030)",
    "LEAVE PAID",
    "",
    "LEAVE BALANCE",
  ]
  rows[7] = [15, "EMP-A", 1.5, 0, 0.5, 0, 0, 2, 1, 0, 0, 0, 0.5, 1, 3, 0, null, 17.5]
  rows[8] = [10, "EMP-B", 0, 0.5, 0, 0, 0.5, 0, 0, 1, 0, 0, 0, 0.5, 2, 0, null, 11]
  rows[9] = [null, "TOTAL"]
  rows[24] = [
    "DATE",
    "STAFF",
    "ABSENT ALS",
    "ABSENT ALU",
    "ABSENT SLM",
    "ABSENT SLR",
    "ABSENT SLX",
    "ATTEND SAT",
    "ATTEND HOL",
    "ABSENT SPL",
    "ABSENT MATERNITY",
    "ABSENT NO PAY",
    "ATTEND HM",
    "BUSINESS TRIP",
    "STAFF COMFIRMATION",
  ]
  rows[25] = [
    new Date("2031-01-31T00:00:00.000Z"),
    "EMP-A",
    0.5,
    0,
    0.5,
    0,
    0,
    1,
    1,
    0,
    0,
    0,
    0.5,
    1,
    "CONFIRMED",
  ]
  rows[26] = [
    new Date("2031-01-31T00:00:00.000Z"),
    "EMP-B",
    0,
    0.5,
    0,
    0,
    0.5,
    0,
    0,
    1,
    0,
    0,
    0,
    0.5,
    "",
  ]
  rows[27] = [
    new Date("2031-01-31T00:00:00.000Z"),
    "EMP-A",
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    "CONFIRMED",
  ]

  return workbookBuffer([
    { name: "LEAVE DATA", rows },
    {
      name: "Reference",
      rows: [
        ["Sick Leave"],
        ["SLX", "Late claim"],
        ["SLX", "No claim"],
        [],
        ["Home Office"],
        ["HO", "Supervisor approved"],
        [],
        ["Business Trip"],
        ["OS", "Business travel"],
      ],
    },
  ], "xls")
}

test("imports the annual legacy layout without Saturday attendance", () => {
  const result = parseLegacyAttendanceWorkbook(annualFixture(), {
    fileName: "fictional-attendance.xls",
  })

  assert.equal(result.workbookType, "annual")
  assert.equal(result.source.year, 2031)
  assert.equal(result.staffOpenings.length, 2)
  assert.equal(result.monthlyAggregates.length, 3)
  assert.equal(result.staffOpenings[0].currentYearAllowance, 15)
  assert.equal(result.staffOpenings[0].carryForward, 3)
  assert.equal(result.staffOpenings[0].categories.HO, 0.5)
  assert.equal(result.staffOpenings[0].categories.OS, 1)
  assert.equal(result.monthlyAggregates[0].statementDate, "2031-01-31")
  assert.equal(result.monthlyAggregates[0].categories.ALS, 0.5)
  assert.equal(result.monthlyAggregates[0].categories.HO, 0.5)
  assert.equal(result.monthlyAggregates[0].categories.OS, 1)
  assert.equal(result.monthlyAggregates[0].confirmation, "confirmed")
  assert.deepEqual(
    Object.keys(result.monthlyAggregates[0].categories),
    [...ATTENDANCE_LEGACY_CATEGORIES],
  )
  assert.equal(result.dryRun.ignoredSaturdayValueCount, 3)
  assert.ok(result.dryRun.halfDayValueCount > 0)
  assert.equal(result.dryRun.duplicateCount, 2)
  assert.ok(result.issues.some((issue) => issue.code === "duplicate_monthly_aggregate"))
  assert.ok(result.issues.some((issue) => issue.code === "duplicate_reference_code"))
  assert.equal(
    result.monthlyAggregates[0].sourceKey,
    result.monthlyAggregates[2].sourceKey,
    "duplicate period/staff rows intentionally share an idempotency key",
  )
})

test("reads daily cells conservatively and leaves ambiguous BT unconverted", () => {
  const rows: unknown[][] = [
    [null, "DAILY SIGN-IN AND SIGN-OUT RECORD (JAN)"],
    [null, "DATE", null, "EMP-A", null, "EMP-B"],
    [null, null, null, "IN", "OUT", "IN", "OUT"],
    ["MON - FRI", new Date("2031-01-06T00:00:00.000Z"), "MO", "09:58", "18:30", "ALS", "ALS"],
    [null, new Date("2031-01-07T00:00:00.000Z"), "TU", "BT", "OS", "HM", "Business Trip"],
    ["SAT", new Date("2031-01-11T00:00:00.000Z"), "SA", "Y", null, null, "Y"],
    ["MONTH SUMMARY"],
  ]
  const result = parseLegacyAttendanceWorkbook(
    workbookBuffer([{ name: "RECORD", rows }], "xls"),
    { fileName: "fictional-daily.xls" },
  )

  assert.equal(result.workbookType, "daily")
  assert.equal(result.dailyRecords.length, 4)
  assert.equal(result.dryRun.ignoredSaturdayValueCount, 2)
  const exact = result.dailyRecords.find(
    (row) => row.staffCode === "EMP-A" && row.workDate === "2031-01-06",
  )
  assert.equal(exact?.signIn, "09:58")
  assert.equal(exact?.hasExactSignIn, true)
  assert.equal(exact?.hasExactSignOut, true)
  const fullDayLeave = result.dailyRecords.find(
    (row) => row.staffCode === "EMP-B" && row.workDate === "2031-01-06",
  )
  assert.equal(fullDayLeave?.categories.ALS, 1)
  const normalized = result.dailyRecords.find(
    (row) => row.staffCode === "EMP-B" && row.workDate === "2031-01-07",
  )
  assert.equal(normalized?.signIn, "HO")
  assert.equal(normalized?.signOut, "OS")
  assert.equal(normalized?.categories.HO, 0.5)
  assert.equal(normalized?.categories.OS, 0.5)
  const ambiguous = result.dailyRecords.find(
    (row) => row.staffCode === "EMP-A" && row.workDate === "2031-01-07",
  )
  assert.equal(ambiguous?.signIn, "BT")
  assert.equal(ambiguous?.categories.OS, 0.5)
  assert.ok(result.issues.some((issue) => issue.code === "ambiguous_bt_value"))
})

test("rejects unrelated workbooks with an explicit dry-run error", () => {
  const result = parseLegacyAttendanceWorkbook(
    workbookBuffer([{ name: "Other", rows: [["Not attendance data"]] }]),
  )
  assert.equal(result.workbookType, "unknown")
  assert.equal(result.dryRun.errorCount, 1)
  assert.equal(result.issues[0].code, "unsupported_attendance_workbook")
})

test("exports a formula-driven monthly workbook without a Saturday column", () => {
  const empty = emptyAttendanceCategoryTotals()
  const staffOpenings: LegacyAttendanceStaffOpening[] = [
    {
      sourceKey: "legacy-opening:2031:EMP-A",
      year: 2031,
      staffCode: "EMP-A",
      currentYearAllowance: 15,
      carryForward: 3,
      legacyBalance: null,
      categories: { ...empty },
      sourceSheet: "Fictional",
      sourceRow: 8,
    },
  ]
  const monthlyAggregates: LegacyAttendanceMonthlyAggregate[] = [
    {
      sourceKey: "legacy-monthly:2031-01-31:EMP-A",
      statementDate: "2031-01-31",
      staffCode: "EMP-A",
      categories: { ...empty, ALS: 0.5, HOL: 1, HO: 0.5, OS: 1 },
      confirmation: "confirmed",
      confirmationRaw: "CONFIRMED",
      sourceSheet: "Fictional",
      sourceRow: 26,
    },
  ]
  const output = createAttendanceMonthlyWorkbook({
    periodEnd: "2031-01-31",
    staffOpenings,
    monthlyAggregates,
    generatedAt: "2031-02-01T02:00:00.000Z",
  })
  assert.equal(output.subarray(0, 2).toString(), "PK")

  const workbook = XLSX.read(output, { type: "buffer", cellFormula: true })
  assert.deepEqual(workbook.SheetNames, [
    "MONTHLY SUMMARY",
    "MONTHLY DATA",
    "OPENING BALANCES",
    "REFERENCE",
  ])
  const summary = workbook.Sheets["MONTHLY SUMMARY"]
  const data = workbook.Sheets["MONTHLY DATA"]
  const summaryHeaders = XLSX.utils.sheet_to_json(summary, {
    header: 1,
    range: "A5:P5",
    raw: true,
  })[0] as string[]
  const dataHeaders = XLSX.utils.sheet_to_json(data, {
    header: 1,
    range: "A1:O1",
    raw: true,
  })[0] as string[]
  assert.ok(!summaryHeaders.some((header) => /SAT(?:URDAY)?/i.test(header)))
  assert.ok(!dataHeaders.some((header) => /SAT(?:URDAY)?/i.test(header)))
  assert.match(summary.D6.f || "", /^SUMIFS\(/)
  assert.equal(summary.O6.f, "B6+C6+I6-D6-E6-H6")
  assert.match(summary.P6.f || "", /CONFIRMED/)
  assert.equal(data.H2.v, 1, "HOL is retained after the removed Saturday position")
  assert.equal(data.L2.v, 0.5, "HO is exported using its canonical code")
  assert.equal(data.M2.v, 1, "business trip is exported as OS")
})
