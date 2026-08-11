"use client"

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import { hktTimeFromTimestamp } from "@/lib/attendanceRules"
import { normalizeEmailList } from "@/lib/emailAddress"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import styles from "./attendanceRecord.module.css"
import type {
  ApiAllTimeSummary,
  ApiAttendanceAnnualSummary,
  ApiAttendanceCalendarDay,
  ApiAttendanceConfirmation,
  ApiAttendanceDailyItem,
  ApiAttendanceEntitlement,
  ApiAttendanceHoliday,
  ApiAttendanceMonthlyAdjustment,
  ApiAttendanceMonthlySummary,
  ApiAttendancePerson,
  ApiMonthlyResponse,
  ApiSettingsResponse,
  AttendanceGroup,
  AttendanceLeaveCode,
  AttendanceMonthData,
  AttendanceWorkMode,
  ManagedAttendanceUser,
} from "./types"

type TabId = "monthly-record" | "monthly" | "all-time"
type MonthSection = {
  month: number
  label: string
  rows: Array<{
    person: ApiAttendancePerson
    summary: ApiAttendanceMonthlySummary | null
    attendedDays: number
    lateDays: number
  }>
}

type LeaveDraft = {
  personId: string
  staffLabel: string
  date: string
  leaveEnabled: boolean
  portion: "full" | "am" | "pm"
  code: AttendanceLeaveCode
  note: string
  workMode: "default" | "office" | "home-office" | "business-trip"
  defaultWorkMode: AttendanceWorkMode
  workModeOverrideId?: string
  entryId?: string
  holiday: boolean
}

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "monthly-record", label: "ATTENDANCE (CURRENT MONTH)" },
  { id: "monthly", label: "MONTHLY" },
  { id: "all-time", label: "ALL TIME" },
]

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const

const EXCLUDED_STAFF_CODES = new Set(["SY", "CD", "HC"])
const DEFAULT_EVENT_CALENDAR_STAFF_ORDER = [
  "VL",
  "SC",
  "OL",
  "DT",
  "KZ",
  "CY",
  "MY",
  "LC",
  "LL",
  "JZ",
] as const
const SUMMARY_CODES = ["ALS", "ALU", "SLM", "SLR", "SLX", "SPL", "MTL", "NPL", "HO", "OS"] as const
const LEAVE_CODES: Array<{ value: AttendanceLeaveCode; label: string }> = [
  { value: "ALS", label: "ALS · Annual leave with advance notice" },
  { value: "ALU", label: "ALU · Annual leave informed on leave day" },
  { value: "SLM", label: "SLM · Sick leave with medical certificate" },
  { value: "SLR", label: "SLR · Sick leave without medical certificate" },
  { value: "SLX", label: "SLX · Sick leave outside policy" },
  { value: "SPL", label: "SPL · Special leave" },
  { value: "MTL", label: "MTL · Maternity leave" },
  { value: "NPL", label: "NPL · No-pay leave" },
]

const EMPTY_MONTH: AttendanceMonthData = {
  year: 0,
  month: 0,
  periodClosed: false,
  people: [],
  summaries: [],
  calendarDays: [],
}

const EMPTY_SETTINGS: ApiSettingsResponse = {
  view: "settings",
  year: 0,
  people: [],
  schedules: [],
  syncRuns: [],
  availableUsers: [],
  allTimeSummaries: [],
  annualSummaries: [],
  entitlements: [],
  monthlyAdjustments: [],
  staffOrder: [],
  availableYears: [],
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function arrayValue<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function responseSource(value: unknown) {
  const envelope = isObject(value) ? value : {}
  return isObject(envelope.data) ? envelope.data : envelope
}

function objectArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  return isObject(value) ? (Object.values(value) as T[]) : []
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(
    value
      .map((item) => String(item || "").trim().toUpperCase())
      .filter(Boolean),
  ))
}

function yearArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(
    value
      .map(Number)
      .filter((year) => Number.isInteger(year) && year >= 2000 && year <= 2200),
  )).sort((left, right) => right - left)
}

function parseHoliday(value: unknown): ApiAttendanceHoliday | null {
  if (!isObject(value)) return null
  const title = String(value.title || value.name || "Hong Kong holiday").trim()
  return {
    eventId: typeof value.eventId === "string"
      ? value.eventId
      : typeof value.event_id === "string"
        ? value.event_id
        : null,
    title,
    name: typeof value.name === "string" ? value.name : null,
    attendeeStaffCodes: stringArray(
      value.attendeeStaffCodes ?? value.attendee_staff_codes ?? value.people,
    ),
    people: stringArray(value.people),
  }
}

function parseAnnualSummary(value: unknown): ApiAttendanceAnnualSummary | null {
  if (!isObject(value)) return null
  const personId = String(value.personId || value.person_id || "").trim()
  if (!personId) return null
  const codeTotalsSource = isObject(value.codeTotals)
    ? value.codeTotals
    : isObject(value.code_totals)
      ? value.code_totals
      : {}
  const codeTotals = Object.fromEntries(
    Object.entries(codeTotalsSource).map(([code, units]) => [code.toUpperCase(), Number(units) || 0]),
  )
  const leavePaidRaw = value.leavePaidUnits ?? value.leave_paid_units
  return {
    personId,
    allowanceUnits: Number(value.allowanceUnits ?? value.allowance_units) || 0,
    openingCarryForwardUnits:
      Number(value.openingCarryForwardUnits ?? value.opening_carry_forward_units) || 0,
    closingBalanceUnits:
      Number(value.closingBalanceUnits ?? value.closing_balance_units) || 0,
    codeTotals,
    confirmation: isObject(value.confirmation)
      ? (value.confirmation as ApiAttendanceConfirmation)
      : null,
    canConfirm: value.canConfirm === true,
    leavePaidUnits:
      leavePaidRaw === null || leavePaidRaw === undefined || leavePaidRaw === ""
        ? null
        : Number(leavePaidRaw),
  }
}

function parseEntitlement(value: unknown): ApiAttendanceEntitlement | null {
  if (!isObject(value)) return null
  const personId = String(value.personId || value.person_id || "").trim()
  const year = Number(value.year)
  if (!personId || !Number.isInteger(year)) return null
  return {
    personId,
    year,
    allowanceUnits: Number(value.allowanceUnits ?? value.allowance_units) || 0,
    openingCarryForwardUnits:
      Number(value.openingCarryForwardUnits ?? value.opening_carry_forward_units) || 0,
  }
}

function parseMonthlyAdjustment(value: unknown): ApiAttendanceMonthlyAdjustment | null {
  if (!isObject(value)) return null
  const personId = String(value.personId || value.person_id || "").trim()
  const year = Number(value.year)
  const month = Number(value.month)
  const code = String(value.code || "").trim().toUpperCase()
  if (!personId || !Number.isInteger(year) || !Number.isInteger(month) || !code) return null
  return { personId, year, month, code, units: Number(value.units) || 0 }
}

function itemDate(item: ApiAttendanceDailyItem) {
  return item.workDate || item.date || ""
}

function parseCalendarDays(source: Record<string, unknown>) {
  const days = new Map<string, ApiAttendanceCalendarDay>()
  for (const rawDay of arrayValue<unknown>(source.calendarDays)) {
    if (typeof rawDay === "string") {
      days.set(rawDay.slice(0, 10), { date: rawDay.slice(0, 10), records: [] })
      continue
    }
    if (!isObject(rawDay)) continue
    const rawDate = rawDay.date ?? rawDay.workDate ?? rawDay.work_date
    if (typeof rawDate !== "string" || !rawDate) continue
    const date = rawDate.slice(0, 10)
    const records = objectArray<ApiAttendanceDailyItem>(
      rawDay.records ?? rawDay.items ?? rawDay.peopleRecords,
    )
    days.set(date, {
      date,
      records,
      day: Number(rawDay.day) || undefined,
      weekday: typeof rawDay.weekday === "string" ? rawDay.weekday : undefined,
      isWeekend: rawDay.isWeekend === true || rawDay.is_weekend === true,
      isFuture: rawDay.isFuture === true || rawDay.is_future === true,
      holiday: parseHoliday(rawDay.holiday ?? rawDay.hongKongHoliday ?? rawDay.hkHoliday),
    })
  }

  const flatRecords = objectArray<ApiAttendanceDailyItem>(
    source.dailyRecords ?? source.records,
  )
  for (const record of flatRecords) {
    const date = itemDate(record).slice(0, 10)
    if (!date) continue
    const day = days.get(date) || { date, records: [] }
    day.records.push(record)
    days.set(date, day)
  }
  return [...days.values()].sort((left, right) => left.date.localeCompare(right.date))
}

