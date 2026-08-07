import * as XLSX from "xlsx"
import {
  ATTENDANCE_LEGACY_CATEGORIES,
  attendanceLegacySourceKey,
  emptyAttendanceCategoryTotals,
  type AttendanceLegacyCategoryCode,
  type LegacyAttendanceDailyRecord,
  type LegacyAttendanceImportIssue,
  type LegacyAttendanceImportResult,
  type LegacyAttendanceMonthlyAggregate,
  type LegacyAttendanceStaffOpening,
} from "./attendanceWorkbook"

type WorkbookBytes = Buffer | Uint8Array | ArrayBuffer
type Cell = XLSX.CellObject | undefined

type HeaderColumns = {
  staff: number | null
  date: number | null
  allowance: number | null
  carryForward: number | null
  legacyBalance: number | null
  confirmation: number | null
  saturday: number[]
  categories: Map<AttendanceLegacyCategoryCode, number>
}

type ParseContext = {
  issues: LegacyAttendanceImportIssue[]
  ignoredSaturdayValueCount: number
  halfDayValueCount: number
  duplicateCount: number
}

const HALF_DAY_EPSILON = 1e-8

function normalizeText(value: unknown) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function cellAt(sheet: XLSX.WorkSheet, row: number, column: number): Cell {
  return sheet[XLSX.utils.encode_cell({ r: row, c: column })] as Cell
}

function cellText(cell: Cell) {
  if (!cell) return ""
  if (typeof cell.w === "string" && cell.w.trim()) return cell.w.trim()
  if (cell.v === null || cell.v === undefined) return ""
  return String(cell.v).trim()
}

function usedRange(sheet: XLSX.WorkSheet) {
  return XLSX.utils.decode_range(sheet["!ref"] || "A1:A1")
}

function rowTexts(sheet: XLSX.WorkSheet, row: number, endColumn: number) {
  return Array.from(
    { length: endColumn + 1 },
    (_, column) => normalizeText(cellText(cellAt(sheet, row, column))),
  )
}

function parseNumber(cell: Cell) {
  if (!cell || cell.v === null || cell.v === undefined || cell.v === "") {
    return null
  }
  if (typeof cell.v === "number" && Number.isFinite(cell.v)) return cell.v
  const text = cellText(cell).replace(/,/g, "").trim()
  if (!text || text === "-" || text === "–" || text === "—") return 0
  const match = /^(-?\d+(?:\.\d+)?)(?:\s*DAY(?:S)?)?$/i.exec(text)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

function recordHalfDay(value: number, context: ParseContext) {
  if (
    Math.abs(value - Math.round(value)) > HALF_DAY_EPSILON &&
    Math.abs(value * 2 - Math.round(value * 2)) <= HALF_DAY_EPSILON
  ) {
    context.halfDayValueCount += 1
  }
}

function readAmount(
  cell: Cell,
  context: ParseContext,
  location: { sheet: string; row: number; field: string },
) {
  const value = parseNumber(cell)
  if (value === null) {
    if (cellText(cell)) {
      context.issues.push({
        severity: "warning",
        code: "invalid_numeric_value",
        message: `Could not read ${location.field} as a number.`,
        sheet: location.sheet,
        row: location.row,
        field: location.field,
      })
    }
    return 0
  }
  recordHalfDay(value, context)
  if (Math.abs(value * 2 - Math.round(value * 2)) > HALF_DAY_EPSILON) {
    context.issues.push({
      severity: "warning",
      code: "non_half_day_increment",
      message: `${location.field} contains ${value}, which is not a whole or half day. It was preserved exactly.`,
      sheet: location.sheet,
      row: location.row,
      field: location.field,
    })
  }
  return value
}

function pad(value: number) {
  return String(value).padStart(2, "0")
}

function validDateParts(year: number, month: number, day: number) {
  const value = new Date(Date.UTC(year, month - 1, day))
  return (
    value.getUTCFullYear() === year &&
    value.getUTCMonth() === month - 1 &&
    value.getUTCDate() === day
  )
}

function formatDateParts(year: number, month: number, day: number) {
  return `${year}-${pad(month)}-${pad(day)}`
}

function parseExcelDate(cell: Cell) {
  if (!cell) return null
  if (typeof cell.v === "number" && Number.isFinite(cell.v)) {
    const decoded = XLSX.SSF.parse_date_code(cell.v)
    if (decoded && validDateParts(decoded.y, decoded.m, decoded.d)) {
      return formatDateParts(decoded.y, decoded.m, decoded.d)
    }
  }
  if (cell.v instanceof Date && Number.isFinite(cell.v.getTime())) {
    return formatDateParts(
      cell.v.getUTCFullYear(),
      cell.v.getUTCMonth() + 1,
      cell.v.getUTCDate(),
    )
  }

  const text = cellText(cell)
  let match = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(text)
  if (match) {
    const [, year, month, day] = match.map(Number)
    return validDateParts(year, month, day)
      ? formatDateParts(year, month, day)
      : null
  }
  match = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/.exec(text)
  if (!match) return null
  const first = Number(match[1])
  const second = Number(match[2])
  const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3])
  const numberFormat = normalizeText(cell.z)
  const monthFirst = numberFormat.startsWith("M") || second > 12
  const month = monthFirst ? first : second
  const day = monthFirst ? second : first
  return validDateParts(year, month, day)
    ? formatDateParts(year, month, day)
    : null
}

