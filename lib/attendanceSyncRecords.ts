import { createHash } from "node:crypto"
import type { DingTalkAttendanceRecord } from "@/lib/dingTalkAttendance"
import { hktDateFromTimestamp } from "@/lib/attendanceRules"

export type AttendanceSyncPerson = {
  id: string
  dingtalkUserId: string
}

export type NormalizedRawPunch = {
  person_id: string
  source_record_key: string
  source_record_id: string | null
  dingtalk_user_id: string
  check_type: "OnDuty" | "OffDuty"
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

function makeRecordKey(record: DingTalkAttendanceRecord) {
  const stableId = cleanString(record.id, 200)
  const identity = stableId
    ? {
        source: "dingtalk-attendance",
        id: stableId,
        userId: cleanString(record.userId, 128),
      }
    : {
        source: "dingtalk-attendance",
        userId: cleanString(record.userId, 128),
        userCheckTime: Number(record.userCheckTime),
        checkType: cleanString(record.checkType, 32),
        sourceType: cleanString(record.sourceType, 100),
        deviceSN: cleanString(record.deviceSN, 200),
      }
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex")
}

export function normalizeDingTalkPunch(
  record: DingTalkAttendanceRecord,
  personByDingTalkId: Map<string, AttendanceSyncPerson>,
): NormalizedRawPunch | null {
  const userId = cleanString(record.userId, 128)
  const person = userId ? personByDingTalkId.get(userId) : undefined
  const checkType = record.checkType
  const timestamp = Number(record.userCheckTime)
  if (
    !userId ||
    !person ||
    (checkType !== "OnDuty" && checkType !== "OffDuty") ||
    !Number.isFinite(timestamp) ||
    timestamp <= 0
  ) {
    return null
  }

  const punchTime = new Date(timestamp)
  if (!Number.isFinite(punchTime.getTime())) return null

  const sourceRecordId = cleanString(record.id, 200)
  const sourceType = cleanString(record.sourceType, 100)
  const deviceSn = cleanString(record.deviceSN, 200)
  const timeResult = cleanString(record.timeResult, 100)
  const locationResult = cleanString(record.locationResult, 100)

  return {
    person_id: person.id,
    source_record_key: makeRecordKey(record),
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
      checkType,
      userCheckTime: timestamp,
      sourceType,
      deviceSN: deviceSn,
      timeResult,
      locationResult,
    },
  }
}
