export type AttendanceGroup = "BT" | "BS" | "AC"

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

export type ApiAttendancePerson = {
  id: string
  staffCode: string
  displayName: string
  dingTalkUserId: string | null
  team: AttendanceGroup
  isActive: boolean
  employmentStartDate: string | null
  employmentEndDate: string | null
  adminUserId?: string | null
  adminUsername?: string | null
  username?: string | null
}

export type ApiAttendanceSchedule = {
  team: AttendanceGroup
  workStart: string
  workEnd: string
  amCutoff: string
  pmCutoff: string
}

export type ApiAttendancePunch = {
  id: string
  checkType: "OnDuty" | "OffDuty"
  punchTime: string
  sourceType: string | null
  deviceSn: string | null
  timeResult: string | null
  locationResult: string | null
}

export type ApiAttendanceOverride = {
  id: string
  personId: string
  workDate: string
  action: "replace" | "exclude"
  checkType: "OnDuty" | "OffDuty" | null
  punchTime: string | null
  rawPunchId: string | null
  reason: string
}

export type ApiAttendanceLeaveEntry = {
  id: string
  groupId: string
  personId: string
  leaveDate: string
  portion: "full" | "am" | "pm"
  code: AttendanceLeaveCode
  units: number
  note: string | null
}

export type ApiAttendanceConfirmation = {
  id: string
  personId: string
  year: number
  month: number
  status: "pending" | "confirmed"
  confirmedAt: string | null
  confirmedBy: string | null
  note: string | null
}

export type ApiAttendanceDailyItem = {
  person: ApiAttendancePerson
  schedule: ApiAttendanceSchedule
  punches: ApiAttendancePunch[]
  overrides: ApiAttendanceOverride[]
  leave: ApiAttendanceLeaveEntry[] | ApiAttendanceLeaveEntry | null
  effectiveSignIn: string | null
  effectiveSignOut: string | null
  status: string
  late: boolean
  early: boolean
  date?: string
  workDate?: string
}

export type ApiAttendanceMonthlySummary = {
  person: ApiAttendancePerson
  codeTotals: Record<string, number>
  confirmation: ApiAttendanceConfirmation | null
  attendedDays?: number
  lateDays?: number
  records?: ApiAttendanceDailyItem[]
  canConfirm?: boolean
  isCurrentUser?: boolean
  lastReminderAt?: string | null
}

export type ApiAttendanceCalendarDay = {
  date: string
  records: ApiAttendanceDailyItem[]
  day?: number
  weekday?: string
  isWeekend?: boolean
  isFuture?: boolean
}

export type ApiMonthlyResponse = {
  view: "monthly"
  year: number
  month: number
  periodClosed?: boolean
  people: ApiAttendancePerson[]
  summaries: ApiAttendanceMonthlySummary[]
  calendarDays: ApiAttendanceCalendarDay[]
  months?: Array<{
    month: number
    periodClosed: boolean
    summaries: ApiAttendanceMonthlySummary[]
  }>
}

export type ManagedAttendanceUser = {
  id: string
  username: string
  displayName: string
  role: string
  staffCode?: string
  suggestedStaffCode?: string
  attendanceTeam?: AttendanceGroup | null
  attendanceGroup?: AttendanceGroup | null
  eligible?: boolean
  isActive?: boolean
}

export type ApiAttendanceSyncRun = {
  id: string
  startedAt: string
  completedAt: string | null
  windowFrom: string
  windowTo: string
  status: string
  peopleRequested: number
  batchesAttempted: number
  recordsFetched: number
  recordsInserted: number
  errorSummary: string | null
}

export type ApiAllTimeSummary = {
  personId: string
  firstAttendanceDate: string | null
  lastAttendanceDate: string | null
  attendedDays: number
  lateDays: number
}

export type ApiSettingsResponse = {
  view: "settings"
  year: number
  people: ApiAttendancePerson[]
  schedules: ApiAttendanceSchedule[]
  syncRuns: ApiAttendanceSyncRun[]
  availableUsers: ManagedAttendanceUser[]
  allTimeSummaries: ApiAllTimeSummary[]
}

export type AttendanceMonthData = {
  year: number
  month: number
  periodClosed?: boolean
  people: ApiAttendancePerson[]
  summaries: ApiAttendanceMonthlySummary[]
  calendarDays: ApiAttendanceCalendarDay[]
}
