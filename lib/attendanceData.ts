import "server-only"

import { randomUUID } from "node:crypto"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import {
  listManagedAdminUsers,
  type ManagedAdminUser,
} from "@/lib/adminUsers"
import { normalizeEmailList, sendNoticeEmail } from "@/lib/emailNotice"
import {
  attendanceTeamAssignmentForDate,
  attendanceTeamAssignmentOverlapsPeriod,
  hasAttendanceTeamHistory,
  resolveAttendanceTeamForDate,
  type AttendanceTeamAssignment,
} from "@/lib/attendanceTeamHistory"
import {
  ATTENDANCE_MONTHLY_CODES,
  ATTENDANCE_SCHEDULES,
  type AttendanceCheckType,
  type AttendanceLeaveCode,
  type AttendanceLeavePortion,
  type AttendanceMonthlyCode,
  type AttendanceTeam,
  deriveAttendanceExpectation,
  enumerateWeekdays,
  formatIsoDate,
  hktYearMonth,
  hktDateFromTimestamp,
  isAttendanceCheckType,
  isAttendanceLeaveCode,
  isAttendanceLeavePortion,
  isAttendanceMonthlyCode,
  isAttendanceTeam,
  isPersonEmployedOnDate,
  isPersonExpectedOnDate,
  parseIsoDate,
} from "@/lib/attendanceRules"

export class AttendanceValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AttendanceValidationError"
  }
}

export type AttendancePerson = {
  id: string
  adminUserId: string | null
  adminUsername: string | null
  username: string | null
  staffCode: string
  displayName: string
  dingTalkUserId: string | null
  team: AttendanceTeam
  isActive: boolean
  employmentStartDate: string | null
  employmentEndDate: string | null
  createdAt: string
  updatedAt: string
}

export type AttendancePunch = {
  id: string
  checkType: AttendanceCheckType
  punchTime: string
  sourceType: string | null
  deviceSn: string | null
  timeResult: string | null
  locationResult: string | null
}

export type AttendanceLeaveEntry = {
  id: string
  groupId: string
  personId: string
  leaveDate: string
  portion: AttendanceLeavePortion
  code: AttendanceLeaveCode
  units: number
  note: string
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
}

export type AttendanceManualOverride = {
  id: string
  personId: string
  workDate: string
  action: "replace" | "exclude"
  checkType: AttendanceCheckType | null
  punchTime: string | null
  rawPunchId: string | null
  reason: string
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
}

export type AttendanceEntitlement = {
  id: string
  personId: string
  year: number
  allowanceUnits: number
  openingCarryForwardUnits: number
  sourceFileHash: string | null
  note: string
  createdAt: string
  updatedAt: string
}

export type AttendanceMonthlyAdjustment = {
  id: string
  personId: string
  year: number
  month: number
  code: AttendanceMonthlyCode
  units: number
  source: string
  sourceFileHash: string | null
  isConfirmed: boolean
  note: string
  createdAt: string
  updatedAt: string
}

export type AttendanceMonthlyConfirmation = {
  id: string
  personId: string
  year: number
  month: number
  status: "pending" | "confirmed"
  confirmedAt: string | null
  confirmedBy: string | null
  note: string
  createdAt: string
  updatedAt: string
}

export type AttendanceSyncRun = {
  id: string
  startedAt: string
  completedAt: string | null
  windowFrom: string
  windowTo: string
  status: "running" | "succeeded" | "partial" | "failed"
  peopleRequested: number
  batchesAttempted: number
  recordsFetched: number
  recordsInserted: number
  errorSummary: string | null
}

type Row = Record<string, unknown>

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

export function getAttendanceServiceClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: { autoRefreshToken: false, persistSession: false },
    },
  )
}

function asRow(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {}
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value ? value : null
}

