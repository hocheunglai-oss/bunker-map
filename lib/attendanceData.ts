import "server-only"

import { randomUUID } from "node:crypto"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
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

function mapPerson(value: unknown): AttendancePerson {
  const row = asRow(value)
  return {
    id: String(row.id),
    staffCode: String(row.staff_code),
    displayName: String(row.display_name),
    dingTalkUserId: stringOrNull(row.dingtalk_user_id),
    team: String(row.team) as AttendanceTeam,
    isActive: Boolean(row.is_active),
    employmentStartDate: stringOrNull(row.employment_start_date),
    employmentEndDate: stringOrNull(row.employment_end_date),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
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
  const { data, error } = await query
  throwIfError(error, "Could not load attendance people.")
  return (data || []).map(mapPerson)
}

function dateRangeForMonth(year: number, month: number) {
  const start = `${year}-${String(month).padStart(2, "0")}-01`
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`
  const next = parseIsoDate(nextMonth)!.date
  const end = new Date(next.getTime() - 24 * 60 * 60 * 1000)
  return { start, end: `${year}-${String(end.getUTCMonth() + 1).padStart(2, "0")}-${String(end.getUTCDate()).padStart(2, "0")}` }
}

export async function getDailyAttendance(date: string) {
  const workDate = requireDate(date, "Date")
  const supabase = getAttendanceServiceClient()
  const [peopleResult, punchResult, overrideResult, leaveResult] = await Promise.all([
    supabase.from("attendance_people").select("*").order("staff_code"),
    supabase.from("attendance_raw_punches").select("*").eq("work_date", workDate).order("punch_time"),
    supabase.from("attendance_manual_overrides").select("*").eq("work_date", workDate).order("created_at"),
    supabase.from("attendance_leave_entries").select("*").eq("leave_date", workDate).order("created_at"),
  ])
  throwIfError(peopleResult.error, "Could not load attendance people.")
  throwIfError(punchResult.error, "Could not load attendance punches.")
  throwIfError(overrideResult.error, "Could not load attendance overrides.")
  throwIfError(leaveResult.error, "Could not load leave entries.")

  const allPeople = (peopleResult.data || []).map(mapPerson)
  const people = allPeople.filter((person) =>
    isPersonEmployedOnDate(workDate, person),
  )
  const rawPunchRows = (punchResult.data || []).map((value) => ({
    row: asRow(value),
    punch: mapPunch(value),
  }))
  const overrides = (overrideResult.data || []).map(mapOverride)
  const leaves = (leaveResult.data || []).map(mapLeave)

  const records = people.map((person) => {
    const personPunchRows = rawPunchRows.filter(
      ({ row }) => String(row.person_id) === person.id,
    )
    const personOverrides = overrides.filter((entry) => entry.personId === person.id)
    const personLeaves = leaves.filter((entry) => entry.personId === person.id)
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
    const schedule = ATTENDANCE_SCHEDULES[person.team]
    const expectation = deriveAttendanceExpectation({
      workDate,
      team: person.team,
      leavePortions: personLeaves.map((entry) => entry.portion),
      effectiveSignIn,
      effectiveSignOut,
      required: isPersonExpectedOnDate(workDate, person),
    })

    return {
      person,
      schedule,
      punches,
      overrides: personOverrides,
      leave: personLeaves,
      effectiveSignIn,
      effectiveSignOut,
      ...expectation,
    }
  })

  return { view: "daily" as const, date: workDate, people, records }
}

export async function getAttendanceLeave(yearInput: unknown) {
  const year = requireYear(yearInput)
  const supabase = getAttendanceServiceClient()
  const [peopleResult, leaveResult] = await Promise.all([
    supabase.from("attendance_people").select("*").order("staff_code"),
    supabase
      .from("attendance_leave_entries")
      .select("*")
      .gte("leave_date", `${year}-01-01`)
      .lte("leave_date", `${year}-12-31`)
      .order("leave_date", { ascending: false }),
  ])
  throwIfError(peopleResult.error, "Could not load attendance people.")
  throwIfError(leaveResult.error, "Could not load leave entries.")
  return {
    view: "leave" as const,
    year,
    people: (peopleResult.data || []).map(mapPerson),
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

export async function getMonthlyAttendance(yearInput: unknown, monthInput: unknown) {
  const year = requireYear(yearInput)
  const month = requireMonth(monthInput)
  const monthRange = dateRangeForMonth(year, month)
  const supabase = getAttendanceServiceClient()
  const [peopleResult, entitlementResult, adjustmentResult, leaveResult, confirmationResult] =
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
        .gte("leave_date", `${year}-01-01`)
        .lte("leave_date", monthRange.end),
      supabase
        .from("attendance_monthly_confirmations")
        .select("*")
        .eq("year", year)
        .eq("month", month),
    ])
  throwIfError(peopleResult.error, "Could not load attendance people.")
  throwIfError(entitlementResult.error, "Could not load entitlements.")
  throwIfError(adjustmentResult.error, "Could not load monthly attendance totals.")
  throwIfError(leaveResult.error, "Could not load leave entries.")
  throwIfError(confirmationResult.error, "Could not load monthly confirmations.")

  const people = (peopleResult.data || []).map(mapPerson)
  const entitlements = (entitlementResult.data || []).map(mapEntitlement)
  const adjustments = (adjustmentResult.data || []).map(mapAdjustment)
  const leaveEntries = (leaveResult.data || []).map(mapLeave)
  const confirmations = (confirmationResult.data || []).map(mapConfirmation)

  const summaries = people.map((person) => {
    const entitlement = entitlements.find((entry) => entry.personId === person.id) || null
    const personAdjustments = adjustments.filter((entry) => entry.personId === person.id)
    const personLeaves = leaveEntries.filter((entry) => entry.personId === person.id)
    const selectedTotals = emptyCodeTotals()
    const ytdTotals = emptyCodeTotals()

    personAdjustments.forEach((entry) => {
      addCodeTotal(ytdTotals, entry.code, entry.units)
      if (entry.month === month) addCodeTotal(selectedTotals, entry.code, entry.units)
    })
    personLeaves.forEach((entry) => {
      addCodeTotal(ytdTotals, entry.code, entry.units)
      if (entry.leaveDate >= monthRange.start && entry.leaveDate <= monthRange.end) {
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

    return {
      person,
      entitlement,
      codeTotals: selectedTotals,
      yearToDateCodeTotals: ytdTotals,
      balance,
      confirmation:
        confirmations.find((entry) => entry.personId === person.id) || null,
    }
  })

  return { view: "monthly" as const, year, month, people, summaries }
}

export async function getAttendanceSettings(yearInput: unknown) {
  const year = requireYear(yearInput)
  const supabase = getAttendanceServiceClient()
  const [peopleResult, entitlementResult, adjustmentResult, syncResult] = await Promise.all([
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
  ])
  throwIfError(peopleResult.error, "Could not load attendance people.")
  throwIfError(entitlementResult.error, "Could not load entitlements.")
  throwIfError(adjustmentResult.error, "Could not load monthly attendance totals.")
  throwIfError(syncResult.error, "Could not load attendance sync history.")
  return {
    view: "settings" as const,
    year,
    people: (peopleResult.data || []).map(mapPerson),
    entitlements: (entitlementResult.data || []).map(mapEntitlement),
    monthlyAdjustments: (adjustmentResult.data || []).map(mapAdjustment),
    syncRuns: (syncResult.data || []).map(mapSyncRun),
    schedules: Object.values(ATTENDANCE_SCHEDULES),
  }
}

export async function saveAttendancePerson(
  client: SupabaseClient,
  input: unknown,
) {
  const row = asRow(input)
  const id = optionalUuid(row.id, "Person id")
  const staffCode = requireText(row.staffCode, "Staff code", 16).toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9_-]{0,15}$/.test(staffCode)) {
    throw new AttendanceValidationError("Staff code contains unsupported characters.")
  }
  const displayName = requireText(row.displayName, "Display name", 120)
  if (!isAttendanceTeam(row.team)) {
    throw new AttendanceValidationError("Team must be BT, BS, or AC.")
  }
  const dingTalkUserId = row.dingTalkUserId
    ? requireText(row.dingTalkUserId, "DingTalk user id", 128)
    : null
  const employmentStartDate = row.employmentStartDate
    ? requireDate(row.employmentStartDate, "Employment start date")
    : null
  const employmentEndDate = row.employmentEndDate
    ? requireDate(row.employmentEndDate, "Employment end date")
    : null
  if (employmentStartDate && employmentEndDate && employmentEndDate < employmentStartDate) {
    throw new AttendanceValidationError("Employment end date cannot be before the start date.")
  }

  const values = {
    staff_code: staffCode,
    display_name: displayName,
    dingtalk_user_id: dingTalkUserId,
    team: row.team,
    is_active: row.isActive !== false,
    employment_start_date: employmentStartDate,
    employment_end_date: employmentEndDate,
  }
  const query = id
    ? client.from("attendance_people").update(values).eq("id", id)
    : client.from("attendance_people").insert(values)
  const { data, error } = await query.select("*").single()
  throwIfError(error, "Could not save attendance person.")
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

export function attendancePeriodFromSearch(searchParams: URLSearchParams) {
  return {
    year: requireYear(searchParams.get("year")),
    month: requireMonth(searchParams.get("month")),
  }
}
