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
type DateTracePopover = {
  label: string
  dates: string[]
  left: number
  top: number
  above: boolean
}
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
  signInTime: string
  signOutTime: string
  initialSignInTime: string
  initialSignOutTime: string
}

type RosterDraftItem = {
  key: string
  personId?: string
  adminUserId?: string
  staffCode: string
  displayName: string
  team: AttendanceGroup
}

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "monthly-record", label: "ATTENDANCE (CURRENT MONTH)" },
  { id: "monthly", label: "MONTHLY STATEMENT" },
  { id: "all-time", label: "ALL TIME RECORD" },
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
  const codeDatesSource = isObject(value.codeDates)
    ? value.codeDates
    : isObject(value.code_dates)
      ? value.code_dates
      : {}
  const codeDates = Object.fromEntries(
    Object.entries(codeDatesSource).map(([code, dates]) => [
      code.toUpperCase(),
      stringArray(dates),
    ]),
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
    codeDates,
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

function traceDates(dates: string[] | undefined) {
  return [...new Set(dates || [])].sort()
}

function displayTraceDate(value: string) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
    weekday: "short",
  }).format(date)
}

function AttendanceLegend() {
  return (
    <aside className={styles.legend} aria-label="Attendance abbreviations and rules">
      <strong>LEGEND &amp; RULES</strong>
      <p><b>ALS</b> annual leave with advance notice · <b>ALU</b> annual leave informed on the day · <b>SLM</b> sick leave with medical certificate · <b>SLR</b> sick leave without medical certificate · <b>SLX</b> sick leave outside policy.</p>
      <p><b>SPL</b> special leave · <b>MTL</b> maternity leave · <b>NPL</b> no-pay leave · <b>HOME</b> home-office attendance · <b>OS</b> overseas/business-trip attendance · <b>HOL</b> holiday attendance.</p>
      <p>BT/BS: before 10:01 is on time, 19:00 finish, AM cutoff 11:30, PM return cutoff 16:30. AC: before 09:01 is on time, 17:30 finish, AM cutoff 11:00, PM return cutoff 15:45. Sign-out before 17:00 is not official. AC does not receive holiday-attendance credit.</p>
    </aside>
  )
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

function editableAttendanceEntry(
  item: ApiAttendanceDailyItem,
  direction: "in" | "out",
) {
  const directionalEntry = leaveEntryForDirection(item, direction)
  if (directionalEntry) return directionalEntry
  const entries = leaveEntries(item)
  // A half-day absence governs the working session shown in the opposite
  // cell: PM leave carries the morning OUT time in the IN cell, while AM
  // leave carries the afternoon IN time in the OUT cell. When there is only
  // one stored status for the day, either cell must therefore edit it.
  if (entries.length === 1) return entries[0]
  // HOME and OS represent one attendance status for the day. Allow either
  // side of the IN/OUT pair to edit the same stored half-day entry, so an AM
  // or PM record can be promoted to Full day without creating a duplicate.
  return entries.find((entry) => entry.code === "HO" || entry.code === "OS")
}

function absenceEntryForPortion(
  item: ApiAttendanceDailyItem,
  portion: "am" | "pm",
) {
  return leaveEntries(item).find(
    (entry) =>
      entry.portion === portion && entry.code !== "HO" && entry.code !== "OS",
  )
}

function halfDayPunchValue(
  item: ApiAttendanceDailyItem,
  direction: "in" | "out",
) {
  const showMorningPair =
    direction === "in" && Boolean(absenceEntryForPortion(item, "pm"))
  const showAfternoonPair =
    direction === "out" &&
    (Boolean(absenceEntryForPortion(item, "am")) || item.automaticAmLeave)
  if (!showMorningPair && !showAfternoonPair) return ""
  return [item.effectiveSignIn, item.effectiveSignOut]
    .filter((value): value is string => Boolean(value))
    .map(displayTime)
    .join("\n")
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
  if (
    item.workModeSource === "leave" &&
    (item.workMode === "home-office" || item.workMode === "business-trip")
  ) return ""
  if (direction === "in" && item.automaticAmLeave) return "AM LEAVE"
  const halfDayPunches = halfDayPunchValue(item, direction)
  if (halfDayPunches) return halfDayPunches
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
  const entry = leaveEntryForDirection(item, direction)
  if (entry) {
    return entry.code === "HO" || entry.code === "OS"
      ? styles.homeOfficeCell
      : styles.leaveCell
  }
  if (
    item.workModeSource === "leave" &&
    (item.workMode === "home-office" || item.workMode === "business-trip")
  ) return ""
  const morningPair =
    direction === "in" && Boolean(absenceEntryForPortion(item, "pm"))
  if (morningPair && (item.effectiveSignIn || item.effectiveSignOut)) {
    return item.early ? styles.lateCell : styles.onTimeCell
  }
  const afternoonPair =
    direction === "out" &&
    (Boolean(absenceEntryForPortion(item, "am")) || item.automaticAmLeave)
  if (afternoonPair && (item.effectiveSignIn || item.effectiveSignOut)) {
    return item.late ? styles.lateCell : styles.onTimeCell
  }
  if (direction === "in" && item.automaticAmLeave) return styles.leaveCell
  if (direction === "in" && item.late) return styles.lateCell
  if (direction === "in" && item.effectiveSignIn) return styles.onTimeCell
  // Every official sign-out (17:00 or later) is acceptable for display,
  // including one before the team's normal finish time.
  if (direction === "out" && item.early && item.effectiveSignOut) return styles.onTimeCell
  if (direction === "out" && item.effectiveSignOut) return styles.onTimeCell
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
  const [selectedSummaryPersonId, setSelectedSummaryPersonId] = useState("all")
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
  const [rosterDraft, setRosterDraft] = useState<RosterDraftItem[]>([])
  const [leaveDraft, setLeaveDraft] = useState<LeaveDraft | null>(null)
  const [dateTrace, setDateTrace] = useState<DateTracePopover | null>(null)
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

  useEffect(() => {
    if (!dateTrace) return
    const timeout = window.setTimeout(() => setDateTrace(null), 8000)
    const close = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest("[data-date-trace-popover]")) return
      setDateTrace(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDateTrace(null)
    }
    window.addEventListener("pointerdown", close)
    window.addEventListener("keydown", closeOnEscape)
    return () => {
      window.clearTimeout(timeout)
      window.removeEventListener("pointerdown", close)
      window.removeEventListener("keydown", closeOnEscape)
    }
  }, [dateTrace])

  function openDateTrace(
    button: HTMLButtonElement,
    label: string,
    dates: string[] | undefined,
  ) {
    const visibleDates = traceDates(dates)
    if (!visibleDates.length) return
    const rect = button.getBoundingClientRect()
    const width = 280
    const above = rect.bottom + 220 > window.innerHeight
    setDateTrace({
      label,
      dates: visibleDates,
      left: Math.min(window.innerWidth - width - 12, Math.max(12, rect.left + rect.width / 2 - width / 2)),
      top: above ? Math.max(12, rect.top - 8) : rect.bottom + 8,
      above,
    })
  }

  function traceableNumber(
    value: number,
    dates: string[] | undefined,
    label: string,
  ) {
    const visibleDates = traceDates(dates)
    if (!visibleDates.length) return displaySummaryDays(value)
    return (
      <button
        type="button"
        className={styles.dateTraceButton}
        aria-label={`${label}: ${displayDays(value)}. Show dates`}
        aria-expanded={dateTrace?.label === label}
        onClick={(event) => {
          event.stopPropagation()
          openDateTrace(event.currentTarget, label, visibleDates)
        }}
      >
        {displaySummaryDays(value)}
      </button>
    )
  }

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

  const summaryPeople = useMemo(() => {
    const peopleById = new Map<string, ApiAttendancePerson>()
    for (const section of monthSections) {
      for (const row of section.rows) peopleById.set(row.person.id, row.person)
    }
    return sortAttendancePeople([...peopleById.values()], staffOrder)
  }, [monthSections, staffOrder])

  const filteredMonthSections = useMemo(
    () => selectedSummaryPersonId === "all"
      ? monthSections
      : monthSections
          .map((section) => ({
            ...section,
            rows: section.rows.filter((row) => row.person.id === selectedSummaryPersonId),
          }))
          .filter((section) => section.rows.length > 0),
    [monthSections, selectedSummaryPersonId],
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
    const matching = record ? editableAttendanceEntry(record, direction) : undefined
    const manualWorkMode = record?.workModeOverride?.mode ||
      (record?.workModeSource === "manual" ? record.workMode : undefined)
    const defaultWorkMode = record?.defaultWorkMode ||
      (!manualWorkMode && record?.workMode
        ? record.workMode
        : "office")
    const displayedWorkMode = manualWorkMode ||
      (record?.holidayAttendance
        ? "office"
        : record?.workMode && record.workMode !== defaultWorkMode
          ? record.workMode
          : undefined)
    const attendanceModeCode = !matching && record?.workMode === "home-office"
      ? "HO"
      : !matching && record?.workMode === "business-trip"
        ? "OS"
        : undefined
    setLeaveDraft({
      personId: person.id,
      staffLabel: `${person.staffCode} · ${person.displayName}`,
      date,
      leaveEnabled: Boolean(matching || attendanceModeCode),
      portion: matching?.portion || (attendanceModeCode ? "full" : direction === "in" ? "am" : "pm"),
      code: matching?.code || attendanceModeCode || "ALS",
      note: matching?.note || "",
      workMode: attendanceModeCode
        ? "default"
        : displayedWorkMode === "home-office" ||
            displayedWorkMode === "office" ||
            displayedWorkMode === "business-trip"
          ? displayedWorkMode
          : "default",
      defaultWorkMode,
      workModeOverrideId: record?.workModeOverride?.id || undefined,
      entryId: matching?.id,
      holiday: Boolean(holiday || record?.holiday),
      signInTime: record?.effectiveSignIn
        ? hktTimeFromTimestamp(record.effectiveSignIn) || ""
        : "",
      signOutTime: record?.effectiveSignOut
        ? hktTimeFromTimestamp(record.effectiveSignOut) || ""
        : "",
      initialSignInTime: record?.effectiveSignIn
        ? hktTimeFromTimestamp(record.effectiveSignIn) || ""
        : "",
      initialSignOutTime: record?.effectiveSignOut
        ? hktTimeFromTimestamp(record.effectiveSignOut) || ""
        : "",
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
      if (
        leaveDraft.signInTime &&
        leaveDraft.signOutTime &&
        leaveDraft.signOutTime <= leaveDraft.signInTime
      ) {
        throw new Error("Sign-out time must be later than sign-in time.")
      }
      const permitsMorningSignOut =
        leaveDraft.leaveEnabled &&
        leaveDraft.portion === "pm" &&
        leaveDraft.code !== "HO" &&
        leaveDraft.code !== "OS"
      if (
        leaveDraft.signOutTime &&
        leaveDraft.signOutTime < "17:00" &&
        !permitsMorningSignOut
      ) {
        throw new Error("Official sign-out time cannot be earlier than 17:00.")
      }
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
          updateSignIn:
            Boolean(leaveDraft.signInTime) &&
            leaveDraft.signInTime !== leaveDraft.initialSignInTime,
          signInTime: leaveDraft.signInTime || undefined,
          updateSignOut:
            Boolean(leaveDraft.signOutTime) &&
            leaveDraft.signOutTime !== leaveDraft.initialSignOutTime,
          signOutTime: leaveDraft.signOutTime || undefined,
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
    setRosterDraft(
      rosterPeople.map((person) => ({
        key: `person:${person.id}`,
        personId: person.id,
        staffCode: person.staffCode,
        displayName: person.displayName,
        team: person.team,
      })),
    )
    setAddUsersOpen(true)
  }

  function moveRosterItem(index: number, direction: -1 | 1) {
    setRosterDraft((current) => {
      const target = index + direction
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  async function saveRoster() {
    const saved = await runMutation(
      "save-roster",
      {
        items: rosterDraft.map((item) => ({
          personId: item.personId,
          adminUserId: item.adminUserId,
        })),
      },
      "Attendance users and display order updated.",
    )
    if (saved) {
      setAddUsersOpen(false)
      await loadAllTime()
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
              onClick={() => {
                setDateTrace(null)
                setActiveTab(tab.id)
              }}
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
            <AttendanceLegend />
          </section>
        ) : null}

        {activeTab === "monthly" ? (
          <section className={styles.tabContent} aria-label="Monthly attendance">
            <div className={styles.yearToolbar}>
              <div className={styles.summaryFilters}>
                <label className={styles.yearSelector}>
                  <span>YEAR</span>
                  <select
                    value={selectedSummaryYear}
                    onChange={(event) => {
                      setSelectedSummaryYear(Number(event.target.value))
                      setSelectedSummaryPersonId("all")
                      setYearData({})
                      setReminderSelection(new Set())
                    }}
                    disabled={yearLoading}
                    aria-label="Monthly attendance year"
                  >
                    {yearOptions.map((year) => <option value={year} key={year}>{year}</option>)}
                  </select>
                </label>
                <label className={styles.userSelector}>
                  <span>USER</span>
                  <select
                    value={selectedSummaryPersonId}
                    onChange={(event) => setSelectedSummaryPersonId(event.target.value)}
                    disabled={yearLoading}
                    aria-label="Monthly attendance user"
                  >
                    <option value="all">ALL USERS</option>
                    {summaryPeople.map((person) => (
                      <option value={person.id} key={person.id}>
                        {person.staffCode}{staffSecondaryLabel(person) ? ` — ${staffSecondaryLabel(person)}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
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
                      <th>ATTEND<br />HOME</th>
                      <th>ATTEND<br />OS</th>
                      <th>ATTENDED<br />DAYS</th>
                      <th>LATE<br />DAYS</th>
                      <th>CONFIRMATION</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredMonthSections.map((section) =>
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
                              return <td key={code} className={summaryNumberClass(value)}>{traceableNumber(value, row.summary?.codeDates?.[code], `${row.person.staffCode} · ${section.label} ${selectedSummaryYear} · ${code}`)}</td>
                            })}
                            <td className={summaryNumberClass(codeTotal(row.summary, "HOL"))}>
                              {traceableNumber(codeTotal(row.summary, "HOL"), row.summary?.codeDates?.HOL, `${row.person.staffCode} · ${section.label} ${selectedSummaryYear} · HOL`)}
                            </td>
                            {SUMMARY_CODES.slice(5).map((code) => {
                              const value = codeTotal(row.summary, code)
                              return <td key={code} className={summaryNumberClass(value)}>{code === "HO" ? displaySummaryDays(value) : traceableNumber(value, row.summary?.codeDates?.[code], `${row.person.staffCode} · ${section.label} ${selectedSummaryYear} · ${code}`)}</td>
                            })}
                            <td className={summaryNumberClass(row.attendedDays, "attended")}>{displaySummaryDays(row.attendedDays)}</td>
                            <td className={summaryNumberClass(row.lateDays, "late")}>{traceableNumber(row.lateDays, row.summary?.lateDates, `${row.person.staffCode} · ${section.label} ${selectedSummaryYear} · LATE`)}</td>
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
                    {!filteredMonthSections.length ? (
                      <tr><td colSpan={16}><div className={styles.emptyState}>No monthly records were found for {selectedSummaryYear}.</div></td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            )}
            <AttendanceLegend />
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
                title={canEdit ? "Add, remove, or arrange attendance users" : "Edit permission required"}
              >
                EDIT
              </button>
            </div>

            {settingsLoading && !settings.people.length ? (
              <div className={styles.inlineLoading}><span className={styles.spinner} aria-hidden="true" />Loading attendance users…</div>
            ) : (
              <>
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
                      <th>HOME</th>
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
                            <small><span>{groupFromUser(linkedUser, person.team)}</span></small>
                          </td>
                          <td className={styles.balanceCell}>{displaySummaryDays(annual?.openingCarryForwardUnits || 0)}</td>
                          <td className={summaryNumberClass(annual?.allowanceUnits || 0)}>{displaySummaryDays(annual?.allowanceUnits || 0)}</td>
                          {SUMMARY_CODES.slice(0, 5).map((code) => (
                            <td key={code} className={summaryNumberClass(annualCodeTotal(annual, code))}>{traceableNumber(annualCodeTotal(annual, code), annual?.codeDates?.[code], `${person.staffCode} · ${selectedAllTimeYear} · ${code}`)}</td>
                          ))}
                          <td className={summaryNumberClass(annualCodeTotal(annual, "HOL"))}>{traceableNumber(annualCodeTotal(annual, "HOL"), annual?.codeDates?.HOL, `${person.staffCode} · ${selectedAllTimeYear} · HOL`)}</td>
                          {SUMMARY_CODES.slice(5).map((code) => (
                            <td key={code} className={summaryNumberClass(annualCodeTotal(annual, code))}>{code === "HO" ? displaySummaryDays(annualCodeTotal(annual, code)) : traceableNumber(annualCodeTotal(annual, code), annual?.codeDates?.[code], `${person.staffCode} · ${selectedAllTimeYear} · ${code}`)}</td>
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
              <AttendanceLegend />
              </>
            )}
          </section>
        ) : null}
      </div>

      {dateTrace ? (
        <aside
          className={`${styles.dateTracePopover} ${dateTrace.above ? styles.dateTracePopoverAbove : ""}`}
          style={{ left: dateTrace.left, top: dateTrace.top }}
          role="status"
          aria-live="polite"
          data-date-trace-popover
        >
          <span>RECORD DATES</span>
          <strong>{dateTrace.label}</strong>
          <ul>
            {dateTrace.dates.map((date) => <li key={date}>{displayTraceDate(date)}</li>)}
          </ul>
          <small>Closes automatically</small>
        </aside>
      ) : null}

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
              <label className={styles.fullField}>
                Attendance status
                <select
                  value={leaveDraft.leaveEnabled
                    ? leaveDraft.code === "HO"
                      ? "mode:home-office"
                      : leaveDraft.code === "OS"
                        ? "mode:business-trip"
                        : `leave:${leaveDraft.code}`
                    : `mode:${leaveDraft.workMode === "default" && !leaveDraft.holiday ? leaveDraft.defaultWorkMode : leaveDraft.workMode}`}
                  onChange={(event) => setLeaveDraft((draft) => {
                    if (!draft) return draft
                    const [kind, value] = event.target.value.split(":")
                    if (kind === "leave") {
                      return {
                        ...draft,
                        leaveEnabled: true,
                        code: value as AttendanceLeaveCode,
                        workMode: "default",
                      }
                    }
                    if (value === "default") {
                      return { ...draft, leaveEnabled: false, workMode: "default" }
                    }
                    if (value === "home-office" || value === "business-trip") {
                      return {
                        ...draft,
                        leaveEnabled: true,
                        code: value === "home-office" ? "HO" : "OS",
                        portion: "full",
                        workMode: "default",
                      }
                    }
                    const selectedMode = value as AttendanceWorkMode
                    return {
                      ...draft,
                      leaveEnabled: false,
                      workMode:
                        selectedMode === draft.defaultWorkMode && !draft.holiday
                          ? "default"
                          : selectedMode,
                    }
                  })}
                >
                  {leaveDraft.holiday ? <option value="mode:default">Not attending holiday</option> : null}
                  <option value="mode:office">{leaveDraft.holiday ? "Holiday attendance" : "Office"}</option>
                  <option value="mode:home-office">Home office</option>
                  <option value="mode:business-trip">Business trip</option>
                  {LEAVE_CODES.map((code) => <option value={`leave:${code.value}`} key={code.value}>{code.label}</option>)}
                </select>
              </label>
              {leaveDraft.leaveEnabled ? (
                <fieldset className={styles.portionField}>
                  <legend>Portion</legend>
                  <div className={styles.portionButtons}>
                    {([
                      ["am", "AM"],
                      ["pm", "PM"],
                      ["full", "Full day"],
                    ] as const).map(([value, label]) => (
                      <button
                        type="button"
                        key={value}
                        className={leaveDraft.portion === value ? styles.portionButtonActive : styles.portionButton}
                        aria-pressed={leaveDraft.portion === value}
                        onClick={() => setLeaveDraft((draft) => draft ? { ...draft, portion: value } : draft)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              <label>
                Sign in
                <input
                  type="time"
                  aria-label="Sign in time"
                  value={leaveDraft.signInTime}
                  onChange={(event) => setLeaveDraft((draft) => draft
                    ? { ...draft, signInTime: event.target.value }
                    : draft)}
                />
              </label>
              <label>
                Sign out
                <input
                  type="time"
                  aria-label="Sign out time"
                  min={
                    leaveDraft.leaveEnabled &&
                    leaveDraft.portion === "pm" &&
                    leaveDraft.code !== "HO" &&
                    leaveDraft.code !== "OS"
                      ? undefined
                      : "17:00"
                  }
                  value={leaveDraft.signOutTime}
                  onChange={(event) => setLeaveDraft((draft) => draft
                    ? { ...draft, signOutTime: event.target.value }
                    : draft)}
                />
              </label>
            </div>
            <div className={styles.modalFooter}>
              <span>
                {leaveDraft.entryId ? (
                  <button type="button" className={styles.dangerButton} onClick={() => void deleteLeave()} disabled={pendingAction === "delete-leave"}>
                    {pendingAction === "delete-leave" ? "Deleting…" : "Delete entry"}
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
                <h2 id="add-users-title">EDIT ATTENDANCE USERS</h2>
              </div>
              <button type="button" aria-label="Close attendance users editor" onClick={() => setAddUsersOpen(false)} disabled={Boolean(pendingAction)}>×</button>
            </div>
            <p className={styles.modalNote}>Add eligible User Management accounts, remove current users, and use the arrows to set their display order. Historical records remain preserved.</p>
            <div className={styles.selectionHeader}>
              <strong>Current attendance users</strong>
            </div>
            <div className={styles.rosterEditorList}>
              {rosterDraft.map((item, index) => (
                <div key={item.key} className={styles.rosterEditorRow}>
                  <span className={styles.rosterPosition}>{index + 1}</span>
                  <span><strong>{item.staffCode}</strong><small>{item.displayName}</small></span>
                  <em>{item.team}</em>
                  <div>
                    <button type="button" onClick={() => moveRosterItem(index, -1)} disabled={index === 0} aria-label={`Move ${item.staffCode} up`}>↑</button>
                    <button type="button" onClick={() => moveRosterItem(index, 1)} disabled={index === rosterDraft.length - 1} aria-label={`Move ${item.staffCode} down`}>↓</button>
                    <button type="button" className={styles.rosterRemoveButton} onClick={() => setRosterDraft((current) => current.filter((entry) => entry.key !== item.key))}>Remove</button>
                  </div>
                </div>
              ))}
            </div>
            {availableUsers.length ? (
              <>
                <div className={styles.selectionHeader}><strong>Available accounts</strong></div>
                <div className={styles.availableRosterUsers}>
                  {availableUsers.filter((user) => !rosterDraft.some((item) => item.adminUserId === user.id)).map((user) => (
                    <button type="button" key={user.id} onClick={() => setRosterDraft((current) => [...current, {
                      key: `user:${user.id}`,
                      adminUserId: user.id,
                      staffCode: userStaffCode(user),
                      displayName: user.displayName || user.username,
                      team: (user.attendanceTeam || user.attendanceGroup) as AttendanceGroup,
                    }])}>
                      + {userStaffCode(user)} <small>{user.displayName || user.username}</small>
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            <div className={styles.modalFooter}>
              <span>{rosterDraft.length} attendance users</span>
              <div>
                <button type="button" className={styles.secondaryButton} onClick={() => setAddUsersOpen(false)} disabled={Boolean(pendingAction)}>Cancel</button>
                <button type="button" className={styles.primaryButton} onClick={() => void saveRoster()} disabled={!rosterDraft.length || pendingAction === "save-roster"}>
                  {pendingAction === "save-roster" ? "Saving…" : "Save users"}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  )
}
