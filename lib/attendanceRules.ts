export const HONG_KONG_TIME_ZONE = "Asia/Hong_Kong"
export const ATTENDANCE_PAGE_ID = "attendance-record"

export type AttendanceTeam = "BT" | "BS" | "AC"
export type AttendanceCheckType = "OnDuty" | "OffDuty"
export type AttendanceLeavePortion = "full" | "am" | "pm"
export type AttendanceLeaveCode =
  | "ALS"
  | "ALU"
  | "SLM"
  | "SLR"
  | "SLX"
  | "SPL"
  | "MTL"
  | "NPL"
  | "HO"
  | "OS"
export type AttendanceMonthlyCode = AttendanceLeaveCode | "HOL"

export type AttendanceSchedule = {
  team: AttendanceTeam
  workStart: string
  workEnd: string
  amCutoff: string
  pmCutoff: string
}

export const ATTENDANCE_SCHEDULES: Record<AttendanceTeam, AttendanceSchedule> = {
  BT: {
    team: "BT",
    workStart: "10:00",
    workEnd: "19:00",
    amCutoff: "11:30",
    pmCutoff: "16:30",
  },
  BS: {
    team: "BS",
    workStart: "10:00",
    workEnd: "19:00",
    amCutoff: "11:30",
    pmCutoff: "16:30",
  },
  AC: {
    team: "AC",
    workStart: "09:00",
    workEnd: "17:30",
    amCutoff: "11:00",
    pmCutoff: "15:45",
  },
}

export const ATTENDANCE_TEAMS = Object.freeze(
  Object.keys(ATTENDANCE_SCHEDULES) as AttendanceTeam[],
)
export const ATTENDANCE_CHECK_TYPES = Object.freeze<AttendanceCheckType[]>([
  "OnDuty",
  "OffDuty",
])
export const ATTENDANCE_LEAVE_PORTIONS = Object.freeze<AttendanceLeavePortion[]>([
  "full",
  "am",
  "pm",
])
export const ATTENDANCE_LEAVE_CODES = Object.freeze<AttendanceLeaveCode[]>([
  "ALS",
  "ALU",
  "SLM",
  "SLR",
  "SLX",
  "SPL",
  "MTL",
  "NPL",
  "HO",
  "OS",
])
export const ATTENDANCE_MONTHLY_CODES = Object.freeze<AttendanceMonthlyCode[]>([
  ...ATTENDANCE_LEAVE_CODES,
  "HOL",
])

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const HONG_KONG_OFFSET_MS = 8 * 60 * 60 * 1000

export function parseIsoDate(value: string) {
  const match = DATE_PATTERN.exec(value)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }

  return { year, month, day, date }
}

export function formatIsoDate(date: Date) {
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-")
}

export function hktDateFromTimestamp(timestamp: number | Date) {
  const date =
    timestamp instanceof Date
      ? new Date(timestamp.getTime() + HONG_KONG_OFFSET_MS)
      : new Date(timestamp + HONG_KONG_OFFSET_MS)
  return formatIsoDate(date)
}

export function hktTimeFromTimestamp(timestamp: number | Date | string) {
  const source =
    timestamp instanceof Date
      ? timestamp
      : new Date(timestamp)
  if (!Number.isFinite(source.getTime())) return null
  const hkt = new Date(source.getTime() + HONG_KONG_OFFSET_MS)
  return `${String(hkt.getUTCHours()).padStart(2, "0")}:${String(
    hkt.getUTCMinutes(),
  ).padStart(2, "0")}`
}

export function hktTimestampForDateAndTime(dateText: string, timeText: string) {
  const date = parseIsoDate(dateText)
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(timeText)
  if (!date || !timeMatch) return null

  const hour = Number(timeMatch[1])
  const minute = Number(timeMatch[2])
  const second = Number(timeMatch[3] || 0)
  if (hour > 23 || minute > 59 || second > 59) return null

  return new Date(
    Date.UTC(date.year, date.month - 1, date.day, hour, minute, second) -
      HONG_KONG_OFFSET_MS,
  )
}

export function formatDingTalkHktTimestamp(date: Date) {
  const hkt = new Date(date.getTime() + HONG_KONG_OFFSET_MS)
  return `${formatIsoDate(hkt)} ${String(hkt.getUTCHours()).padStart(2, "0")}:${String(
    hkt.getUTCMinutes(),
  ).padStart(2, "0")}:${String(hkt.getUTCSeconds()).padStart(2, "0")}`
}

export function isWeekday(dateText: string) {
  const parsed = parseIsoDate(dateText)
  if (!parsed) return false
  const weekday = parsed.date.getUTCDay()
  return weekday >= 1 && weekday <= 5
}

