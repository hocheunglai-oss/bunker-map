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

export type AttendanceAdjustmentCode = AttendanceLeaveCode | "HOL"
export type AttendanceLeaveUnit = "FULL" | "AM" | "PM"

export type AttendanceResult =
  | "COMPLETE"
  | "LATE"
  | "LATE_EARLY"
  | "EARLY"
  | "MISSING"
  | "MISSING_IN"
  | "MISSING_OUT"
  | "ON_LEAVE"
  | "HOLIDAY"
  | "REST_DAY"
  | "PENDING"

export type AttendanceSource = "DINGTALK" | "MANUAL" | "IMPORT"

export type ApiAttendancePerson = {
  id: string
  staffCode: string
  displayName: string
  dingTalkUserId: string | null
  team: AttendanceGroup
  isActive: boolean
  employmentStartDate: string | null
  employmentEndDate: string | null
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

export type ApiAttendanceEntitlement = {
  id: string
  personId: string
  year: number
  allowanceUnits: number
  openingCarryForwardUnits: number
  sourceFileHash: string | null
  note: string | null
}

export type ApiAttendanceMonthlyAdjustment = {
  id: string
  personId: string
  year: number
  month: number
  code: AttendanceAdjustmentCode
  units: number
  source: string
  sourceFileHash: string | null
  isConfirmed: boolean
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
}

export type ApiAttendanceMonthlySummary = {
  person: ApiAttendancePerson
  entitlement: ApiAttendanceEntitlement | null
  codeTotals: Record<string, number>
  balance: number
  confirmation: ApiAttendanceConfirmation | null
}

export type ApiDailyResponse = {
  view: "daily"
  date: string
  people: ApiAttendancePerson[]
  records: ApiAttendanceDailyItem[]
}

export type ApiLeaveResponse = {
  view: "leave"
  year: number
  people: ApiAttendancePerson[]
  leaveEntries: ApiAttendanceLeaveEntry[]
}

export type ApiMonthlyResponse = {
  view: "monthly"
  year: number
  month: number
  people: ApiAttendancePerson[]
  summaries: ApiAttendanceMonthlySummary[]
}

export type ApiSettingsResponse = {
  view: "settings"
  year: number
  people: ApiAttendancePerson[]
  entitlements: ApiAttendanceEntitlement[]
  monthlyAdjustments: ApiAttendanceMonthlyAdjustment[]
  syncRuns: ApiAttendanceSyncRun[]
  schedules: ApiAttendanceSchedule[]
}

export type AttendanceEmployee = {
  id: string
  initials: string
  name: string
  dingTalkUserId: string
  group: AttendanceGroup
  annualEntitlement: number
  carryForward: number
  active: boolean
  employmentStartDate: string
  employmentEndDate: string
}

export type AttendanceDailyRecord = {
  id: string
  date: string
  employeeId: string
  employeeName: string
  initials: string
  group: AttendanceGroup
  signIn: string | null
  signOut: string | null
  result: AttendanceResult
  leaveCode: AttendanceLeaveCode | null
  leaveUnit: AttendanceLeaveUnit | null
  source: AttendanceSource
  reviewed: boolean
  reviewNote: string
  signInOverrideId?: string
  signOutOverrideId?: string
}

export type AttendanceLeaveRecord = {
  id: string
  groupId: string
  employeeId: string
  employeeName: string
  initials: string
  fromDate: string
  toDate: string
  unit: AttendanceLeaveUnit
  code: AttendanceLeaveCode
  days: number
  reason: string
  source: "MANUAL" | "IMPORT"
}

export type AttendanceMonthlySummaryRow = {
  employeeId: string
  employeeName: string
  initials: string
  group: AttendanceGroup
  openingCarryForward: number
  annualAllowance: number
  holidayAttendance: number
  als: number
  alu: number
  slm: number
  slr: number
  slx: number
  spl: number
  mtl: number
  npl: number
  ho: number
  os: number
  leaveBalance: number
}

export type AttendanceSyncStatus = {
  state: "idle" | "running" | "success" | "error" | "not_configured"
  lastSyncedAt: string | null
  lastRangeFrom: string | null
  lastRangeTo: string | null
  recordsImported: number
  message: string
}

export type AttendanceDashboardPayload = {
  employees: AttendanceEmployee[]
  dailyRecords: AttendanceDailyRecord[]
  leaveRecords: AttendanceLeaveRecord[]
  monthlySummary: AttendanceMonthlySummaryRow[]
  sync: AttendanceSyncStatus
  fetchedAt?: string
}

export type LeaveDraft = {
  id?: string
  groupId?: string
  employeeId: string
  fromDate: string
  toDate: string
  unit: AttendanceLeaveUnit
  code: AttendanceLeaveCode
  reason: string
}

export type EmployeeDraft = {
  id?: string
  initials: string
  name: string
  dingTalkUserId: string
  group: AttendanceGroup
  annualEntitlement: number
  carryForward: number
  active: boolean
  employmentStartDate: string
  employmentEndDate: string
}

export type CorrectionDraft = {
  recordId: string
  personId: string
  employeeName: string
  date: string
  signIn: string
  signOut: string
  originalSignIn: string
  originalSignOut: string
  reviewNote: string
  signInOverrideId?: string
  signOutOverrideId?: string
}

export type HolidayDraft = {
  employeeId: string
  units: number
  note: string
}

export type AttendanceImportPreview = {
  file: File
  summary: Record<string, number | string>
  issues: string[]
  hasErrors: boolean
}