function categoryFromHeader(header: string): AttendanceLegacyCategoryCode | "SAT" | null {
  const text = normalizeText(header)
  if (!text) return null
  if (/\bSAT(?:URDAY)?\b/.test(text)) return "SAT"
  if (/\bALS\b/.test(text)) return "ALS"
  if (/\bALU\b/.test(text)) return "ALU"
  if (/\bSLM\b/.test(text)) return "SLM"
  if (/\bSLR\b/.test(text)) return "SLR"
  if (/\bSLX\b/.test(text)) return "SLX"
  if (/\bHOL(?:IDAY)?\b/.test(text)) return "HOL"
  if (/\bSPL\b/.test(text) || /SPECIAL|SPECAL/.test(text)) return "SPL"
  if (/\bMTL\b/.test(text) || /MATERNITY/.test(text)) return "MTL"
  if (/\bNPL\b/.test(text) || /NO PAY/.test(text)) return "NPL"
  if (/\b(?:HM|HO)\b/.test(text) || /HOME OFFICE/.test(text)) return "HO"
  if (/\bOS\b/.test(text) || /BUSINESS TRIP/.test(text)) return "OS"
  return null
}

function categoryFromValue(value: string) {
  const text = normalizeText(value)
  if (!text) return { category: null, ambiguous: false }
  if (text === "BT") return { category: null, ambiguous: true }
  return { category: categoryFromHeader(text), ambiguous: false }
}

function findHeaderRows(sheet: XLSX.WorkSheet) {
  const range = usedRange(sheet)
  let summary: number | null = null
  let monthly: number | null = null
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    const values = rowTexts(sheet, row, range.e.c)
    const joined = values.join(" | ")
    if (
      summary === null &&
      values.includes("STAFF") &&
      joined.includes("CURRENT YEAR ALLOWANCE")
    ) {
      summary = row
    }
    if (
      monthly === null &&
      values.includes("DATE") &&
      values.includes("STAFF") &&
      joined.includes("ALS")
    ) {
      monthly = row
    }
  }
  return { summary, monthly }
}

function mapHeaders(
  sheet: XLSX.WorkSheet,
  sheetName: string,
  headerRow: number,
  context: ParseContext,
): HeaderColumns {
  const range = usedRange(sheet)
  const columns: HeaderColumns = {
    staff: null,
    date: null,
    allowance: null,
    carryForward: null,
    legacyBalance: null,
    confirmation: null,
    saturday: [],
    categories: new Map(),
  }
  for (let column = range.s.c; column <= range.e.c; column += 1) {
    const raw = cellText(cellAt(sheet, headerRow, column))
    const text = normalizeText(raw)
    if (!text) continue
    if (text === "STAFF") columns.staff = column
    if (text === "DATE") columns.date = column
    if (text.includes("CURRENT YEAR ALLOWANCE")) columns.allowance = column
    if (text.includes("LAST YEAR") && /BAL|B F/.test(text)) columns.carryForward = column
    if (text.includes("LEAVE BALANCE")) columns.legacyBalance = column
    if (/CONFIRM|COMFIRM/.test(text)) columns.confirmation = column

    const category = categoryFromHeader(text)
    if (category === "SAT") {
      columns.saturday.push(column)
    } else if (category) {
      if (columns.categories.has(category)) {
        context.issues.push({
          severity: "warning",
          code: "duplicate_category_column",
          message: `Multiple columns map to ${category}; only the first column is imported.`,
          sheet: sheetName,
          row: headerRow + 1,
          field: category,
        })
        context.duplicateCount += 1
      } else {
        columns.categories.set(category, column)
      }
    }
  }
  return columns
}

