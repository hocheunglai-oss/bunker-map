import { createHash } from "node:crypto"
import type { DingTalkAttendanceRecord } from "@/lib/dingTalkAttendance"

// The DingTalk API always returns a rolling window. Keep historical test
// punches out of the internal system even after they have been deleted here.
export const DINGTALK_ATTENDANCE_IMPORT_CUTOFF = new Date(
  "2026-08-13T00:00:00+08:00",
)

export function isImportableDingTalkPunch(punchTime: string) {
  const value = Date.parse(punchTime)
  return Number.isFinite(value) && value >= DINGTALK_ATTENDANCE_IMPORT_CUTOFF.getTime()
}
import { hktDateFromTimestamp, type AttendanceRawCheckType } from "@/lib/attendanceRules"

export type AttendanceSyncPerson = {
  id: string
  dingtalkUserId: string
}

export type NormalizedRawPunch = {
  person_id: string
  source_record_key: string
  source_record_id: string | null
  dingtalk_user_id: string
  check_type: AttendanceRawCheckType
  punch_time: string
  work_date: string
  source_type: string | null
  device_sn: string | null
  time_result: string | null
  location_result: string | null
  raw_payload: Record<string, string | number | null>
}

function cleanString(value: unknown, maxLength = 500) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text ? text.slice(0, maxLength) : null
}

function makeRecordKey(record: DingTalkAttendanceRecord, stableId: string) {
  const identity = {
    source: "dingtalk-attendance",
    id: stableId,
    userId: cleanString(record.userId, 128),
  }
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex")
}

export function normalizeDingTalkPunch(
  record: DingTalkAttendanceRecord,
  personByDingTalkId: Map<string, AttendanceSyncPerson>,
): NormalizedRawPunch | null {
  const userId = cleanString(record.userId, 128)
  const person = userId ? personByDingTalkId.get(userId) : undefined
  const sourceCheckType = cleanString(record.checkType, 32)
  // This is an explicit upstream calendar rejection, not a generic invalid
  // punch. Never bypass Security, second-confirmation or unknown exceptions.
  const restDayMachinePunch =
    !sourceCheckType &&
    record.sourceType === "ATM" &&
    record.invalidRecordType === "Other" &&
    record.invalidRecordMsg === "今日休息，打卡需申请"
  const checkType = restDayMachinePunch ? "Unclassified" : record.checkType
  const timestamp = Number(record.userCheckTime)
  const sourceRecordId = cleanString(record.id, 200)
  if (
    !userId ||
    !person ||
    !sourceRecordId ||
    (checkType !== "OnDuty" && checkType !== "OffDuty" && checkType !== "Unclassified") ||
    (checkType === "Unclassified" && !restDayMachinePunch) ||
    !Number.isFinite(timestamp) ||
    timestamp <= 0
  ) {
    return null
  }

  const punchTime = new Date(timestamp)
  if (!Number.isFinite(punchTime.getTime())) return null

  const sourceType = cleanString(record.sourceType, 100)
  const deviceSn = cleanString(record.deviceSN, 200)
  const timeResult = cleanString(record.timeResult, 100)
  const locationResult = cleanString(record.locationResult, 100)

  return {
    person_id: person.id,
    source_record_key: makeRecordKey(record, sourceRecordId),
    source_record_id: sourceRecordId,
    dingtalk_user_id: userId,
    check_type: checkType,
    punch_time: punchTime.toISOString(),
    work_date: hktDateFromTimestamp(punchTime),
    source_type: sourceType,
    device_sn: deviceSn,
    time_result: timeResult,
    location_result: locationResult,
    raw_payload: {
      id: sourceRecordId,
      userId,
      checkType: restDayMachinePunch ? null : checkType,
      userCheckTime: timestamp,
      sourceType,
      deviceSN: deviceSn,
      timeResult,
      locationResult,
      ...(restDayMachinePunch
        ? {
            normalizationReason: "dingtalk-rest-day",
            invalidRecordType: "Other",
            invalidRecordMsg: "今日休息，打卡需申请",
          }
        : {}),
    },
  }
}

// DingTalk may return an extra physical scan without a direction and explicitly
// say that the earlier arrival is authoritative. It is redundant only when that
// earlier, valid arrival is present in this same complete response/window.
// Never turn a repeat arrival into an inferred departure or ignore it on text
// alone: unknown/security exceptions and missing primary evidence still fail.
export function classifyDingTalkPunches(
  records: DingTalkAttendanceRecord[],
  people: Map<string, AttendanceSyncPerson>,
  window: { from: Date; to: Date },
) {
  const mapped = records.map((record) => normalizeDingTalkPunch(record, people))
  const inWindow = (time: number) => Number.isFinite(time) && time > 0 &&
    time >= window.from.getTime() && time <= window.to.getTime()
  const primaryArrivals = new Map<string, { time: number; id: string }>()
  const acceptedIds = new Set<string>()
  for (let index = 0; index < mapped.length; index += 1) {
    const punch = mapped[index]
    if (!punch || !inWindow(Date.parse(punch.punch_time))) continue
    acceptedIds.add(`${punch.person_id}:${punch.source_record_id}`)
    const raw = records[index]
    if (punch.check_type !== "OnDuty" || raw.sourceType !== "ATM" ||
        cleanString(raw.invalidRecordType) || cleanString(raw.invalidRecordMsg)) continue
    const key = `${punch.person_id}:${punch.work_date}`
    const time = Date.parse(punch.punch_time)
    const previous = primaryArrivals.get(key)
    if (!previous || time < previous.time) {
      primaryArrivals.set(key, { time, id: punch.source_record_id! })
    }
  }
  const redundantArrivalIndexes = new Set<number>()
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (mapped[index] || cleanString(record.checkType) || record.sourceType !== "ATM" ||
        record.invalidRecordType !== "Other" ||
        record.invalidRecordMsg !== "已经打过卡了，上班时间以最早打卡时间为准") continue
    const userId = cleanString(record.userId, 128)
    const person = userId ? people.get(userId) : undefined
    const id = cleanString(record.id, 200)
    const time = Number(record.userCheckTime)
    if (!person || !id || !inWindow(time) || !Number.isFinite(new Date(time).getTime()) ||
        acceptedIds.has(`${person.id}:${id}`)) continue
    const primary = primaryArrivals.get(`${person.id}:${hktDateFromTimestamp(new Date(time))}`)
    if (primary && primary.id !== id && primary.time < time) redundantArrivalIndexes.add(index)
  }
  return { mapped, redundantArrivalIndexes }
}
