import assert from "node:assert/strict"
import test from "node:test"
import {
  DingTalkAttendanceClient,
  DINGTALK_ATTENDANCE_MAX_USERS,
  validateDingTalkAttendanceQuery,
} from "../lib/dingTalkAttendance"

const NOW = Date.parse("2026-08-07T07:00:00.000Z")
const VALID_QUERY = {
  userIds: [" test-user-001 ", "test-user-001"],
  checkDateFrom: "2026-08-01 00:00:00",
  checkDateTo: "2026-08-07 23:59:59",
}

test("validates, trims, and deduplicates a DingTalk attendance query", () => {
  assert.deepEqual(validateDingTalkAttendanceQuery(VALID_QUERY, NOW), {
    userIds: ["test-user-001"],
    checkDateFrom: "2026-08-01 00:00:00",
    checkDateTo: "2026-08-07 23:59:59",
    isI18n: true,
  })
})

test("rejects invalid dates, ranges over seven days, old data, and more than 50 users", () => {
  assert.throws(
    () => validateDingTalkAttendanceQuery({ ...VALID_QUERY, checkDateFrom: "2026-02-30 00:00:00" }, NOW),
    /valid YYYY-MM-DD/,
  )
  assert.throws(
    () => validateDingTalkAttendanceQuery({
      ...VALID_QUERY,
      checkDateFrom: "2026-07-31 23:59:58",
    }, NOW),
    /maximum 7-day/,
  )
  assert.throws(
    () => validateDingTalkAttendanceQuery({
      ...VALID_QUERY,
      checkDateFrom: "2026-01-01 00:00:00",
      checkDateTo: "2026-01-02 00:00:00",
    }, NOW),
    /older than 180 days/,
  )
  assert.throws(
    () => validateDingTalkAttendanceQuery({
      ...VALID_QUERY,
      userIds: Array.from({ length: DINGTALK_ATTENDANCE_MAX_USERS + 1 }, (_, index) => `user-${index}`),
    }, NOW),
    /at most 50 users/,
  )
  assert.throws(
    () => validateDingTalkAttendanceQuery({
      ...VALID_QUERY,
      userIds: Array.from({ length: DINGTALK_ATTENDANCE_MAX_USERS + 1 }, () => "same-user"),
    }, NOW),
    /at most 50 users/,
  )
})

test("uses the official token and raw-record endpoints without caching responses", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, init })

    if (url.includes("/v1.0/oauth2/accessToken")) {
      return Response.json({ accessToken: "short-lived-token", expireIn: 7200 })
    }

    return Response.json({
      errcode: 0,
      errmsg: "ok",
      recordresult: [
        {
          id: 123,
          userId: "test-user-001",
          userCheckTime: 1786077120000,
          checkType: "OnDuty",
          sourceType: "ATM",
          deviceSN: "TEST-DEVICE-001",
        },
      ],
    })
  }
  const client = new DingTalkAttendanceClient({
    appKey: "client-id-test",
    appSecret: "client-secret-test",
    fetchImpl,
    now: () => NOW,
  })

  const first = await client.listRecords(VALID_QUERY)
  const second = await client.listRecords(VALID_QUERY)

  assert.equal(first.records.length, 1)
  assert.equal(first.records[0].sourceType, "ATM")
  assert.equal(first.records[0].deviceSN, "TEST-DEVICE-001")
  assert.equal(second.records.length, 1)
  assert.equal(requests.length, 3, "the second query should reuse the cached app token")

  const tokenRequest = requests[0]
  assert.equal(tokenRequest.url, "https://api.dingtalk.com/v1.0/oauth2/accessToken")
  assert.equal(tokenRequest.init?.method, "POST")
  assert.equal(tokenRequest.init?.cache, "no-store")
  assert.deepEqual(JSON.parse(String(tokenRequest.init?.body)), {
    appKey: "client-id-test",
    appSecret: "client-secret-test",
  })

  const attendanceRequest = requests[1]
  assert.equal(
    new URL(attendanceRequest.url).searchParams.get("access_token"),
    "short-lived-token",
  )
  assert.equal(attendanceRequest.init?.method, "POST")
  assert.equal(attendanceRequest.init?.cache, "no-store")
  const attendanceBody = new URLSearchParams(String(attendanceRequest.init?.body))
  assert.equal(attendanceBody.get("checkDateFrom"), VALID_QUERY.checkDateFrom)
  assert.equal(attendanceBody.get("checkDateTo"), VALID_QUERY.checkDateTo)
  assert.equal(attendanceBody.get("isI18n"), "true")
  assert.equal(attendanceBody.get("userIds"), JSON.stringify(["test-user-001"]))
})

test("upstream authentication failures never expose credentials or a token", async () => {
  const appKey = "client-id-that-must-stay-private"
  const appSecret = "client-secret-that-must-stay-private"
  const client = new DingTalkAttendanceClient({
    appKey,
    appSecret,
    now: () => NOW,
    fetchImpl: async () => new Response(
      JSON.stringify({
        code: `${appKey}:${appSecret}`,
        message: `${appKey}:${appSecret}:unexpected-token`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    ),
  })

  await assert.rejects(
    () => client.listRecords(VALID_QUERY),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.doesNotMatch(error.message, new RegExp(appKey))
      assert.doesNotMatch(error.message, new RegExp(appSecret))
      assert.doesNotMatch(error.message, /unexpected-token/)
      assert.match(error.message, /authentication failed/)
      return true
    },
  )
})
