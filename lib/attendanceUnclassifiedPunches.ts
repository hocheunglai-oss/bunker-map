import {
  ATTENDANCE_SCHEDULES,
  hktDateFromTimestamp,
  hktTimestampForDateAndTime,
  type AttendanceCheckType,
  type AttendanceTeam,
} from "./attendanceRules"

type DirectionCandidate = {
  id: string
  checkType: AttendanceCheckType | "Unclassified"
  punchTime: string
}

/**
 * Derive display directions from FCUNO's clock boundaries, never changing the
 * stored DingTalk punch. The caller supplies only accepted, non-excluded rows;
 * upstream invalid-record allowlisting and leave/holiday policy stay outside
 * this helper. Typed punches and manual corrections keep their own directions.
 */
export function inferUnclassifiedAttendanceDirections(input: {
  workDate: string
  team: AttendanceTeam
  hasAfternoonLeave: boolean
  punches: DirectionCandidate[]
  manualSignIn?: string | null
}): Map<string, AttendanceCheckType> {
  const directions = new Map<string, AttendanceCheckType>()
  const boundary = hktTimestampForDateAndTime(
    input.workDate,
    input.hasAfternoonLeave
      ? ATTENDANCE_SCHEDULES[input.team].amCutoff
      : "17:00",
  )
  if (!boundary) return directions
  const boundaryTime = boundary.getTime()

  const sameDayTime = (value: string | null | undefined) => {
    if (!value) return null
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) &&
      hktDateFromTimestamp(timestamp) === input.workDate
      ? timestamp
      : null
  }

  const punches = input.punches.flatMap((punch) => {
    const timestamp = sameDayTime(punch.punchTime)
    return punch.id && timestamp !== null ? [{ ...punch, timestamp }] : []
  }).sort((left, right) =>
    left.timestamp - right.timestamp ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  )
  const unclassified = punches.filter((punch) => punch.checkType === "Unclassified")
  const arrival = unclassified.find((punch) => punch.timestamp < boundaryTime)
  if (arrival) directions.set(arrival.id, "OnDuty")

  // A PM-leave departure near lunchtime is ambiguous without an independently
  // evidenced arrival before the team's AM cutoff. In particular, one scan at
  // or after that cutoff must never fill both the IN and OUT cells.
  const manualArrival = sameDayTime(input.manualSignIn)
  const earlierArrival = input.hasAfternoonLeave
    ? (manualArrival !== null
        ? [manualArrival]
        : [
            ...(arrival ? [arrival.timestamp] : []),
            ...punches
              .filter((punch) => punch.checkType === "OnDuty")
              .map((punch) => punch.timestamp),
          ]
      ).filter((timestamp) => timestamp < boundaryTime)
    : []
  if (input.hasAfternoonLeave && !earlierArrival.length) return directions

  const departure = unclassified.findLast((punch) =>
    punch.timestamp >= boundaryTime &&
    punch.id !== arrival?.id &&
    // A corrected IN supersedes raw arrival evidence. Never manufacture an
    // OUT at or before the administrator's authoritative arrival time.
    (manualArrival === null || punch.timestamp > manualArrival) &&
    (!input.hasAfternoonLeave || earlierArrival.some((time) => time < punch.timestamp)),
  )
  if (departure) directions.set(departure.id, "OffDuty")
  return directions
}
