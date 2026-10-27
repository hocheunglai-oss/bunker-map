import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { afterEach, beforeEach, mock, test } from "node:test"
import { transformSync } from "esbuild"
import {
  AttendanceAlreadyConfirmedError,
  AttendancePunchReviewRequiredError,
  AttendanceSyncReviewRequiredError,
  AttendanceIdentityReviewRequiredError,
  AttendanceSourceChangedError,
  AttendanceValidationError,
  attendancePersonBelongsToAdminUser,
  saveAttendanceMonthlyConfirmation,
  saveAttendanceAnnualConfirmation,
} from "../lib/attendanceData"
import { ATTENDANCE_PAGE_ID } from "../lib/attendanceRules"
import { annualColumns, annualMigration, annualTable } from "./fixtures/backup-annual.mjs"

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
  rpcError?: string
  rpcRecordOverride?: Record<string, unknown>
  inventory?: unknown
  inventoryError?: string
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
  const rpcNames: string[] = []
  const ownershipFilters: Array<Record<string, unknown>> = []
  const edits: unknown[] = []
  let clientCreations = 0
  const client = {
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === "get_bunker_map_backup_inventory") return {
        data: Object.hasOwn(options, "inventory") ? options.inventory : { tables: [annualTable], appliedMigrations: [annualMigration], annualConfirmationColumns: annualColumns },
        error: options.inventoryError ? { message: options.inventoryError } : null,
      }
      assert.ok(["save_attendance_monthly_confirmation_checked", "save_attendance_annual_confirmation_checked"].includes(name))
      const annual = name === "save_attendance_annual_confirmation_checked"
      rpcNames.push(name)
      if (annual) assert.equal(Object.hasOwn(args, "p_month"), false)
      assert.equal(args.p_expected_revision, args.p_status === "confirmed" ? 7 : null)
      writes.push(args)
      if (options.rpcError) return { data: null, error: { message: options.rpcError } }
      return {
        data: [{ id: "synthetic-confirmation", person_id: args.p_person_id,
          year: args.p_year, ...(annual ? { confirmed_source_revision: args.p_expected_revision } : { month: args.p_month }), status: args.p_status,
          confirmed_at: args.p_status === "confirmed" ? new Date().toISOString() : null,
          confirmed_by: args.p_status === "confirmed" ? args.p_actor : null,
          note: args.p_note, created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(), ...options.rpcRecordOverride }],
        error: null,
      }
    },
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
      AttendanceValidationError, AttendanceSourceChangedError, AttendanceAlreadyConfirmedError,
      AttendancePunchReviewRequiredError, AttendanceSyncReviewRequiredError,
      AttendanceIdentityReviewRequiredError,
      attendancePersonBelongsToAdminUser, saveAttendanceMonthlyConfirmation, saveAttendanceAnnualConfirmation,
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
    writes, rpcNames, edits, ownershipFilters,
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
    personId: PERSON_ID, year: 2026, month: 9, status: "confirmed", sourceRevision: 7, ...overrides,
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

test("an unresolved DingTalk correction returns a clear confirmation conflict", async () => {
  const app = harness({ rpcError: "ATTENDANCE_DINGTALK_ANOMALY_OPEN: review required" })
  const response = await app.request(confirmation())
  assert.equal(response.status, 409)
  assert.match(response.body.message, /DingTalk punch discrepancy needs administrator review/)
})

test("an unresolved DingTalk sync failure returns a clear confirmation conflict", async () => {
  const app = harness({ rpcError: "ATTENDANCE_SYNC_INCOMPLETE: recheck required" })
  const response = await app.request(confirmation())
  assert.equal(response.status, 409)
  assert.match(response.body.message, /synchronization is incomplete.*Recheck the source/)
})

