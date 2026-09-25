import assert from "node:assert/strict"
import test from "node:test"
import {
  DINGTALK_ATTENDANCE_IMPORT_CUTOFF,
  isImportableDingTalkPunch,
  normalizeDingTalkPunch,
} from "../lib/attendanceSyncRecords"

const PERSON_ID = "11111111-1111-4111-8111-111111111111"

test("normalizes a fictional DingTalk punch in Hong Kong time", () => {
  const people = new Map([
    ["fictional-user-001", { id: PERSON_ID, dingtalkUserId: "fictional-user-001" }],
  ])
  const record = {
    id: 987654,
    userId: "fictional-user-001",
    userCheckTime: Date.parse("2026-08-07T16:30:00.000Z"),
    checkType: "OnDuty",
    sourceType: "ATM",
    deviceSN: "FICTIONAL-DEVICE-001",
    photoUrl: "https://sensitive.invalid/photo.jpg",
    locationDetail: "Sensitive fictional location",
  }

  const first = normalizeDingTalkPunch(record, people)
  const second = normalizeDingTalkPunch(record, people)
  assert.ok(first)
  assert.equal(first.person_id, PERSON_ID)
  assert.equal(first.work_date, "2026-08-08")
  assert.equal(first.source_record_key.length, 64)
  assert.equal(first.source_record_key, second?.source_record_key)
  assert.deepEqual(first.raw_payload, {
    id: "987654",
    userId: "fictional-user-001",
    checkType: "OnDuty",
    userCheckTime: Date.parse("2026-08-07T16:30:00.000Z"),
    sourceType: "ATM",
    deviceSN: "FICTIONAL-DEVICE-001",
    timeResult: null,
    locationResult: null,
  })
  assert.equal("photoUrl" in first.raw_payload, false)
  assert.equal("locationDetail" in first.raw_payload, false)
})

test("rejects invalid or unmapped DingTalk punches", () => {
  const people = new Map([
    ["fictional-user-001", { id: PERSON_ID, dingtalkUserId: "fictional-user-001" }],
  ])
  assert.equal(
    normalizeDingTalkPunch(
      {
        id: 1,
        userId: "unknown-fictional-user",
        userCheckTime: Date.now(),
        checkType: "OnDuty",
      },
      people,
    ),
    null,
  )
  assert.equal(
    normalizeDingTalkPunch(
      {
        id: 2,
        userId: "fictional-user-001",
        userCheckTime: Date.now(),
        checkType: "UnknownDuty",
      },
      people,
    ),
    null,
  )
})

test("internal DingTalk imports start cleanly on 13 August 2026 HKT", () => {
  assert.equal(
    DINGTALK_ATTENDANCE_IMPORT_CUTOFF.toISOString(),
    "2026-08-12T16:00:00.000Z",
  )
  assert.equal(isImportableDingTalkPunch("2026-08-12T15:59:59.999Z"), false)
  assert.equal(isImportableDingTalkPunch("2026-08-12T16:00:00.000Z"), true)
  assert.equal(isImportableDingTalkPunch("invalid"), false)
})

const restDayRecord = {
  id: 987655,
  userId: "fictional-user-001",
  userCheckTime: Date.parse("2026-09-25T01:55:12.000Z"),
  sourceType: "ATM",
  invalidRecordType: "Other",
  invalidRecordMsg: "今日休息，打卡需申请",
}
const mappedPeople = new Map([
  ["fictional-user-001", { id: PERSON_ID, dingtalkUserId: "fictional-user-001" }],
])

test("retains rest-day machine scans without inventing a source direction", () => {
  const punch = normalizeDingTalkPunch(restDayRecord, mappedPeople)!
  assert.ok(punch)
  assert.equal(punch.check_type, "Unclassified")
  assert.equal(punch.work_date, "2026-09-25")
  assert.equal(punch.punch_time, "2026-09-25T01:55:12.000Z")
  assert.equal(punch.raw_payload.checkType, null)
  assert.equal(punch.raw_payload.invalidRecordMsg, restDayRecord.invalidRecordMsg)
  assert.equal(punch.raw_payload.normalizationReason, "dingtalk-rest-day")
  assert.equal(punch.source_record_key, normalizeDingTalkPunch(restDayRecord, mappedPeople)?.source_record_key)
  // Source identity remains stable if DingTalk later supplies its own direction.
  assert.equal(punch.source_record_key, normalizeDingTalkPunch({ ...restDayRecord, checkType: "OnDuty" }, mappedPeople)?.source_record_key)
})

test("the rest-day exception is narrow and does not bypass other invalid punches", () => {
  for (const patch of [
    { invalidRecordType: "Security" },
    { invalidRecordType: null },
    { invalidRecordMsg: "需要二次确认" },
    { invalidRecordMsg: null },
    { sourceType: "USER" },
    { checkType: "UnknownDuty" },
    { checkType: "Unclassified", invalidRecordMsg: null },
    { userId: "unmapped" },
    { userCheckTime: 0 },
    { userCheckTime: "bad-time" },
    { userCheckTime: 1e20 },
  ]) {
    assert.equal(normalizeDingTalkPunch({ ...restDayRecord, ...patch }, mappedPeople), null)
  }
})

test("normal labelled punches keep their existing behavior and privacy filtering", () => {
  const punch = normalizeDingTalkPunch({
    ...restDayRecord,
    checkType: "OffDuty",
    userAddress: "private address",
    userLatitude: 12,
    photoUrl: "https://sensitive.invalid/photo.jpg",
  }, mappedPeople)!
  assert.equal(punch.check_type, "OffDuty")
  assert.equal(punch.raw_payload.checkType, "OffDuty")
  assert.equal("normalizationReason" in punch.raw_payload, false)
  assert.equal("userAddress" in punch.raw_payload, false)
  assert.equal("userLatitude" in punch.raw_payload, false)
  assert.equal("photoUrl" in punch.raw_payload, false)
})
