import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { afterEach, beforeEach, mock, test } from "node:test"
import { transformSync } from "esbuild"
import {
  AttendanceValidationError,
  attendancePersonBelongsToAdminUser,
  saveAttendanceMonthlyConfirmation,
} from "../lib/attendanceData"
import { ATTENDANCE_PAGE_ID } from "../lib/attendanceRules"

// Execute the actual route and confirmation/ownership helpers. Authentication,
// audit-client creation, and database I/O are synthetic; no live services run.
const routeCode = transformSync(
  readFileSync(new URL("../app/api/admin/attendance/route.ts", import.meta.url), "utf8"),
  { loader: "ts", format: "cjs", target: "node24" },
).code
const USER_ID = "11111111-1111-4111-8111-111111111111"
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222"
const PERSON_ID = "33333333-3333-4333-8333-333333333333"
const OTHER_PERSON_ID = "44444444-4444-4444-8444-444444444444"
const INACTIVE_PERSON_ID = "55555555-5555-4555-8555-555555555555"

beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-02T04:00:00.000Z") })
})
afterEach(() => mock.timers.reset())

function harness(options: {
  permission?: "none" | "view" | "edit"
  adminUserId?: string | null
  signedIn?: boolean
} = {}) {
  const permission = options.permission ?? "view"
  const session = {
    adminUserId: options.adminUserId === undefined ? USER_ID : options.adminUserId,
    username: "synthetic-user", displayName: "Synthetic User",
  }
  const people = [
    { id: PERSON_ID, admin_user_id: USER_ID, is_active: true },
    { id: OTHER_PERSON_ID, admin_user_id: OTHER_USER_ID, is_active: true },
    { id: INACTIVE_PERSON_ID, admin_user_id: USER_ID, is_active: false },
  ]
  const writes: Array<Record<string, unknown>> = []
  const ownershipFilters: Array<Record<string, unknown>> = []
  const edits: unknown[] = []
  let clientCreations = 0
  const client = {
    from(table: string) {
      assert.ok(["attendance_people", "attendance_monthly_confirmations"].includes(table))
      const filters: Record<string, unknown> = {}
      let values: Record<string, unknown> | undefined
      const query = {
        select() { return query },
        eq(key: string, value: unknown) { filters[key] = value; return query },
        async maybeSingle() {
          assert.equal(table, "attendance_people")
          ownershipFilters.push({ ...filters })
          const data = people.find((person) => Object.entries(filters).every(
            ([key, value]) => person[key as keyof typeof person] === value,
          ))
          return { data: data ?? null, error: null }
        },
        upsert(input: Record<string, unknown>, upsertOptions: unknown) {
          assert.equal(table, "attendance_monthly_confirmations")
          assert.deepEqual(upsertOptions, { onConflict: "person_id,year,month" })
          values = input
          writes.push(input)
          return query
        },
        async single() {
          assert.ok(values, "confirmation writes must use upsert")
          return {
            data: { id: "synthetic-confirmation", ...values,
              created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
            error: null,
          }
        },
      }
      return query
    },
  }
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@/lib/adminAuth": {
      async requireAdminPagePermissionForRequest(_request: Request, pageId: string, level: string) {
        assert.equal(pageId, ATTENDANCE_PAGE_ID)
        assert.equal(level, "view")
        if (options.signedIn === false) throw new Error("Unauthorized")
        if (permission === "none") throw new Error("Forbidden")
        return session
      },
      hasAdminPagePermission(actualSession: unknown, pageId: string, level: string) {
        assert.equal(actualSession, session)
        assert.equal(pageId, ATTENDANCE_PAGE_ID)
        assert.equal(level, "edit")
        return permission === "edit"
      },
    },
    "@/lib/adminAudit": {
      createAdminAuditContext(actualSession: unknown, request: Request, pageId: string) {
        assert.equal(actualSession, session)
        assert.equal(pageId, ATTENDANCE_PAGE_ID)
        return { session, request, pageId }
      },
      createAdminAuditedSupabaseClient(_context: unknown, clientOptions: unknown) {
        assert.deepEqual(clientOptions, { useServiceRole: true })
        clientCreations += 1
        return client
      },
    },
    "@/lib/attendanceData": {
      AttendanceValidationError, attendancePersonBelongsToAdminUser, saveAttendanceMonthlyConfirmation,
      async saveAttendanceDayEdit(actualClient: unknown, input: unknown, actor: string) {
        assert.equal(actualClient, client)
        assert.equal(actor, session.username)
        edits.push(input)
        return { edited: true }
      },
    },
    "@/lib/attendanceRules": { ATTENDANCE_PAGE_ID },
    "@/lib/attendanceSync": {
      runAttendanceSync() { throw new Error("Unexpected sync execution") },
    },
  }
  const loaded: { exports: { POST?: (request: Request) => Promise<Response> } } = { exports: {} }
  new Function("require", "module", "exports", routeCode)((name: string) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`)
    return modules[name]
  }, loaded, loaded.exports)
  const post = loaded.exports.POST!
  return {
    writes, edits, ownershipFilters,
    clientCreations: () => clientCreations,
    async request(payload: unknown) {
      const response = await post(new Request("https://example.test/api/admin/attendance", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      }))
      assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0")
      return { status: response.status, body: await response.json() }
    },
  }
}

function confirmation(overrides: Record<string, unknown> = {}) {
  return { action: "save-confirmation", confirmation: {
    personId: PERSON_ID, year: 2026, month: 9, status: "confirmed", ...overrides,
  } }
}

test("View user can confirm their own closed month through the actual API and data helpers", async () => {
  const app = harness()
  const response = await app.request(confirmation())
  assert.equal(response.status, 200)
  assert.equal(response.body.success, true)
  assert.equal(response.body.confirmation.personId, PERSON_ID)
  assert.equal(response.body.confirmation.status, "confirmed")
  assert.equal(response.body.confirmation.confirmedBy, "synthetic-user")
  assert.equal(response.body.confirmation.confirmedAt, "2026-10-02T04:00:00.000Z")
  assert.deepEqual(app.ownershipFilters, [{ id: PERSON_ID, admin_user_id: USER_ID, is_active: true }])
  assert.equal(app.writes.length, 1)
})

test("View user cannot confirm another user's statement or their inactive attendance record", async () => {
  for (const personId of [OTHER_PERSON_ID, INACTIVE_PERSON_ID]) {
    const app = harness()
    const response = await app.request({ ...confirmation({ personId }), adminUserId: OTHER_USER_ID })
    assert.equal(response.status, 403)
    assert.deepEqual(app.writes, [])
  }
})

test("View user without a linked user identity cannot confirm", async () => {
  const app = harness({ adminUserId: null })
  assert.equal((await app.request(confirmation())).status, 403)
  assert.deepEqual(app.writes, [])
  assert.deepEqual(app.ownershipFilters, [])
})

test("View user cannot reset confirmation to pending", async () => {
  const app = harness()
  assert.equal((await app.request(confirmation({ status: "pending" }))).status, 403)
  assert.deepEqual(app.writes, [])
})

test("View users cannot edit attendance, send reminders, manage people or trigger sync", async () => {
  for (const action of ["save-day-edit", "save-leave", "save-person", "remove-person", "save-roster",
    "save-work-mode", "save-override", "save-entitlement", "save-monthly-adjustment", "send-reminder", "sync"]) {
    const app = harness()
    assert.equal((await app.request({ action })).status, 403, action)
    assert.deepEqual(app.writes, [])
    assert.deepEqual(app.edits, [])
  }
})

test("no-access and signed-out requests fail before an audited database client is created", async () => {
  for (const options of [{ permission: "none" as const }, { signedIn: false }]) {
    const app = harness(options)
    assert.equal((await app.request(confirmation())).status, options.signedIn === false ? 401 : 403)
    assert.equal(app.clientCreations(), 0)
    assert.deepEqual(app.writes, [])
  }
})

test("both View and Edit retain the real Hong Kong closed-month validation", async () => {
  for (const permission of ["view", "edit"] as const) {
    for (const month of [10, 11]) {
      const app = harness({ permission })
      const response = await app.request(confirmation({ month }))
      assert.equal(response.status, 400)
      assert.match(response.body.message, /only after the Hong Kong month has closed/)
      assert.deepEqual(app.writes, [])
    }
  }
})

test("Edit retains confirmation, reset and attendance edit rights", async () => {
  const app = harness({ permission: "edit" })
  assert.equal((await app.request(confirmation({ personId: OTHER_PERSON_ID }))).status, 200)
  const reset = await app.request(confirmation({ personId: OTHER_PERSON_ID, status: "pending" }))
  assert.equal(reset.status, 200)
  assert.equal(reset.body.confirmation.confirmedBy, null)
  assert.equal((await app.request({ action: "save-day-edit", dayEdit: { fixture: true } })).status, 200)
  assert.equal(app.writes.length, 2)
  assert.deepEqual(app.ownershipFilters, [])
  assert.deepEqual(app.edits, [{ fixture: true }])
})

test("confirmation validates person and period before writing", async () => {
  for (const invalid of [{ personId: "invalid" }, { year: 1999 }, { month: 13 }]) {
    const app = harness()
    assert.equal((await app.request(confirmation(invalid))).status, 400)
    assert.deepEqual(app.writes, [])
  }
})