function parseMonthlyResponse(value: unknown, fallbackYear: number, fallbackMonth: number): ApiMonthlyResponse {
  const source = responseSource(value)
  const summaries = arrayValue<ApiAttendanceMonthlySummary>(source.summaries)
  const records = summaries.flatMap((summary) => arrayValue<ApiAttendanceDailyItem>(summary.records))
  const calendarDays = parseCalendarDays({ ...source, dailyRecords: records })
  const people = arrayValue<ApiAttendancePerson>(source.people)
  const peopleById = new Map(people.map((person) => [person.id, person]))
  for (const summary of summaries) peopleById.set(summary.person.id, summary.person)
  for (const day of calendarDays) {
    for (const record of day.records) peopleById.set(record.person.id, record.person)
  }
  return {
    view: "monthly",
    year: Number(source.year) || fallbackYear,
    month: Number(source.month) || fallbackMonth,
    periodClosed: source.periodClosed === true,
    people: [...peopleById.values()],
    summaries,
    calendarDays,
    staffOrder: stringArray(source.staffOrder ?? source.staff_order ?? source.peopleOrder),
    availableYears: yearArray(source.availableYears ?? source.available_years),
  }
}

function parseYearResponse(value: unknown, fallbackYear: number) {
  const source = responseSource(value)
  const year = Number(source.year) || fallbackYear
  const staffOrder = stringArray(source.staffOrder ?? source.staff_order ?? source.peopleOrder)
  const availableYears = yearArray(source.availableYears ?? source.available_years)
  const months = Object.fromEntries(
    arrayValue<Record<string, unknown>>(source.months).flatMap((rawMonth) => {
      const month = Number(rawMonth.month)
      if (!Number.isInteger(month) || month < 1 || month > 12) return []
      const summaries = arrayValue<ApiAttendanceMonthlySummary>(rawMonth.summaries)
      const people = [...new Map(
        summaries.map((summary) => [summary.person.id, summary.person]),
      ).values()]
      return [[
        month,
        {
          year,
          month,
          periodClosed: rawMonth.periodClosed === true,
          people,
          summaries,
          calendarDays: [],
          staffOrder,
          availableYears,
        } satisfies AttendanceMonthData,
      ]]
    }),
  ) as Record<number, AttendanceMonthData>
  return { year, months, staffOrder, availableYears }
}

function parseSettingsResponse(value: unknown, year: number): ApiSettingsResponse {
  const source = responseSource(value)
  const annualSummaries = arrayValue<unknown>(source.annualSummaries ?? source.annual_summaries)
    .map(parseAnnualSummary)
    .filter((item): item is ApiAttendanceAnnualSummary => Boolean(item))
  const entitlements = arrayValue<unknown>(source.entitlements)
    .map(parseEntitlement)
    .filter((item): item is ApiAttendanceEntitlement => Boolean(item))
  const monthlyAdjustments = arrayValue<unknown>(source.monthlyAdjustments ?? source.monthly_adjustments)
    .map(parseMonthlyAdjustment)
    .filter((item): item is ApiAttendanceMonthlyAdjustment => Boolean(item))
  return {
    view: "settings",
    year: Number(source.year) || year,
    people: arrayValue<ApiAttendancePerson>(source.people),
    schedules: arrayValue(source.schedules),
    syncRuns: arrayValue(source.syncRuns),
    availableUsers: arrayValue<ManagedAttendanceUser>(
      source.availableUsers ?? source.eligibleUsers ?? source.managedUsers,
    ),
    allTimeSummaries: arrayValue<ApiAllTimeSummary>(
      source.allTimeSummaries ?? source.allTime,
    ),
    annualSummaries,
    entitlements,
    monthlyAdjustments,
    staffOrder: stringArray(source.staffOrder ?? source.staff_order ?? source.peopleOrder),
    availableYears: yearArray(source.availableYears ?? source.available_years),
  }
}

function getErrorMessage(value: unknown, fallback: string) {
  if (isObject(value) && typeof value.message === "string" && value.message.trim()) {
    return value.message
  }
  return fallback
}

async function fetchAttendance(params: Record<string, string>) {
  const query = new URLSearchParams(params)
  const response = await fetch(`/api/admin/attendance?${query.toString()}`, {
    cache: "no-store",
  })
  const payload: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(getErrorMessage(payload, "Attendance records could not be loaded."))
  }
  return payload
}

function hongKongDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${lookup.year}-${lookup.month}-${lookup.day}`
}

function hongKongDateTimeKey(date = new Date()) {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date)
  return `${hongKongDateKey(date)} ${time}`
}

function monthKey(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}`
}

function displayShortDate(value: string) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return value
  const weekday = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][date.getUTCDay()]
  return `${String(date.getUTCDate()).padStart(2, "0")}/${String(date.getUTCMonth() + 1).padStart(2, "0")} ${weekday}`
}

function displayDateTime(value: string | null) {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)
}

function displayTime(value: string | null) {
  if (!value) return ""
  return hktTimeFromTimestamp(value) || value.slice(0, 5)
}

function displayDays(value: number) {
  if (!Number.isFinite(value)) return "0"
  return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")
}

function displaySummaryDays(value: number) {
  return Math.abs(value) < 0.00001 ? "–" : displayDays(value)
}

function summaryNumberClass(value: number, emphasis?: "attended" | "late") {
  if (Math.abs(value) < 0.00001) return styles.summaryZero
  if (emphasis === "attended") return styles.attendedCell
  if (emphasis === "late") return styles.lateTotalCell
  return styles.summaryValue
}

function staffSecondaryLabel(person: ApiAttendancePerson) {
  const code = person.staffCode.trim().toUpperCase()
  const name = person.displayName.trim()
  return name && name.toUpperCase() !== code ? name : ""
}

function isHistoricalPersonVisible(person: ApiAttendancePerson) {
  return !EXCLUDED_STAFF_CODES.has(person.staffCode.trim().toUpperCase())
}

function isActiveRosterPerson(person: ApiAttendancePerson) {
  return person.isActive && isHistoricalPersonVisible(person)
}

function isReminderEligiblePerson(person: ApiAttendancePerson) {
  const username = person.adminUsername || person.username || ""
  return (
    isActiveRosterPerson(person) &&
    Boolean(person.adminUserId) &&
    normalizeEmailList(username).length === 1
  )
}

function staffOrderRank(staffOrder: readonly string[]) {
  return new Map(
    staffOrder.map((code, index) => [code.trim().toUpperCase(), index]),
  )
}

function sortAttendancePeople(
  people: ApiAttendancePerson[],
  staffOrder: readonly string[],
) {
  const rank = staffOrderRank(staffOrder)
  return people
    .map((person, index) => ({ person, index }))
    .sort((left, right) => {
      const leftCode = left.person.staffCode.trim().toUpperCase()
      const rightCode = right.person.staffCode.trim().toUpperCase()
      const leftRank = rank.get(leftCode)
      const rightRank = rank.get(rightCode)
      if (leftRank !== undefined || rightRank !== undefined) {
        if (leftRank === undefined) return 1
        if (rightRank === undefined) return -1
        if (leftRank !== rightRank) return leftRank - rightRank
      }
      return leftCode.localeCompare(rightCode) || left.index - right.index
    })
    .map(({ person }) => person)
}

function sortManagedAttendanceUsers(
  users: ManagedAttendanceUser[],
  staffOrder: readonly string[],
) {
  const rank = staffOrderRank(staffOrder)
  return users
    .map((user, index) => ({ user, index, code: userStaffCode(user) }))
    .sort((left, right) => {
      const leftRank = rank.get(left.code)
      const rightRank = rank.get(right.code)
      if (leftRank !== undefined || rightRank !== undefined) {
        if (leftRank === undefined) return 1
        if (rightRank === undefined) return -1
        if (leftRank !== rightRank) return leftRank - rightRank
      }
      return left.code.localeCompare(right.code) || left.index - right.index
    })
    .map(({ user }) => user)
}

function holidayTitle(holiday: ApiAttendanceHoliday | null | undefined) {
  if (!holiday) return ""
  return holiday.title || holiday.name || "Hong Kong holiday"
}

function leaveEntries(item: ApiAttendanceDailyItem) {
  return Array.isArray(item.leave) ? item.leave : item.leave ? [item.leave] : []
}

