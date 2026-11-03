import { parseIsoDate, type AttendanceLeaveCode, type AttendanceLeavePortion } from "./attendanceRules"
import type { AttendanceWorkMode } from "./attendanceWorkModes"

type DayEntry = { code: AttendanceLeaveCode; portion: AttendanceLeavePortion }

export type AttendanceDayUnitsRecord = {
  date?: string
  workDate?: string
  required?: boolean
  status: string
  leave: DayEntry[] | DayEntry | null
  effectiveSignIn: string | null
  workMode?: AttendanceWorkMode
  workModeSource?: "manual" | "leave" | "default" | null
  holidayAttendance?: boolean
  automaticAmLeave?: boolean
}

const workingStatuses = new Set([
  "present", "partial-leave", "incomplete", "late", "early", "late-and-early",
  "home-office", "business-trip",
])
const portionMask = (portion: AttendanceLeavePortion) => portion === "full" ? 3 : portion === "am" ? 1 : 2
const units = (mask: number) => ((mask & 1 ? 1 : 0) + (mask & 2 ? 1 : 0)) / 2

// One shared attended-day calculation for API totals and older UI responses.
// Status establishes eligibility, not a whole day's credit: each absent half
// is excluded, and a portioned HO/OS entry proves only its own working half.
export function attendanceDayUnits(record: AttendanceDayUnitsRecord, today: string): number {
  const date = record.date || record.workDate || ""
  if (!parseIsoDate(date) || !parseIsoDate(today) || date > today) return 0
  const required = record.required ?? workingStatuses.has(record.status)
  if (!record.holidayAttendance && (!required || record.status === "leave" || record.status === "pending")) return 0

  const entries = Array.isArray(record.leave) ? record.leave : record.leave ? [record.leave] : []
  let absence = 0
  let recordedWork = 0
  for (const entry of entries) {
    if (entry.code === "HO" || entry.code === "OS") recordedWork |= portionMask(entry.portion)
    else absence |= portionMask(entry.portion)
  }
  // Compatibility responses may still carry the old automatic flag beside
  // an approved AM HO/OS entry. Explicit work is not automatic absence; an
  // explicit absence still wins if an invalid overlapping record is supplied.
  if (record.automaticAmLeave && !(recordedWork & 1)) absence |= 1
  const available = 3 & ~absence
  if (!available) return 0

  // Keep the established qualifying office-IN rule; an OUT-only or missing
  // office session must not become attendance merely because leave was saved.
  if (record.effectiveSignIn) return units(available)
  const wholeDayMode = (record.workMode === "home-office" || record.workMode === "business-trip") &&
    (record.workModeSource === "manual" || record.workModeSource === "default" ||
      (!record.workModeSource && !recordedWork))
  if (wholeDayMode) return units(available)
  if (recordedWork) return units(recordedWork & available)
  // Existing holiday-attendance qualification already includes authorised
  // holiday attendance without punches. It does not change earned HOL credit.
  return record.holidayAttendance ? units(available) : 0
}
