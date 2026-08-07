export const ATTENDANCE_LEGACY_CATEGORIES = [
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
] as const

export type AttendanceLegacyCategoryCode =
  (typeof ATTENDANCE_LEGACY_CATEGORIES)[number]

export type AttendanceCategoryTotals = Record<
  AttendanceLegacyCategoryCode,
  number
>

export type LegacyAttendanceImportIssue = {
  severity: "error" | "warning" | "info"
  code: string
  message: string
  sheet?: string
  row?: number
  field?: string
}

export type LegacyAttendanceStaffOpening = {
  sourceKey: string
  year: number
  staffCode: string
  currentYearAllowance: number
  carryForward: number
  legacyBalance: number | null
  categories: AttendanceCategoryTotals
  sourceSheet: string
  sourceRow: number
}

export type LegacyAttendanceMonthlyAggregate = {
  sourceKey: string
  statementDate: string
  staffCode: string
  categories: AttendanceCategoryTotals
  confirmation: "confirmed" | "unconfirmed"
  confirmationRaw: string | null
  sourceSheet: string
  sourceRow: number
}

export type LegacyAttendanceDailyRecord = {
  sourceKey: string
  workDate: string
  staffCode: string
  signIn: string | null
  signOut: string | null
  hasExactSignIn: boolean
  hasExactSignOut: boolean
  categories: AttendanceCategoryTotals
  sourceSheet: string
  sourceRow: number
}

export type LegacyAttendanceImportResult = {
  workbookType: "annual" | "daily" | "unknown"
  source: {
    fileName: string | null
    sheetNames: string[]
    year: number | null
  }
  staffOpenings: LegacyAttendanceStaffOpening[]
  monthlyAggregates: LegacyAttendanceMonthlyAggregate[]
  dailyRecords: LegacyAttendanceDailyRecord[]
  issues: LegacyAttendanceImportIssue[]
  dryRun: {
    staffOpeningCount: number
    monthlyAggregateCount: number
    dailyRecordCount: number
    ignoredSaturdayValueCount: number
    halfDayValueCount: number
    duplicateCount: number
    warningCount: number
    errorCount: number
  }
}

export type AttendanceMonthlyWorkbookInput = {
  periodEnd: string
  staffOpenings: LegacyAttendanceStaffOpening[]
  monthlyAggregates: LegacyAttendanceMonthlyAggregate[]
  generatedAt?: string | Date
}

export const ATTENDANCE_CATEGORY_LABELS: Record<
  AttendanceLegacyCategoryCode,
  string
> = {
  ALS: "Annual leave - advance notice",
  ALU: "Annual leave - informed on leave day",
  SLM: "Sick leave - medical certificate",
  SLR: "Sick leave - without medical certificate",
  SLX: "Sick leave exception (legacy SLX)",
  HOL: "Holiday attendance",
  SPL: "Special leave",
  MTL: "Maternity leave",
  NPL: "No-pay leave",
  HO: "Home office",
  OS: "Business trip",
}

export function emptyAttendanceCategoryTotals(): AttendanceCategoryTotals {
  return {
    ALS: 0,
    ALU: 0,
    SLM: 0,
    SLR: 0,
    SLX: 0,
    HOL: 0,
    SPL: 0,
    MTL: 0,
    NPL: 0,
    HO: 0,
    OS: 0,
  }
}

export function attendanceLegacySourceKey(
  kind: "opening" | "monthly" | "daily",
  period: string | number,
  staffCode: string,
) {
  return `legacy-${kind}:${period}:${encodeURIComponent(staffCode.trim().toUpperCase())}`
}
