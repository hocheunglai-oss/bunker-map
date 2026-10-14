import assert from "node:assert/strict"
import test from "node:test"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  attendanceMonthSyncWindows,
  requeryAttendanceMonthForAutoConfirmation,
  runAttendanceSync,
} from "../lib/attendanceSync"

function syncFixture(
  people: Array<{ id: string; dingtalk_user_id: string | null }>,
  input: {
    records?: Array<Record<string, unknown>>
    insertedCount?: number
    changedCount?: number
    missingCount?: number
  } = {},
) {
  const updates: Array<Record<string, unknown>> = []
  const queriedUserIds: string[][] = []
  const queries: Array<{ userIds: string[]; checkDateFrom: string; checkDateTo: string }> = []
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []
  const supabase = {
    from(table: string) {
      if (table === "attendance_sync_runs") {
        return {
          insert() { return { select() { return { async single() {
            return { data: { id: "run-1" }, error: null }
          } } } } },
          update(values: Record<string, unknown>) {
            updates.push(values)
            return { async eq() { return { error: null } } }
          },
        }
      }
      assert.equal(table, "attendance_people")
      const query = {
        select() { return query },
        eq() { return query },
        not() { return query },
        order() { return Promise.resolve({ data: people, error: null }) },
      }
      return query
    },
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args })
      if (name === "insert_attendance_raw_punches_checked") {
        return { data: {
          inserted_count: input.insertedCount || 0,
          anomaly_count: input.changedCount || 0,
        }, error: null }
      }
      assert.equal(name, "reconcile_attendance_dingtalk_punch_window")
      return { data: { missing_count: input.missingCount || 0 }, error: null }
    },
  } as unknown as SupabaseClient
  const client = {
    async listRecords(query: { userIds: string[]; checkDateFrom: string; checkDateTo: string }) {
      queriedUserIds.push(query.userIds)
      queries.push(query)
      return { query, records: input.records || [] }
    },
  }
  return { supabase, client, updates, queriedUserIds, queries, rpcCalls }
}

test("a successful sync records the exact DingTalk identities queried", async () => {
  const fixture = syncFixture([
    { id: "person-1", dingtalk_user_id: " ding-one " },
    { id: "person-2", dingtalk_user_id: "" },
  ])
  const result = await runAttendanceSync({
    now: new Date("2026-11-04T09:59:00.000Z"),
    ...fixture,
  })
  assert.equal(result.status, "succeeded")
  assert.deepEqual(fixture.queriedUserIds, [["ding-one"]])
  assert.deepEqual(fixture.updates[0].requested_people, { "person-1": "ding-one" })
  assert.equal(fixture.updates[0].people_requested, 1)
  assert.equal(fixture.rpcCalls[0].name, "reconcile_attendance_dingtalk_punch_window")
})

test("a sync records only the whole-second bounds queried from DingTalk", async () => {
  const fixture = syncFixture([{ id: "person-1", dingtalk_user_id: "ding-one" }])
  const result = await runAttendanceSync({
    now: new Date("2026-11-04T09:59:00.789Z"),
    ...fixture,
  })
  assert.equal(result.windowTo, "2026-11-04T09:59:00.000Z")
  assert.equal(fixture.queries[0].checkDateTo, "2026-11-04 17:59:00")
  assert.equal(fixture.rpcCalls[0].args.p_window_to, result.windowTo)
})

test("a zero-person sync is recorded as failed", async () => {
  const fixture = syncFixture([])
  await assert.rejects(runAttendanceSync({
    now: new Date("2026-11-04T09:59:00.000Z"),
    ...fixture,
  }), /No DingTalk-linked attendance people/)
  assert.equal(fixture.updates[0].status, "failed")
  assert.deepEqual(fixture.queriedUserIds, [])
})

test("duplicate DingTalk identities fail the sync before requesting records", async () => {
  const fixture = syncFixture([
    { id: "person-1", dingtalk_user_id: "same-id" },
    { id: "person-2", dingtalk_user_id: " same-id " },
  ])
  await assert.rejects(runAttendanceSync({
    now: new Date("2026-11-04T09:59:00.000Z"),
    ...fixture,
  }), /share a DingTalk user ID/)
  assert.equal(fixture.updates[0].status, "failed")
  assert.deepEqual(fixture.queriedUserIds, [])
})