function numberValue(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function attendanceTeamFromManagedUser(user: ManagedAdminUser | undefined) {
  if (!user) return null
  return isAttendanceTeam(user.attendanceGroup) ? user.attendanceGroup : null
}

function mapPerson(
  value: unknown,
  managedUser?: ManagedAdminUser,
): AttendancePerson {
  const row = asRow(value)
  const managedTeam = attendanceTeamFromManagedUser(managedUser)
  return {
    id: String(row.id),
    adminUserId: stringOrNull(row.admin_user_id),
    adminUsername: managedUser?.username || null,
    username: managedUser?.username || null,
    staffCode: String(row.staff_code),
    displayName: managedUser?.displayName || String(row.display_name),
    dingTalkUserId: stringOrNull(row.dingtalk_user_id),
    team: managedTeam || (String(row.team) as AttendanceTeam),
    isActive:
      Boolean(row.is_active) &&
      (managedUser ? managedUser.isActive && Boolean(managedTeam) : true),
    employmentStartDate: stringOrNull(row.employment_start_date),
    employmentEndDate: stringOrNull(row.employment_end_date),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

async function managedAdminUsersById() {
  const users = await listManagedAdminUsers()
  return {
    users,
    byId: new Map(users.map((user) => [user.id, user])),
  }
}

function mapPeopleWithManagedUsers(
  rows: unknown[],
  usersById: Map<string, ManagedAdminUser>,
) {
  return rows.map((value) => {
    const row = asRow(value)
    const adminUserId = stringOrNull(row.admin_user_id)
    return mapPerson(
      value,
      adminUserId ? usersById.get(adminUserId) : undefined,
    )
  })
}

function mapTeamAssignment(value: unknown): AttendanceTeamAssignment {
  const row = asRow(value)
  return {
    id: String(row.id),
    personId: String(row.person_id),
    team: String(row.team) as AttendanceTeam,
    effectiveFrom: String(row.effective_from),
    effectiveTo: stringOrNull(row.effective_to),
    sourceAdminUserId: stringOrNull(row.source_admin_user_id),
  }
}

function mapPunch(value: unknown): AttendancePunch {
  const row = asRow(value)
  return {
    id: String(row.id),
    checkType: String(row.check_type) as AttendanceCheckType,
    punchTime: String(row.punch_time),
    sourceType: stringOrNull(row.source_type),
    deviceSn: stringOrNull(row.device_sn),
    timeResult: stringOrNull(row.time_result),
    locationResult: stringOrNull(row.location_result),
  }
}

function mapLeave(value: unknown): AttendanceLeaveEntry {
  const row = asRow(value)
  return {
    id: String(row.id),
    groupId: String(row.entry_group_id),
    personId: String(row.person_id),
    leaveDate: String(row.leave_date),
    portion: String(row.portion) as AttendanceLeavePortion,
    code: String(row.code) as AttendanceLeaveCode,
    units: numberValue(row.units),
    note: String(row.note || ""),
    createdBy: String(row.created_by),
    updatedBy: String(row.updated_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function mapOverride(value: unknown): AttendanceManualOverride {
  const row = asRow(value)
  return {
    id: String(row.id),
    personId: String(row.person_id),
    workDate: String(row.work_date),
    action: String(row.action) as "replace" | "exclude",
    checkType: stringOrNull(row.check_type) as AttendanceCheckType | null,
    punchTime: stringOrNull(row.punch_time),
    rawPunchId: stringOrNull(row.raw_punch_id),
    reason: String(row.reason),
    createdBy: String(row.created_by),
    updatedBy: String(row.updated_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function mapEntitlement(value: unknown): AttendanceEntitlement {
  const row = asRow(value)
  return {
    id: String(row.id),
    personId: String(row.person_id),
    year: numberValue(row.year),
    allowanceUnits: numberValue(row.allowance_units),
    openingCarryForwardUnits: numberValue(row.opening_carry_forward_units),
    sourceFileHash: stringOrNull(row.source_file_hash),
    note: String(row.note || ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function mapAdjustment(value: unknown): AttendanceMonthlyAdjustment {
  const row = asRow(value)
  return {
    id: String(row.id),
    personId: String(row.person_id),
    year: numberValue(row.year),
    month: numberValue(row.month),
    code: String(row.code) as AttendanceMonthlyCode,
    units: numberValue(row.units),
    source: String(row.source),
    sourceFileHash: stringOrNull(row.source_file_hash),
    isConfirmed: Boolean(row.is_confirmed),
    note: String(row.note || ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function mapConfirmation(value: unknown): AttendanceMonthlyConfirmation {
  const row = asRow(value)
  return {
    id: String(row.id),
    personId: String(row.person_id),
    year: numberValue(row.year),
    month: numberValue(row.month),
    status: String(row.status) as "pending" | "confirmed",
    confirmedAt: stringOrNull(row.confirmed_at),
    confirmedBy: stringOrNull(row.confirmed_by),
    note: String(row.note || ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function mapSyncRun(value: unknown): AttendanceSyncRun {
  const row = asRow(value)
  return {
    id: String(row.id),
    startedAt: String(row.started_at),
    completedAt: stringOrNull(row.completed_at),
    windowFrom: String(row.window_from),
    windowTo: String(row.window_to),
    status: String(row.status) as AttendanceSyncRun["status"],
    peopleRequested: numberValue(row.people_requested),
    batchesAttempted: numberValue(row.batches_attempted),
    recordsFetched: numberValue(row.records_fetched),
    recordsInserted: numberValue(row.records_inserted),
    errorSummary: stringOrNull(row.error_summary),
  }
}

function throwIfError(error: { message?: string } | null, fallback: string) {
  if (error) throw new Error(error.message || fallback)
}

async function loadAttendancePunchRows(
  client: SupabaseClient,
  fromDate?: string,
  toDate?: string,
) {
  const pageSize = 1_000
  const rows: unknown[] = []
  for (let offset = 0; ; offset += pageSize) {
    let query = client
      .from("attendance_raw_punches")
      .select(
        "id,person_id,check_type,punch_time,work_date,source_type,device_sn,time_result,location_result",
      )
      .order("punch_time")
      .order("id")
      .range(offset, offset + pageSize - 1)
    if (fromDate) query = query.gte("work_date", fromDate)
    if (toDate) query = query.lte("work_date", toDate)
    const { data, error } = await query
    throwIfError(error, "Could not load attendance punches.")
    const page = data || []
    rows.push(...page)
    if (page.length < pageSize) return rows
  }
}

function requireYear(value: unknown, fallback = hktYearMonth().year) {
  const year = value === undefined || value === null || value === "" ? fallback : Number(value)
  if (!Number.isInteger(year) || year < 2000 || year > 2200) {
    throw new AttendanceValidationError("Year must be between 2000 and 2200.")
  }
  return year
}

function requireMonth(value: unknown, fallback = hktYearMonth().month) {
  const month = value === undefined || value === null || value === "" ? fallback : Number(value)
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new AttendanceValidationError("Month must be between 1 and 12.")
  }
  return month
}

export function isClosedAttendanceMonth(
  year: number,
  month: number,
  now = new Date(),
) {
  const current = hktYearMonth(now)
  return year < current.year || (year === current.year && month < current.month)
}

function requireUuid(value: unknown, fieldName: string) {
  const text = typeof value === "string" ? value.trim() : ""
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new AttendanceValidationError(`${fieldName} is invalid.`)
  }
  return text
}

function optionalUuid(value: unknown, fieldName: string) {
  return value === undefined || value === null || value === ""
    ? null
    : requireUuid(value, fieldName)
}

function requireText(value: unknown, fieldName: string, maxLength = 500) {
  const text = typeof value === "string" ? value.trim() : ""
  if (!text) throw new AttendanceValidationError(`${fieldName} is required.`)
  if (text.length > maxLength) {
    throw new AttendanceValidationError(`${fieldName} is too long.`)
  }
  return text
}

function optionalText(value: unknown, maxLength = 2000) {
  if (value === undefined || value === null) return ""
  if (typeof value !== "string") {
    throw new AttendanceValidationError("Text fields must be strings.")
  }
  const text = value.trim()
  if (text.length > maxLength) throw new AttendanceValidationError("A text field is too long.")
  return text
}

function requireDate(value: unknown, fieldName: string) {
  const text = typeof value === "string" ? value : ""
  if (!parseIsoDate(text)) {
    throw new AttendanceValidationError(`${fieldName} must use YYYY-MM-DD.`)
  }
  return text
}

function requireFiniteNumber(
  value: unknown,
  fieldName: string,
  minimum: number,
  maximum: number,
) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new AttendanceValidationError(
      `${fieldName} must be between ${minimum} and ${maximum}.`,
    )
  }
  return Math.round(number * 100) / 100
}

export async function listAttendancePeople(includeInactive = true) {
  let query = getAttendanceServiceClient()
    .from("attendance_people")
    .select("*")
    .order("staff_code")
  if (!includeInactive) query = query.eq("is_active", true)
  const [{ data, error }, managed] = await Promise.all([
    query,
    managedAdminUsersById(),
  ])
  throwIfError(error, "Could not load attendance people.")
  return mapPeopleWithManagedUsers(data || [], managed.byId)
}

function dateRangeForMonth(year: number, month: number) {
  const start = `${year}-${String(month).padStart(2, "0")}-01`
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`
  const next = parseIsoDate(nextMonth)!.date
  const end = new Date(next.getTime() - 24 * 60 * 60 * 1000)
  return { start, end: `${year}-${String(end.getUTCMonth() + 1).padStart(2, "0")}-${String(end.getUTCDate()).padStart(2, "0")}` }
}

type AttendancePunchRow = {
  personId: string
  workDate: string
  punch: AttendancePunch
}

function buildAttendanceRecord(
  person: AttendancePerson,
  workDate: string,
  rawPunchRows: AttendancePunchRow[],
  overrides: AttendanceManualOverride[],
  leaves: AttendanceLeaveEntry[],
  teamAssignments: AttendanceTeamAssignment[],
) {
  const personPunchRows = rawPunchRows.filter(
    (entry) => entry.personId === person.id && entry.workDate === workDate,
  )
  const personOverrides = overrides.filter(
    (entry) => entry.personId === person.id && entry.workDate === workDate,
  )
  const personLeaves = leaves.filter(
    (entry) => entry.personId === person.id && entry.leaveDate === workDate,
  )
  const excludedPunchIds = new Set(
    personOverrides
      .filter((entry) => entry.action === "exclude" && entry.rawPunchId)
      .map((entry) => entry.rawPunchId as string),
  )
  const punches = personPunchRows
    .map(({ punch }) => punch)
    .filter((punch) => !excludedPunchIds.has(punch.id))

  const effectiveTime = (checkType: AttendanceCheckType) => {
    const replacement = personOverrides.find(
      (entry) => entry.action === "replace" && entry.checkType === checkType,
    )
    if (replacement?.punchTime) return replacement.punchTime
    const matching = punches
      .filter((punch) => punch.checkType === checkType)
      .sort((left, right) => Date.parse(left.punchTime) - Date.parse(right.punchTime))
    if (checkType === "OnDuty") return matching[0]?.punchTime || null
    return matching.at(-1)?.punchTime || null
  }

  const effectiveSignIn = effectiveTime("OnDuty")
  const effectiveSignOut = effectiveTime("OffDuty")
  const datedAssignment = attendanceTeamAssignmentForDate(
    person.id,
    workDate,
    teamAssignments,
  )
  const hasTeamHistory = hasAttendanceTeamHistory(person.id, teamAssignments)
  const team = resolveAttendanceTeamForDate(
    person.id,
    workDate,
    person.team,
    teamAssignments,
  )
  const schedule = ATTENDANCE_SCHEDULES[team]
  const expectation = deriveAttendanceExpectation({
    workDate,
    team,
    leavePortions: personLeaves.map((entry) => entry.portion),
    effectiveSignIn,
    effectiveSignOut,
    required:
      isPersonExpectedOnDate(workDate, person) &&
      (!hasTeamHistory || Boolean(datedAssignment)),
  })
  const effectiveExpectation =
    workDate > hktDateFromTimestamp(new Date()) &&
    expectation.status !== "leave" &&
    expectation.status !== "rest-day"
      ? { ...expectation, status: "pending", late: false, early: false }
      : expectation

  return {
    date: workDate,
    person: team === person.team ? person : { ...person, team },
    schedule,
    punches,
    overrides: personOverrides,
    leave: personLeaves,
    effectiveSignIn,
    effectiveSignOut,
    ...effectiveExpectation,
  }
}

export async function getDailyAttendance(date: string) {
  const workDate = requireDate(date, "Date")
  const supabase = getAttendanceServiceClient()
  const [
    peopleResult,
    punchResult,
    overrideResult,
    leaveResult,
    teamAssignmentResult,
    managed,
  ] = await Promise.all([
    supabase.from("attendance_people").select("*").order("staff_code"),
    supabase.from("attendance_raw_punches").select("*").eq("work_date", workDate).order("punch_time"),
    supabase.from("attendance_manual_overrides").select("*").eq("work_date", workDate).order("created_at"),
    supabase.from("attendance_leave_entries").select("*").eq("leave_date", workDate).order("created_at"),
    supabase
      .from("attendance_team_assignments")
      .select("*")
      .lte("effective_from", workDate)
      .order("effective_from"),
    managedAdminUsersById(),
  ])
  throwIfError(peopleResult.error, "Could not load attendance people.")
  throwIfError(punchResult.error, "Could not load attendance punches.")
  throwIfError(overrideResult.error, "Could not load attendance overrides.")
  throwIfError(leaveResult.error, "Could not load leave entries.")
  throwIfError(
    teamAssignmentResult.error,
    "Could not load attendance group history.",
  )

  const allPeople = mapPeopleWithManagedUsers(peopleResult.data || [], managed.byId)
  const rawPunchRows = (punchResult.data || []).map((value) => {
    const row = asRow(value)
    return {
      personId: String(row.person_id),
      workDate: String(row.work_date),
      punch: mapPunch(value),
    }
  })
  const overrides = (overrideResult.data || []).map(mapOverride)
  const leaves = (leaveResult.data || []).map(mapLeave)
  const teamAssignments = (teamAssignmentResult.data || []).map(
    mapTeamAssignment,
  )
  const people = allPeople.filter((person) =>
    hasAttendanceTeamHistory(person.id, teamAssignments)
      ? Boolean(
          attendanceTeamAssignmentForDate(
            person.id,
            workDate,
            teamAssignments,
          ),
        )
      : isPersonEmployedOnDate(workDate, person),
  )

  const records = people.map((person) =>
    buildAttendanceRecord(
      person,
      workDate,
      rawPunchRows,
      overrides,
      leaves,
      teamAssignments,
    ),
  )

  return { view: "daily" as const, date: workDate, people, records }
}

export async function getAttendanceLeave(yearInput: unknown) {
  const year = requireYear(yearInput)
  const supabase = getAttendanceServiceClient()
  const [peopleResult, leaveResult, managed] = await Promise.all([
    supabase.from("attendance_people").select("*").order("staff_code"),
    supabase
      .from("attendance_leave_entries")
      .select("*")
      .gte("leave_date", `${year}-01-01`)
      .lte("leave_date", `${year}-12-31`)
      .order("leave_date", { ascending: false }),
    managedAdminUsersById(),
  ])
  throwIfError(peopleResult.error, "Could not load attendance people.")
  throwIfError(leaveResult.error, "Could not load leave entries.")
  return {
    view: "leave" as const,
    year,
    people: mapPeopleWithManagedUsers(peopleResult.data || [], managed.byId),
    leaveEntries: (leaveResult.data || []).map(mapLeave),
  }
}

function emptyCodeTotals() {
  return Object.fromEntries(
    ATTENDANCE_MONTHLY_CODES.map((code) => [code, 0]),
  ) as Record<AttendanceMonthlyCode, number>
}

function addCodeTotal(
  target: Record<AttendanceMonthlyCode, number>,
  code: AttendanceMonthlyCode,
  units: number,
) {
  target[code] = Math.round((target[code] + units) * 100) / 100
}

function calendarDates(fromDate: string, toDate: string) {
  const from = parseIsoDate(fromDate)
  const to = parseIsoDate(toDate)
  if (!from || !to || from.date > to.date) return []
  const dates: string[] = []
  for (
    let cursor = from.date;
    cursor <= to.date;
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
  ) {
    dates.push(formatIsoDate(cursor))
  }
  return dates
}

function calendarDay(date: string, today: string) {
  const parsed = parseIsoDate(date)!
  const weekdayNumber = parsed.date.getUTCDay()
  return {
    date,
    day: parsed.day,
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekdayNumber],
    isWeekend: weekdayNumber === 0 || weekdayNumber === 6,
    isFuture: date > today,
  }
}

function personOverlapsPeriod(
  person: AttendancePerson,
  fromDate: string,
  toDate: string,
  teamAssignments: AttendanceTeamAssignment[],
) {
  if (hasAttendanceTeamHistory(person.id, teamAssignments)) {
    return attendanceTeamAssignmentOverlapsPeriod(
      person.id,
      fromDate,
      toDate,
      teamAssignments,
    )
  }
  if (person.employmentStartDate && person.employmentStartDate > toDate) return false
  if (person.employmentEndDate && person.employmentEndDate < fromDate) return false
  return person.isActive || person.employmentEndDate !== null
}

function countsAsAttended(record: ReturnType<typeof buildAttendanceRecord>) {
  return Boolean(
    record.required &&
      record.status !== "leave" &&
      record.effectiveSignIn,
  )
}

export async function getMonthlyAttendance(
  yearInput: unknown,
  monthInput: unknown,
  viewer: {
    adminUserId?: string | null
    canEdit?: boolean
    includeYearSummary?: boolean
  } = {},
) {
  const year = requireYear(yearInput)
  const month = requireMonth(monthInput)
  const periodClosed = isClosedAttendanceMonth(year, month)
  const monthRange = dateRangeForMonth(year, month)
  const yearStart = `${year}-01-01`
  const today = hktDateFromTimestamp(new Date())
  const calendarDays = calendarDates(monthRange.start, monthRange.end)
    .map((date) => calendarDay(date, today))
    .filter((day) => !day.isWeekend)
  const yearToDateDates = calendarDates(yearStart, monthRange.end).filter(
    (date) => {
      const day = calendarDay(date, today)
      return !day.isWeekend
    },
  )
  const supabase = getAttendanceServiceClient()
  const [
    peopleResult,
    entitlementResult,
    adjustmentResult,
    leaveResult,
    confirmationResult,
    punchRows,
    overrideResult,
    reminderResult,
    teamAssignmentResult,
    managed,
  ] =
    await Promise.all([
      supabase.from("attendance_people").select("*").order("staff_code"),
      supabase.from("attendance_entitlements").select("*").eq("year", year),
      supabase
        .from("attendance_monthly_adjustments")
        .select("*")
        .eq("year", year)
        .lte("month", month),
      supabase
        .from("attendance_leave_entries")
        .select("*")
        .gte("leave_date", yearStart)
        .lte("leave_date", monthRange.end),
      supabase
        .from("attendance_monthly_confirmations")
        .select("*")
        .eq("year", year)
        .order("month"),
      loadAttendancePunchRows(supabase, yearStart, monthRange.end),
      supabase
        .from("attendance_manual_overrides")
        .select("*")
        .gte("work_date", yearStart)
        .lte("work_date", monthRange.end)
        .order("created_at"),
      supabase
        .from("attendance_reminder_dispatches")
        .select("person_id,requested_at,status")
        .eq("year", year)
        .eq("month", month)
        .eq("status", "sent")
        .order("requested_at", { ascending: false }),
      supabase
        .from("attendance_team_assignments")
        .select("*")
        .order("effective_from"),
      managedAdminUsersById(),
    ])
  throwIfError(peopleResult.error, "Could not load attendance people.")
  throwIfError(entitlementResult.error, "Could not load entitlements.")
  throwIfError(adjustmentResult.error, "Could not load monthly attendance totals.")
  throwIfError(leaveResult.error, "Could not load leave entries.")
  throwIfError(confirmationResult.error, "Could not load monthly confirmations.")
  throwIfError(overrideResult.error, "Could not load attendance overrides.")
  throwIfError(reminderResult.error, "Could not load attendance reminders.")
  throwIfError(
    teamAssignmentResult.error,
    "Could not load attendance group history.",
  )

  const allPeople = mapPeopleWithManagedUsers(
    peopleResult.data || [],
    managed.byId,
  )
  const entitlements = (entitlementResult.data || []).map(mapEntitlement)
  const adjustments = (adjustmentResult.data || []).map(mapAdjustment)
  const leaveEntries = (leaveResult.data || []).map(mapLeave)
  const confirmations = (confirmationResult.data || []).map(mapConfirmation)
  const punches: AttendancePunchRow[] = punchRows.map((value) => {
    const row = asRow(value)
    return {
      personId: String(row.person_id),
      workDate: String(row.work_date),
      punch: mapPunch(value),
    }
  })
  const overrides = (overrideResult.data || []).map(mapOverride)
  const reminderRows = (reminderResult.data || []).map(asRow)
  const teamAssignments = (teamAssignmentResult.data || []).map(
    mapTeamAssignment,
  )
  const yearPeople = allPeople.filter((person) =>
    personOverlapsPeriod(person, yearStart, monthRange.end, teamAssignments),
  )
  const people = yearPeople.filter((person) =>
    personOverlapsPeriod(
      person,
      monthRange.start,
      monthRange.end,
      teamAssignments,
    ),
  )

  const personContexts = new Map(
    yearPeople.map((person) => {
      const personAdjustments = adjustments.filter(
        (entry) => entry.personId === person.id,
      )
      const personLeaves = leaveEntries.filter(
        (entry) => entry.personId === person.id,
      )
      const personConfirmations = confirmations.filter(
        (entry) => entry.personId === person.id,
      )
      const yearRecords = yearToDateDates.map((date) =>
        buildAttendanceRecord(
          person,
          date,
          punches,
          overrides,
          leaveEntries,
          teamAssignments,
        ),
      )
      return [
        person.id,
        {
          personAdjustments,
          personLeaves,
          personConfirmations,
          yearRecords,
        },
      ] as const
    }),
  )

  function buildMonthlySummary(person: AttendancePerson, targetMonth: number) {
    const context = personContexts.get(person.id)!
    const targetRange = dateRangeForMonth(year, targetMonth)
    const entitlement = entitlements.find((entry) => entry.personId === person.id) || null
    const selectedTotals = emptyCodeTotals()
    const ytdTotals = emptyCodeTotals()

    context.personAdjustments.forEach((entry) => {
      if (entry.month <= targetMonth) addCodeTotal(ytdTotals, entry.code, entry.units)
      if (entry.month === targetMonth) {
        addCodeTotal(selectedTotals, entry.code, entry.units)
      }
    })
    context.personLeaves.forEach((entry) => {
      if (entry.leaveDate <= targetRange.end) {
        addCodeTotal(ytdTotals, entry.code, entry.units)
      }
      if (entry.leaveDate >= targetRange.start && entry.leaveDate <= targetRange.end) {
        addCodeTotal(selectedTotals, entry.code, entry.units)
      }
    })

    const balance = Math.round(
      ((entitlement?.openingCarryForwardUnits || 0) +
        (entitlement?.allowanceUnits || 0) +
        ytdTotals.HOL -
        ytdTotals.ALS -
        ytdTotals.ALU -
        ytdTotals.SLX) *
        100,
    ) / 100
    const yearRecords = context.yearRecords.filter(
      (record) => record.date <= targetRange.end,
    )
    const records = yearRecords.filter(
      (record) => record.date >= targetRange.start,
    )
    const attendedDays = records.filter(countsAsAttended).length
    const lateDays = records.filter((record) => record.required && record.late).length
    const yearToDateAttendedDays = yearRecords.filter(countsAsAttended).length
    const yearToDateLateDays = yearRecords.filter(
      (record) => record.required && record.late,
    ).length
    const confirmation =
      context.personConfirmations.find((entry) => entry.month === targetMonth) || null
    const lastReminderAt = stringOrNull(
      targetMonth === month
        ? reminderRows.find((entry) => String(entry.person_id) === person.id)
            ?.requested_at
        : null,
    )

    return {
      person,
      entitlement,
      codeTotals: selectedTotals,
      yearToDateCodeTotals: ytdTotals,
      balance,
      records,
      attendedDays,
      lateDays,
      yearToDateAttendedDays,
      yearToDateLateDays,
      confirmation,
      confirmations: Array.from({ length: 12 }, (_, index) => {
        const confirmationForMonth = context.personConfirmations.find(
          (entry) => entry.month === index + 1,
        )
        return {
          month: index + 1,
          status: confirmationForMonth?.status || "pending",
          confirmedAt: confirmationForMonth?.confirmedAt || null,
          confirmedBy: confirmationForMonth?.confirmedBy || null,
        }
      }),
      lastReminderAt,
      isCurrentUser: Boolean(
        viewer.adminUserId && person.adminUserId === viewer.adminUserId,
      ),
      canConfirm: Boolean(
        isClosedAttendanceMonth(year, targetMonth) &&
          (viewer.canEdit ||
            (viewer.adminUserId && person.adminUserId === viewer.adminUserId)),
      ),
    }
  }

  const summaries = people.map((person) => buildMonthlySummary(person, month))
  const months = viewer.includeYearSummary
    ? Array.from({ length: month }, (_, index) => {
        const targetMonth = index + 1
        const targetRange = dateRangeForMonth(year, targetMonth)
        const targetPeople = yearPeople.filter((person) =>
          personOverlapsPeriod(
            person,
            targetRange.start,
            targetRange.end,
            teamAssignments,
          ),
        )
        return {
          month: targetMonth,
          periodClosed: isClosedAttendanceMonth(year, targetMonth),
          summaries: targetPeople.map((person) => {
            const summary = buildMonthlySummary(person, targetMonth)
            return {
              person: summary.person,
              codeTotals: summary.codeTotals,
              attendedDays: summary.attendedDays,
              lateDays: summary.lateDays,
              confirmation: summary.confirmation,
              isCurrentUser: summary.isCurrentUser,
              canConfirm: summary.canConfirm,
              lastReminderAt: summary.lastReminderAt,
            }
          }),
        }
      })
    : undefined

  return {
    view: "monthly" as const,
    year,
    month,
    periodClosed,
    calendarDays,
    dailyRecords: summaries.flatMap((summary) => summary.records),
    people,
    summaries,
    ...(months ? { months } : {}),
  }
}

function suggestedStaffCode(user: ManagedAdminUser) {
  const display = user.displayName.trim().toUpperCase()
  if (/^[A-Z0-9][A-Z0-9_-]{0,15}$/.test(display)) return display
  const initials = display
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 16)
  if (/^[A-Z0-9][A-Z0-9_-]{0,15}$/.test(initials)) return initials
  const usernamePrefix = user.username.split("@")[0].toUpperCase()
  return usernamePrefix.replace(/[^A-Z0-9_-]/g, "").slice(0, 16)
}

export async function getAllTimeAttendance(
  yearInput: unknown,
  options: { includeAvailableUsers?: boolean } = {},
) {
  const year = requireYear(yearInput)
  const supabase = getAttendanceServiceClient()
  const [
    peopleResult,
    entitlementResult,
    adjustmentResult,
    syncResult,
    punchRows,
    overrideResult,
    leaveResult,
    teamAssignmentResult,
    managed,
  ] = await Promise.all([
    supabase.from("attendance_people").select("*").order("staff_code"),
    supabase.from("attendance_entitlements").select("*").eq("year", year),
    supabase
      .from("attendance_monthly_adjustments")
      .select("*")
      .eq("year", year)
      .order("month", { ascending: false }),
    supabase
      .from("attendance_sync_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(20),
    loadAttendancePunchRows(supabase),
    supabase.from("attendance_manual_overrides").select("*").order("work_date"),
    supabase.from("attendance_leave_entries").select("*").order("leave_date"),
    supabase
      .from("attendance_team_assignments")
      .select("*")
      .order("effective_from"),
    managedAdminUsersById(),
  ])
  throwIfError(peopleResult.error, "Could not load attendance people.")
  throwIfError(entitlementResult.error, "Could not load entitlements.")
  throwIfError(adjustmentResult.error, "Could not load monthly attendance totals.")
  throwIfError(syncResult.error, "Could not load attendance sync history.")
  throwIfError(overrideResult.error, "Could not load attendance overrides.")
  throwIfError(leaveResult.error, "Could not load leave entries.")
  throwIfError(
    teamAssignmentResult.error,
    "Could not load attendance group history.",
  )
  const allPeople = mapPeopleWithManagedUsers(
    peopleResult.data || [],
    managed.byId,
  )
  const activePeople = allPeople.filter((person) => person.isActive)
  const activeAdminUserIds = new Set(
    activePeople.flatMap((person) =>
      person.adminUserId ? [person.adminUserId] : [],
    ),
  )
  const availableUsers = options.includeAvailableUsers
    ? managed.users
        .filter(
          (user) =>
            user.isActive &&
            Boolean(attendanceTeamFromManagedUser(user)) &&
            !activeAdminUserIds.has(user.id),
        )
        .map((user) => {
          const attendanceTeam = attendanceTeamFromManagedUser(user)
          return {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            role: user.role,
            attendanceTeam,
            suggestedStaffCode: suggestedStaffCode(user),
            eligible: Boolean(attendanceTeam),
          }
        })
    : []
  const punches: AttendancePunchRow[] = punchRows.map((value) => {
    const row = asRow(value)
    return {
      personId: String(row.person_id),
      workDate: String(row.work_date),
      punch: mapPunch(value),
    }
  })
  const overrides = (overrideResult.data || []).map(mapOverride)
  const leaves = (leaveResult.data || []).map(mapLeave)
  const teamAssignments = (teamAssignmentResult.data || []).map(
    mapTeamAssignment,
  )
  const allTimeSummaries = activePeople.map((person) => {
    const dates = [
      ...new Set([
        ...punches
          .filter((entry) => entry.personId === person.id)
          .map((entry) => entry.workDate),
        ...overrides
          .filter((entry) => entry.personId === person.id)
          .map((entry) => entry.workDate),
      ]),
    ].sort()
    const records = dates.map((date) =>
      buildAttendanceRecord(
        person,
        date,
        punches,
        overrides,
        leaves,
        teamAssignments,
      ),
    )
    return {
      personId: person.id,
      firstAttendanceDate: dates[0] || null,
      lastAttendanceDate: dates.at(-1) || null,
      attendedDays: records.filter(countsAsAttended).length,
      lateDays: records.filter((record) => record.required && record.late).length,
    }
  })
  return {
    view: "all-time" as const,
    year,
    people: activePeople,
    availableUsers,
    allTimeSummaries,
    entitlements: (entitlementResult.data || []).map(mapEntitlement),
    monthlyAdjustments: (adjustmentResult.data || []).map(mapAdjustment),
    syncRuns: (syncResult.data || []).map(mapSyncRun),
    schedules: Object.values(ATTENDANCE_SCHEDULES),
  }
}

export async function getAttendanceSettings(
  yearInput: unknown,
  options: { includeAvailableUsers?: boolean } = {},
) {
  const response = await getAllTimeAttendance(yearInput, options)
  return { ...response, view: "settings" as const }
}

export async function saveAttendancePerson(
  client: SupabaseClient,
  input: unknown,
) {
  const row = asRow(input)
  const id = optionalUuid(row.id, "Person id")
  const adminUserId = requireUuid(row.adminUserId, "User Management user id")
  const managedUsers = await listManagedAdminUsers()
  const managedUser = managedUsers.find((user) => user.id === adminUserId)
  if (!managedUser || !managedUser.isActive) {
    throw new AttendanceValidationError(
      "Select an active user from User Management.",
    )
  }
  const attendanceTeam = attendanceTeamFromManagedUser(managedUser)
  if (!attendanceTeam) {
    throw new AttendanceValidationError(
      "Assign this user an AC, BS, or BT attendance group in User Management first.",
    )
  }
  const staffCode = suggestedStaffCode(managedUser)
  if (!/^[A-Z0-9][A-Z0-9_-]{0,15}$/.test(staffCode)) {
    throw new AttendanceValidationError(
      "The User Management display name cannot produce valid staff initials.",
    )
  }
  const hasDingTalkUserId = Object.prototype.hasOwnProperty.call(
    row,
    "dingTalkUserId",
  )
  const requestedDingTalkUserId = row.dingTalkUserId
    ? requireText(row.dingTalkUserId, "DingTalk user id", 128)
    : null

  let existing: Row | null = null
  if (id) {
    const { data, error } = await client
      .from("attendance_people")
      .select("*")
      .eq("id", id)
      .maybeSingle()
    throwIfError(error, "Could not load attendance person.")
    existing = data ? asRow(data) : null
    if (!existing) throw new AttendanceValidationError("Attendance person was not found.")
    const existingAdminUserId = stringOrNull(existing.admin_user_id)
    if (existingAdminUserId && existingAdminUserId !== adminUserId) {
      throw new AttendanceValidationError(
        "This attendance person is already linked to another User Management account.",
      )
    }
  } else {
    const { data: linked, error: linkedError } = await client
      .from("attendance_people")
      .select("*")
      .eq("admin_user_id", adminUserId)
      .maybeSingle()
    throwIfError(linkedError, "Could not load attendance person.")
    existing = linked ? asRow(linked) : null
    if (!existing) {
      const { data: legacy, error: legacyError } = await client
        .from("attendance_people")
        .select("*")
        .eq("staff_code", staffCode)
        .is("admin_user_id", null)
        .maybeSingle()
      throwIfError(legacyError, "Could not load the legacy attendance person.")
      existing = legacy ? asRow(legacy) : null
    }
  }

  const values = {
    admin_user_id: adminUserId,
    staff_code: existing ? String(existing.staff_code) : staffCode,
    display_name: managedUser.displayName,
    dingtalk_user_id: hasDingTalkUserId
      ? requestedDingTalkUserId
      : stringOrNull(existing?.dingtalk_user_id),
    team: attendanceTeam,
    is_active: true,
    employment_start_date:
      stringOrNull(existing?.employment_start_date) || hktDateFromTimestamp(new Date()),
    employment_end_date: null,
  }
  const targetId = existing ? String(existing.id) : null
  const query = targetId
    ? client.from("attendance_people").update(values).eq("id", targetId)
    : client.from("attendance_people").insert(values)
  const { data, error } = await query.select("*").single()
  throwIfError(error, "Could not save attendance person.")
  return mapPerson(data, managedUser)
}

export async function removeAttendancePerson(
  client: SupabaseClient,
  idInput: unknown,
) {
  const id = requireUuid(idInput, "Person id")
  const today = parseIsoDate(hktDateFromTimestamp(new Date()))!.date
  const yesterday = formatIsoDate(new Date(today.getTime() - 24 * 60 * 60 * 1000))
  const { data, error } = await client
    .from("attendance_people")
    .update({
      admin_user_id: null,
      is_active: false,
      employment_end_date: yesterday,
    })
    .eq("id", id)
    .eq("is_active", true)
    .select("*")
    .maybeSingle()
  throwIfError(error, "Could not remove attendance person.")
  if (!data) {
    throw new AttendanceValidationError("Active attendance person was not found.")
  }
  return mapPerson(data)
}

export async function saveAttendanceLeaveRange(
  client: SupabaseClient,
  input: unknown,
  actor: string,
) {
  const row = asRow(input)
  const personId = requireUuid(row.personId, "Person id")
  const fromDate = requireDate(row.fromDate ?? row.leaveDate, "From date")
  const toDate = requireDate(row.toDate ?? row.leaveDate ?? row.fromDate, "To date")
  const groupId = optionalUuid(row.groupId, "Leave group id")
  if (!isAttendanceLeavePortion(row.portion)) {
    throw new AttendanceValidationError("Leave portion must be full, am, or pm.")
  }
  if (!isAttendanceLeaveCode(row.code)) {
    throw new AttendanceValidationError("Leave code is unsupported.")
  }
  if (row.portion !== "full" && fromDate !== toDate) {
    throw new AttendanceValidationError("Half-day leave must be recorded for one date.")
  }
  const dates = enumerateWeekdays(fromDate, toDate)
  if (!dates || dates.length === 0 || dates.length > 366) {
    throw new AttendanceValidationError("The leave range must contain 1 to 366 weekdays.")
  }

  const newGroupId = randomUUID()
  const { data, error } = await client.rpc("replace_attendance_leave_group", {
    p_existing_group_id: groupId,
    p_new_group_id: newGroupId,
    p_person_id: personId,
    p_leave_dates: dates,
    p_portion: row.portion,
    p_code: row.code,
    p_note: optionalText(row.note),
    p_actor: actor,
  })
  throwIfError(error, "Could not save leave entries.")
  return (data || []).map(mapLeave)
}

export async function deleteAttendanceLeave(
  client: SupabaseClient,
  idInput: unknown,
) {
  const id = requireUuid(idInput, "Leave id")
  const { data: target, error: targetError } = await client
    .from("attendance_leave_entries")
    .select("entry_group_id")
    .eq("id", id)
    .maybeSingle()
  throwIfError(targetError, "Could not load the leave entry.")
  if (!target) throw new AttendanceValidationError("Leave entry was not found.")
  const { error } = await client
    .from("attendance_leave_entries")
    .delete()
    .eq("entry_group_id", String(asRow(target).entry_group_id))
  throwIfError(error, "Could not delete the leave entry.")
}

export async function saveAttendanceOverride(
  client: SupabaseClient,
  input: unknown,
  actor: string,
) {
  const row = asRow(input)
  const id = optionalUuid(row.id, "Override id")
  const personId = requireUuid(row.personId, "Person id")
  const workDate = requireDate(row.workDate, "Work date")
  const action = row.action
  if (action !== "replace" && action !== "exclude") {
    throw new AttendanceValidationError("Override action must be replace or exclude.")
  }
  const reason = requireText(row.reason, "Reason", 1000)
  let checkType: AttendanceCheckType | null = null
  let punchTime: string | null = null
  let rawPunchId: string | null = null

  if (action === "replace") {
    if (!isAttendanceCheckType(row.checkType)) {
      throw new AttendanceValidationError("Replacement check type is invalid.")
    }
    checkType = row.checkType
    if (typeof row.punchTime !== "string" || !Number.isFinite(Date.parse(row.punchTime))) {
      throw new AttendanceValidationError("Replacement punch time is invalid.")
    }
    punchTime = new Date(row.punchTime).toISOString()
    if (hktDateFromTimestamp(new Date(punchTime)) !== workDate) {
      throw new AttendanceValidationError(
        "Replacement punch time must fall on the work date in Hong Kong time.",
      )
    }
  } else {
    rawPunchId = requireUuid(row.rawPunchId, "Raw punch id")
    const { data: punch, error: punchError } = await client
      .from("attendance_raw_punches")
      .select("person_id,work_date")
      .eq("id", rawPunchId)
      .maybeSingle()
    throwIfError(punchError, "Could not load the raw punch.")
    const punchRow = asRow(punch)
    if (!punch || String(punchRow.person_id) !== personId || String(punchRow.work_date) !== workDate) {
      throw new AttendanceValidationError("Raw punch does not match this person and work date.")
    }
  }

  const values = {
    person_id: personId,
    work_date: workDate,
    action,
    check_type: checkType,
    punch_time: punchTime,
    raw_punch_id: rawPunchId,
    reason,
    updated_by: actor,
    ...(id ? {} : { created_by: actor }),
  }
  const query = id
    ? client.from("attendance_manual_overrides").update(values).eq("id", id)
    : client.from("attendance_manual_overrides").insert(values)
  const { data, error } = await query.select("*").single()
  throwIfError(error, "Could not save attendance override.")
  return mapOverride(data)
}

export async function deleteAttendanceOverride(
  client: SupabaseClient,
  idInput: unknown,
) {
  const id = requireUuid(idInput, "Override id")
  const { data, error } = await client
    .from("attendance_manual_overrides")
    .delete()
    .eq("id", id)
    .select("id")
  throwIfError(error, "Could not delete attendance override.")
  if (!data?.length) throw new AttendanceValidationError("Attendance override was not found.")
}

export async function saveAttendanceEntitlement(
  client: SupabaseClient,
  input: unknown,
  actor: string,
) {
  const row = asRow(input)
  const personId = requireUuid(row.personId, "Person id")
  const year = requireYear(row.year)
  const values = {
    person_id: personId,
    year,
    allowance_units: requireFiniteNumber(row.allowanceUnits, "Allowance", 0, 366),
    opening_carry_forward_units: requireFiniteNumber(
      row.openingCarryForwardUnits,
      "Opening carry-forward",
      -366,
      366,
    ),
    source_file_hash: row.sourceFileHash
      ? requireText(row.sourceFileHash, "Source file hash", 64)
      : null,
    note: optionalText(row.note),
    created_by: actor,
    updated_by: actor,
  }
  const { data, error } = await client
    .from("attendance_entitlements")
    .upsert(values, { onConflict: "person_id,year" })
    .select("*")
    .single()
  throwIfError(error, "Could not save attendance entitlement.")
  return mapEntitlement(data)
}

export async function saveAttendanceMonthlyAdjustment(
  client: SupabaseClient,
  input: unknown,
  actor: string,
) {
  const row = asRow(input)
  const id = optionalUuid(row.id, "Adjustment id")
  const personId = requireUuid(row.personId, "Person id")
  const year = requireYear(row.year)
  const month = requireMonth(row.month)
  if (!isAttendanceMonthlyCode(row.code)) {
    throw new AttendanceValidationError("Monthly code is unsupported.")
  }
  const source = row.source ? requireText(row.source, "Source", 160) : "manual"
  const values = {
    person_id: personId,
    year,
    month,
    code: row.code,
    units: requireFiniteNumber(row.units, "Units", -366, 366),
    source,
    source_file_hash: row.sourceFileHash
      ? requireText(row.sourceFileHash, "Source file hash", 64)
      : null,
    is_confirmed: Boolean(row.confirmed ?? row.isConfirmed),
    note: optionalText(row.note),
    updated_by: actor,
    ...(id ? {} : { created_by: actor }),
  }
  if (values.units === 0) {
    throw new AttendanceValidationError("Monthly adjustment units cannot be zero.")
  }
  let targetId = id
  if (!targetId) {
    const { data: existing, error: existingError } = await client
      .from("attendance_monthly_adjustments")
      .select("id")
      .eq("person_id", personId)
      .eq("year", year)
      .eq("month", month)
      .eq("code", row.code)
      .eq("source", source)
      .maybeSingle()
    throwIfError(existingError, "Could not load monthly adjustment.")
    targetId = existing ? String(asRow(existing).id) : null
  }
  const query = targetId
    ? client
        .from("attendance_monthly_adjustments")
        .update({ ...values, created_by: undefined })
        .eq("id", targetId)
    : client.from("attendance_monthly_adjustments").insert(values)
  const { data, error } = await query.select("*").single()
  throwIfError(error, "Could not save monthly adjustment.")
  return mapAdjustment(data)
}

export async function deleteAttendanceMonthlyAdjustment(
  client: SupabaseClient,
  idInput: unknown,
) {
  const id = requireUuid(idInput, "Adjustment id")
  const { data, error } = await client
    .from("attendance_monthly_adjustments")
    .delete()
    .eq("id", id)
    .select("id")
  throwIfError(error, "Could not delete monthly adjustment.")
  if (!data?.length) throw new AttendanceValidationError("Monthly adjustment was not found.")
}

export async function saveAttendanceMonthlyConfirmation(
  client: SupabaseClient,
  input: unknown,
  actor: string,
) {
  const row = asRow(input)
  const personId = requireUuid(row.personId, "Person id")
  const year = requireYear(row.year)
  const month = requireMonth(row.month)
  if (row.status !== "pending" && row.status !== "confirmed") {
    throw new AttendanceValidationError("Confirmation status is invalid.")
  }
  const confirmed = row.status === "confirmed"
  if (confirmed && !isClosedAttendanceMonth(year, month)) {
    throw new AttendanceValidationError(
      "Attendance can be confirmed only after the Hong Kong month has closed.",
    )
  }
  const values = {
    person_id: personId,
    year,
    month,
    status: row.status,
    confirmed_at: confirmed ? new Date().toISOString() : null,
    confirmed_by: confirmed ? actor : null,
    note: optionalText(row.note),
    created_by: actor,
    updated_by: actor,
  }
  const { data, error } = await client
    .from("attendance_monthly_confirmations")
    .upsert(values, { onConflict: "person_id,year,month" })
    .select("*")
    .single()
  throwIfError(error, "Could not save monthly confirmation.")
  return mapConfirmation(data)
}

export async function attendancePersonBelongsToAdminUser(
  client: SupabaseClient,
  personIdInput: unknown,
  adminUserIdInput: unknown,
) {
  const personId = requireUuid(personIdInput, "Person id")
  const adminUserId = requireUuid(adminUserIdInput, "User Management user id")
  const { data, error } = await client
    .from("attendance_people")
    .select("id")
    .eq("id", personId)
    .eq("admin_user_id", adminUserId)
    .eq("is_active", true)
    .maybeSingle()
  throwIfError(error, "Could not verify the attendance person.")
  return Boolean(data)
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function attendanceMonthLabel(year: number, month: number) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "Asia/Hong_Kong",
  }).format(new Date(Date.UTC(year, month - 1, 1)))
}

export function buildAttendanceReminderEmail(input: {
  displayName: string
  year: number
  month: number
}) {
  const monthLabel = attendanceMonthLabel(input.year, input.month)
  return {
    subject: `***** Attendance Confirmation Reminder - ${monthLabel}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#10243a;line-height:1.45">
        <p style="margin:0 0 10px">Hello ${escapeHtml(input.displayName)},</p>
        <p style="margin:0 0 10px">Please review and confirm your attendance record for <strong>${escapeHtml(monthLabel)}</strong>.</p>
        <p style="margin:14px 0 0"><a href="https://fcuno.com/admin/attendancerecord" style="color:#0a73c9">Open Attendance Record</a></p>
      </div>
    `,
  }
}

export async function sendAttendanceConfirmationReminders(
  client: SupabaseClient,
  input: unknown,
  actor: string,
) {
  const row = asRow(input)
  const year = requireYear(row.year)
  const month = requireMonth(row.month)
  if (!isClosedAttendanceMonth(year, month)) {
    throw new AttendanceValidationError(
      "Confirmation reminders can be sent only after the Hong Kong month has closed.",
    )
  }
  if (!Array.isArray(row.personIds)) {
    throw new AttendanceValidationError("Select attendance users to remind.")
  }
  const personIds = [
    ...new Set(row.personIds.map((value) => requireUuid(value, "Person id"))),
  ]
  if (personIds.length === 0 || personIds.length > 100) {
    throw new AttendanceValidationError(
      "Select between 1 and 100 attendance users to remind.",
    )
  }

  const [
    { data: peopleData, error: peopleError },
    { data: confirmedData, error: confirmedError },
    { data: recentDispatchData, error: recentDispatchError },
    managedUsers,
  ] = await Promise.all([
    client
      .from("attendance_people")
      .select("id,admin_user_id,staff_code,display_name,is_active")
      .in("id", personIds),
    client
      .from("attendance_monthly_confirmations")
      .select("person_id")
      .eq("year", year)
      .eq("month", month)
      .eq("status", "confirmed")
      .in("person_id", personIds),
    client
      .from("attendance_reminder_dispatches")
      .select("person_id")
      .eq("year", year)
      .eq("month", month)
      .eq("status", "sent")
      .gte("requested_at", new Date(Date.now() - 15 * 60 * 1000).toISOString())
      .in("person_id", personIds),
    listManagedAdminUsers(),
  ])
  throwIfError(peopleError, "Could not load attendance reminder recipients.")
  throwIfError(confirmedError, "Could not verify attendance confirmations.")
  throwIfError(recentDispatchError, "Could not verify recent attendance reminders.")
  if (confirmedData?.length) {
    throw new AttendanceValidationError(
      "Remove staff who already confirmed this month before sending the reminder.",
    )
  }
  const peopleRows = (peopleData || []).map(asRow)
  if (peopleRows.length !== personIds.length) {
    throw new AttendanceValidationError(
      "Every reminder recipient must be an active attendance user.",
    )
  }
  const usersById = new Map(managedUsers.map((user) => [user.id, user]))
  const targets = personIds.map((personId) => {
    const person = peopleRows.find((entry) => String(entry.id) === personId)
    const adminUserId = stringOrNull(person?.admin_user_id)
    const user = adminUserId ? usersById.get(adminUserId) : undefined
    const emails = normalizeEmailList(user?.username || "")
    if (
      !person ||
      person.is_active !== true ||
      !user ||
      !user.isActive ||
      emails.length !== 1
    ) {
      throw new AttendanceValidationError(
        "Every reminder recipient must be linked to an active User Management account with a valid email username.",
      )
    }
    return {
      personId,
      displayName: user.displayName,
      email: emails[0],
    }
  })
  const recentlySentPersonIds = new Set(
    (recentDispatchData || []).map((value) => String(asRow(value).person_id)),
  )
  const sendTargets = targets.filter(
    (target) => !recentlySentPersonIds.has(target.personId),
  )

  const dispatchData = sendTargets.length
    ? await client
        .from("attendance_reminder_dispatches")
        .insert(
          sendTargets.map((target) => ({
            person_id: target.personId,
            year,
            month,
            status: "pending",
            requested_by: actor,
          })),
        )
        .select("id,person_id")
    : { data: [], error: null }
  throwIfError(dispatchData.error, "Could not record attendance reminders.")
  const dispatchByPersonId = new Map(
    (dispatchData.data || []).map((value) => {
      const dispatch = asRow(value)
      return [String(dispatch.person_id), String(dispatch.id)]
    }),
  )

  const results: Array<{
    personId: string
    status: "sent" | "failed"
  }> = []
  for (const target of sendTargets) {
    const dispatchId = dispatchByPersonId.get(target.personId)
    if (!dispatchId) throw new Error("Attendance reminder dispatch was not recorded.")
    const email = buildAttendanceReminderEmail({
      displayName: target.displayName,
      year,
      month,
    })
    let messageId: string
    try {
      const sent = await sendNoticeEmail({
        to: [target.email],
        subject: email.subject,
        html: email.html,
      })
      messageId = String(sent.id || "sent").slice(0, 1000)
    } catch {
      const { error } = await client
        .from("attendance_reminder_dispatches")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          message_id: null,
          error_code: "EMAIL_SEND_FAILED",
        })
        .eq("id", dispatchId)
      throwIfError(error, "Could not complete failed attendance reminder audit.")
      results.push({ personId: target.personId, status: "failed" })
      continue
    }
    const { error } = await client
      .from("attendance_reminder_dispatches")
      .update({
        status: "sent",
        completed_at: new Date().toISOString(),
        message_id: messageId,
        error_code: null,
      })
      .eq("id", dispatchId)
    throwIfError(error, "Could not complete attendance reminder audit.")
    results.push({ personId: target.personId, status: "sent" })
  }

  const sent = results.filter((result) => result.status === "sent").length
  return {
    requested: targets.length,
    attempted: results.length,
    sent,
    failed: results.length - sent,
    skipped: targets.length - sendTargets.length,
    results,
  }
}

export function attendancePeriodFromSearch(searchParams: URLSearchParams) {
  return {
    year: requireYear(searchParams.get("year")),
    month: requireMonth(searchParams.get("month")),
  }
}
