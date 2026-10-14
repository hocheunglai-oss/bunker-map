import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { transformSync } from "esbuild"
import { AttendanceSourceChangedError } from "../lib/attendanceData"

const routeCode = transformSync(
  readFileSync(new URL("../app/api/admin/attendance/route.ts", import.meta.url), "utf8"),
  { loader: "ts", format: "cjs", target: "node24" },
).code

function harness(revisions: number[]) {
  let reads = 0
  const client = {}
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@/lib/adminAuth": {
      async requireAdminPagePermissionForRequest() { return { adminUserId: "user-1" } },
      hasAdminPagePermission() { return true },
    },
    "@/lib/adminAudit": {},
    "@/lib/attendanceData": {
      AttendanceSourceChangedError,
      getAttendanceServiceClient() { return client },
      async getAttendanceSourceRevision(actual: unknown) {
        assert.equal(actual, client)
        const revision = revisions.shift()
        assert.notEqual(revision, undefined)
        return revision
      },
      async getMonthlyAttendance() {
        reads += 1
        return { view: "monthly", year: 2026, month: 9, people: [], summaries: [] }
      },
    },
    "@/lib/attendanceRules": { ATTENDANCE_PAGE_ID: "attendance-record" },
    "@/lib/attendanceSync": {},
  }
  const loaded: { exports: { GET?: (request: Request) => Promise<Response> } } = { exports: {} }
  new Function("require", "module", "exports", routeCode)((name: string) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`)
    return modules[name]
  }, loaded, loaded.exports)
  return {
    reads: () => reads,
    request: () => loaded.exports.GET!(new Request(
      "https://example.test/api/admin/attendance?view=monthly&scope=year&year=2026&month=9",
    )),
  }
}

test("monthly statement returns the revision that enclosed a consistent source read", async () => {
  const app = harness([8, 9, 9, 9])
  const response = await app.request()
  assert.equal(response.status, 200)
  assert.equal((await response.json()).sourceRevision, 9)
  assert.equal(app.reads(), 2)
})

test("monthly statement refuses a repeatedly changing source snapshot", async () => {
  const app = harness([8, 9, 9, 10])
  const response = await app.request()
  assert.equal(response.status, 409)
  assert.match((await response.json()).message, /Reload and review/)
  assert.equal(app.reads(), 2)
})
