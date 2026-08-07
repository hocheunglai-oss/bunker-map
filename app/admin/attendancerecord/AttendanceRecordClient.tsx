"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import { hktTimeFromTimestamp } from "@/lib/attendanceRules"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import styles from "./attendanceRecord.module.css"
import type {
  AttendanceDailyRecord,
  AttendanceDashboardPayload,
  AttendanceEmployee,
  AttendanceGroup,
  AttendanceLeaveCode,
  AttendanceLeaveRecord,
  AttendanceLeaveUnit,
  AttendanceMonthlySummaryRow,
  AttendanceResult,
  AttendanceSyncStatus,
  ApiAttendanceDailyItem,
  ApiAttendanceEntitlement,
  ApiAttendanceLeaveEntry,
  ApiAttendanceMonthlySummary,
  ApiAttendancePerson,
  ApiAttendanceSyncRun,
  ApiDailyResponse,
  ApiLeaveResponse,
  ApiMonthlyResponse,
  ApiSettingsResponse,
  AttendanceImportPreview,
  CorrectionDraft,
  EmployeeDraft,
  HolidayDraft,
  LeaveDraft,
} from "./types"

type TabId = "daily" | "leave" | "monthly" | "settings"

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "daily", label: "DAILY RECORD" },
  { id: "leave", label: "LEAVE RECORD" },
  { id: "monthly", label: "MONTHLY SUMMARY" },
  { id: "settings", label: "SETTINGS" },
]

const GROUPS: AttendanceGroup[] = ["BT", "BS", "AC"]
const LEAVE_UNITS: Array<{ value: AttendanceLeaveUnit; label: string }> = [
  { value: "FULL", label: "Full day" },
  { value: "AM", label: "AM half-day" },
  { value: "PM", label: "PM half-day" },
]
const LEAVE_CODES: Array<{ value: AttendanceLeaveCode; label: string }> = [
  { value: "ALS", label: "ALS · Annual leave with advance notice" },
  { value: "ALU", label: "ALU · Annual leave informed on leave day" },
  { value: "SLM", label: "SLM · Sick leave with medical certificate" },
  { value: "SLR", label: "SLR · Sick leave without medical certificate" },
  { value: "SLX", label: "SLX · Sick leave outside policy" },
  { value: "SPL", label: "SPL · Special leave" },
  { value: "MTL", label: "MTL · Maternity leave" },
  { value: "NPL", label: "NPL · No-pay leave" },
  { value: "HO", label: "HO · Home office" },
  { value: "OS", label: "OS · Business trip" },
]

const RESULT_LABELS: Record<AttendanceResult, string> = {
  COMPLETE: "Complete",
  LATE: "Late",
  LATE_EARLY: "Late / early out",
  EARLY: "Early out",
  MISSING: "Missing punches",
  MISSING_IN: "Missing sign-in",
  MISSING_OUT: "Missing sign-out",
  ON_LEAVE: "On leave",
  HOLIDAY: "Holiday",
  REST_DAY: "Rest day",
  PENDING: "Pending",
}

const EMPTY_SYNC: AttendanceSyncStatus = {
  state: "idle",
  lastSyncedAt: null,
  lastRangeFrom: null,
  lastRangeTo: null,
  recordsImported: 0,
  message: "DingTalk has not been synced yet.",
}

