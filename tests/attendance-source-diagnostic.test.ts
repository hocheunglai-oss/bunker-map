import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"
import * as diagnostic from "../lib/attendanceSourceDiagnostic"
import * as provider from "../lib/dingTalkAttendance"

const personId = "11111111-1111-4111-8111-111111111111"
const date = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10)
const params = `personId=${personId}&date=${date}`
const record = { id: "source-id", userId: "provider-id", checkType: "OnDuty", userCheckTime: Date.parse(`${date}T01:30:00Z`), sourceType: "ATM", secret: "never-return", deviceSN: "private-device" }

function fixture(options: { auth?: string; missing?: boolean; dbError?: boolean; upstreamError?: boolean } = {}) {
  const calls: unknown[] = []
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: Object.assign(Response, { json: Response.json }) },
    "@/lib/adminAuth": { requireAdminSessionForRequest: async () => {
      calls.push("auth")
      if (options.auth === "anonymous") throw Error("Unauthorized")
      return { role: options.auth === "staff" ? "STAFF" : "ADMIN" }
    } },
    "@/lib/adminPages": { isAdminRole: (role: string) => role === "ADMIN" },
    "@/lib/attendanceSourceDiagnostic": diagnostic,
    "@/lib/attendanceData": { getAttendanceServiceClient: () => {
      calls.push("database")
      return { from: (table: string) => {
        assert.equal(table, "attendance_people")
        return { select: (fields: string) => {
          assert.equal(fields, "id,staff_code,dingtalk_user_id")
          return { eq: (key: string, value: string) => {
            assert.equal(key, "id"); assert.equal(value, personId)
            return { maybeSingle: async () => ({ data: options.missing ? null : { id: personId, staff_code: "XX", dingtalk_user_id: "provider-id" }, error: options.dbError ? Error("secret-db-error") : null }) }
          } }
        } }
      } }
    } },
    "@/lib/dingTalkAttendance": { ...provider, getDingTalkAttendanceClient: () => ({ listRecords: async (input: unknown) => {
      calls.push(input)
      if (options.upstreamError) throw Error("secret-provider-error")
      return { records: [record] }
    } }) },
  }
  const loaded: { exports: { GET?: (request: Request) => Promise<Response> } } = { exports: {} }
  const code = transformSync(readFileSync(new URL("../app/api/admin/dingtalk-attendance/route.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
  new Function("require", "module", "exports", code)((name: string) => {
    assert.ok(Object.hasOwn(modules, name), name); return modules[name]
  }, loaded, loaded.exports)
  return { calls, request: (query = params) => loaded.exports.GET!(new Request(`https://fixture.invalid/api/admin/dingtalk-attendance?${query}`)) }
}

test("source diagnostic authenticates and restricts to admin before database/provider reads", async () => {
  for (const [auth, expected] of [["anonymous", 401], ["staff", 403]] as const) {
    const f = fixture({ auth }); const r = await f.request()
    assert.equal(r.status, expected); assert.deepEqual(f.calls, ["auth"])
    assert.match(r.headers.get("cache-control")!, /private, no-store/)
  }
})

test("source diagnostic validates one employee/date, rejects duplicates, extra keys and impossible dates", async () => {
  for (const query of ["", `personId=bad&date=${date}`, `${params}&personId=${personId}`, `${params}&date=${date}`, `${params}&userIds=other`, `personId=${personId}&date=2026-02-30`, `personId=${personId}&date=2000-01-01`]) {
    const f = fixture(); assert.equal((await f.request(query)).status, 400)
    assert.deepEqual(f.calls, ["auth"])
  }
})

test("source diagnostic queries only server-linked identity for one day and returns an allowlisted no-store summary", async () => {
  const f = fixture(); const r = await f.request(); const body = await r.json()
  assert.equal(r.status, 200)
  assert.match(r.headers.get("cache-control")!, /private, no-store/)
  assert.deepEqual(f.calls, ["auth", "database", { userIds: ["provider-id"], checkDateFrom: `${date} 00:00:00`, checkDateTo: `${date} 23:59:59`, isI18n: false }])
  assert.equal(body.staffCode, "XX"); assert.equal(body.records[0].acceptedByNormalizer, true)
  assert.doesNotMatch(JSON.stringify(body), /never-return|private-device|provider-id|source-id/)
})

test("source diagnostic fails closed without a linked person and redacts internal errors", async () => {
  for (const [options, status] of [[{ missing: true }, 404], [{ dbError: true }, 500], [{ upstreamError: true }, 500]] as const) {
    const f = fixture(options); const r = await f.request()
    assert.equal(r.status, status); assert.doesNotMatch(await r.text(), /secret-/)
    if (!options.upstreamError) assert.deepEqual(f.calls, ["auth", "database"])
  }
})

test("source diagnostic reports rejected records without accepting unknown/security exceptions", () => {
  const records = diagnostic.summarizeAttendanceSource([
    { ...record, checkType: null, invalidRecordType: "Security", invalidRecordMsg: "review needed" },
    { ...record, userId: "different" },
    { ...record, userCheckTime: "invalid" },
  ], personId, "provider-id")
  assert.ok(records.every((r) => !r.acceptedByNormalizer))
  assert.equal(records[0].invalidRecordType, "Security")
  assert.equal(records[1].identityMatches, false)
  assert.equal(records[2].punchTime, null)
})