test("September requery uses five touching whole-second windows of at most seven days", async () => {
  const windows = attendanceMonthSyncWindows(2026, 9)
  assert.deepEqual(windows.map((window) => [window.from.toISOString(), window.to.toISOString()]), [
    ["2026-08-31T16:00:00.000Z", "2026-09-07T16:00:00.000Z"],
    ["2026-09-07T16:00:00.000Z", "2026-09-14T16:00:00.000Z"],
    ["2026-09-14T16:00:00.000Z", "2026-09-21T16:00:00.000Z"],
    ["2026-09-21T16:00:00.000Z", "2026-09-28T16:00:00.000Z"],
    ["2026-09-28T16:00:00.000Z", "2026-09-30T16:00:00.000Z"],
  ])

  const fixture = syncFixture([])
  const result = await requeryAttendanceMonthForAutoConfirmation({
    year: 2026, month: 9,
    people: [{ id: "former-staff", dingtalkUserId: "former-ding-id" }],
    now: new Date("2026-10-14T10:10:00.000Z"),
    ...fixture,
  })
  assert.deepEqual(result, { windows: 5, runs: 5 })
  assert.deepEqual(fixture.queriedUserIds, Array.from({ length: 5 }, () => ["former-ding-id"]))
  assert.deepEqual(fixture.updates.map((value) => value.requested_people),
    Array.from({ length: 5 }, () => ({ "former-staff": "former-ding-id" })))
  assert.deepEqual(fixture.queries.map((query) => [query.checkDateFrom, query.checkDateTo]), [
    ["2026-09-01 00:00:00", "2026-09-08 00:00:00"],
    ["2026-09-08 00:00:00", "2026-09-15 00:00:00"],
    ["2026-09-15 00:00:00", "2026-09-22 00:00:00"],
    ["2026-09-22 00:00:00", "2026-09-29 00:00:00"],
    ["2026-09-29 00:00:00", "2026-10-01 00:00:00"],
  ])
})

test("full-month requery divides more than 50 people into exact queried manifests", async () => {
  const fixture = syncFixture([])
  const people = Array.from({ length: 51 }, (_, index) => ({
    id: `person-${index}`, dingtalkUserId: `ding-${index}`,
  }))
  const result = await requeryAttendanceMonthForAutoConfirmation({
    year: 2026, month: 9, people,
    now: new Date("2026-10-14T10:10:00.000Z"),
    ...fixture,
  })
  assert.deepEqual(result, { windows: 5, runs: 10 })
  assert.deepEqual(fixture.queriedUserIds.map((ids) => ids.length).sort((a, b) => a - b),
    [1, 1, 1, 1, 1, 50, 50, 50, 50, 50])
  assert.ok(fixture.updates.every((value) =>
    Object.keys(value.requested_people as Record<string, string>).length === value.people_requested))
})

test("a response for a person outside its requested batch cannot certify the batch", async () => {
  const people = Array.from({ length: 51 }, (_, index) => ({
    id: `person-${index}`, dingtalkUserId: `ding-${index}`,
  }))
  const fixture = syncFixture([], { records: [{
    id: "unrequested-source", userId: "ding-50", checkType: "OnDuty",
    userCheckTime: Date.parse("2026-10-14T01:00:00.000Z"),
  }] })
  const result = await runAttendanceSync({
    now: new Date("2026-10-14T10:10:00.000Z"),
    people, ...fixture,
  })
  assert.equal(result.status, "partial")
  assert.match(result.errorSummary || "", /invalid or unmapped/)
  assert.equal(fixture.queriedUserIds.length, 2)
  assert.deepEqual(fixture.updates.at(-1)?.failure_scope, {
    unknown: false,
    affected: [{ person_id: null, work_date: "2026-10-14" }],
  })
})

test("an upstream punch outside the exact requested window cannot certify or alter it", async () => {
  const fixture = syncFixture([], { records: [{
    id: "outside-window", userId: "ding-one", checkType: "OnDuty",
    userCheckTime: Date.parse("2026-10-13T15:59:59.000Z"),
  }] })
  const result = await runAttendanceSync({
    now: new Date("2026-10-14T10:10:00.000Z"),
    window: {
      from: new Date("2026-10-13T16:00:00.000Z"),
      to: new Date("2026-10-14T10:10:00.000Z"),
    },
    people: [{ id: "person-1", dingtalkUserId: "ding-one" }],
    ...fixture,
  })
  assert.equal(result.status, "partial")
  assert.equal(result.recordsInserted, 0)
  assert.deepEqual(fixture.rpcCalls, [])
  assert.deepEqual(fixture.updates.at(-1)?.failure_scope, {
    unknown: true, affected: [],
  })
})