export function hktYearMonth(now = new Date()) {
  const parsed = parseIsoDate(hktDateFromTimestamp(now))!
  return { year: parsed.year, month: parsed.month }
}

export function isPersonEmployedOnDate(
  dateText: string,
  person: {
    isActive: boolean
    employmentStartDate: string | null
    employmentEndDate: string | null
  },
) {
  if (!parseIsoDate(dateText)) return false
  if (person.employmentStartDate && dateText < person.employmentStartDate) return false
  if (person.employmentEndDate && dateText > person.employmentEndDate) return false
  return person.isActive || person.employmentEndDate !== null
}

export function isPersonExpectedOnDate(
  dateText: string,
  person: {
    isActive: boolean
    employmentStartDate: string | null
    employmentEndDate: string | null
  },
) {
  return isWeekday(dateText) && isPersonEmployedOnDate(dateText, person)
}

export function deriveAttendanceExpectation(input: {
  workDate: string
  team: AttendanceTeam
  leavePortions: AttendanceLeavePortion[]
  effectiveSignIn: string | null
  effectiveSignOut: string | null
  required: boolean
}) {
  const schedule = ATTENDANCE_SCHEDULES[input.team]
  const fullLeave = input.leavePortions.includes("full")
  const morningLeave = fullLeave || input.leavePortions.includes("am")
  const afternoonLeave = fullLeave || input.leavePortions.includes("pm")
  const signInDeadline =
    !input.required || fullLeave
      ? null
      : hktTimestampForDateAndTime(
          input.workDate,
          morningLeave ? schedule.pmCutoff : schedule.workStart,
        )
  const signOutDeadline =
    !input.required || fullLeave
      ? null
      : hktTimestampForDateAndTime(
          input.workDate,
          afternoonLeave ? schedule.amCutoff : schedule.workEnd,
        )
  const late = Boolean(
    input.effectiveSignIn &&
      signInDeadline &&
      Date.parse(input.effectiveSignIn) > signInDeadline.getTime(),
  )
  const early = Boolean(
    input.effectiveSignOut &&
      signOutDeadline &&
      Date.parse(input.effectiveSignOut) < signOutDeadline.getTime(),
  )

  let status = "present"
  if (!input.required) status = "rest-day"
  else if (fullLeave) status = "leave"
  else if (!input.effectiveSignIn && !input.effectiveSignOut) {
    status = input.leavePortions.length ? "partial-leave" : "missing"
  } else if (!input.effectiveSignIn || !input.effectiveSignOut) status = "incomplete"
  else if (late && early) status = "late-and-early"
  else if (late) status = "late"
  else if (early) status = "early"
  else if (input.leavePortions.length) status = "partial-leave"

  return {
    required: input.required,
    signInDeadline: signInDeadline?.toISOString() || null,
    signOutDeadline: signOutDeadline?.toISOString() || null,
    late,
    early,
    status,
  }
}

export function enumerateWeekdays(fromDate: string, toDate: string) {
  const from = parseIsoDate(fromDate)
  const to = parseIsoDate(toDate)
  if (!from || !to || from.date.getTime() > to.date.getTime()) return null

  const dates: string[] = []
  for (
    let cursor = new Date(from.date);
    cursor.getTime() <= to.date.getTime();
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
  ) {
    const weekday = cursor.getUTCDay()
    if (weekday >= 1 && weekday <= 5) dates.push(formatIsoDate(cursor))
  }
  return dates
}

export function isAttendanceTeam(value: unknown): value is AttendanceTeam {
  return typeof value === "string" && ATTENDANCE_TEAMS.includes(value as AttendanceTeam)
}

export function isAttendanceCheckType(
  value: unknown,
): value is AttendanceCheckType {
  return (
    typeof value === "string" &&
    ATTENDANCE_CHECK_TYPES.includes(value as AttendanceCheckType)
  )
}

export function isAttendanceLeavePortion(
  value: unknown,
): value is AttendanceLeavePortion {
  return (
    typeof value === "string" &&
    ATTENDANCE_LEAVE_PORTIONS.includes(value as AttendanceLeavePortion)
  )
}

export function isAttendanceLeaveCode(
  value: unknown,
): value is AttendanceLeaveCode {
  return (
    typeof value === "string" &&
    ATTENDANCE_LEAVE_CODES.includes(value as AttendanceLeaveCode)
  )
}

export function isAttendanceMonthlyCode(
  value: unknown,
): value is AttendanceMonthlyCode {
  return (
    typeof value === "string" &&
    ATTENDANCE_MONTHLY_CODES.includes(value as AttendanceMonthlyCode)
  )
}
