import type { AttendanceTeam } from "./attendanceRules"

export type AttendanceTeamAssignment = {
  id: string
  personId: string
  team: AttendanceTeam
  effectiveFrom: string
  effectiveTo: string | null
  sourceAdminUserId: string | null
}

export function attendanceTeamAssignmentForDate(
  personId: string,
  workDate: string,
  assignments: AttendanceTeamAssignment[],
) {
  return assignments.find(
    (entry) =>
      entry.personId === personId &&
      entry.effectiveFrom <= workDate &&
      (!entry.effectiveTo || entry.effectiveTo >= workDate),
  )
}

export function attendanceTeamAssignmentOverlapsPeriod(
  personId: string,
  fromDate: string,
  toDate: string,
  assignments: AttendanceTeamAssignment[],
) {
  return assignments.some(
    (entry) =>
      entry.personId === personId &&
      entry.effectiveFrom <= toDate &&
      (!entry.effectiveTo || entry.effectiveTo >= fromDate),
  )
}

export function hasAttendanceTeamHistory(
  personId: string,
  assignments: AttendanceTeamAssignment[],
) {
  return assignments.some((entry) => entry.personId === personId)
}

export function resolveAttendanceTeamForDate(
  personId: string,
  workDate: string,
  fallbackTeam: AttendanceTeam,
  assignments: AttendanceTeamAssignment[],
) {
  const assignment = attendanceTeamAssignmentForDate(
    personId,
    workDate,
    assignments,
  )

  return assignment?.team || fallbackTeam
}
