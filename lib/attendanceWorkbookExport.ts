import * as XLSX from "xlsx"
import {
  ATTENDANCE_CATEGORY_LABELS,
  ATTENDANCE_LEGACY_CATEGORIES,
  type AttendanceLegacyCategoryCode,
  type AttendanceMonthlyWorkbookInput,
} from "./attendanceWorkbook"

const SUMMARY_HEADERS = [
  "STAFF",
  "CURRENT YEAR ALLOWANCE",
  "LAST YEAR BAL B/F",
  "ALS",
  "ALU",
  "SLM",
  "SLR",
  "SLX",
  "ATTEND HOL",
  "SPECIAL LEAVE",
  "MATERNITY LEAVE",
  "NO PAY LEAVE",
  "HOME OFFICE",
  "BUSINESS TRIP",
  "LEAVE BALANCE",
  "CONFIRMATION",
] as const

const DATA_HEADERS = [
  "STATEMENT DATE",
  "STAFF",
  "ALS",
  "ALU",
  "SLM",
  "SLR",
  "SLX",
  "HOL",
  "SPL",
  "MTL",
  "NPL",
  "HO",
  "OS",
  "CONFIRMATION",
  "SOURCE KEY",
] as const

const HEADER_FILL = "1F4E78"
const INPUT_FILL = "FFF2CC"
const DERIVED_FILL = "EAF2F8"
const BORDER_COLOR = "B7C9D6"
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)
const DAY_MS = 24 * 60 * 60 * 1000

function requiredIsoDate(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} must use YYYY-MM-DD.`)
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a valid date.`)
  }
  return date
}

function excelDateSerial(value: string, field = "date") {
  const date = requiredIsoDate(value, field)
  return (date.getTime() - EXCEL_EPOCH_MS) / DAY_MS
}

function excelDateTimeSerial(value: Date) {
  return (value.getTime() - EXCEL_EPOCH_MS) / DAY_MS
}

function setStyle(
  cell: XLSX.CellObject | undefined,
  style: NonNullable<XLSX.CellObject["s"]>,
) {
  if (cell) cell.s = style
}

function styleHeaderRow(sheet: XLSX.WorkSheet, row: number, columnCount: number) {
  for (let column = 0; column < columnCount; column += 1) {
    setStyle(sheet[XLSX.utils.encode_cell({ r: row, c: column })], {
      fill: { patternType: "solid", fgColor: { rgb: HEADER_FILL } },
      font: { name: "Roboto", bold: true, color: { rgb: "FFFFFF" } },
      alignment: { horizontal: "center", vertical: "center", wrapText: true },
      border: {
        bottom: { style: "thin", color: { rgb: BORDER_COLOR } },
      },
    })
  }
}

function styleDataRange(
  sheet: XLSX.WorkSheet,
  startRow: number,
  endRow: number,
  startColumn: number,
  endColumn: number,
  fill?: string,
) {
  for (let row = startRow; row <= endRow; row += 1) {
    for (let column = startColumn; column <= endColumn; column += 1) {
      setStyle(sheet[XLSX.utils.encode_cell({ r: row, c: column })], {
        fill: fill
          ? { patternType: "solid", fgColor: { rgb: fill } }
          : undefined,
        font: { name: "Roboto", color: { rgb: "172B3A" } },
        alignment: {
          horizontal: column === 0 ? "left" : "center",
          vertical: "center",
        },
        border: {
          bottom: { style: "hair", color: { rgb: "D9E2E8" } },
        },
      })
    }
  }
}

function categoryDataColumn(category: AttendanceLegacyCategoryCode) {
  return 2 + ATTENDANCE_LEGACY_CATEGORIES.indexOf(category)
}

function excelColumn(column: number) {
  return XLSX.utils.encode_col(column)
}