function leaveEntryForDirection(
  item: ApiAttendanceDailyItem,
  direction: "in" | "out",
) {
  const entries = leaveEntries(item)
  const fullDayEntry = entries.find((entry) => entry.portion === "full")
  if (fullDayEntry) return fullDayEntry
  const matchingPortion = direction === "in" ? "am" : "pm"
  return entries.find((entry) => entry.portion === matchingPortion)
}

function recordCellValue(
  item: ApiAttendanceDailyItem | undefined,
  direction: "in" | "out",
  holiday?: ApiAttendanceHoliday | null,
  now = new Date(),
) {
  if (!item) return holiday ? "PH" : ""
  const entry = leaveEntryForDirection(item, direction)
  if (entry) return entry.code
  if (direction === "in" && item.automaticAmLeave) return "AM LEAVE"
  const punch = direction === "in" ? item.effectiveSignIn : item.effectiveSignOut
  if (punch) return displayTime(punch)
  const status = String(item.status || "").toUpperCase()
  if (item.holidayAttendance || status.includes("HOLIDAY-ATTENDANCE")) return "HOL"
  if (status.includes("HOLIDAY") || holiday) return "PH"
  if (item.workMode === "home-office") {
    const workDate = item.date || item.workDate
    if (workDate && hongKongDateTimeKey(now) < `${workDate} ${direction === "in" ? "10:30" : "19:30"}`) return ""
    return "HO"
  }
  if (item.workMode === "business-trip") return "OS"
  return ""
}

function recordCellTone(
  item: ApiAttendanceDailyItem | undefined,
  direction: "in" | "out",
  holiday?: ApiAttendanceHoliday | null,
  now = new Date(),
) {
  if (!item) return holiday ? styles.holidayCell : ""
  if (leaveEntryForDirection(item, direction)) return styles.leaveCell
  if (direction === "in" && item.automaticAmLeave) return styles.leaveCell
  if (direction === "in" && item.late) return styles.lateCell
  if (direction === "in" && item.effectiveSignIn) return styles.onTimeCell
  if (direction === "out" && item.early) return styles.earlyCell
  if (item.holidayAttendance || holiday) return styles.holidayCell
  if (item.workMode === "home-office") {
    const workDate = item.date || item.workDate
    if (workDate && hongKongDateTimeKey(now) < `${workDate} ${direction === "in" ? "10:30" : "19:30"}`) return ""
    return styles.homeOfficeCell
  }
  if (item.workMode === "business-trip") return styles.businessTripCell
  return ""
}

function codeTotal(summary: ApiAttendanceMonthlySummary | null, code: string) {
  if (!summary) return 0
  const value = Number(summary.codeTotals?.[code] ?? summary.codeTotals?.[code.toLowerCase()] ?? 0)
  return Number.isFinite(value) ? value : 0
}

function annualCodeTotal(summary: ApiAttendanceAnnualSummary | undefined, code: string) {
  if (!summary) return 0
  const value = Number(summary.codeTotals?.[code] ?? summary.codeTotals?.[code.toLowerCase()] ?? 0)
  return Number.isFinite(value) ? value : 0
}

function calculatedMonthlyStats(month: AttendanceMonthData, personId: string) {
  const summary = month.summaries.find((item) => item.person.id === personId)
  if (
    Number.isFinite(summary?.attendedDays) &&
    Number.isFinite(summary?.lateDays)
  ) {
    return {
      attendedDays: Number(summary?.attendedDays || 0),
      lateDays: Number(summary?.lateDays || 0),
    }
  }
  let attendedDays = 0
  let lateDays = 0
  for (const day of month.calendarDays) {
    const record = day.records.find((item) => item.person.id === personId)
    if (!record) continue
    if (record.effectiveSignIn || record.effectiveSignOut || record.punches.length) {
      attendedDays += 1
    }
    if (record.late) lateDays += 1
  }
  return { attendedDays, lateDays }
}

function groupFromUser(user: ManagedAttendanceUser | undefined, fallback: AttendanceGroup) {
  return user?.attendanceTeam || user?.attendanceGroup || fallback
}

function userStaffCode(user: ManagedAttendanceUser) {
  const supplied = String(user.suggestedStaffCode || user.staffCode || "").trim().toUpperCase()
  if (/^[A-Z0-9][A-Z0-9_-]{0,15}$/.test(supplied)) return supplied
  const initials = user.displayName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("")
  const fallback = initials || user.username.replace(/[^a-z0-9_-]/gi, "").slice(0, 16).toUpperCase()
  return fallback || "USER"
}