function readCategoryTotals(
  sheet: XLSX.WorkSheet,
  sheetName: string,
  row: number,
  columns: HeaderColumns,
  context: ParseContext,
) {
  const totals = emptyAttendanceCategoryTotals()
  for (const category of ATTENDANCE_LEGACY_CATEGORIES) {
    const column = columns.categories.get(category)
    if (column === undefined) continue
    totals[category] = readAmount(cellAt(sheet, row, column), context, {
      sheet: sheetName,
      row: row + 1,
      field: category,
    })
  }
  for (const column of columns.saturday) {
    const value = parseNumber(cellAt(sheet, row, column))
    if (value !== null && Math.abs(value) > HALF_DAY_EPSILON) {
      context.ignoredSaturdayValueCount += 1
    }
  }
  return totals
}

function inferAnnualYear(
  sheet: XLSX.WorkSheet,
  summaryRow: number,
  monthlyRow: number,
) {
  const range = usedRange(sheet)
  for (let column = range.s.c; column <= range.e.c; column += 1) {
    const text = normalizeText(cellText(cellAt(sheet, summaryRow, column)))
    const match = /LAST YEAR.*\b(20\d{2})\b/.exec(text)
    if (match) return Number(match[1]) + 1
  }
  const counts = new Map<number, number>()
  for (let row = monthlyRow + 1; row <= range.e.r; row += 1) {
    for (let column = range.s.c; column <= Math.min(range.e.c, 3); column += 1) {
      const date = parseExcelDate(cellAt(sheet, row, column))
      if (!date) continue
      const year = Number(date.slice(0, 4))
      counts.set(year, (counts.get(year) || 0) + 1)
      break
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

function inspectReferenceSheet(
  workbook: XLSX.WorkBook,
  context: ParseContext,
) {
  const sheetName = workbook.SheetNames.find(
    (name) => normalizeText(name) === "REFERENCE",
  )
  if (!sheetName) return
  const sheet = workbook.Sheets[sheetName]
  const range = usedRange(sheet)
  const seen = new Map<string, string>()
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    const code = normalizeText(cellText(cellAt(sheet, row, 0)))
    const description = cellText(cellAt(sheet, row, 1))
    if (!code || !description) continue
    const normalized = categoryFromHeader(code)
    if (!normalized || normalized === "SAT") continue
    const previous = seen.get(normalized)
    if (previous && normalizeText(previous) !== normalizeText(description)) {
      context.issues.push({
        severity: "warning",
        code: "duplicate_reference_code",
        message: `${normalized} has more than one legacy definition and requires policy review.`,
        sheet: sheetName,
        row: row + 1,
        field: normalized,
      })
      context.duplicateCount += 1
    } else if (!previous) {
      seen.set(normalized, description)
    }
  }
}

function parseAnnualWorkbook(
  workbook: XLSX.WorkBook,
  sheetName: string,
  summaryRow: number,
  monthlyRow: number,
  context: ParseContext,
) {
  const sheet = workbook.Sheets[sheetName]
  const range = usedRange(sheet)
  const year = inferAnnualYear(sheet, summaryRow, monthlyRow)
  const summaryColumns = mapHeaders(sheet, sheetName, summaryRow, context)
  const monthlyColumns = mapHeaders(sheet, sheetName, monthlyRow, context)
  const staffOpenings: LegacyAttendanceStaffOpening[] = []
  const monthlyAggregates: LegacyAttendanceMonthlyAggregate[] = []

  if (year === null) {
    context.issues.push({
      severity: "error",
      code: "missing_attendance_year",
      message: "The attendance year could not be inferred from the workbook.",
      sheet: sheetName,
    })
  }

  if (summaryColumns.staff === null) {
    context.issues.push({
      severity: "error",
      code: "missing_staff_header",
      message: "The annual summary does not contain a STAFF column.",
      sheet: sheetName,
      row: summaryRow + 1,
    })
  } else if (year !== null) {
    const seen = new Set<string>()
    for (let row = summaryRow + 1; row < monthlyRow; row += 1) {
      const staffCode = cellText(cellAt(sheet, row, summaryColumns.staff)).trim()
      if (!staffCode || normalizeText(staffCode) === "TOTAL") continue
      const normalizedStaff = normalizeText(staffCode)
      if (!normalizedStaff) continue
      if (seen.has(normalizedStaff)) {
        context.issues.push({
          severity: "error",
          code: "duplicate_staff_opening",
          message: `The annual opening contains duplicate staff code ${staffCode}.`,
          sheet: sheetName,
          row: row + 1,
          field: "staffCode",
        })
        context.duplicateCount += 1
        continue
      }
      seen.add(normalizedStaff)
      const allowance = summaryColumns.allowance === null
        ? 0
        : readAmount(cellAt(sheet, row, summaryColumns.allowance), context, {
          sheet: sheetName,
          row: row + 1,
          field: "currentYearAllowance",
        })
      const carryForward = summaryColumns.carryForward === null
        ? 0
        : readAmount(cellAt(sheet, row, summaryColumns.carryForward), context, {
          sheet: sheetName,
          row: row + 1,
          field: "carryForward",
        })
      const parsedLegacyBalance = summaryColumns.legacyBalance === null
        ? null
        : parseNumber(cellAt(sheet, row, summaryColumns.legacyBalance))
      staffOpenings.push({
        sourceKey: attendanceLegacySourceKey("opening", year, staffCode),
        year,
        staffCode,
        currentYearAllowance: allowance,
        carryForward,
        legacyBalance: parsedLegacyBalance,
        categories: readCategoryTotals(
          sheet,
          sheetName,
          row,
          summaryColumns,
          context,
        ),
        sourceSheet: sheetName,
        sourceRow: row + 1,
      })
    }
  }

  if (monthlyColumns.staff === null || monthlyColumns.date === null) {
    context.issues.push({
      severity: "error",
      code: "missing_monthly_headers",
      message: "The monthly statement area requires DATE and STAFF columns.",
      sheet: sheetName,
      row: monthlyRow + 1,
    })
  } else {
    const seen = new Set<string>()
    for (let row = monthlyRow + 1; row <= range.e.r; row += 1) {
      const staffCode = cellText(cellAt(sheet, row, monthlyColumns.staff)).trim()
      const rawDate = cellText(cellAt(sheet, row, monthlyColumns.date))
      if (!staffCode && !rawDate) continue
      if (!staffCode || normalizeText(staffCode) === "TOTAL") continue
      const statementDate = parseExcelDate(cellAt(sheet, row, monthlyColumns.date))
      if (!statementDate) {
        context.issues.push({
          severity: "error",
          code: "invalid_statement_date",
          message: `A monthly aggregate for ${staffCode} has no valid statement date.`,
          sheet: sheetName,
          row: row + 1,
          field: "statementDate",
        })
        continue
      }
      const sourceKey = attendanceLegacySourceKey("monthly", statementDate, staffCode)
      if (seen.has(sourceKey)) {
        context.issues.push({
          severity: "error",
          code: "duplicate_monthly_aggregate",
          message: `More than one monthly aggregate exists for ${staffCode} on ${statementDate}.`,
          sheet: sheetName,
          row: row + 1,
          field: "sourceKey",
        })
        context.duplicateCount += 1
      }
      seen.add(sourceKey)
      const confirmationRaw = monthlyColumns.confirmation === null
        ? null
        : cellText(cellAt(sheet, row, monthlyColumns.confirmation)) || null
      monthlyAggregates.push({
        sourceKey,
        statementDate,
        staffCode,
        categories: readCategoryTotals(
          sheet,
          sheetName,
          row,
          monthlyColumns,
          context,
        ),
        confirmation: normalizeText(confirmationRaw).startsWith("CONFIRM")
          ? "confirmed"
          : "unconfirmed",
        confirmationRaw,
        sourceSheet: sheetName,
        sourceRow: row + 1,
      })
    }
  }

  inspectReferenceSheet(workbook, context)
  return { year, staffOpenings, monthlyAggregates }
}

function exactTime(value: string) {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
  if (!match) return false
  const hour = Number(match[1])
  const minute = Number(match[2])
  const second = Number(match[3] || 0)
  return hour <= 23 && minute <= 59 && second <= 59
}

function normalizedDailyCell(
  cell: Cell,
  context: ParseContext,
  location: { sheet: string; row: number; field: string },
) {
  const raw = cellText(cell)
  if (!raw) return { value: null, category: null, exactTime: false }
  const parsed = categoryFromValue(raw)
  if (parsed.ambiguous) {
    context.issues.push({
      severity: "warning",
      code: "ambiguous_bt_value",
      message: "BT is ambiguous between a staff group and a business-trip marker; it was not converted to OS.",
      sheet: location.sheet,
      row: location.row,
      field: location.field,
    })
  }
  if (parsed.category === "SAT") {
    context.ignoredSaturdayValueCount += 1
    return { value: null, category: null, exactTime: false }
  }
  const value = parsed.category || raw
  return {
    value,
    category: parsed.category,
    exactTime: exactTime(value),
  }
}

function parseDailyWorkbook(
  workbook: XLSX.WorkBook,
  sheetName: string,
  context: ParseContext,
) {
  const sheet = workbook.Sheets[sheetName]
  const range = usedRange(sheet)
  let staffRow: number | null = null
  let directionRow: number | null = null
  let dateColumn: number | null = null
  for (let row = range.s.r; row <= Math.min(range.e.r, range.s.r + 20); row += 1) {
    const texts = rowTexts(sheet, row, range.e.c)
    const candidateDateColumn = texts.indexOf("DATE")
    if (candidateDateColumn >= 0) {
      staffRow = row
      dateColumn = candidateDateColumn
      const next = rowTexts(sheet, row + 1, range.e.c)
      if (next.includes("IN") && next.includes("OUT")) directionRow = row + 1
      break
    }
  }
  if (staffRow === null || directionRow === null || dateColumn === null) {
    context.issues.push({
      severity: "error",
      code: "missing_daily_headers",
      message: "The daily workbook requires DATE and paired IN/OUT headers.",
      sheet: sheetName,
    })
    return { year: null, dailyRecords: [] as LegacyAttendanceDailyRecord[] }
  }

  const staffColumns: Array<{ staffCode: string; signIn: number; signOut: number }> = []
  const seenStaff = new Set<string>()
  for (let column = dateColumn + 1; column <= range.e.c; column += 1) {
    if (normalizeText(cellText(cellAt(sheet, directionRow, column))) !== "IN") continue
    if (normalizeText(cellText(cellAt(sheet, directionRow, column + 1))) !== "OUT") continue
    const staffCode = cellText(cellAt(sheet, staffRow, column)).trim()
    if (!staffCode || /^0(?:\.0+)?$/.test(staffCode)) continue
    const normalizedStaff = normalizeText(staffCode)
    if (seenStaff.has(normalizedStaff)) {
      context.issues.push({
        severity: "error",
        code: "duplicate_daily_staff",
        message: `The daily sheet contains duplicate staff code ${staffCode}.`,
        sheet: sheetName,
        row: staffRow + 1,
        field: "staffCode",
      })
      context.duplicateCount += 1
      continue
    }
    seenStaff.add(normalizedStaff)
    staffColumns.push({ staffCode, signIn: column, signOut: column + 1 })
  }

  const dailyRecords: LegacyAttendanceDailyRecord[] = []
  const seenKeys = new Set<string>()
  let year: number | null = null
  for (let row = directionRow + 1; row <= range.e.r; row += 1) {
    const firstText = normalizeText(cellText(cellAt(sheet, row, range.s.c)))
    if (firstText.includes("MONTH SUMMARY")) break
    const dateCell = cellAt(sheet, row, dateColumn)
    const workDate = parseExcelDate(dateCell)
    if (!workDate) continue
    const parsedDate = new Date(`${workDate}T00:00:00.000Z`)
    if (parsedDate.getUTCDay() === 6 || /\bSAT(?:URDAY)?\b/.test(firstText)) {
      for (const staff of staffColumns) {
        if (cellText(cellAt(sheet, row, staff.signIn))) {
          context.ignoredSaturdayValueCount += 1
        }
        if (cellText(cellAt(sheet, row, staff.signOut))) {
          context.ignoredSaturdayValueCount += 1
        }
      }
      continue
    }
    year ??= Number(workDate.slice(0, 4))

    for (const staff of staffColumns) {
      const signIn = normalizedDailyCell(cellAt(sheet, row, staff.signIn), context, {
        sheet: sheetName,
        row: row + 1,
        field: "signIn",
      })
      const signOut = normalizedDailyCell(cellAt(sheet, row, staff.signOut), context, {
        sheet: sheetName,
        row: row + 1,
        field: "signOut",
      })
      if (!signIn.value && !signOut.value) continue
      const categories = emptyAttendanceCategoryTotals()
      if (signIn.category) categories[signIn.category] += 0.5
      if (signOut.category) categories[signOut.category] += 0.5
      context.halfDayValueCount += Number(Boolean(signIn.category)) + Number(Boolean(signOut.category))
      const sourceKey = attendanceLegacySourceKey("daily", workDate, staff.staffCode)
      if (seenKeys.has(sourceKey)) {
        context.issues.push({
          severity: "error",
          code: "duplicate_daily_record",
          message: `More than one daily record exists for ${staff.staffCode} on ${workDate}.`,
          sheet: sheetName,
          row: row + 1,
          field: "sourceKey",
        })
        context.duplicateCount += 1
      }
      seenKeys.add(sourceKey)
      dailyRecords.push({
        sourceKey,
        workDate,
        staffCode: staff.staffCode,
        signIn: signIn.value,
        signOut: signOut.value,
        hasExactSignIn: signIn.exactTime,
        hasExactSignOut: signOut.exactTime,
        categories,
        sourceSheet: sheetName,
        sourceRow: row + 1,
      })
    }
  }
  return { year, dailyRecords }
}

function annualSheet(workbook: XLSX.WorkBook) {
  for (const sheetName of workbook.SheetNames) {
    const headers = findHeaderRows(workbook.Sheets[sheetName])
    if (headers.summary !== null && headers.monthly !== null) {
      return { sheetName, summaryRow: headers.summary, monthlyRow: headers.monthly }
    }
  }
  return null
}

function dailySheet(workbook: XLSX.WorkBook) {
  return workbook.SheetNames.find((sheetName) => {
    const sheet = workbook.Sheets[sheetName]
    const range = usedRange(sheet)
    for (let row = range.s.r; row <= Math.min(range.e.r, range.s.r + 10); row += 1) {
      for (let column = range.s.c; column <= Math.min(range.e.c, range.s.c + 12); column += 1) {
        if (normalizeText(cellText(cellAt(sheet, row, column))).includes("DAILY SIGN IN AND SIGN OUT RECORD")) {
          return true
        }
      }
    }
    return false
  }) || null
}

export function parseLegacyAttendanceWorkbook(
  input: WorkbookBytes,
  options: { fileName?: string } = {},
): LegacyAttendanceImportResult {
  const workbook = XLSX.read(input, {
    type: input instanceof ArrayBuffer ? "array" : "buffer",
    cellDates: false,
    cellFormula: true,
    cellNF: true,
  })
  const context: ParseContext = {
    issues: [],
    ignoredSaturdayValueCount: 0,
    halfDayValueCount: 0,
    duplicateCount: 0,
  }
  let workbookType: LegacyAttendanceImportResult["workbookType"] = "unknown"
  let year: number | null = null
  let staffOpenings: LegacyAttendanceStaffOpening[] = []
  let monthlyAggregates: LegacyAttendanceMonthlyAggregate[] = []
  let dailyRecords: LegacyAttendanceDailyRecord[] = []

  const annual = annualSheet(workbook)
  if (annual) {
    workbookType = "annual"
    const parsed = parseAnnualWorkbook(
      workbook,
      annual.sheetName,
      annual.summaryRow,
      annual.monthlyRow,
      context,
    )
    year = parsed.year
    staffOpenings = parsed.staffOpenings
    monthlyAggregates = parsed.monthlyAggregates
  } else {
    const daily = dailySheet(workbook)
    if (daily) {
      workbookType = "daily"
      const parsed = parseDailyWorkbook(workbook, daily, context)
      year = parsed.year
      dailyRecords = parsed.dailyRecords
    } else {
      context.issues.push({
        severity: "error",
        code: "unsupported_attendance_workbook",
        message: "The workbook does not match the supported annual or daily legacy attendance layouts.",
      })
    }
  }

  return {
    workbookType,
    source: {
      fileName: options.fileName?.trim() || null,
      sheetNames: [...workbook.SheetNames],
      year,
    },
    staffOpenings,
    monthlyAggregates,
    dailyRecords,
    issues: context.issues,
    dryRun: {
      staffOpeningCount: staffOpenings.length,
      monthlyAggregateCount: monthlyAggregates.length,
      dailyRecordCount: dailyRecords.length,
      ignoredSaturdayValueCount: context.ignoredSaturdayValueCount,
      halfDayValueCount: context.halfDayValueCount,
      duplicateCount: context.duplicateCount,
      warningCount: context.issues.filter((issue) => issue.severity === "warning").length,
      errorCount: context.issues.filter((issue) => issue.severity === "error").length,
    },
  }
}