export function createAttendanceMonthlyWorkbook(
  input: AttendanceMonthlyWorkbookInput,
): Buffer {
  const periodEnd = requiredIsoDate(input.periodEnd, "periodEnd")
  const year = periodEnd.getUTCFullYear()
  const periodEndText = input.periodEnd
  const generatedAt = input.generatedAt
    ? new Date(input.generatedAt)
    : new Date()
  if (!Number.isFinite(generatedAt.getTime())) {
    throw new Error("generatedAt must be a valid date when provided.")
  }

  const openingByStaff = new Map(
    input.staffOpenings
      .filter((opening) => opening.year === year)
      .map((opening) => [opening.staffCode.trim().toUpperCase(), opening]),
  )
  const monthlyRows = input.monthlyAggregates
    .filter((row) => row.statementDate.slice(0, 4) === String(year))
    .filter((row) => row.statementDate <= periodEndText)
    .sort((a, b) =>
      a.statementDate.localeCompare(b.statementDate) ||
      a.staffCode.localeCompare(b.staffCode),
    )
  const staffCodes = [...new Set([
    ...openingByStaff.keys(),
    ...monthlyRows.map((row) => row.staffCode.trim().toUpperCase()),
  ])].filter(Boolean).sort()
  const cachedSummaryValues: number[][] = []

  const workbook = XLSX.utils.book_new()
  const summary = XLSX.utils.aoa_to_sheet([
    [`ATTENDANCE MONTHLY STATEMENT - ${periodEndText.slice(0, 7)}`],
    ["PERIOD END", excelDateSerial(periodEndText)],
    ["GENERATED AT", excelDateTimeSerial(generatedAt)],
    [],
    [...SUMMARY_HEADERS],
    ...staffCodes.map((staffCode) => [staffCode]),
    ["TOTAL"],
  ], { cellDates: true, dateNF: "yyyy-mm-dd" })
  const data = XLSX.utils.aoa_to_sheet([
    [...DATA_HEADERS],
    ...monthlyRows.map((row) => [
      excelDateSerial(row.statementDate, "monthlyAggregates.statementDate"),
      row.staffCode.trim().toUpperCase(),
      ...ATTENDANCE_LEGACY_CATEGORIES.map((category) => row.categories[category]),
      row.confirmation === "confirmed" ? "CONFIRMED" : "UNCONFIRMED",
      row.sourceKey,
    ]),
  ], { cellDates: true, dateNF: "yyyy-mm-dd" })
  const openings = XLSX.utils.aoa_to_sheet([
    ["STAFF", "CURRENT YEAR ALLOWANCE", "LAST YEAR BAL B/F", "LEGACY BALANCE", "SOURCE KEY"],
    ...staffCodes.map((staffCode) => {
      const opening = openingByStaff.get(staffCode)
      return [
        staffCode,
        opening?.currentYearAllowance || 0,
        opening?.carryForward || 0,
        opening?.legacyBalance ?? null,
        opening?.sourceKey || "",
      ]
    }),
  ])
  const reference = XLSX.utils.aoa_to_sheet([
    ["CODE", "DESCRIPTION"],
    ...ATTENDANCE_LEGACY_CATEGORIES.map((category) => [
      category,
      ATTENDANCE_CATEGORY_LABELS[category],
    ]),
    [],
    ["LEAVE BALANCE", "Last year balance + current year allowance + holiday attendance - ALS - ALU - SLX"],
    ["NORMALIZATION", "Legacy HM and HO are exported as HO. Business trip is exported as OS."],
  ])

  const dataEndRow = Math.max(2, monthlyRows.length + 1)
  const openingEndRow = Math.max(2, staffCodes.length + 1)
  const firstSummaryRow = 6
  const lastSummaryRow = firstSummaryRow + staffCodes.length - 1
  const totalRow = lastSummaryRow + 1
  for (let index = 0; index < staffCodes.length; index += 1) {
    const rowNumber = firstSummaryRow + index
    const rowIndex = rowNumber - 1
    const staffCode = staffCodes[index]
    const opening = openingByStaff.get(staffCode)
    const ytdCategories = Object.fromEntries(
      ATTENDANCE_LEGACY_CATEGORIES.map((category) => [category, 0]),
    ) as Record<AttendanceLegacyCategoryCode, number>
    const staffRows = monthlyRows.filter(
      (row) => row.staffCode.trim().toUpperCase() === staffCode,
    )
    for (const aggregate of staffRows) {
      for (const category of ATTENDANCE_LEGACY_CATEGORIES) {
        ytdCategories[category] += aggregate.categories[category]
      }
    }
    const allowance = opening?.currentYearAllowance || 0
    const carryForward = opening?.carryForward || 0
    summary[XLSX.utils.encode_cell({ r: rowIndex, c: 1 })] = {
      t: "n",
      v: allowance,
      f: `IFERROR(VLOOKUP($A${rowNumber},'OPENING BALANCES'!$A$2:$E$${openingEndRow},2,FALSE),0)`,
    }
    summary[XLSX.utils.encode_cell({ r: rowIndex, c: 2 })] = {
      t: "n",
      v: carryForward,
      f: `IFERROR(VLOOKUP($A${rowNumber},'OPENING BALANCES'!$A$2:$E$${openingEndRow},3,FALSE),0)`,
    }
    for (let categoryIndex = 0; categoryIndex < ATTENDANCE_LEGACY_CATEGORIES.length; categoryIndex += 1) {
      const summaryColumn = 3 + categoryIndex
      const dataColumn = excelColumn(categoryDataColumn(ATTENDANCE_LEGACY_CATEGORIES[categoryIndex]))
      summary[XLSX.utils.encode_cell({ r: rowIndex, c: summaryColumn })] = {
        t: "n",
        v: ytdCategories[ATTENDANCE_LEGACY_CATEGORIES[categoryIndex]],
        f: `SUMIFS('MONTHLY DATA'!$${dataColumn}$2:$${dataColumn}$${dataEndRow},'MONTHLY DATA'!$B$2:$B$${dataEndRow},$A${rowNumber},'MONTHLY DATA'!$A$2:$A$${dataEndRow},">="&DATE(YEAR($B$2),1,1),'MONTHLY DATA'!$A$2:$A$${dataEndRow},"<="&$B$2)`,
      }
    }
    const leaveBalance =
      allowance +
      carryForward +
      ytdCategories.HOL -
      ytdCategories.ALS -
      ytdCategories.ALU -
      ytdCategories.SLX
    summary[XLSX.utils.encode_cell({ r: rowIndex, c: 14 })] = {
      t: "n",
      v: leaveBalance,
      f: `B${rowNumber}+C${rowNumber}+I${rowNumber}-D${rowNumber}-E${rowNumber}-H${rowNumber}`,
    }
    const currentMonthCount = `COUNTIFS('MONTHLY DATA'!$B$2:$B$${dataEndRow},$A${rowNumber},'MONTHLY DATA'!$A$2:$A$${dataEndRow},">="&EOMONTH($B$2,-1)+1,'MONTHLY DATA'!$A$2:$A$${dataEndRow},"<="&$B$2)`
    const currentMonthConfirmed = `COUNTIFS('MONTHLY DATA'!$B$2:$B$${dataEndRow},$A${rowNumber},'MONTHLY DATA'!$A$2:$A$${dataEndRow},">="&EOMONTH($B$2,-1)+1,'MONTHLY DATA'!$A$2:$A$${dataEndRow},"<="&$B$2,'MONTHLY DATA'!$N$2:$N$${dataEndRow},"CONFIRMED")`
    const currentMonthRows = staffRows.filter(
      (row) => row.statementDate.slice(0, 7) === periodEndText.slice(0, 7),
    )
    const confirmation = currentMonthRows.length === 0
      ? "NO RECORD"
      : currentMonthRows.every((row) => row.confirmation === "confirmed")
        ? "CONFIRMED"
        : "PENDING"
    summary[XLSX.utils.encode_cell({ r: rowIndex, c: 15 })] = {
      t: "s",
      v: confirmation,
      f: `IF(${currentMonthCount}=0,"NO RECORD",IF(${currentMonthConfirmed}=${currentMonthCount},"CONFIRMED","PENDING"))`,
    }
    cachedSummaryValues.push([
      allowance,
      carryForward,
      ...ATTENDANCE_LEGACY_CATEGORIES.map((category) => ytdCategories[category]),
      leaveBalance,
    ])
  }
  if (staffCodes.length > 0) {
    for (let column = 1; column <= 14; column += 1) {
      const letter = excelColumn(column)
      summary[XLSX.utils.encode_cell({ r: totalRow - 1, c: column })] = {
        t: "n",
        v: cachedSummaryValues.reduce((total, row) => total + row[column - 1], 0),
        f: `SUM(${letter}${firstSummaryRow}:${letter}${lastSummaryRow})`,
      }
    }
  }

  summary["!merges"] = [XLSX.utils.decode_range("A1:P1")]
  summary["!autofilter"] = { ref: `A5:P${Math.max(5, lastSummaryRow)}` }
  summary["!cols"] = [
    { wch: 14 }, { wch: 25 }, { wch: 22 },
    { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
    { wch: 14 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 14 },
    { wch: 16 }, { wch: 16 }, { wch: 16 },
  ]
  summary["!rows"] = [{ hpt: 26 }, { hpt: 20 }, { hpt: 20 }, { hpt: 8 }, { hpt: 42 }]
  summary["!freeze"] = { xSplit: 1, ySplit: 5 }
  if (summary.B2) summary.B2.z = "yyyy-mm-dd"
  if (summary.B3) summary.B3.z = "yyyy-mm-dd hh:mm"
  setStyle(summary.A1, {
    fill: { patternType: "solid", fgColor: { rgb: HEADER_FILL } },
    font: { name: "Roboto", bold: true, sz: 16, color: { rgb: "FFFFFF" } },
    alignment: { horizontal: "left", vertical: "center" },
  })
  styleHeaderRow(summary, 4, SUMMARY_HEADERS.length)
  if (staffCodes.length > 0) {
    styleDataRange(summary, 5, lastSummaryRow - 1, 0, 15, DERIVED_FILL)
    styleDataRange(summary, totalRow - 1, totalRow - 1, 0, 15, HEADER_FILL)
  }

  data["!autofilter"] = { ref: `A1:O${Math.max(1, monthlyRows.length + 1)}` }
  data["!cols"] = [
    { wch: 17 }, { wch: 13 },
    ...Array.from({ length: 11 }, () => ({ wch: 10 })),
    { wch: 16 }, { wch: 45 },
  ]
  data["!freeze"] = { xSplit: 2, ySplit: 1 }
  styleHeaderRow(data, 0, DATA_HEADERS.length)
  if (monthlyRows.length > 0) {
    styleDataRange(data, 1, monthlyRows.length, 0, DATA_HEADERS.length - 1, INPUT_FILL)
    for (let row = 2; row <= monthlyRows.length + 1; row += 1) {
      const cell = data[`A${row}`]
      if (cell) cell.z = "yyyy-mm-dd"
    }
  }

  openings["!autofilter"] = { ref: `A1:E${Math.max(1, staffCodes.length + 1)}` }
  openings["!cols"] = [
    { wch: 13 }, { wch: 26 }, { wch: 22 }, { wch: 18 }, { wch: 45 },
  ]
  openings["!freeze"] = { xSplit: 1, ySplit: 1 }
  styleHeaderRow(openings, 0, 5)
  if (staffCodes.length > 0) {
    styleDataRange(openings, 1, staffCodes.length, 0, 4, INPUT_FILL)
  }

  reference["!cols"] = [{ wch: 20 }, { wch: 85 }]
  reference["!freeze"] = { ySplit: 1 }
  styleHeaderRow(reference, 0, 2)
  styleDataRange(reference, 1, ATTENDANCE_LEGACY_CATEGORIES.length, 0, 1)

  XLSX.utils.book_append_sheet(workbook, summary, "MONTHLY SUMMARY")
  XLSX.utils.book_append_sheet(workbook, data, "MONTHLY DATA")
  XLSX.utils.book_append_sheet(workbook, openings, "OPENING BALANCES")
  XLSX.utils.book_append_sheet(workbook, reference, "REFERENCE")
  workbook.Workbook = {
    ...workbook.Workbook,
    CalcPr: { calcMode: "auto", fullCalcOnLoad: "1", forceFullCalc: "1" },
  } as XLSX.WBProps

  return XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
    cellDates: true,
    cellStyles: true,
    compression: true,
  }) as Buffer
}
