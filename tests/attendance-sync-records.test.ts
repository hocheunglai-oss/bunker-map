import assert from "node:assert/strict"
import test from "node:test"
import { normalizeDingTalkPunch } from "../lib/attendanceSyncRecords"

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
  }

  const first = normalizeDingTalkPunch(record, people)
  const second = normalizeDingTalkPunch(record, people)
  assert.ok(first)
  assert.equal(first.person_id, PERSON_ID)
  assert.equal(first.work_date, "2026-08-08")
  assert.equal(first.source_record_key.length, 64)
  assert.equal(first.source_record_key, second?.source_record_key)
  assert.equal(first.raw_payload, record)
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