export default function AttendanceRecordClient() {
  const {
    loading: authLoading,
    authenticated,
    permissions,
    role,
  } = useSimpleAdminAuth()
  const today = useMemo(() => hongKongDateKey(), [])
  const currentYear = Number(today.slice(0, 4))
  const currentMonth = Number(today.slice(5, 7))
  const [activeTab, setActiveTab] = useState<TabId>("monthly-record")
  const [viewNow, setViewNow] = useState(() => new Date())
  const [selectedMonth, setSelectedMonth] = useState(currentMonth)
  const [selectedSummaryYear, setSelectedSummaryYear] = useState(currentYear)
  const [selectedAllTimeYear, setSelectedAllTimeYear] = useState(currentYear)
  const [monthData, setMonthData] = useState<AttendanceMonthData>(EMPTY_MONTH)
  const [yearData, setYearData] = useState<Record<number, AttendanceMonthData>>({})
  const [settings, setSettings] = useState<ApiSettingsResponse>(EMPTY_SETTINGS)
  const [staffOrder, setStaffOrder] = useState<string[]>([
    ...DEFAULT_EVENT_CALENDAR_STAFF_ORDER,
  ])
  const [availableYears, setAvailableYears] = useState<number[]>([currentYear])
  const [monthLoading, setMonthLoading] = useState(true)
  const [yearLoading, setYearLoading] = useState(false)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [monthError, setMonthError] = useState("")
  const [yearError, setYearError] = useState("")
  const [settingsError, setSettingsError] = useState("")
  const [notice, setNotice] = useState("")
  const [pendingAction, setPendingAction] = useState("")
  const [reminderOpen, setReminderOpen] = useState(false)
  const [reminderMonth, setReminderMonth] = useState(Math.max(1, currentMonth - 1))
  const [reminderSelection, setReminderSelection] = useState<Set<string>>(new Set())
  const [addUsersOpen, setAddUsersOpen] = useState(false)
  const [addUserSelection, setAddUserSelection] = useState<Set<string>>(new Set())
  const [leaveDraft, setLeaveDraft] = useState<LeaveDraft | null>(null)
  const [rosterSearch, setRosterSearch] = useState("")
  const monthRequestRef = useRef(0)
  const yearRequestRef = useRef(0)
  const settingsRequestRef = useRef(0)

  const canEdit =
    authenticated &&
    (isAdminRole(role) || canAccessAdminPage(permissions, "attendance-record", "edit"))

  const loadSelectedMonth = useCallback(async () => {
    if (!authenticated) return
    const requestId = monthRequestRef.current + 1
    monthRequestRef.current = requestId
    setMonthLoading(true)
    setMonthError("")
    try {
      const payload = await fetchAttendance({
        view: "monthly",
        year: String(currentYear),
        month: String(selectedMonth),
        scope: "month",
      })
      const parsed = parseMonthlyResponse(payload, currentYear, selectedMonth)
      if (monthRequestRef.current === requestId) {
        setMonthData(parsed)
        if (parsed.staffOrder?.length) setStaffOrder(parsed.staffOrder)
        if (parsed.availableYears?.length) setAvailableYears(parsed.availableYears)
      }
    } catch (error) {
      if (monthRequestRef.current === requestId) {
        setMonthError(error instanceof Error ? error.message : "Attendance records could not be loaded.")
      }
    } finally {
      if (monthRequestRef.current === requestId) setMonthLoading(false)
    }
  }, [authenticated, currentYear, selectedMonth])

  const loadSelectedYear = useCallback(async () => {
    if (!authenticated) return
    const requestId = yearRequestRef.current + 1
    yearRequestRef.current = requestId
    setYearLoading(true)
    setYearError("")
    try {
      const payload = await fetchAttendance({
        view: "monthly",
        year: String(selectedSummaryYear),
        month: String(selectedSummaryYear < currentYear ? 12 : currentMonth),
        scope: "year",
      })
      const next = parseYearResponse(payload, selectedSummaryYear)
      if (yearRequestRef.current === requestId) {
        setYearData(next.months)
        if (next.staffOrder.length) setStaffOrder(next.staffOrder)
        if (next.availableYears.length) setAvailableYears(next.availableYears)
      }
    } catch (error) {
      if (yearRequestRef.current === requestId) {
        setYearError(error instanceof Error ? error.message : "Monthly attendance could not be loaded.")
      }
    } finally {
      if (yearRequestRef.current === requestId) setYearLoading(false)
    }
  }, [authenticated, currentMonth, currentYear, selectedSummaryYear])

  const loadAllTime = useCallback(async () => {
    if (!authenticated) return
    const requestId = settingsRequestRef.current + 1
    settingsRequestRef.current = requestId
    setSettingsLoading(true)
    setSettingsError("")
    try {
      const payload = await fetchAttendance({
        view: "all-time",
        year: String(selectedAllTimeYear),
      })
      if (settingsRequestRef.current === requestId) {
        const parsed = parseSettingsResponse(payload, selectedAllTimeYear)
        setSettings(parsed)
        if (parsed.staffOrder.length) setStaffOrder(parsed.staffOrder)
        if (parsed.availableYears.length) setAvailableYears(parsed.availableYears)
      }
    } catch (error) {
      if (settingsRequestRef.current === requestId) {
        setSettingsError(error instanceof Error ? error.message : "Attendance users could not be loaded.")
      }
    } finally {
      if (settingsRequestRef.current === requestId) setSettingsLoading(false)
    }
  }, [authenticated, selectedAllTimeYear])

  useEffect(() => {
    if (authLoading || !authenticated || activeTab !== "monthly-record") return
    const timer = window.setTimeout(() => void loadSelectedMonth(), 0)
    return () => window.clearTimeout(timer)
  }, [activeTab, authLoading, authenticated, loadSelectedMonth])

  useEffect(() => {
    if (authLoading || !authenticated || activeTab !== "monthly") return
    const timer = window.setTimeout(() => void loadSelectedYear(), 0)
    return () => window.clearTimeout(timer)
  }, [activeTab, authLoading, authenticated, loadSelectedYear])

  useEffect(() => {
    if (authLoading || !authenticated || activeTab !== "all-time") return
    const timer = window.setTimeout(() => void loadAllTime(), 0)
    return () => window.clearTimeout(timer)
  }, [activeTab, authLoading, authenticated, loadAllTime])

  useEffect(() => {
    if (!reminderOpen && !addUsersOpen && !leaveDraft) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || pendingAction) return
      setReminderOpen(false)
      setAddUsersOpen(false)
      setLeaveDraft(null)
    }
    window.addEventListener("keydown", closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener("keydown", closeOnEscape)
    }
  }, [addUsersOpen, leaveDraft, pendingAction, reminderOpen])

  const postAttendance = useCallback(async (action: string, body: Record<string, unknown>) => {
    const response = await fetch("/api/admin/attendance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...body }),
    })
    const payload: unknown = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(getErrorMessage(payload, "The attendance record could not be updated."))
    }
    return payload
  }, [])

  const runMutation = useCallback(
    async (
      action: string,
      body: Record<string, unknown>,
      successMessage: string,
      refresh?: () => Promise<void>,
    ) => {
      if (!canEdit) {
        setNotice("You have view-only access. Ask an administrator for Edit permission in User Management.")
        return false
      }
      setPendingAction(action)
      setNotice("")
      try {
        const payload = await postAttendance(action, body)
        setNotice(getErrorMessage(payload, successMessage))
        if (refresh) await refresh()
        return true
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "The attendance record could not be updated.")
        return false
      } finally {
        setPendingAction("")
      }
    },
    [canEdit, postAttendance],
  )

  const monthPeople = useMemo(
    () => sortAttendancePeople(
      monthData.people.filter(isHistoricalPersonVisible),
      monthData.staffOrder?.length ? monthData.staffOrder : staffOrder,
    ),
    [monthData.people, monthData.staffOrder, staffOrder],
  )

  const monthDays = useMemo(() => {
    const recordsByDate = new Map(monthData.calendarDays.map((day) => [day.date, day]))
    const daysInMonth = new Date(Date.UTC(currentYear, selectedMonth, 0)).getUTCDate()
    const days: ApiAttendanceCalendarDay[] = []
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${monthKey(currentYear, selectedMonth)}-${String(day).padStart(2, "0")}`
      const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay()
      if (dayOfWeek === 0 || dayOfWeek === 6) continue
      days.push(recordsByDate.get(date) || { date, records: [] })
    }
    return days
  }, [currentYear, monthData.calendarDays, selectedMonth])

  const monthRecordMap = useMemo(() => {
    const records = new Map<string, ApiAttendanceDailyItem>()
    for (const day of monthDays) {
      for (const record of day.records) {
        records.set(`${day.date}:${record.person.id}`, record)
      }
    }
    return records
  }, [monthDays])

  const monthStats = useMemo(
    () => new Map(monthPeople.map((person) => [person.id, calculatedMonthlyStats(monthData, person.id)])),
    [monthData, monthPeople],
  )

  const monthSections = useMemo<MonthSection[]>(() => {
    const sections: MonthSection[] = []
    const lastMonth = selectedSummaryYear < currentYear ? 12 : currentMonth
    for (let month = 1; month <= lastMonth; month += 1) {
      const data = yearData[month]
      if (!data) continue
      const summaryByPerson = new Map(data.summaries.map((summary) => [summary.person.id, summary]))
      const peopleById = new Map(data.people.filter(isHistoricalPersonVisible).map((person) => [person.id, person]))
      for (const summary of data.summaries) {
        if (isHistoricalPersonVisible(summary.person)) peopleById.set(summary.person.id, summary.person)
      }
      sections.push({
        month,
        label: MONTH_NAMES[month - 1],
        rows: sortAttendancePeople(
          [...peopleById.values()],
          data.staffOrder?.length ? data.staffOrder : staffOrder,
        ).map((person) => ({
          person,
          summary: summaryByPerson.get(person.id) || null,
          ...calculatedMonthlyStats(data, person.id),
        })),
      })
    }
    return sections
  }, [currentMonth, currentYear, selectedSummaryYear, staffOrder, yearData])

  const closedMonthSections = useMemo(
    () => monthSections.filter((section) => yearData[section.month]?.periodClosed),
    [monthSections, yearData],
  )

  const yearOptions = useMemo(
    () => [...new Set([
      currentYear,
      2026,
      selectedSummaryYear,
      selectedAllTimeYear,
      ...availableYears,
    ])]
      .filter((year) => year <= currentYear)
      .sort((left, right) => right - left),
    [availableYears, currentYear, selectedAllTimeYear, selectedSummaryYear],
  )

  const reminderRecipients = useMemo(() => {
    const section = monthSections.find((item) => item.month === reminderMonth)
    return (section?.rows || []).filter(
      (row) =>
        isReminderEligiblePerson(row.person) &&
        row.summary?.confirmation?.status !== "confirmed",
    )
  }, [monthSections, reminderMonth])

  const selectedReminderPersonIds = useMemo(
    () => reminderRecipients.flatMap((row) =>
      reminderSelection.has(row.person.id) ? [row.person.id] : [],
    ),
    [reminderRecipients, reminderSelection],
  )

  const linkedUsersById = useMemo(
    () => new Map(settings.availableUsers.map((user) => [user.id, user])),
    [settings.availableUsers],
  )

  const linkedUsernames = useMemo(() => {
    const names = new Set<string>()
    for (const person of settings.people) {
      if (person.adminUserId) names.add(person.adminUserId)
      const username = person.adminUsername || person.username
      if (username) names.add(username.trim().toLowerCase())
    }
    return names
  }, [settings.people])

  const availableUsers = useMemo(() => {
    return sortManagedAttendanceUsers(settings.availableUsers.filter((user) => {
      if (user.eligible === false || !(user.attendanceTeam || user.attendanceGroup)) return false
      if (EXCLUDED_STAFF_CODES.has(userStaffCode(user))) return false
      return !linkedUsernames.has(user.id) && !linkedUsernames.has(user.username.trim().toLowerCase())
    }), staffOrder)
  }, [linkedUsernames, settings.availableUsers, staffOrder])

  const annualByPerson = useMemo(() => {
    const summaries = new Map(
      settings.annualSummaries.map((summary) => [summary.personId, summary]),
    )
    for (const person of settings.people) {
      if (summaries.has(person.id)) continue
      const entitlement = settings.entitlements.find(
        (entry) => entry.personId === person.id && entry.year === selectedAllTimeYear,
      )
      const codeTotals: Record<string, number> = {}
      for (const adjustment of settings.monthlyAdjustments) {
        if (adjustment.personId !== person.id || adjustment.year !== selectedAllTimeYear) continue
        codeTotals[adjustment.code] = (codeTotals[adjustment.code] || 0) + adjustment.units
      }
      summaries.set(person.id, {
        personId: person.id,
        allowanceUnits: entitlement?.allowanceUnits || 0,
        openingCarryForwardUnits: entitlement?.openingCarryForwardUnits || 0,
        closingBalanceUnits:
          (entitlement?.openingCarryForwardUnits || 0) +
          (entitlement?.allowanceUnits || 0) +
          (codeTotals.HOL || 0) -
          (codeTotals.ALS || 0) -
          (codeTotals.ALU || 0) -
          (codeTotals.SLX || 0),
        codeTotals,
        leavePaidUnits: null,
      })
    }
    return summaries
  }, [selectedAllTimeYear, settings.annualSummaries, settings.entitlements, settings.monthlyAdjustments, settings.people])

  const rosterPeople = useMemo(() => {
    const search = rosterSearch.trim().toLowerCase()
    const filtered = settings.people.filter((person) => {
      if (!isActiveRosterPerson(person)) return false
      if (!search) return true
      return `${person.staffCode} ${person.displayName} ${person.adminUsername || person.username || ""}`.toLowerCase().includes(search)
    })
    return sortAttendancePeople(filtered, staffOrder)
  }, [rosterSearch, settings.people, staffOrder])

  const annualTotals = useMemo(() => {
    const totals = {
      allowanceUnits: 0,
      openingCarryForwardUnits: 0,
      closingBalanceUnits: 0,
      codeTotals: {} as Record<string, number>,
      leavePaidUnits: 0,
      hasLeavePaid: false,
    }
    for (const person of rosterPeople) {
      const annual = annualByPerson.get(person.id)
      if (!annual) continue
      totals.allowanceUnits += annual.allowanceUnits || 0
      totals.openingCarryForwardUnits += annual.openingCarryForwardUnits || 0
      totals.closingBalanceUnits += annual.closingBalanceUnits || 0
      for (const code of [...SUMMARY_CODES, "HOL"] as const) {
        totals.codeTotals[code] = (totals.codeTotals[code] || 0) + annualCodeTotal(annual, code)
      }
      if (annual.leavePaidUnits !== null && annual.leavePaidUnits !== undefined) {
        totals.hasLeavePaid = true
        totals.leavePaidUnits += annual.leavePaidUnits
      }
    }
    return totals
  }, [annualByPerson, rosterPeople])

  function moveSelectedMonth(offset: number) {
    setSelectedMonth((month) => Math.min(12, Math.max(1, month + offset)))
  }

  function openLeave(
    person: ApiAttendancePerson,
    date: string,
    direction: "in" | "out",
    record: ApiAttendanceDailyItem | undefined,
    holiday: ApiAttendanceHoliday | null | undefined,
  ) {
    if (!canEdit) return
    const matching = record ? leaveEntryForDirection(record, direction) : undefined
    const manualWorkMode = record?.workModeOverride?.mode ||
      (record?.workModeSource === "manual" ? record.workMode : undefined)
    const defaultWorkMode = record?.defaultWorkMode ||
      (!manualWorkMode && record?.workMode
        ? record.workMode
        : "office")
    setLeaveDraft({
      personId: person.id,
      staffLabel: `${person.staffCode} · ${person.displayName}`,
      date,
      leaveEnabled: Boolean(matching),
      portion: matching?.portion || (direction === "in" ? "am" : "pm"),
      code: matching?.code || "ALS",
      note: matching?.note || "",
      workMode:
        manualWorkMode === "home-office" ||
        manualWorkMode === "office" ||
        manualWorkMode === "business-trip"
          ? manualWorkMode
          : "default",
      defaultWorkMode,
      workModeOverrideId: record?.workModeOverride?.id || undefined,
      entryId: matching?.id,
      holiday: Boolean(holiday || record?.holiday),
    })
  }

  async function saveDayEdit() {
    if (!leaveDraft) return
    if (!canEdit) {
      setNotice("You have view-only access. Ask an administrator for Edit permission in User Management.")
      return
    }
    setPendingAction("save-day-edit")
    setNotice("")
    try {
      await postAttendance("save-day-edit", {
        dayEdit: {
          personId: leaveDraft.personId,
          workDate: leaveDraft.date,
          workMode: leaveDraft.workMode,
          workModeNote: leaveDraft.note.trim() || undefined,
          leaveEnabled: leaveDraft.leaveEnabled,
          existingLeaveEntryId: leaveDraft.entryId,
          leavePortion: leaveDraft.leaveEnabled ? leaveDraft.portion : undefined,
          leaveCode: leaveDraft.leaveEnabled ? leaveDraft.code : undefined,
          leaveNote: leaveDraft.note.trim() || undefined,
        },
      })

      setNotice("Attendance day updated.")
      setLeaveDraft(null)
      await loadSelectedMonth()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The attendance day could not be updated.")
    } finally {
      setPendingAction("")
    }
  }

  async function deleteLeave() {
    if (!leaveDraft?.entryId) return
    if (!canEdit) {
      setNotice("You have view-only access. Ask an administrator for Edit permission in User Management.")
      return
    }
    setPendingAction("delete-leave")
    setNotice("")
    try {
      await postAttendance("save-day-edit", {
        dayEdit: {
          personId: leaveDraft.personId,
          workDate: leaveDraft.date,
          workMode: leaveDraft.workMode,
          workModeNote: leaveDraft.note.trim() || undefined,
          leaveEnabled: false,
          existingLeaveEntryId: leaveDraft.entryId,
        },
      })
      setNotice("Leave record deleted.")
      setLeaveDraft(null)
      await loadSelectedMonth()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The leave record could not be deleted.")
    } finally {
      setPendingAction("")
    }
  }

  async function confirmMonth(personId: string, month: number) {
    setPendingAction(`save-confirmation:${personId}:${month}`)
    setNotice("")
    try {
      const payload = await postAttendance("save-confirmation", {
        confirmation: {
          personId,
          year: selectedSummaryYear,
          month,
          status: "confirmed",
        },
      })
      setNotice(getErrorMessage(payload, `${MONTH_NAMES[month - 1]} attendance confirmed.`))
      await loadSelectedYear()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Attendance confirmation could not be saved.")
    } finally {
      setPendingAction("")
    }
  }

  async function confirmAnnualSummary(personId: string) {
    setPendingAction(`save-annual-confirmation:${personId}:${selectedAllTimeYear}`)
    setNotice("")
    try {
      const payload = await postAttendance("save-confirmation", {
        confirmation: {
          personId,
          year: selectedAllTimeYear,
          month: 12,
          status: "confirmed",
          note: "annual-summary",
        },
      })
      setNotice(getErrorMessage(payload, `${selectedAllTimeYear} year-end summary confirmed.`))
      await loadAllTime()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Year-end summary confirmation could not be saved.")
    } finally {
      setPendingAction("")
    }
  }

  function openReminder() {
    setReminderMonth(closedMonthSections.at(-1)?.month || 1)
    setReminderSelection(new Set())
    setReminderOpen(true)
  }

  async function sendReminder() {
    if (!selectedReminderPersonIds.length) {
      setNotice("Select at least one staff member to receive a reminder.")
      return
    }
    const sent = await runMutation(
      "send-reminder",
      {
        year: selectedSummaryYear,
        month: reminderMonth,
        personIds: selectedReminderPersonIds,
      },
      `Reminder sent to ${selectedReminderPersonIds.length} staff member${selectedReminderPersonIds.length === 1 ? "" : "s"}.`,
    )
    if (sent) setReminderOpen(false)
  }

  function openAddUsers() {
    setAddUserSelection(new Set())
    setAddUsersOpen(true)
  }

  async function addSelectedUsers() {
    const users = availableUsers.filter((user) => addUserSelection.has(user.id))
    if (!users.length) {
      setNotice("Select at least one User Management account to add.")
      return
    }
    if (!canEdit) {
      setNotice("You have view-only access. Ask an administrator for Edit permission in User Management.")
      return
    }
    setPendingAction("add-attendance-users")
    setNotice("")
    try {
      for (const user of users) {
        await postAttendance("save-person", {
          person: {
            adminUserId: user.id,
          },
        })
      }
      setNotice(`${users.length} User Management account${users.length === 1 ? "" : "s"} added to attendance.`)
      setAddUsersOpen(false)
      await loadAllTime()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Attendance users could not be added.")
    } finally {
      setPendingAction("")
    }
  }

  async function removeAttendanceUser(person: ApiAttendancePerson) {
    if (!window.confirm(`Remove ${person.displayName} from current attendance users? Historical records will be retained.`)) return
    const removed = await runMutation(
      "remove-person",
      { id: person.id },
      `${person.displayName} removed from current attendance users. Historical records were retained.`,
      loadAllTime,
    )
    if (removed) {
      setMonthData(EMPTY_MONTH)
      setYearData({})
    }
  }

  const activeError =
    activeTab === "monthly-record"
      ? monthError
      : activeTab === "monthly"
        ? yearError
        : settingsError
  const activeLoading =
    activeTab === "monthly-record"
      ? monthLoading
      : activeTab === "monthly"
        ? yearLoading
        : settingsLoading

  if (authLoading || (activeTab === "monthly-record" && monthLoading && !monthData.year)) {
    return (
      <main className={styles.page}>
        <div className={styles.shell} aria-busy="true">
          <div className={styles.loadingPanel}>
            <span className={styles.spinner} aria-hidden="true" />
            <strong>Loading attendance records</strong>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        {activeError ? (
          <section className={styles.errorPanel} role="alert">
            <div>
              <strong>Attendance data is unavailable</strong>
              <span>{activeError}</span>
            </div>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => {
                if (activeTab === "monthly-record") void loadSelectedMonth()
                else if (activeTab === "monthly") void loadSelectedYear()
                else void loadAllTime()
              }}
            >
              Try again
            </button>
          </section>
        ) : null}

        {notice ? (
          <div className={styles.notice} role="status">
            {notice}
            <button type="button" aria-label="Dismiss message" onClick={() => setNotice("")}>×</button>
          </div>
        ) : null}

        <nav className={styles.tabs} aria-label="Attendance record sections" data-admin-view-safe="true">
          {TABS.map((tab) => (
            <button
              type="button"
              key={tab.id}
              className={activeTab === tab.id ? styles.activeTab : styles.tab}
              aria-current={activeTab === tab.id ? "page" : undefined}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {activeTab === "monthly-record" ? (
          <section className={styles.tabContent} aria-labelledby="monthly-record-heading">
            <div className={styles.recordToolbar} data-admin-view-safe="true">
              <div>
                <h1 id="monthly-record-heading">{MONTH_NAMES[selectedMonth - 1]} {currentYear}</h1>
                <span>DAILY SIGN-IN AND SIGN-OUT RECORD</span>
              </div>
              <div className={styles.toolbarActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => {
                    setViewNow(new Date())
                    void loadSelectedMonth()
                  }}
                  disabled={monthLoading}
                >
                  {monthLoading ? "REFRESHING…" : "REFRESH"}
                </button>
                <button
                  type="button"
                  className={styles.monthArrow}
                  aria-label="Previous month"
                  onClick={() => moveSelectedMonth(-1)}
                  disabled={selectedMonth === 1 || activeLoading}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className={styles.monthArrow}
                  aria-label="Next month"
                  onClick={() => moveSelectedMonth(1)}
                  disabled={selectedMonth === 12 || activeLoading}
                >
                  ›
                </button>
              </div>
            </div>

            <div className={styles.excelPanel}>
              <table
                className={styles.monthRecordTable}
                style={{ minWidth: `${Math.max(760, 104 + monthPeople.length * 116)}px` }}
              >
                <thead>
                  <tr>
                    <th rowSpan={2} className={styles.dateHeader}>DATE</th>
                    {monthPeople.map((person) => (
                      <th colSpan={2} key={person.id} className={styles.staffHeader}>
                        <strong>{person.staffCode}</strong>
                        <span>{person.displayName}</span>
                      </th>
                    ))}
                  </tr>
                  <tr>
                    {monthPeople.map((person) => (
                      <Fragment key={person.id}>
                        <th>IN</th>
                        <th>OUT</th>
                      </Fragment>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {monthDays.map((day) => (
                    <tr key={day.date} className={day.holiday ? styles.holidayRow : undefined}>
                      <th scope="row" title={holidayTitle(day.holiday)}>
                        <span>{displayShortDate(day.date)}</span>
                        {day.holiday ? <em>HK HOLIDAY</em> : null}
                      </th>
                      {monthPeople.map((person) => {
                        const record = monthRecordMap.get(`${day.date}:${person.id}`)
                        return (
                          <Fragment key={`${day.date}:${person.id}`}>
                            <td className={recordCellTone(record, "in", day.holiday, viewNow)}>
                              {canEdit ? (
                                <button
                                  type="button"
                                  className={styles.cellButton}
                                  onClick={() => openLeave(person, day.date, "in", record, day.holiday)}
                                  aria-label={`Edit ${person.displayName} ${displayShortDate(day.date)} IN attendance`}
                                >
                                  {recordCellValue(record, "in", day.holiday, viewNow) || " "}
                                </button>
                              ) : recordCellValue(record, "in", day.holiday, viewNow)}
                            </td>
                            <td className={recordCellTone(record, "out", day.holiday, viewNow)}>
                              {canEdit ? (
                                <button
                                  type="button"
                                  className={styles.cellButton}
                                  onClick={() => openLeave(person, day.date, "out", record, day.holiday)}
                                  aria-label={`Edit ${person.displayName} ${displayShortDate(day.date)} OUT attendance`}
                                >
                                  {recordCellValue(record, "out", day.holiday, viewNow) || " "}
                                </button>
                              ) : recordCellValue(record, "out", day.holiday, viewNow)}
                            </td>
                          </Fragment>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">ATTENDED DAYS</th>
                    {monthPeople.map((person) => (
                      <td colSpan={2} key={person.id}>{displayDays(monthStats.get(person.id)?.attendedDays || 0)}</td>
                    ))}
                  </tr>
                  <tr>
                    <th scope="row">LATE DAYS</th>
                    {monthPeople.map((person) => (
                      <td colSpan={2} key={person.id}>{displayDays(monthStats.get(person.id)?.lateDays || 0)}</td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        ) : null}

        {activeTab === "monthly" ? (
          <section className={styles.tabContent} aria-label="Monthly attendance">
            <div className={styles.yearToolbar}>
              <label className={styles.yearSelector}>
                <span>YEAR</span>
                <select
                  value={selectedSummaryYear}
                  onChange={(event) => {
                    setSelectedSummaryYear(Number(event.target.value))
                    setYearData({})
                    setReminderSelection(new Set())
                  }}
                  disabled={yearLoading}
                  aria-label="Monthly attendance year"
                >
                  {yearOptions.map((year) => <option value={year} key={year}>{year}</option>)}
                </select>
              </label>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={openReminder}
                disabled={!canEdit || yearLoading || !closedMonthSections.length}
                title={canEdit ? "Remind selected staff to confirm a month" : "Edit permission required"}
              >
                SEND REMINDER
              </button>
            </div>

            {yearLoading && !monthSections.length ? (
              <div className={styles.inlineLoading}><span className={styles.spinner} aria-hidden="true" />Loading {selectedSummaryYear}…</div>
            ) : (
              <div className={styles.excelPanel}>
                <table className={styles.yearSummaryTable}>
                  <thead>
                    <tr>
                      <th>MONTH</th>
                      <th>STAFF</th>
                      <th>ABSENT<br />ALS</th>
                      <th>ABSENT<br />ALU</th>
                      <th>ABSENT<br />SLM</th>
                      <th>ABSENT<br />SLR</th>
                      <th>ABSENT<br />SLX</th>
                      <th>ATTEND<br />HOL</th>
                      <th>SPECIAL<br />LEAVE</th>
                      <th>MATERNITY<br />LEAVE</th>
                      <th>NO PAY<br />LEAVE</th>
                      <th>ATTEND<br />HO</th>
                      <th>ATTEND<br />OS</th>
                      <th>ATTENDED<br />DAYS</th>
                      <th>LATE<br />DAYS</th>
                      <th>CONFIRMATION</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthSections.map((section) =>
                      section.rows.map((row, rowIndex) => {
                        const confirmed = row.summary?.confirmation?.status === "confirmed"
                        const systemConfirmed = confirmed && row.summary?.confirmation?.confirmedBy === "system:attendance-auto-confirm"
                        const open = !yearData[section.month]?.periodClosed
                        return (
                          <tr key={`${section.month}:${row.person.id}`}>
                            {rowIndex === 0 ? (
                              <th scope="rowgroup" rowSpan={section.rows.length} className={styles.monthCell}>
                                {section.label.toUpperCase()}
                              </th>
                            ) : null}
                            <th scope="row" className={styles.summaryStaffCell}>
                              <strong>{row.person.staffCode}</strong>
                              {staffSecondaryLabel(row.person) ? (
                                <span>{staffSecondaryLabel(row.person)}</span>
                              ) : null}
                            </th>
                            {SUMMARY_CODES.slice(0, 5).map((code) => {
                              const value = codeTotal(row.summary, code)
                              return <td key={code} className={summaryNumberClass(value)}>{displaySummaryDays(value)}</td>
                            })}
                            <td className={summaryNumberClass(codeTotal(row.summary, "HOL"))}>
                              {displaySummaryDays(codeTotal(row.summary, "HOL"))}
                            </td>
                            {SUMMARY_CODES.slice(5).map((code) => {
                              const value = codeTotal(row.summary, code)
                              return <td key={code} className={summaryNumberClass(value)}>{displaySummaryDays(value)}</td>
                            })}
                            <td className={summaryNumberClass(row.attendedDays, "attended")}>{displaySummaryDays(row.attendedDays)}</td>
                            <td className={summaryNumberClass(row.lateDays, "late")}>{displaySummaryDays(row.lateDays)}</td>
                            <td className={styles.confirmationCell}>
                              {confirmed ? (
                                <span className={styles.confirmedBadge} title={displayDateTime(row.summary?.confirmation?.confirmedAt || null)}>
                                  {systemConfirmed ? "SYSTEM CONFIRMED" : "CONFIRMED"}
                                </span>
                              ) : open ? (
                                <span className={styles.openBadge}>OPEN</span>
                              ) : (
                                <button
                                  type="button"
                                  className={styles.confirmButton}
                                  onClick={() => void confirmMonth(row.person.id, section.month)}
                                  disabled={!row.summary?.canConfirm || pendingAction === `save-confirmation:${row.person.id}:${section.month}`}
                                  title={row.summary?.canConfirm ? `Confirm ${section.label} attendance` : "Only this staff member or an editor can confirm"}
                                >
                                  {pendingAction === `save-confirmation:${row.person.id}:${section.month}` ? "SAVING…" : "CONFIRM"}
                                </button>
                              )}
                            </td>
                          </tr>
                        )
                      }),
                    )}
                    {!monthSections.length ? (
                      <tr><td colSpan={16}><div className={styles.emptyState}>No monthly records were found for {selectedSummaryYear}.</div></td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : null}

        {activeTab === "all-time" ? (
          <section className={styles.tabContent} aria-label="All-time attendance users">
            <div className={styles.rosterControls}>
              <div className={styles.rosterFilters}>
                <label className={styles.compactYearSelector}>
                  <span>YEAR</span>
                  <select
                    value={selectedAllTimeYear}
                    onChange={(event) => {
                      setSelectedAllTimeYear(Number(event.target.value))
                      setSettings(EMPTY_SETTINGS)
                    }}
                    disabled={settingsLoading}
                    aria-label="Annual attendance totals year"
                  >
                    {yearOptions.map((year) => <option value={year} key={year}>{year}</option>)}
                  </select>
                </label>
                <label>
                  <span>SEARCH STAFF</span>
                  <input
                    type="search"
                    value={rosterSearch}
                    onChange={(event) => setRosterSearch(event.target.value)}
                    placeholder="Name or initials"
                  />
                </label>
              </div>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={openAddUsers}
                disabled={!canEdit || settingsLoading}
                title={canEdit ? "Add accounts from User Management" : "Edit permission required"}
              >
                ADD USERS
              </button>
            </div>

            {settingsLoading && !settings.people.length ? (
              <div className={styles.inlineLoading}><span className={styles.spinner} aria-hidden="true" />Loading attendance users…</div>
            ) : (
              <>
              <div className={styles.balanceExplanation}>
                <strong>{selectedAllTimeYear} BALANCE</strong>
                <span>
                  Balance B/F at 31 Dec {selectedAllTimeYear - 1} + {selectedAllTimeYear} allowance + HOL − ALS − ALU − SLX
                </span>
                <small>
                  SLM, SLR, special leave, maternity leave and no-pay leave do not change the balance. HO and OS count as attended days only.
                </small>
              </div>
              <div className={`${styles.tablePanel} ${styles.allTimePanel}`}>
                <table className={styles.allTimeTable}>
                  <thead>
                    <tr>
                      <th rowSpan={2}>STAFF</th>
                      <th colSpan={1} className={styles.openingGroup}>OPENING POSITION</th>
                      <th colSpan={12} className={styles.activityGroup}>{selectedAllTimeYear} ATTENDANCE &amp; LEAVE ACTIVITY</th>
                      <th colSpan={1} className={styles.closingGroup}>
                        {selectedAllTimeYear < currentYear ? "CLOSING POSITION" : "CURRENT BALANCE"}
                      </th>
                      <th rowSpan={2}>YEAR-END<br />CONFIRMATION</th>
                    </tr>
                    <tr>
                      <th>BALANCE B/F<br />31 DEC {selectedAllTimeYear - 1}</th>
                      <th>{selectedAllTimeYear}<br />ALLOWANCE</th>
                      <th>ALS</th>
                      <th>ALU</th>
                      <th>SLM</th>
                      <th>SLR</th>
                      <th>SLX</th>
                      <th>HOL</th>
                      <th>SPECIAL</th>
                      <th>MATERNITY</th>
                      <th>NO PAY</th>
                      <th>HO</th>
                      <th>OS</th>
                      <th className={styles.closingSubhead}>
                        {selectedAllTimeYear < currentYear ? (
                          <>BALANCE C/F<br />31 DEC {selectedAllTimeYear}</>
                        ) : (
                          <>BALANCE<br />TO DATE</>
                        )}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rosterPeople.map((person) => {
                      const linkedUser = person.adminUserId ? linkedUsersById.get(person.adminUserId) : undefined
                      const annual = annualByPerson.get(person.id)
                      return (
                        <tr key={person.id}>
                          <td className={styles.annualStaffCell}>
                            <strong>{person.staffCode}</strong>
                            {staffSecondaryLabel(person) ? <span>{staffSecondaryLabel(person)}</span> : null}
                            <small>
                              <span>{groupFromUser(linkedUser, person.team)}</span>
                              <button
                                type="button"
                                className={styles.removeButton}
                                onClick={() => void removeAttendanceUser(person)}
                                disabled={!canEdit || Boolean(pendingAction)}
                              >
                                REMOVE
                              </button>
                            </small>
                          </td>
                          <td className={styles.balanceCell}>{displaySummaryDays(annual?.openingCarryForwardUnits || 0)}</td>
                          <td className={summaryNumberClass(annual?.allowanceUnits || 0)}>{displaySummaryDays(annual?.allowanceUnits || 0)}</td>
                          {SUMMARY_CODES.slice(0, 5).map((code) => (
                            <td key={code} className={summaryNumberClass(annualCodeTotal(annual, code))}>{displaySummaryDays(annualCodeTotal(annual, code))}</td>
                          ))}
                          <td className={summaryNumberClass(annualCodeTotal(annual, "HOL"))}>{displaySummaryDays(annualCodeTotal(annual, "HOL"))}</td>
                          {SUMMARY_CODES.slice(5).map((code) => (
                            <td key={code} className={summaryNumberClass(annualCodeTotal(annual, code))}>{displaySummaryDays(annualCodeTotal(annual, code))}</td>
                          ))}
                          <td className={styles.closingBalanceCell}>{displaySummaryDays(annual?.closingBalanceUnits || 0)}</td>
                          <td className={styles.confirmationCell}>
                            {annual?.confirmation?.status === "confirmed" ? (
                              <span className={styles.confirmedBadge}>CONFIRMED</span>
                            ) : annual?.canConfirm ? (
                              <button
                                type="button"
                                className={styles.confirmButton}
                                onClick={() => void confirmAnnualSummary(person.id)}
                                disabled={pendingAction === `save-annual-confirmation:${person.id}:${selectedAllTimeYear}`}
                              >
                                {pendingAction === `save-annual-confirmation:${person.id}:${selectedAllTimeYear}` ? "SAVING…" : "CONFIRM YEAR"}
                              </button>
                            ) : (
                              <span className={styles.openBadge} title={`${selectedAllTimeYear} year in progress`}>IN PROGRESS</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                    {!rosterPeople.length ? (
                      <tr><td colSpan={16}><div className={styles.emptyState}>No attendance users match this search.</div></td></tr>
                    ) : null}
                  </tbody>
                  {rosterPeople.length ? (
                    <tfoot>
                      <tr>
                        <th scope="row">TOTAL</th>
                        <td>{displaySummaryDays(annualTotals.openingCarryForwardUnits)}</td>
                        <td>{displaySummaryDays(annualTotals.allowanceUnits)}</td>
                        {SUMMARY_CODES.slice(0, 5).map((code) => (
                          <td key={code}>{displaySummaryDays(annualTotals.codeTotals[code] || 0)}</td>
                        ))}
                        <td>{displaySummaryDays(annualTotals.codeTotals.HOL || 0)}</td>
                        {SUMMARY_CODES.slice(5).map((code) => (
                          <td key={code}>{displaySummaryDays(annualTotals.codeTotals[code] || 0)}</td>
                        ))}
                        <td>{displaySummaryDays(annualTotals.closingBalanceUnits)}</td>
                        <td />
                      </tr>
                    </tfoot>
                  ) : null}
                </table>
              </div>
              </>
            )}
          </section>
        ) : null}
      </div>

      {leaveDraft ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !pendingAction) setLeaveDraft(null) }}>
          <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="leave-title">
            <div className={styles.modalHeader}>
              <div>
                <span>{leaveDraft.staffLabel} · {displayShortDate(leaveDraft.date)}</span>
                <h2 id="leave-title">EDIT ATTENDANCE</h2>
              </div>
              <button type="button" aria-label="Close attendance editor" onClick={() => setLeaveDraft(null)} disabled={Boolean(pendingAction)}>×</button>
            </div>
            <div className={styles.formGrid}>
              <label>
                Work mode
                <select
                  value={leaveDraft.workMode}
                  onChange={(event) => setLeaveDraft((draft) => draft ? { ...draft, workMode: event.target.value as LeaveDraft["workMode"] } : draft)}
                >
                  <option value="default">Default ({leaveDraft.defaultWorkMode === "home-office" ? "Home Office" : "Office"})</option>
                  <option value="office">{leaveDraft.holiday ? "Holiday Attendance (Office)" : "Office"}</option>
                  <option value="home-office">Home Office</option>
                  <option value="business-trip">Business Trip</option>
                </select>
              </label>
              <label>
                Leave
                <select
                  value={leaveDraft.leaveEnabled ? leaveDraft.code : "NONE"}
                  onChange={(event) => setLeaveDraft((draft) => draft ? {
                    ...draft,
                    leaveEnabled: event.target.value !== "NONE",
                    code: event.target.value === "NONE" ? draft.code : event.target.value as AttendanceLeaveCode,
                  } : draft)}
                >
                  <option value="NONE">No leave</option>
                  {leaveDraft.leaveEnabled && (leaveDraft.code === "HO" || leaveDraft.code === "OS") ? (
                    <option value={leaveDraft.code} disabled>
                      {leaveDraft.code} · Legacy work-mode record (remove to replace)
                    </option>
                  ) : null}
                  {LEAVE_CODES.map((code) => <option value={code.value} key={code.value}>{code.label}</option>)}
                </select>
              </label>
              <label>
                Leave portion
                <select
                  value={leaveDraft.portion}
                  disabled={!leaveDraft.leaveEnabled}
                  onChange={(event) => setLeaveDraft((draft) => draft ? { ...draft, portion: event.target.value as LeaveDraft["portion"] } : draft)}
                >
                  <option value="full">Full day</option>
                  <option value="am">AM half-day</option>
                  <option value="pm">PM half-day</option>
                </select>
              </label>
            </div>
            <div className={styles.modalFooter}>
              <span>
                {leaveDraft.entryId ? (
                  <button type="button" className={styles.dangerButton} onClick={() => void deleteLeave()} disabled={pendingAction === "delete-leave"}>
                    {pendingAction === "delete-leave" ? "Deleting…" : "Delete leave"}
                  </button>
                ) : null}
              </span>
              <div>
                <button type="button" className={styles.secondaryButton} onClick={() => setLeaveDraft(null)} disabled={Boolean(pendingAction)}>Cancel</button>
                <button type="button" className={styles.primaryButton} onClick={() => void saveDayEdit()} disabled={pendingAction === "save-day-edit"}>
                  {pendingAction === "save-day-edit" ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {reminderOpen ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !pendingAction) setReminderOpen(false) }}>
          <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="reminder-title">
            <div className={styles.modalHeader}>
              <div>
                <span>MONTHLY CONFIRMATION</span>
                <h2 id="reminder-title">Send reminder</h2>
              </div>
              <button type="button" aria-label="Close reminder" onClick={() => setReminderOpen(false)} disabled={Boolean(pendingAction)}>×</button>
            </div>
            <label className={styles.modalSelect}>
              Month
              <select
                value={reminderMonth}
                onChange={(event) => {
                  setReminderMonth(Number(event.target.value))
                  setReminderSelection(new Set())
                }}
              >
                {closedMonthSections.map(({ month }) => (
                  <option value={month} key={month}>{MONTH_NAMES[month - 1]} {selectedSummaryYear}</option>
                ))}
              </select>
            </label>
            <div className={styles.selectionHeader}>
              <strong>Choose staff</strong>
              <div>
                <button type="button" onClick={() => setReminderSelection(new Set(reminderRecipients.map((row) => row.person.id)))}>Select all</button>
                <button type="button" onClick={() => setReminderSelection(new Set())}>Clear</button>
              </div>
            </div>
            <div className={styles.selectionList}>
              {reminderRecipients.map((row) => (
                <label key={row.person.id}>
                  <input
                    type="checkbox"
                    checked={reminderSelection.has(row.person.id)}
                    onChange={(event) => setReminderSelection((current) => {
                      const next = new Set(current)
                      if (event.target.checked) next.add(row.person.id)
                      else next.delete(row.person.id)
                      return next
                    })}
                  />
                  <span><strong>{row.person.staffCode}</strong>{row.person.displayName}</span>
                </label>
              ))}
              {!reminderRecipients.length ? <div className={styles.selectionEmpty}>Everyone has confirmed this month.</div> : null}
            </div>
            <div className={styles.modalFooter}>
              <span>{selectedReminderPersonIds.length} selected</span>
              <div>
                <button type="button" className={styles.secondaryButton} onClick={() => setReminderOpen(false)} disabled={Boolean(pendingAction)}>Cancel</button>
                <button type="button" className={styles.primaryButton} onClick={() => void sendReminder()} disabled={!selectedReminderPersonIds.length || pendingAction === "send-reminder"}>
                  {pendingAction === "send-reminder" ? "Sending…" : "Send reminder"}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {addUsersOpen ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !pendingAction) setAddUsersOpen(false) }}>
          <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="add-users-title">
            <div className={styles.modalHeader}>
              <div>
                <span>USER MANAGEMENT</span>
                <h2 id="add-users-title">Add attendance users</h2>
              </div>
              <button type="button" aria-label="Close add users" onClick={() => setAddUsersOpen(false)} disabled={Boolean(pendingAction)}>×</button>
            </div>
            <p className={styles.modalNote}>Only User Management accounts in the BT, BS or AC group can be added. Their group is controlled in User Management.</p>
            <div className={styles.selectionHeader}>
              <strong>Available accounts</strong>
              <div>
                <button type="button" onClick={() => setAddUserSelection(new Set(availableUsers.map((user) => user.id)))}>Select all</button>
                <button type="button" onClick={() => setAddUserSelection(new Set())}>Clear</button>
              </div>
            </div>
            <div className={styles.selectionList}>
              {availableUsers.map((user) => (
                <label key={user.id}>
                  <input
                    type="checkbox"
                    checked={addUserSelection.has(user.id)}
                    onChange={(event) => setAddUserSelection((current) => {
                      const next = new Set(current)
                      if (event.target.checked) next.add(user.id)
                      else next.delete(user.id)
                      return next
                    })}
                  />
                  <span><strong>{userStaffCode(user)}</strong>{user.displayName || user.username}</span>
                  <em>{user.attendanceTeam || user.attendanceGroup}</em>
                </label>
              ))}
              {!availableUsers.length ? <div className={styles.selectionEmpty}>All eligible User Management accounts are already included.</div> : null}
            </div>
            <div className={styles.modalFooter}>
              <span>{addUserSelection.size} selected</span>
              <div>
                <button type="button" className={styles.secondaryButton} onClick={() => setAddUsersOpen(false)} disabled={Boolean(pendingAction)}>Cancel</button>
                <button type="button" className={styles.primaryButton} onClick={() => void addSelectedUsers()} disabled={!addUserSelection.size || pendingAction === "add-attendance-users"}>
                  {pendingAction === "add-attendance-users" ? "Adding…" : "Add selected"}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  )
}
