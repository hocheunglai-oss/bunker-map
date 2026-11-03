import type {
  ApiAttendanceDailyItem,
  ApiAttendanceLeaveEntry,
  AttendanceLeaveCode,
  AttendanceWorkMode,
} from "./types"

export type AttendancePortion = "full" | "am" | "pm"

export function attendanceWorkModeForStatus(
  code: AttendanceLeaveCode,
  manualWorkMode: AttendanceWorkMode | undefined,
): AttendanceWorkMode | "default" {
  // A portioned HO/OS row replaces a whole-day mode. An absence does not:
  // the unaffected working half must retain an existing manual work mode.
  return code === "HO" || code === "OS" ? "default" : manualWorkMode || "default"
}

// IN and OUT are also the morning and afternoon status cells. An entry in
// the opposite half must never become the replacement target for this edit.
export function editableAttendanceEntry(
  item: ApiAttendanceDailyItem,
  direction: "in" | "out",
) {
  const entries = Array.isArray(item.leave) ? item.leave : item.leave ? [item.leave] : []
  return entries.find((entry) => entry.portion === "full") ||
    entries.find((entry) => entry.portion === (direction === "in" ? "am" : "pm"))
}

export function attendancePortionConflicts(
  portion: AttendancePortion,
  otherEntries: ApiAttendanceLeaveEntry[],
) {
  return otherEntries.some((entry) =>
    portion === "full" || entry.portion === "full" || entry.portion === portion,
  )
}

export function permitsAttendanceMorningSignOut(input: {
  leaveEnabled: boolean
  portion: AttendancePortion
  code: AttendanceLeaveCode
}) {
  return input.leaveEnabled && input.portion === "pm" &&
    input.code !== "HO" && input.code !== "OS"
}