const EMPTY_DATA: AttendanceDashboardPayload = {
  employees: [],
  dailyRecords: [],
  leaveRecords: [],
  monthlySummary: [],
  sync: EMPTY_SYNC,
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

function parseDailyResponse(value: unknown): ApiDailyResponse {
  const source = responseSource(value)
  return {
    view: "daily",
    date: typeof source.date === "string" ? source.date : "",
    people: arrayValue<ApiAttendancePerson>(source.people),
    records: arrayValue<ApiAttendanceDailyItem>(source.records),
  }
}

function parseLeaveResponse(value: unknown): ApiLeaveResponse {
  const source = responseSource(value)
  return {
    view: "leave",
    year: Number(source.year) || 0,
    people: arrayValue<ApiAttendancePerson>(source.people),
    leaveEntries: arrayValue<ApiAttendanceLeaveEntry>(source.leaveEntries),
  }
}

function parseMonthlyResponse(value: unknown): ApiMonthlyResponse {
  const source = responseSource(value)
  return {
    view: "monthly",
    year: Number(source.year) || 0,
    month: Number(source.month) || 0,
    people: arrayValue<ApiAttendancePerson>(source.people),
    summaries: arrayValue<ApiAttendanceMonthlySummary>(source.summaries),
  }
}

function parseSettingsResponse(value: unknown): ApiSettingsResponse {
  const source = responseSource(value)
  return {
    view: "settings",
    year: Number(source.year) || 0,
    people: arrayValue<ApiAttendancePerson>(source.people),
    entitlements: arrayValue<ApiAttendanceEntitlement>(source.entitlements),
    monthlyAdjustments: arrayValue(source.monthlyAdjustments),
    syncRuns: arrayValue<ApiAttendanceSyncRun>(source.syncRuns),
    schedules: arrayValue(source.schedules),
  }
}

function mapResult(item: ApiAttendanceDailyItem): AttendanceResult {
  const status = String(item.status || "").toUpperCase().replace(/[\s-]+/g, "_")
  const leaveEntries = Array.isArray(item.leave) ? item.leave : item.leave ? [item.leave] : []
  if (leaveEntries.some((entry) => entry.portion === "full")) return "ON_LEAVE"
  if (status.includes("REST")) return "REST_DAY"
  if (status.includes("HOLIDAY")) return "HOLIDAY"
  if (status === "MISSING") return "MISSING"
  if (status === "INCOMPLETE") return item.effectiveSignIn ? "MISSING_OUT" : "MISSING_IN"
  if (status.includes("MISSING") && status.includes("IN")) return "MISSING_IN"
  if (status.includes("MISSING") && status.includes("OUT")) return "MISSING_OUT"
  if ((item.late && item.early) || status.includes("LATE_AND_EARLY")) return "LATE_EARLY"
  if (item.late || status.includes("LATE")) return "LATE"
  if (item.early || status.includes("EARLY")) return "EARLY"
  if (leaveEntries.length || status.includes("PARTIAL_LEAVE")) return "ON_LEAVE"
  if (status === "PRESENT" || status === "COMPLETE" || status === "NORMAL" || status === "OK") return "COMPLETE"
  return "PENDING"
}

function latestSyncStatus(syncRuns: ApiAttendanceSyncRun[]): AttendanceSyncStatus {
  let latest: ApiAttendanceSyncRun | null = null
  for (const run of syncRuns) {
    if (!latest || run.startedAt > latest.startedAt) latest = run
  }
  if (!latest) return EMPTY_SYNC

  const status = latest.status.toLowerCase()
  const state: AttendanceSyncStatus["state"] = status.includes("running")
    ? "running"
    : status.includes("success") || status.includes("succeed") || status.includes("complete")
      ? "success"
      : status.includes("error") || status.includes("fail") || status.includes("partial")
        ? "error"
        : "idle"

  return {
    state,
    lastSyncedAt: latest.completedAt || latest.startedAt,
    lastRangeFrom: latest.windowFrom,
    lastRangeTo: latest.windowTo,
    recordsImported: latest.recordsInserted,
    message: latest.errorSummary || (state === "success" ? "DingTalk sync completed." : `DingTalk sync ${latest.status}.`),
  }
}

function codeTotal(summary: ApiAttendanceMonthlySummary, code: string) {
  const value = Number(summary.codeTotals?.[code] ?? summary.codeTotals?.[code.toLowerCase()] ?? 0)
  return Number.isFinite(value) ? value : 0
}

function buildDashboard(
  daily: ApiDailyResponse,
  leave: ApiLeaveResponse,
  monthly: ApiMonthlyResponse,
  settings: ApiSettingsResponse,
  selectedDate: string,
  year: number,
): AttendanceDashboardPayload {
  const peopleMap = new Map<string, ApiAttendancePerson>()
  for (const person of [...daily.people, ...leave.people, ...monthly.people, ...settings.people]) {
    peopleMap.set(person.id, person)
  }
  for (const item of daily.records) peopleMap.set(item.person.id, item.person)
  for (const summary of monthly.summaries) peopleMap.set(summary.person.id, summary.person)

  const entitlementMap = new Map(
    settings.entitlements
      .filter((entitlement) => entitlement.year === year)
      .map((entitlement) => [entitlement.personId, entitlement]),
  )
  const employees: AttendanceEmployee[] = Array.from(peopleMap.values()).map((person) => {
    const entitlement = entitlementMap.get(person.id)
    return {
      id: person.id,
      initials: person.staffCode,
      name: person.displayName,
      dingTalkUserId: person.dingTalkUserId || "",
      group: person.team,
      annualEntitlement: entitlement?.allowanceUnits || 0,
      carryForward: entitlement?.openingCarryForwardUnits || 0,
      active: person.isActive,
      employmentStartDate: person.employmentStartDate || "",
      employmentEndDate: person.employmentEndDate || "",
    }
  })

  const dailyRecords: AttendanceDailyRecord[] = daily.records.map((item) => {
    const leaveEntries = Array.isArray(item.leave) ? item.leave : item.leave ? [item.leave] : []
    const firstLeave = leaveEntries[0]
    const result = mapResult(item)
    const corrected = item.overrides.length > 0
    const signInOverride = item.overrides.find(
      (override) => override.action === "replace" && override.checkType === "OnDuty",
    )
    const signOutOverride = item.overrides.find(
      (override) => override.action === "replace" && override.checkType === "OffDuty",
    )
    return {
      id: `${item.person.id}:${selectedDate}`,
      date: selectedDate,
      employeeId: item.person.id,
      employeeName: item.person.displayName,
      initials: item.person.staffCode,
      group: item.person.team,
      signIn: item.effectiveSignIn,
      signOut: item.effectiveSignOut,
      result,
      leaveCode: firstLeave?.code || null,
      leaveUnit: firstLeave
        ? firstLeave.portion === "am" ? "AM" : firstLeave.portion === "pm" ? "PM" : "FULL"
        : null,
      source: corrected ? "MANUAL" : item.punches.length ? "DINGTALK" : firstLeave ? "MANUAL" : "DINGTALK",
      reviewed: corrected || result === "COMPLETE" || result === "ON_LEAVE" || result === "HOLIDAY" || result === "REST_DAY",
      reviewNote: item.overrides.map((override) => override.reason).filter(Boolean).join(" · "),
      signInOverrideId: signInOverride?.id,
      signOutOverrideId: signOutOverride?.id,
    }
  })

  const leaveGroups = new Map<string, ApiAttendanceLeaveEntry[]>()
  for (const entry of leave.leaveEntries) {
    const entries = leaveGroups.get(entry.groupId) || []
    entries.push(entry)
    leaveGroups.set(entry.groupId, entries)
  }
  const leaveRecords: AttendanceLeaveRecord[] = Array.from(leaveGroups.values()).map((entries) => {
    const sorted = [...entries].sort((left, right) => left.leaveDate.localeCompare(right.leaveDate))
    const first = sorted[0]
    const person = peopleMap.get(first.personId)
    return {
      id: first.id,
      groupId: first.groupId,
      employeeId: first.personId,
      employeeName: person?.displayName || "Unknown staff",
      initials: person?.staffCode || "—",
      fromDate: first.leaveDate,
      toDate: sorted.at(-1)?.leaveDate || first.leaveDate,
      unit: first.portion === "am" ? "AM" : first.portion === "pm" ? "PM" : "FULL",
      code: first.code,
      days: sorted.reduce((total, entry) => total + entry.units, 0),
      reason: first.note || "",
      source: "MANUAL",
    }
  })

  const monthlySummary: AttendanceMonthlySummaryRow[] = monthly.summaries.map((summary) => ({
    employeeId: summary.person.id,
    employeeName: summary.person.displayName,
    initials: summary.person.staffCode,
    group: summary.person.team,
    openingCarryForward: summary.entitlement?.openingCarryForwardUnits || 0,
    annualAllowance: summary.entitlement?.allowanceUnits || 0,
    holidayAttendance: codeTotal(summary, "HOL"),
    als: codeTotal(summary, "ALS"),
    alu: codeTotal(summary, "ALU"),
    slm: codeTotal(summary, "SLM"),
    slr: codeTotal(summary, "SLR"),
    slx: codeTotal(summary, "SLX"),
    spl: codeTotal(summary, "SPL"),
    mtl: codeTotal(summary, "MTL"),
    npl: codeTotal(summary, "NPL"),
    ho: codeTotal(summary, "HO"),
    os: codeTotal(summary, "OS"),
    leaveBalance: Number(summary.balance) || 0,
  }))

  return {
    employees,
    dailyRecords,
    leaveRecords,
    monthlySummary,
    sync: latestSyncStatus(settings.syncRuns),
    fetchedAt: new Date().toISOString(),
  }
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

function displayDate(value: string) {
  if (!value) return "—"
  const [year, month, day] = value.slice(0, 10).split("-")
  return year && month && day ? `${day}/${month}/${year}` : value
}

function displayDateTime(value: string | null) {
  if (!value) return "Never"
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
  if (!value) return "—"
  return hktTimeFromTimestamp(value) || value.slice(0, 5)
}

function displayDays(value: number) {
  if (!Number.isFinite(value)) return "0"
  return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")
}

function resultTone(result: AttendanceResult) {
  if (result === "COMPLETE") return styles.successBadge
  if (result === "ON_LEAVE" || result === "HOLIDAY" || result === "REST_DAY") {
    return styles.neutralBadge
  }
  if (result === "PENDING") return styles.warningBadge
  return styles.dangerBadge
}

function makeLeaveDraft(date: string, employees: AttendanceEmployee[]): LeaveDraft {
  return {
    employeeId: employees.find((employee) => employee.active)?.id || "",
    fromDate: date,
    toDate: date,
    unit: "FULL",
    code: "ALS",
    reason: "",
  }
}

function makeEmployeeDraft(): EmployeeDraft {
  return {
    initials: "",
    name: "",
    dingTalkUserId: "",
    group: "BT",
    annualEntitlement: 0,
    carryForward: 0,
    active: true,
    employmentStartDate: "",
    employmentEndDate: "",
  }
}

function getErrorMessage(value: unknown, fallback: string) {
  if (isObject(value) && typeof value.message === "string" && value.message.trim()) {
    return value.message
  }
  return fallback
}

export default function AttendanceRecordClient() {
  const { loading: authLoading, authenticated, permissions, role } = useSimpleAdminAuth()
  const importFileRef = useRef<HTMLInputElement | null>(null)
  const loadRequestRef = useRef(0)
  const today = useMemo(() => hongKongDateKey(), [])
  const [activeTab, setActiveTab] = useState<TabId>("daily")
  const [selectedDate, setSelectedDate] = useState(today)
  const [selectedMonth, setSelectedMonth] = useState(today.slice(0, 7))
  const [staffFilter, setStaffFilter] = useState("all")
  const [groupFilter, setGroupFilter] = useState<"all" | AttendanceGroup>("all")
  const [resultFilter, setResultFilter] = useState<"all" | AttendanceResult>("all")
  const [data, setData] = useState<AttendanceDashboardPayload>(EMPTY_DATA)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [notice, setNotice] = useState("")
  const [pendingAction, setPendingAction] = useState("")
  const [leaveDraft, setLeaveDraft] = useState<LeaveDraft | null>(null)
  const [employeeDraft, setEmployeeDraft] = useState<EmployeeDraft | null>(null)
  const [correctionDraft, setCorrectionDraft] = useState<CorrectionDraft | null>(null)
  const [holidayDraft, setHolidayDraft] = useState<HolidayDraft | null>(null)
  const [importPreview, setImportPreview] = useState<AttendanceImportPreview | null>(null)

  const canEdit =
    authenticated &&
    (isAdminRole(role) || canAccessAdminPage(permissions, "attendance-record", "edit"))

  const loadDashboard = useCallback(async () => {
    if (!authenticated) return
    const requestId = loadRequestRef.current + 1
    loadRequestRef.current = requestId
    setLoading(true)
    setLoadError("")

    const [yearText, monthText] = selectedMonth.split("-")
    const year = Number(yearText)
    const month = Number(monthText)
    try {
      const fetchView = async (params: Record<string, string>) => {
        const query = new URLSearchParams(params)
        const response = await fetch(`/api/admin/attendance?${query.toString()}`, { cache: "no-store" })
        const payload: unknown = await response.json().catch(() => ({}))
        if (!response.ok) {
          throw new Error(getErrorMessage(payload, "Attendance records could not be loaded."))
        }
        return payload
      }
      const [dailyPayload, leavePayload, monthlyPayload, settingsPayload] = await Promise.all([
        fetchView({ view: "daily", date: selectedDate }),
        fetchView({ view: "leave", year: yearText }),
        fetchView({ view: "monthly", year: yearText, month: String(month) }),
        fetchView({ view: "settings", year: yearText }),
      ])
      const dashboard = buildDashboard(
        parseDailyResponse(dailyPayload),
        parseLeaveResponse(leavePayload),
        parseMonthlyResponse(monthlyPayload),
        parseSettingsResponse(settingsPayload),
        selectedDate,
        year,
      )
      if (loadRequestRef.current === requestId) setData(dashboard)
    } catch (error) {
      if (loadRequestRef.current === requestId) {
        setLoadError(error instanceof Error ? error.message : "Attendance records could not be loaded.")
      }
    } finally {
      if (loadRequestRef.current === requestId) setLoading(false)
    }
  }, [authenticated, selectedDate, selectedMonth])

  useEffect(() => {
    if (authLoading || !authenticated) return
    const timer = window.setTimeout(() => void loadDashboard(), 0)
    return () => window.clearTimeout(timer)
  }, [authLoading, authenticated, loadDashboard])

  useEffect(() => {
    if (!leaveDraft && !employeeDraft && !correctionDraft && !holidayDraft && !importPreview) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      setLeaveDraft(null)
      setEmployeeDraft(null)
      setCorrectionDraft(null)
      setHolidayDraft(null)
      setImportPreview(null)
    }
    window.addEventListener("keydown", closeOnEscape)
    return () => window.removeEventListener("keydown", closeOnEscape)
  }, [correctionDraft, employeeDraft, holidayDraft, importPreview, leaveDraft])

  const runMutation = useCallback(
    async (
      action: string,
      body: Record<string, unknown>,
      successMessage: string,
      options: { refresh?: boolean } = {},
    ): Promise<Record<string, unknown> | null> => {
      if (!canEdit) {
        setNotice("You have view-only access. Ask an administrator for Edit permission in User Management.")
        return null
      }

      setPendingAction(action)
      setNotice("")
      try {
        const response = await fetch("/api/admin/attendance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...body }),
        })
        const payload: unknown = await response.json().catch(() => ({}))
        if (!response.ok) {
          throw new Error(getErrorMessage(payload, "The attendance record could not be updated."))
        }
        setNotice(getErrorMessage(payload, successMessage))
        if (options.refresh !== false) await loadDashboard()
        return isObject(payload) ? payload : { success: true }
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "The attendance record could not be updated.")
        return null
      } finally {
        setPendingAction("")
      }
    },
    [canEdit, loadDashboard],
  )

  const employeesById = useMemo(
    () => new Map(data.employees.map((employee) => [employee.id, employee])),
    [data.employees],
  )

  const dailyRows = useMemo(() => {
    return data.dailyRecords.filter((record) => {
      if (record.date.slice(0, 10) !== selectedDate) return false
      if (staffFilter !== "all" && record.employeeId !== staffFilter) return false
      if (groupFilter !== "all" && record.group !== groupFilter) return false
      if (resultFilter !== "all" && record.result !== resultFilter) return false
      return true
    })
  }, [data.dailyRecords, groupFilter, resultFilter, selectedDate, staffFilter])

  const dailySummary = useMemo(() => {
    let complete = 0
    let exceptions = 0
    let onLeave = 0
    for (const row of dailyRows) {
      if (row.result === "COMPLETE") complete += 1
      else if (["ON_LEAVE", "HOLIDAY", "REST_DAY"].includes(row.result)) onLeave += 1
      else exceptions += 1
    }
    return { total: dailyRows.length, complete, exceptions, onLeave }
  }, [dailyRows])

  const leaveRows = useMemo(() => {
    return data.leaveRecords.filter((record) => {
      if (staffFilter !== "all" && record.employeeId !== staffFilter) return false
      if (groupFilter !== "all" && employeesById.get(record.employeeId)?.group !== groupFilter) {
        return false
      }
      return true
    })
  }, [data.leaveRecords, employeesById, groupFilter, staffFilter])

  const monthlyTotals = useMemo(() => {
    return data.monthlySummary.reduce(
      (totals, row) => ({
        opening: totals.opening + row.openingCarryForward,
        allowance: totals.allowance + row.annualAllowance,
        holiday: totals.holiday + row.holidayAttendance,
        deducted: totals.deducted + row.als + row.alu + row.slx,
        balance: totals.balance + row.leaveBalance,
      }),
      { opening: 0, allowance: 0, holiday: 0, deducted: 0, balance: 0 },
    )
  }, [data.monthlySummary])

  async function syncDingTalk() {
    await runMutation(
      "sync",
      { date: selectedDate },
      "DingTalk attendance sync completed.",
    )
  }

  async function saveLeave() {
    if (!leaveDraft) return
    if (!leaveDraft.employeeId || !leaveDraft.fromDate || !leaveDraft.toDate) {
      setNotice("Choose a staff member and a valid date range.")
      return
    }
    if (leaveDraft.toDate < leaveDraft.fromDate) {
      setNotice("Leave end date cannot be before its start date.")
      return
    }
    if (leaveDraft.unit !== "FULL" && leaveDraft.fromDate !== leaveDraft.toDate) {
      setNotice("AM and PM half-day leave must use a single date.")
      return
    }
    const saved = await runMutation(
      "save-leave",
      {
        leave: {
          id: leaveDraft.id,
          groupId: leaveDraft.groupId,
          personId: leaveDraft.employeeId,
          fromDate: leaveDraft.fromDate,
          toDate: leaveDraft.toDate,
          portion: leaveDraft.unit.toLowerCase(),
          code: leaveDraft.code,
          note: leaveDraft.reason.trim() || undefined,
        },
      },
      leaveDraft.id ? "Leave record updated." : "Leave record added.",
    )
    if (saved) setLeaveDraft(null)
  }

  async function deleteLeave(record: AttendanceLeaveRecord) {
    if (!window.confirm(`Delete ${record.code} for ${record.employeeName}?`)) return
    await runMutation("delete-leave", { id: record.id }, "Leave record deleted.")
  }

  async function saveEmployee() {
    if (!employeeDraft) return
    if (!employeeDraft.initials.trim() || !employeeDraft.name.trim()) {
      setNotice("Initials and staff name are required.")
      return
    }
    if (
      !Number.isFinite(employeeDraft.annualEntitlement) ||
      employeeDraft.annualEntitlement < 0 ||
      employeeDraft.annualEntitlement > 366 ||
      Math.abs(employeeDraft.annualEntitlement * 100 - Math.round(employeeDraft.annualEntitlement * 100)) > 1e-8 ||
      !Number.isFinite(employeeDraft.carryForward) ||
      employeeDraft.carryForward < -366 ||
      employeeDraft.carryForward > 366 ||
      Math.abs(employeeDraft.carryForward * 100 - Math.round(employeeDraft.carryForward * 100)) > 1e-8
    ) {
      setNotice("Entitlement and carry-forward must use values between the allowed limits with no more than two decimals.")
      return
    }
    const personResult = await runMutation(
      "save-person",
      {
        person: {
          id: employeeDraft.id,
          staffCode: employeeDraft.initials.trim().toUpperCase(),
          displayName: employeeDraft.name.trim(),
          dingTalkUserId: employeeDraft.dingTalkUserId.trim() || null,
          team: employeeDraft.group,
          isActive: employeeDraft.active,
          employmentStartDate: employeeDraft.employmentStartDate || null,
          employmentEndDate: employeeDraft.employmentEndDate || null,
        },
      },
      employeeDraft.id ? "Staff settings updated." : "Staff member added.",
      { refresh: false },
    )
    if (!personResult) return

    const returnedPerson = isObject(personResult.person) ? personResult.person : null
    const personId =
      (returnedPerson && typeof returnedPerson.id === "string" ? returnedPerson.id : "") ||
      employeeDraft.id ||
      ""
    if (!personId) {
      setNotice("Staff was saved, but its new ID was not returned. Refresh and set the entitlement separately.")
      await loadDashboard()
      return
    }

    const entitlementResult = await runMutation(
      "save-entitlement",
      {
        entitlement: {
          personId,
          year: Number(selectedMonth.slice(0, 4)),
          allowanceUnits: employeeDraft.annualEntitlement,
          openingCarryForwardUnits: employeeDraft.carryForward,
        },
      },
      "Staff and annual opening values saved.",
    )
    if (entitlementResult) setEmployeeDraft(null)
  }

  async function saveCorrection() {
    if (!correctionDraft) return
    const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/
    if (
      (correctionDraft.signIn && !timePattern.test(correctionDraft.signIn)) ||
      (correctionDraft.signOut && !timePattern.test(correctionDraft.signOut))
    ) {
      setNotice("Corrected times must use the 24-hour HH:MM format.")
      return
    }
    if (
      !correctionDraft.signIn &&
      !correctionDraft.signOut &&
      !correctionDraft.signInOverrideId &&
      !correctionDraft.signOutOverrideId
    ) {
      setNotice("Enter at least one corrected punch time.")
      return
    }
    if (!correctionDraft.reviewNote.trim()) {
      setNotice("A review note is required for an attendance correction.")
      return
    }
    const replaceSignIn = Boolean(
      correctionDraft.signIn &&
      (correctionDraft.signIn !== correctionDraft.originalSignIn || correctionDraft.signInOverrideId),
    )
    const replaceSignOut = Boolean(
      correctionDraft.signOut &&
      (correctionDraft.signOut !== correctionDraft.originalSignOut || correctionDraft.signOutOverrideId),
    )
    const overrides = [
      replaceSignIn
        ? {
            id: correctionDraft.signInOverrideId,
            personId: correctionDraft.personId,
            workDate: correctionDraft.date,
            action: "replace",
            checkType: "OnDuty",
            punchTime: `${correctionDraft.date}T${correctionDraft.signIn}:00+08:00`,
            reason: correctionDraft.reviewNote.trim(),
          }
        : null,
      replaceSignOut
        ? {
            id: correctionDraft.signOutOverrideId,
            personId: correctionDraft.personId,
            workDate: correctionDraft.date,
            action: "replace",
            checkType: "OffDuty",
            punchTime: `${correctionDraft.date}T${correctionDraft.signOut}:00+08:00`,
            reason: correctionDraft.reviewNote.trim(),
      }
        : null,
    ].filter(Boolean)
    const deleteOverrideIds = [
      correctionDraft.signInOverrideId && !correctionDraft.signIn
        ? correctionDraft.signInOverrideId
        : null,
      correctionDraft.signOutOverrideId && !correctionDraft.signOut
        ? correctionDraft.signOutOverrideId
        : null,
    ].filter((id): id is string => Boolean(id))
    if (!overrides.length && !deleteOverrideIds.length) {
      setNotice("Change at least one punch time before saving the correction.")
      return
    }
    for (const id of deleteOverrideIds) {
      const deleted = await runMutation(
        "delete-override",
        { id },
        "Manual correction removed.",
        { refresh: false },
      )
      if (!deleted) return
    }
    if (overrides.length) {
      const saved = await runMutation(
        "save-override",
        { overrides },
        "Attendance correction saved and reviewed.",
      )
      if (saved) setCorrectionDraft(null)
      return
    }
    await loadDashboard()
    setNotice("Manual correction removed; the original DingTalk punch is active again.")
    setCorrectionDraft(null)
  }

  async function saveHolidayAdjustment() {
    if (!holidayDraft) return
    if (!holidayDraft.employeeId || !Number.isFinite(holidayDraft.units) || holidayDraft.units <= 0 || holidayDraft.units % 0.5 !== 0) {
      setNotice("Choose a staff member and enter holiday attendance in 0.5-day increments.")
      return
    }
    const [year, month] = selectedMonth.split("-").map(Number)
    const saved = await runMutation(
      "save-monthly-adjustment",
      {
        adjustment: {
          personId: holidayDraft.employeeId,
          year,
          month,
          code: "HOL",
          units: holidayDraft.units,
          source: "manual",
          confirmed: true,
          note: holidayDraft.note.trim() || undefined,
        },
      },
      "Holiday attendance credit added.",
    )
    if (saved) setHolidayDraft(null)
  }

  async function uploadLegacyWorkbook(file: File, mode: "dry-run" | "apply") {
    if (!canEdit) return
    setPendingAction(`import-${mode}`)
    setNotice("")
    try {
      const formData = new FormData()
      formData.set("file", file)
      formData.set("mode", mode)
      const response = await fetch("/api/admin/attendance/import", { method: "POST", body: formData })
      const payload: unknown = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(getErrorMessage(payload, "The workbook could not be imported."))

      const result = isObject(payload) ? payload : {}
      const issueObjects = arrayValue<unknown>(result.issues)
      const issues = issueObjects.map((issue) => {
        if (typeof issue === "string") return issue
        if (!isObject(issue)) return JSON.stringify(issue)
        const severity = typeof issue.severity === "string" ? issue.severity.toUpperCase() : "REVIEW"
        const location = [
          typeof issue.sheet === "string" ? issue.sheet : "",
          typeof issue.row === "number" ? `row ${issue.row}` : "",
        ].filter(Boolean).join(" · ")
        const message = typeof issue.message === "string" ? issue.message : JSON.stringify(issue)
        return `${severity}${location ? ` · ${location}` : ""} · ${message}`
      })
      const apply = isObject(result.apply) ? result.apply : {}
      const dryRun = isObject(result.dryRun) ? result.dryRun : {}
      const source = isObject(result.source) ? result.source : {}
      const summary: Record<string, number | string> = {
        "Workbook type": typeof result.workbookType === "string" ? result.workbookType : "Legacy attendance workbook",
        "Workbook year": typeof source.year === "number" ? source.year : "Not detected",
        "Sheets": Array.isArray(source.sheetNames) ? source.sheetNames.join(", ") : "Not reported",
      }
      for (const [key, value] of Object.entries(dryRun)) {
        if (typeof value === "number" || typeof value === "string") summary[key] = value
      }
      for (const [key, value] of Object.entries(apply)) {
        if (typeof value === "number" || typeof value === "string") summary[key] = value
        if (Array.isArray(value)) summary[key] = value.join(", ") || "None"
      }

      if (mode === "dry-run") {
        setImportPreview({
          file,
          summary,
          issues,
          hasErrors: issueObjects.some((issue) => isObject(issue) && issue.severity === "error"),
        })
      } else {
        setImportPreview(null)
        const unmapped = Array.isArray(apply.unmappedStaffCodes) ? apply.unmappedStaffCodes.join(", ") : ""
        setNotice(
          unmapped
            ? `Workbook import completed. Unmapped staff not applied: ${unmapped}.`
            : "2026 workbook imported. Daily legacy rows were reviewed but not converted into invented leave dates.",
        )
        await loadDashboard()
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The workbook could not be imported.")
    } finally {
      setPendingAction("")
      if (importFileRef.current) importFileRef.current.value = ""
    }
  }

  function editLeave(record: AttendanceLeaveRecord) {
    setLeaveDraft({
      id: record.id,
      groupId: record.groupId,
      employeeId: record.employeeId,
      fromDate: record.fromDate.slice(0, 10),
      toDate: record.toDate.slice(0, 10),
      unit: record.unit,
      code: record.code,
      reason: record.reason,
    })
  }

  function editEmployee(employee: AttendanceEmployee) {
    setEmployeeDraft({
      id: employee.id,
      initials: employee.initials,
      name: employee.name,
      dingTalkUserId: employee.dingTalkUserId,
      group: employee.group,
      annualEntitlement: employee.annualEntitlement,
      carryForward: employee.carryForward,
      active: employee.active,
      employmentStartDate: employee.employmentStartDate,
      employmentEndDate: employee.employmentEndDate,
    })
  }

  function editCorrection(record: AttendanceDailyRecord) {
    const signIn = displayTime(record.signIn) === "—" ? "" : displayTime(record.signIn)
    const signOut = displayTime(record.signOut) === "—" ? "" : displayTime(record.signOut)
    setCorrectionDraft({
      recordId: record.id,
      personId: record.employeeId,
      employeeName: `${record.initials} · ${record.employeeName}`,
      date: record.date.slice(0, 10),
      signIn,
      signOut,
      originalSignIn: signIn,
      originalSignOut: signOut,
      reviewNote: record.reviewNote,
      signInOverrideId: record.signInOverrideId,
      signOutOverrideId: record.signOutOverrideId,
    })
  }

  if (authLoading || (loading && !data.fetchedAt && data.employees.length === 0)) {
    return (
      <main className={styles.page}>
        <div className={styles.shell} aria-busy="true">
          <div className={styles.loadingPanel}>
            <span className={styles.spinner} aria-hidden="true" />
            <strong>Loading attendance records</strong>
            <span>Preparing staff, leave and DingTalk data.</span>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <div className={styles.eyebrow}>OFFICE TOOL</div>
            <h1>ATTENDANCE RECORD</h1>
            <p>Sign-in, sign-out and manually entered leave records in Hong Kong time.</p>
          </div>
          <div className={styles.accessSummary}>
            <span className={canEdit ? styles.editAccess : styles.viewAccess}>
              {canEdit ? "Edit access" : "View access"}
            </span>
            <span>{data.employees.filter((employee) => employee.active).length} active staff</span>
          </div>
        </header>

        {loadError ? (
          <section className={styles.errorPanel} role="alert">
            <div>
              <strong>Attendance data is unavailable</strong>
              <span>{loadError}</span>
            </div>
            <button type="button" onClick={() => void loadDashboard()} className={styles.secondaryButton}>
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

        {activeTab === "daily" ? (
          <section className={styles.tabContent} aria-labelledby="daily-record-heading">
            <div className={styles.toolbar} data-admin-view-safe="true">
              <div>
                <h2 id="daily-record-heading">Daily record</h2>
                <p>One line per staff member, combining DingTalk punches with manual leave and corrections.</p>
              </div>
              <div className={styles.toolbarActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void loadDashboard()}
                  disabled={loading}
                >
                  {loading ? "Refreshing…" : "Refresh"}
                </button>
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => void syncDingTalk()}
                  disabled={!canEdit || pendingAction === "sync"}
                  title={canEdit ? "Import the latest DingTalk punches" : "Edit permission required"}
                >
                  {pendingAction === "sync" ? "Syncing…" : "Sync DingTalk"}
                </button>
              </div>
            </div>

            <div className={styles.syncStrip}>
              <span className={`${styles.syncDot} ${styles[`sync_${data.sync.state}`]}`} aria-hidden="true" />
              <div>
                <strong>{data.sync.message || "DingTalk sync status"}</strong>
                <span>
                  Last sync: {displayDateTime(data.sync.lastSyncedAt)}
                  {data.sync.recordsImported ? ` · ${data.sync.recordsImported} record(s) imported` : ""}
                </span>
              </div>
            </div>

            <div className={styles.filterGrid} data-admin-view-safe="true">
              <label>
                Date
                <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
              </label>
              <label>
                Staff
                <select value={staffFilter} onChange={(event) => setStaffFilter(event.target.value)}>
                  <option value="all">All staff</option>
                  {data.employees.map((employee) => (
                    <option value={employee.id} key={employee.id}>{employee.initials} · {employee.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Group
                <select
                  value={groupFilter}
                  onChange={(event) => setGroupFilter(event.target.value as "all" | AttendanceGroup)}
                >
                  <option value="all">All groups</option>
                  {GROUPS.map((group) => <option value={group} key={group}>{group}</option>)}
                </select>
              </label>
              <label>
                Result
                <select
                  value={resultFilter}
                  onChange={(event) => setResultFilter(event.target.value as "all" | AttendanceResult)}
                >
                  <option value="all">All results</option>
                  {Object.entries(RESULT_LABELS).map(([value, label]) => (
                    <option value={value} key={value}>{label}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className={styles.summaryGrid}>
              <article><span>Staff shown</span><strong>{dailySummary.total}</strong></article>
              <article><span>Complete</span><strong>{dailySummary.complete}</strong></article>
              <article><span>Exceptions</span><strong>{dailySummary.exceptions}</strong></article>
              <article><span>Leave / holiday</span><strong>{dailySummary.onLeave}</strong></article>
            </div>

            <div className={styles.tablePanel}>
              <table className={styles.dailyTable}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Staff</th>
                    <th>Group</th>
                    <th>Sign-in</th>
                    <th>Sign-out</th>
                    <th>Result</th>
                    <th>Leave</th>
                    <th>Source</th>
                    <th>Review</th>
                    <th aria-label="Record actions" />
                  </tr>
                </thead>
                <tbody>
                  {dailyRows.map((record) => (
                    <tr key={record.id}>
                      <td>{displayDate(record.date)}</td>
                      <td><strong>{record.initials}</strong><span className={styles.secondaryText}>{record.employeeName}</span></td>
                      <td><span className={styles.groupBadge}>{record.group}</span></td>
                      <td className={styles.timeCell}>{displayTime(record.signIn)}</td>
                      <td className={styles.timeCell}>{displayTime(record.signOut)}</td>
                      <td><span className={`${styles.badge} ${resultTone(record.result)}`}>{RESULT_LABELS[record.result] || record.result}</span></td>
                      <td>{record.leaveCode ? <span className={styles.codeBadge}>{record.leaveCode} · {record.leaveUnit}</span> : "—"}</td>
                      <td>{record.source}</td>
                      <td>
                        <span className={record.reviewed ? styles.reviewedButton : styles.reviewButton}>
                          {record.reviewed ? "Reviewed" : "Needs review"}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className={styles.textButton}
                          onClick={() => editCorrection(record)}
                          disabled={!canEdit}
                          title={canEdit ? "Correct times and add a review note" : "Edit permission required"}
                        >
                          Correct
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!dailyRows.length ? (
                    <tr><td colSpan={10}><div className={styles.emptyState}><strong>No daily records</strong><span>Try another date or clear the filters. If this is a new date, run DingTalk sync.</span></div></td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {activeTab === "leave" ? (
          <section className={styles.tabContent} aria-labelledby="leave-record-heading">
            <div className={styles.toolbar}>
              <div>
                <h2 id="leave-record-heading">Leave record</h2>
                <p>Manual entries only. Half-days and legacy leave codes are retained; HOL is recorded in Monthly Summary.</p>
              </div>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => setLeaveDraft(makeLeaveDraft(selectedDate, data.employees))}
                disabled={!canEdit}
                title={canEdit ? "Add a manual leave record" : "Edit permission required"}
              >
                Add leave record
              </button>
            </div>

            <div className={styles.filterGridCompact} data-admin-view-safe="true">
              <label>
                Staff
                <select value={staffFilter} onChange={(event) => setStaffFilter(event.target.value)}>
                  <option value="all">All staff</option>
                  {data.employees.map((employee) => <option value={employee.id} key={employee.id}>{employee.initials} · {employee.name}</option>)}
                </select>
              </label>
              <label>
                Group
                <select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value as "all" | AttendanceGroup)}>
                  <option value="all">All groups</option>
                  {GROUPS.map((group) => <option value={group} key={group}>{group}</option>)}
                </select>
              </label>
            </div>

            <div className={styles.tablePanel}>
              <table className={styles.leaveTable}>
                <thead><tr><th>Staff</th><th>From</th><th>To</th><th>Unit</th><th>Code</th><th>Days</th><th>Reason</th><th>Source</th><th aria-label="Leave actions" /></tr></thead>
                <tbody>
                  {leaveRows.map((record) => (
                    <tr key={record.id}>
                      <td><strong>{record.initials}</strong><span className={styles.secondaryText}>{record.employeeName}</span></td>
                      <td>{displayDate(record.fromDate)}</td>
                      <td>{displayDate(record.toDate)}</td>
                      <td>{LEAVE_UNITS.find((unit) => unit.value === record.unit)?.label || record.unit}</td>
                      <td><span className={styles.codeBadge}>{record.code}</span></td>
                      <td>{displayDays(record.days)}</td>
                      <td className={styles.reasonCell}>{record.reason || "—"}</td>
                      <td>{record.source}</td>
                      <td>
                        <div className={styles.rowActions}>
                          <button type="button" className={styles.textButton} onClick={() => editLeave(record)} disabled={!canEdit}>Edit</button>
                          <button type="button" className={styles.deleteTextButton} onClick={() => void deleteLeave(record)} disabled={!canEdit || Boolean(pendingAction)}>Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!leaveRows.length ? (
                    <tr><td colSpan={9}><div className={styles.emptyState}><strong>No leave records</strong><span>Add a manual entry or choose a different staff filter.</span></div></td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {activeTab === "monthly" ? (
          <section className={styles.tabContent} aria-labelledby="monthly-summary-heading">
            <div className={styles.toolbar}>
              <div>
                <h2 id="monthly-summary-heading">Monthly summary</h2>
                <p>Opening carry-forward + allowance + holiday attendance − ALS − ALU − SLX.</p>
              </div>
              <div className={styles.toolbarActions}>
                <label className={styles.monthPicker} data-admin-view-safe="true">
                  Month
                  <input type="month" value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)} />
                </label>
                <a
                  className={styles.secondaryButton}
                  data-admin-view-safe="true"
                  href={`/api/admin/attendance/export?year=${selectedMonth.slice(0, 4)}`}
                >
                  Export {selectedMonth.slice(0, 4)} Excel
                </a>
                <button
                  type="button"
                  className={styles.primaryButton}
                  disabled={!canEdit}
                  onClick={() => setHolidayDraft({ employeeId: data.employees.find((employee) => employee.active)?.id || "", units: 1, note: "" })}
                  title={canEdit ? "Add an attendance credit for work on a public holiday" : "Edit permission required"}
                >
                  Add HOL credit
                </button>
              </div>
            </div>

            <div className={styles.formulaPanel}>
              <span>LEAVE BALANCE</span>
              <strong>Carry-forward + allowance + HOL − ALS − ALU − SLX</strong>
              <small>Saturday attendance has been removed. SLM and SLR remain reported but do not reduce this balance.</small>
            </div>

            <div className={styles.summaryGridFive}>
              <article><span>Opening</span><strong>{displayDays(monthlyTotals.opening)}</strong></article>
              <article><span>Allowance</span><strong>{displayDays(monthlyTotals.allowance)}</strong></article>
              <article><span>Holiday credit</span><strong>{displayDays(monthlyTotals.holiday)}</strong></article>
              <article><span>ALS + ALU + SLX</span><strong>{displayDays(monthlyTotals.deducted)}</strong></article>
              <article><span>Balance</span><strong>{displayDays(monthlyTotals.balance)}</strong></article>
            </div>

            <div className={styles.tablePanel}>
              <table className={styles.monthlyTable}>
                <thead><tr><th>Staff</th><th>Group</th><th>Opening</th><th>Allowance</th><th>HOL</th><th>ALS</th><th>ALU</th><th>SLM</th><th>SLR</th><th>SLX</th><th>SPL</th><th>MTL</th><th>NPL</th><th>HO</th><th>OS</th><th>Balance</th></tr></thead>
                <tbody>
                  {data.monthlySummary.map((row) => (
                    <tr key={row.employeeId}>
                      <td><strong>{row.initials}</strong><span className={styles.secondaryText}>{row.employeeName}</span></td>
                      <td><span className={styles.groupBadge}>{row.group}</span></td>
                      <td>{displayDays(row.openingCarryForward)}</td><td>{displayDays(row.annualAllowance)}</td><td>{displayDays(row.holidayAttendance)}</td><td>{displayDays(row.als)}</td><td>{displayDays(row.alu)}</td><td>{displayDays(row.slm)}</td><td>{displayDays(row.slr)}</td><td>{displayDays(row.slx)}</td><td>{displayDays(row.spl)}</td><td>{displayDays(row.mtl)}</td><td>{displayDays(row.npl)}</td><td>{displayDays(row.ho)}</td><td>{displayDays(row.os)}</td><td><strong>{displayDays(row.leaveBalance)}</strong></td>
                    </tr>
                  ))}
                  {!data.monthlySummary.length ? (
                    <tr><td colSpan={16}><div className={styles.emptyState}><strong>No monthly summary</strong><span>No staff settings or leave data were found for this month.</span></div></td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {activeTab === "settings" ? (
          <section className={styles.tabContent} aria-labelledby="settings-heading">
            <div className={styles.toolbar}>
              <div>
                <h2 id="settings-heading">Settings</h2>
                <p>Staff identity, DingTalk mapping, work group and annual opening values.</p>
              </div>
              <div className={styles.toolbarActions}>
                <label className={styles.yearPicker} data-admin-view-safe="true">
                  Opening year
                  <input
                    type="number"
                    min="2000"
                    max="2200"
                    value={selectedMonth.slice(0, 4)}
                    onChange={(event) => {
                      const year = event.target.value
                      if (/^\d{4}$/.test(year)) setSelectedMonth(`${year}-${selectedMonth.slice(5, 7)}`)
                    }}
                  />
                </label>
                <input
                  ref={importFileRef}
                  className={styles.hiddenInput}
                  type="file"
                  accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void uploadLegacyWorkbook(file, "dry-run")
                  }}
                  disabled={!canEdit || pendingAction.startsWith("import-")}
                />
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => importFileRef.current?.click()}
                  disabled={!canEdit || pendingAction.startsWith("import-")}
                  title={canEdit ? "Dry-run and review the 2026 legacy workbook before importing" : "Edit permission required"}
                >
                  {pendingAction === "import-dry-run" ? "Checking workbook…" : "Import 2026 workbook"}
                </button>
                <button type="button" className={styles.primaryButton} onClick={() => setEmployeeDraft(makeEmployeeDraft())} disabled={!canEdit}>
                  Add staff member
                </button>
              </div>
            </div>

            <div className={styles.ruleGrid}>
              <article><span>BT · Bunker Trader</span><strong>10:00–19:00</strong><small>AM cut-off 11:30 · PM sign-in cut-off 16:30 when AM is on leave</small></article>
              <article><span>BS · Bunker Support</span><strong>10:00–19:00</strong><small>AM cut-off 11:30 · PM sign-in cut-off 16:30 when AM is on leave</small></article>
              <article><span>AC · Accounts</span><strong>09:00–17:30</strong><small>AM cut-off 11:00 · PM sign-in cut-off 15:45 when AM is on leave</small></article>
            </div>

            <div className={styles.tablePanel}>
              <table className={styles.settingsTable}>
                <thead><tr><th>Initials</th><th>Name</th><th>DingTalk user ID</th><th>Group</th><th>Annual entitlement</th><th>Carry-forward</th><th>Status</th><th aria-label="Staff actions" /></tr></thead>
                <tbody>
                  {data.employees.map((employee) => (
                    <tr key={employee.id}>
                      <td><strong>{employee.initials}</strong></td>
                      <td>{employee.name}</td>
                      <td className={styles.monoCell}>{employee.dingTalkUserId || "Not mapped"}</td>
                      <td><span className={styles.groupBadge}>{employee.group}</span></td>
                      <td>{displayDays(employee.annualEntitlement)}</td>
                      <td>{displayDays(employee.carryForward)}</td>
                      <td><span className={`${styles.badge} ${employee.active ? styles.successBadge : styles.neutralBadge}`}>{employee.active ? "Active" : "Inactive"}</span></td>
                      <td><button type="button" className={styles.textButton} onClick={() => editEmployee(employee)} disabled={!canEdit}>Edit</button></td>
                    </tr>
                  ))}
                  {!data.employees.length ? (
                    <tr><td colSpan={8}><div className={styles.emptyState}><strong>No staff configured</strong><span>Add the first staff member to begin importing attendance.</span></div></td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </div>

      {leaveDraft ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setLeaveDraft(null) }}>
          <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="leave-modal-title">
            <div className={styles.modalHeader}>
              <div><span>MANUAL ENTRY</span><h2 id="leave-modal-title">{leaveDraft.id ? "Edit leave record" : "Add leave record"}</h2></div>
              <button type="button" aria-label="Close leave form" onClick={() => setLeaveDraft(null)}>×</button>
            </div>
            <div className={styles.formGrid}>
              <label className={styles.fullField}>Staff<select value={leaveDraft.employeeId} onChange={(event) => setLeaveDraft((draft) => draft ? { ...draft, employeeId: event.target.value } : draft)}><option value="">Choose staff</option>{data.employees.filter((employee) => employee.active).map((employee) => <option value={employee.id} key={employee.id}>{employee.initials} · {employee.name}</option>)}</select></label>
              <label>From<input type="date" value={leaveDraft.fromDate} onChange={(event) => setLeaveDraft((draft) => draft ? { ...draft, fromDate: event.target.value, toDate: draft.toDate < event.target.value ? event.target.value : draft.toDate } : draft)} /></label>
              <label>To<input type="date" value={leaveDraft.toDate} onChange={(event) => setLeaveDraft((draft) => draft ? { ...draft, toDate: event.target.value } : draft)} /></label>
              <label className={styles.fullField}>Unit<select value={leaveDraft.unit} onChange={(event) => setLeaveDraft((draft) => draft ? { ...draft, unit: event.target.value as AttendanceLeaveUnit, toDate: event.target.value === "FULL" ? draft.toDate : draft.fromDate } : draft)}>{LEAVE_UNITS.map((unit) => <option value={unit.value} key={unit.value}>{unit.label}</option>)}</select></label>
              <label className={styles.fullField}>Leave code<select value={leaveDraft.code} onChange={(event) => setLeaveDraft((draft) => draft ? { ...draft, code: event.target.value as AttendanceLeaveCode } : draft)}>{LEAVE_CODES.map((code) => <option value={code.value} key={code.value}>{code.label}</option>)}</select></label>
              <label className={styles.fullField}>Reason / note<textarea rows={3} maxLength={500} value={leaveDraft.reason} onChange={(event) => setLeaveDraft((draft) => draft ? { ...draft, reason: event.target.value } : draft)} placeholder="Optional operational note" /></label>
            </div>
            <div className={styles.modalFooter}><button type="button" className={styles.secondaryButton} onClick={() => setLeaveDraft(null)}>Cancel</button><button type="button" className={styles.primaryButton} onClick={() => void saveLeave()} disabled={pendingAction === "save-leave"}>{pendingAction === "save-leave" ? "Saving…" : "Save leave record"}</button></div>
          </section>
        </div>
      ) : null}

      {employeeDraft ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEmployeeDraft(null) }}>
          <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="employee-modal-title">
            <div className={styles.modalHeader}><div><span>STAFF SETTINGS</span><h2 id="employee-modal-title">{employeeDraft.id ? "Edit staff member" : "Add staff member"}</h2></div><button type="button" aria-label="Close staff form" onClick={() => setEmployeeDraft(null)}>×</button></div>
            <div className={styles.formGrid}>
              <label>Initials<input maxLength={8} value={employeeDraft.initials} onChange={(event) => setEmployeeDraft((draft) => draft ? { ...draft, initials: event.target.value.toUpperCase() } : draft)} placeholder="AB" /></label>
              <label>Name<input maxLength={120} value={employeeDraft.name} onChange={(event) => setEmployeeDraft((draft) => draft ? { ...draft, name: event.target.value } : draft)} placeholder="Staff full name" /></label>
              <label className={styles.fullField}>DingTalk user ID<input maxLength={128} value={employeeDraft.dingTalkUserId} onChange={(event) => setEmployeeDraft((draft) => draft ? { ...draft, dingTalkUserId: event.target.value } : draft)} placeholder="Required for automatic punch sync" /></label>
              <label>Group<select value={employeeDraft.group} onChange={(event) => setEmployeeDraft((draft) => draft ? { ...draft, group: event.target.value as AttendanceGroup } : draft)}>{GROUPS.map((group) => <option value={group} key={group}>{group}</option>)}</select></label>
              <label>Status<select value={employeeDraft.active ? "active" : "inactive"} onChange={(event) => setEmployeeDraft((draft) => draft ? { ...draft, active: event.target.value === "active" } : draft)}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
              <label>{selectedMonth.slice(0, 4)} annual entitlement<input type="number" min="0" max="366" step="0.01" value={employeeDraft.annualEntitlement} onChange={(event) => setEmployeeDraft((draft) => draft ? { ...draft, annualEntitlement: Number(event.target.value) } : draft)} /></label>
              <label>{selectedMonth.slice(0, 4)} opening carry-forward<input type="number" min="-366" max="366" step="0.01" value={employeeDraft.carryForward} onChange={(event) => setEmployeeDraft((draft) => draft ? { ...draft, carryForward: Number(event.target.value) } : draft)} /></label>
            </div>
            <div className={styles.modalFooter}><button type="button" className={styles.secondaryButton} onClick={() => setEmployeeDraft(null)}>Cancel</button><button type="button" className={styles.primaryButton} onClick={() => void saveEmployee()} disabled={pendingAction === "save-person" || pendingAction === "save-entitlement"}>{pendingAction === "save-person" || pendingAction === "save-entitlement" ? "Saving…" : "Save staff settings"}</button></div>
          </section>
        </div>
      ) : null}

      {correctionDraft ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCorrectionDraft(null) }}>
          <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="correction-modal-title">
            <div className={styles.modalHeader}><div><span>{displayDate(correctionDraft.date)} · {correctionDraft.employeeName}</span><h2 id="correction-modal-title">Correct attendance record</h2></div><button type="button" aria-label="Close correction form" onClick={() => setCorrectionDraft(null)}>×</button></div>
            <p className={styles.modalNote}>The original DingTalk punch remains unchanged. Clear a previously corrected time to restore the original. Every change is stored in the Audit Log.</p>
            <div className={styles.formGrid}>
              <label>Corrected sign-in<input type="time" value={correctionDraft.signIn} onChange={(event) => setCorrectionDraft((draft) => draft ? { ...draft, signIn: event.target.value } : draft)} /></label>
              <label>Corrected sign-out<input type="time" value={correctionDraft.signOut} onChange={(event) => setCorrectionDraft((draft) => draft ? { ...draft, signOut: event.target.value } : draft)} /></label>
              <label className={styles.fullField}>Review note<textarea rows={3} maxLength={500} value={correctionDraft.reviewNote} onChange={(event) => setCorrectionDraft((draft) => draft ? { ...draft, reviewNote: event.target.value } : draft)} placeholder="Why was this record corrected?" /></label>
            </div>
            <div className={styles.modalFooter}><button type="button" className={styles.secondaryButton} onClick={() => setCorrectionDraft(null)}>Cancel</button><button type="button" className={styles.primaryButton} onClick={() => void saveCorrection()} disabled={pendingAction === "save-override"}>{pendingAction === "save-override" ? "Saving…" : "Save correction"}</button></div>
          </section>
        </div>
      ) : null}

      {holidayDraft ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHolidayDraft(null) }}>
          <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="holiday-modal-title">
            <div className={styles.modalHeader}><div><span>{selectedMonth}</span><h2 id="holiday-modal-title">Add holiday-attendance credit</h2></div><button type="button" aria-label="Close holiday attendance form" onClick={() => setHolidayDraft(null)}>×</button></div>
            <p className={styles.modalNote}>HOL is an attendance credit, not leave. It increases the workbook-style leave balance and is recorded as a monthly adjustment.</p>
            <div className={styles.formGrid}>
              <label className={styles.fullField}>Staff<select value={holidayDraft.employeeId} onChange={(event) => setHolidayDraft((draft) => draft ? { ...draft, employeeId: event.target.value } : draft)}><option value="">Choose staff</option>{data.employees.filter((employee) => employee.active).map((employee) => <option value={employee.id} key={employee.id}>{employee.initials} · {employee.name}</option>)}</select></label>
              <label className={styles.fullField}>HOL credit<input type="number" min="0.5" step="0.5" value={holidayDraft.units} onChange={(event) => setHolidayDraft((draft) => draft ? { ...draft, units: Number(event.target.value) } : draft)} /></label>
              <label className={styles.fullField}>Note<textarea rows={3} maxLength={500} value={holidayDraft.note} onChange={(event) => setHolidayDraft((draft) => draft ? { ...draft, note: event.target.value } : draft)} placeholder="Public holiday worked and supporting note" /></label>
            </div>
            <div className={styles.modalFooter}><button type="button" className={styles.secondaryButton} onClick={() => setHolidayDraft(null)}>Cancel</button><button type="button" className={styles.primaryButton} onClick={() => void saveHolidayAdjustment()} disabled={pendingAction === "save-monthly-adjustment"}>{pendingAction === "save-monthly-adjustment" ? "Saving…" : "Add HOL credit"}</button></div>
          </section>
        </div>
      ) : null}

      {importPreview ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setImportPreview(null) }}>
          <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="import-modal-title">
            <div className={styles.modalHeader}><div><span>DRY-RUN COMPLETE</span><h2 id="import-modal-title">Review 2026 workbook import</h2></div><button type="button" aria-label="Close workbook review" onClick={() => setImportPreview(null)}>×</button></div>
            <p className={styles.modalNote}>No records have been changed. Add any unmapped staff in Settings with the correct BT, BS or AC group before applying this import.</p>
            <dl className={styles.importSummary}>
              <div><dt>File</dt><dd>{importPreview.file.name}</dd></div>
              {Object.entries(importPreview.summary).map(([label, value]) => <div key={label}><dt>{label.replace(/([A-Z])/g, " $1")}</dt><dd>{String(value)}</dd></div>)}
            </dl>
            {importPreview.issues.length ? <div className={styles.issueList}><strong>{importPreview.hasErrors ? "Errors must be resolved before import" : "Review warnings"}</strong><ul>{importPreview.issues.map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}</ul></div> : <div className={styles.readyMessage}>Workbook checks passed. It is ready to apply.</div>}
            <div className={styles.modalFooter}><button type="button" className={styles.secondaryButton} onClick={() => setImportPreview(null)}>Cancel</button><button type="button" className={styles.primaryButton} onClick={() => void uploadLegacyWorkbook(importPreview.file, "apply")} disabled={importPreview.hasErrors || pendingAction === "import-apply"}>{pendingAction === "import-apply" ? "Importing…" : "Apply import"}</button></div>
          </section>
        </div>
      ) : null}
    </main>
  )
}