test("changed or missing upstream punches make their sync partial", async () => {
  const record = {
    id: "source-1", userId: "ding-one", checkType: "OnDuty",
    userCheckTime: Date.parse("2026-10-14T01:00:00.000Z"),
  }
  const changed = syncFixture([{ id: "person-1", dingtalk_user_id: "ding-one" }], {
    records: [record], changedCount: 1,
  })
  const changedResult = await runAttendanceSync({
    now: new Date("2026-10-14T10:10:00.000Z"), ...changed,
  })
  assert.equal(changedResult.status, "partial")
  assert.match(changedResult.errorSummary || "", /changed DingTalk record/)
  assert.deepEqual(changed.updates.at(-1)?.failure_scope, { unknown: false, affected: [] })
  assert.deepEqual(changed.rpcCalls.map((value) => value.name), [
    "insert_attendance_raw_punches_checked",
    "reconcile_attendance_dingtalk_punch_window",
  ])

  const missing = syncFixture([{ id: "person-1", dingtalk_user_id: "ding-one" }], {
    missingCount: 1,
  })
  const missingResult = await runAttendanceSync({
    now: new Date("2026-10-14T10:10:00.000Z"), ...missing,
  })
  assert.equal(missingResult.status, "partial")
  assert.match(missingResult.errorSummary || "", /missing DingTalk record/)
  assert.deepEqual(missing.updates.at(-1)?.failure_scope, { unknown: false, affected: [] })
  assert.deepEqual(missing.rpcCalls[0].args.p_requested_users, [
    { person_id: "person-1", dingtalk_user_id: "ding-one" },
  ])
})

test("invalid upstream records never reach the complete-window comparison", async () => {
  const fixture = syncFixture([{ id: "person-1", dingtalk_user_id: "ding-one" }], {
    records: [{ userId: "ding-one", checkType: "rejected", userCheckTime: Date.now() }],
  })
  const result = await runAttendanceSync({
    now: new Date("2026-10-14T10:10:00.000Z"), ...fixture,
  })
  assert.equal(result.status, "partial")
  assert.deepEqual(fixture.rpcCalls, [])
  assert.deepEqual(fixture.updates.at(-1)?.failure_scope, {
    unknown: false,
    affected: [{ person_id: "person-1", work_date: "2026-10-14" }],
  })
})

test("reconciliation receives exact queried seconds and normalized pre-import source keys", async () => {
  const fixture = syncFixture([], { records: [{
    id: "pre-import-record", userId: "ding-one", checkType: "OnDuty",
    userCheckTime: Date.parse("2026-08-12T01:00:00.000Z"),
  }] })
  const result = await runAttendanceSync({
    now: new Date("2026-08-14T10:00:01.000Z"),
    window: {
      from: new Date("2026-08-11T16:00:00.123Z"),
      to: new Date("2026-08-14T10:00:00.987Z"),
    },
    people: [{ id: "person-1", dingtalkUserId: "ding-one" }],
    ...fixture,
  })
  assert.equal(result.status, "succeeded")
  assert.deepEqual(fixture.rpcCalls.map((value) => value.name), [
    "reconcile_attendance_dingtalk_punch_window",
  ])
  const args = fixture.rpcCalls[0].args
  assert.equal(args.p_window_from, "2026-08-11T16:00:00.000Z")
  assert.equal(args.p_window_to, "2026-08-14T10:00:00.000Z")
  assert.equal((args.p_returned_source_keys as string[]).length, 1)
})

test("an expired month or cancelled budget stops the requery before it can certify coverage", async () => {
  const people = [{ id: "person-1", dingtalkUserId: "ding-one" }]
  const expired = syncFixture([])
  await assert.rejects(requeryAttendanceMonthForAutoConfirmation({
    year: 2026, month: 1, people,
    now: new Date("2026-10-14T10:10:00.000Z"), ...expired,
  }), /older than DingTalk's query limit/)
  assert.deepEqual(expired.queriedUserIds, [])

  const cancelled = syncFixture([])
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(requeryAttendanceMonthForAutoConfirmation({
    year: 2026, month: 9, people,
    now: new Date("2026-10-14T10:10:00.000Z"),
    signal: controller.signal, ...cancelled,
  }), /abort/i)
  assert.deepEqual(cancelled.queriedUserIds, [])
})