test("a historical DingTalk identity mismatch returns a clear confirmation conflict", async () => {
  const app = harness({ rpcError: "ATTENDANCE_DINGTALK_IDENTITY_MISMATCH: review required" })
  const response = await app.request(confirmation())
  assert.equal(response.status, 409)
  assert.match(response.body.message, /different linked identity.*administrator review/)
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

test("confirmation opens at Hong Kong midnight, not UTC midnight, including year rollover", async () => {
  for (const boundary of [
    { before: "2026-09-30T15:59:59.999Z", after: "2026-09-30T16:00:00.000Z", year: 2026, month: 9 },
    { before: "2026-12-31T15:59:59.999Z", after: "2026-12-31T16:00:00.000Z", year: 2026, month: 12 },
  ]) {
    mock.timers.setTime(new Date(boundary.before).getTime())
    const app = harness()
    const input = confirmation({ year: boundary.year, month: boundary.month })
    assert.equal((await app.request(input)).status, 400)
    assert.deepEqual(app.writes, [])
    mock.timers.setTime(new Date(boundary.after).getTime())
    const response = await app.request(input)
    assert.equal(response.status, 200)
    assert.equal(response.body.confirmation.confirmedAt, boundary.after)
    assert.equal(app.writes.length, 1)
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

function annualConfirmation(overrides: Record<string, unknown> = {}) {
  return { action: "save-annual-confirmation", confirmation: {
    personId: PERSON_ID, year: 2025, status: "confirmed", sourceRevision: 7, ...overrides,
  } }
}

test("View confirms only their own closed annual statement using the distinct RPC and response", async () => {
  const app = harness()
  const response = await app.request(annualConfirmation({ note: "Reviewed annual totals" }))
  assert.equal(response.status, 200)
  assert.equal(response.body.success, true)
  assert.equal(Object.hasOwn(response.body, "confirmation"), false)
  assert.equal(Object.hasOwn(response.body.annualConfirmation, "month"), false)
  assert.equal(response.body.annualConfirmation.confirmedSourceRevision, 7)
  assert.equal(response.body.annualConfirmation.personId, PERSON_ID)
  assert.equal(response.body.annualConfirmation.year, 2025)
  assert.equal(response.body.annualConfirmation.note, "Reviewed annual totals")
  assert.deepEqual(app.rpcNames, ["save_attendance_annual_confirmation_checked"])
  assert.deepEqual(app.writes, [{ p_person_id: PERSON_ID, p_year: 2025, p_status: "confirmed",
    p_note: "Reviewed annual totals", p_actor: "synthetic-user", p_expected_revision: 7 }])
  assert.deepEqual(app.ownershipFilters, [{ id: PERSON_ID, admin_user_id: USER_ID, is_active: true }])
})

test("annual View ownership cannot be forged and reset still requires Edit", async () => {
  for (const overrides of [{ personId: OTHER_PERSON_ID }, { personId: INACTIVE_PERSON_ID }, { status: "pending" }]) {
    const app = harness()
    assert.equal((await app.request({ ...annualConfirmation(overrides), adminUserId: OTHER_USER_ID })).status, 403)
    assert.deepEqual(app.writes, [])
  }
  const unlinked = harness({ adminUserId: null })
  assert.equal((await unlinked.request(annualConfirmation())).status, 403)
  assert.deepEqual(unlinked.writes, [])
})

test("annual no-access and signed-out requests fail before database client creation", async () => {
  for (const options of [{ permission: "none" as const }, { signedIn: false }]) {
    const app = harness(options)
    assert.equal((await app.request(annualConfirmation())).status, options.signedIn === false ? 401 : 403)
    assert.equal(app.clientCreations(), 0)
    assert.deepEqual(app.writes, [])
  }
})

test("Edit can confirm or reset a separate annual row without changing a monthly row", async () => {
  const app = harness({ permission: "edit" })
  assert.equal((await app.request(confirmation({ personId: OTHER_PERSON_ID, year: 2025, month: 12 }))).status, 200)
  assert.equal((await app.request(annualConfirmation({ personId: OTHER_PERSON_ID }))).status, 200)
  const reset = await app.request(annualConfirmation({ personId: OTHER_PERSON_ID, status: "pending", sourceRevision: undefined }))
  assert.equal(reset.status, 200)
  assert.equal(reset.body.annualConfirmation.status, "pending")
  assert.equal(reset.body.annualConfirmation.confirmedBy, null)
  assert.equal(reset.body.annualConfirmation.confirmedSourceRevision, null)
  assert.deepEqual(app.rpcNames, ["save_attendance_monthly_confirmation_checked", "save_attendance_annual_confirmation_checked", "save_attendance_annual_confirmation_checked"])
  assert.equal(app.writes[0].p_month, 12)
  assert.ok(app.writes.slice(1).every((row) => !Object.hasOwn(row, "p_month")))
})

test("annual confirmation closes at Hong Kong New Year, not UTC midnight", async () => {
  for (const permission of ["view", "edit"] as const) {
    mock.timers.setTime(new Date("2026-12-31T15:59:59.999Z").getTime())
    const app = harness({ permission })
    assert.equal((await app.request(annualConfirmation({ year: 2026 }))).status, 400)
    assert.deepEqual(app.writes, [])
    mock.timers.setTime(new Date("2026-12-31T16:00:00.000Z").getTime())
    assert.equal((await app.request(annualConfirmation({ year: 2026 }))).status, 200)
  }
})

test("annual validation rejects current/future years, fake months and missing/unsafe source revisions", async () => {
  for (const invalid of [{ year: 2026 }, { year: 2027 }, { year: 1999 }, { year: undefined }, { year: null }, { year: "" }, { personId: "invalid" },
    { month: 12 }, { month: null }, { status: "wrong" }, { sourceRevision: undefined },
    { sourceRevision: null }, { sourceRevision: false }, { sourceRevision: "" }, { sourceRevision: "7" },
    { sourceRevision: -1 }, { sourceRevision: 1.5 }, { sourceRevision: Number.MAX_SAFE_INTEGER + 1 }]) {
    const app = harness({ permission: "edit" })
    assert.equal((await app.request(annualConfirmation(invalid))).status, 400, JSON.stringify(invalid))
    assert.deepEqual(app.writes, [])
  }
})

test("annual concurrency, anomaly, sync and identity failures retain conflict status and annual wording", async () => {
  for (const [prefix, message] of [
    ["ATTENDANCE_SOURCE_CHANGED", /changed while this statement was open/],
    ["ATTENDANCE_ALREADY_CONFIRMED", /attendance year was already confirmed/],
    ["ATTENDANCE_DINGTALK_ANOMALY_OPEN", /before this year can be confirmed/],
    ["ATTENDANCE_SYNC_INCOMPLETE", /synchronization is incomplete/],
    ["ATTENDANCE_DINGTALK_IDENTITY_MISMATCH", /different linked identity/],
  ] as const) {
    const app = harness({ rpcError: `${prefix}: synthetic guard rejected` })
    const response = await app.request(annualConfirmation())
    assert.equal(response.status, 409)
    assert.match(response.body.message, message)
  }
})

test("annual acknowledgements fail closed on mismatched source, identity, year or status", async () => {
  for (const override of [{ person_id: OTHER_PERSON_ID }, { year: 2024 }, { status: "pending" }, { month: 12 },
    { id: null }, { confirmed_at: null }, { confirmed_by: null },
    { confirmed_source_revision: 6 }, { confirmed_source_revision: null },
    { confirmed_source_revision: "9007199254740992" }]) {
    const app = harness({ rpcRecordOverride: override })
    const response = await app.request(annualConfirmation())
    assert.equal(response.status, 500)
    assert.notEqual(response.body.success, true)
    assert.doesNotMatch(response.body.message, /synthetic|9007199254740992|mismatched record/)
  }
})

test("legacy annual-summary monthly requests fail safely without creating or overwriting December", async () => {
  for (const status of ["pending", "confirmed"]) {
    const app = harness({ permission: "edit" })
    const response = await app.request(confirmation({ year: 2025, month: 12, status, note: "  annual-summary  " }))
    assert.equal(response.status, 400)
    assert.match(response.body.message, /separate annual confirmation action/)
    assert.deepEqual(app.writes, [])
  }
})

test("proven pre-migration inventory blocks annual confirm and reset explicitly without a missing-table write", async () => {
  for (const status of ["confirmed", "pending"]) {
    const app = harness({ permission: "edit", inventory: { tables: [], appliedMigrations: [] } })
    const response = await app.request(annualConfirmation({ status }))
    assert.equal(response.status, 400)
    assert.match(response.body.message, /Year-end confirmation is not available yet.*Monthly confirmations are unchanged/)
    assert.deepEqual(app.writes, [])
    assert.deepEqual(app.rpcNames, [])
  }
})

test("annual capability drift, missing evidence and inventory errors fail closed before the write RPC", async () => {
  for (const options of [
    { inventory: null }, { inventory: {} }, { inventoryError: "synthetic private metadata failure" },
    { inventory: { tables: [annualTable], appliedMigrations: [] } },
    { inventory: { tables: [], appliedMigrations: [annualMigration] } },
    { inventory: { tables: [annualTable], appliedMigrations: [annualMigration], annualConfirmationColumns: [] } },
  ]) {
    const app = harness(options)
    const response = await app.request(annualConfirmation())
    assert.equal(response.status, 500)
    assert.doesNotMatch(response.body.message, /private metadata failure|applied.migration|physical.column/)
    assert.deepEqual(app.writes, [])
  }
})

test("monthly confirmation remains independent of annual capability availability or inventory failure", async () => {
  for (const options of [{ inventory: { tables: [], appliedMigrations: [] } }, { inventoryError: "synthetic inventory outage" }]) {
    const app = harness(options)
    assert.equal((await app.request(confirmation())).status, 200)
    assert.deepEqual(app.rpcNames, ["save_attendance_monthly_confirmation_checked"])
  }
})

test("annual UUID acknowledgement compares PostgreSQL's canonical lowercase UUID", async () => {
  const personId = "ABCDEFAB-1234-4234-8234-ABCDEFABCDEF"
  const app = harness({ permission: "edit" })
  const response = await app.request(annualConfirmation({ personId }))
  assert.equal(response.status, 200)
  assert.equal(response.body.annualConfirmation.personId, personId.toLowerCase())
  assert.equal(app.writes[0].p_person_id, personId.toLowerCase())
})
