import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { afterEach, beforeEach, mock, test } from "node:test"
import { transformSync } from "esbuild"
import { annualColumns, annualMigration, annualTable } from "./fixtures/backup-annual.mjs"

// Exercise the actual annual read orchestration with synthetic storage only.
// No .env, remote database, auth session, email or sync operation is accessed.
const localRequire = createRequire(import.meta.url)
const code = transformSync(readFileSync(new URL("../lib/attendanceData.ts", import.meta.url), "utf8"),
  { loader: "ts", format: "cjs", target: "node24" }).code
const PERSON = "11111111-1111-4111-8111-111111111111"
const USER = "22222222-2222-4222-8222-222222222222"
beforeEach(() => mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-27T02:00:00Z") }))
afterEach(() => mock.timers.reset())

function harness(annualRows: unknown[] = [], error: { message: string } | null = null,
  inventory: unknown = { tables: [annualTable], appliedMigrations: [annualMigration], annualConfirmationColumns: annualColumns },
  inventoryError: string | null = null, tableRows: Record<string, unknown[]> = {},
  readView: "annual" | "monthly" = "annual") {
  const reads: Array<{ table: string; filters: Record<string, unknown> }> = []
  const client = {
    from(table: string) {
      if (readView === "annual") {
        assert.notEqual(table, "attendance_monthly_confirmations", "annual reads must not infer approvals from December")
      }
      const filters: Record<string, unknown> = {}
      const query = {
        select() { return query }, order() { return query }, limit() { return query },
        range() { return query }, gte() { return query }, lte() { return query }, or() { return query },
        eq(key: string, value: unknown) { filters[key] = value; return query },
        then(resolve: (value: unknown) => unknown) {
          reads.push({ table, filters: { ...filters } })
          const people = [
            { id: PERSON, admin_user_id: USER, staff_code: "AT", display_name: "Alice Test", team: "BT", is_active: true },
            { id: "33333333-3333-4333-8333-333333333333", admin_user_id: null, staff_code: "UT", display_name: "Unlinked Test", team: "BT", is_active: true },
          ]
          return Promise.resolve({ data: table === "attendance_people" ? people : table === "attendance_annual_confirmations" ? annualRows : tableRows[table] || [],
            error: table === "attendance_annual_confirmations" ? error : null }).then(resolve)
        },
      }
      return query
    },
    async rpc(name: string) {
      if (name === "get_bunker_map_backup_inventory") return { data: inventory, error: inventoryError ? { message: inventoryError } : null }
      assert.equal(name, "list_attendance_available_years")
      return { data: [{ year: 2026 }, { year: 2025 }], error: null }
    },
  }
  const boundaries: Record<string, unknown> = {
    "server-only": {},
    "@supabase/supabase-js": { createClient(url: string, key: string) {
      assert.equal(url, "https://synthetic.invalid")
      assert.equal(key, "synthetic-only")
      return client
    } },
    "@/lib/adminUsers": { async listManagedAdminUsers() { return [] } },
    "@/lib/attendanceCalendar": {
      async loadAttendanceCalendarContext() { return { staffOrder: ["AT", "UT"], holidaysByDate: new Map() } },
      sortAttendancePeople: <T>(rows: T[]) => rows,
    },
    "@/lib/emailNotice": { normalizeEmailList() { throw new Error("No email access") }, sendNoticeEmail() { throw new Error("No email access") } },
  }
  const loaded: { exports: {
    getAllTimeAttendance?: (year: number, options: object) => Promise<Record<string, unknown>>
    getMonthlyAttendance?: (year: number, month: number, options: object) => Promise<Record<string, unknown>>
  } } = { exports: {} }
  new Function("require", "module", "exports", "process", code)((name: string) =>
    Object.hasOwn(boundaries, name) ? boundaries[name] : localRequire(name.startsWith("@/") ? `../${name.slice(2)}` : name),
  loaded, loaded.exports, { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" } })
  return {
    reads,
    read: (year = 2025, options: object = { adminUserId: USER, canEdit: false }) => {
      assert.equal(readView, "annual", "annual reads must retain their monthly-table guard")
      return loaded.exports.getAllTimeAttendance!(year, options)
    },
    readMonthly: (year: number, month: number) => {
      assert.equal(readView, "monthly")
      return loaded.exports.getMonthlyAttendance!(year, month, { adminUserId: USER, canEdit: false })
    },
  }
}

const annual = { id: "synthetic-annual", person_id: PERSON, year: 2025, status: "confirmed", note: "Reviewed totals",
  confirmed_at: "2026-01-01T00:00:00Z", confirmed_by: "synthetic-user", confirmed_source_revision: "7" }

for (const homePortion of ["am", "pm"]) {
  test(`${homePortion.toUpperCase()} HOME plus opposite annual leave deducts only half a day from annual balance`, async () => {
    const response = await harness([], null, undefined, null, {
      attendance_entitlements: [{ person_id: PERSON, year: 2025, allowance_units: 15, opening_carry_forward_units: 2 }],
      attendance_leave_entries: [
        { id: "home-half", person_id: PERSON, leave_date: "2025-09-15", portion: homePortion, code: "HO", units: 0.5 },
        { id: "leave-half", person_id: PERSON, leave_date: "2025-09-15", portion: homePortion === "am" ? "pm" : "am", code: "ALS", units: 0.5 },
      ],
    }).read()
    const summary = (response.annualSummaries as Array<Record<string, unknown>>).find(row => row.personId === PERSON)!
    const totals = summary.codeTotals as Record<string, number>
    assert.equal(totals.HO, 0.5, "stored HO must not be counted again as derived whole-day HOME")
    assert.equal(totals.ALS, 0.5)
    assert.equal(totals.ALU, 0)
    assert.equal(summary.closingBalanceUnits, 16.5)
  })
}

for (const leavePortion of ["am", "pm"]) {
  test(`legacy manual HOME and ${leavePortion.toUpperCase()} annual leave keep half-day monthly and annual totals`, async () => {
    const rows = {
      attendance_entitlements: [{ person_id: PERSON, year: 2025, allowance_units: 15, opening_carry_forward_units: 2 }],
      attendance_leave_entries: [
        { id: "leave-half", person_id: PERSON, leave_date: "2025-09-15", portion: leavePortion, code: "ALS", units: 0.5 },
      ],
      attendance_work_mode_overrides: [
        { id: "legacy-home", person_id: PERSON, work_date: "2025-09-15", mode: "home-office", note: "Existing manual HOME" },
      ],
    }
    const annualResponse = await harness([], null, undefined, null, rows).read()
    const annualSummary = (annualResponse.annualSummaries as Array<Record<string, unknown>>).find(row => row.personId === PERSON)!
    const monthlyResponse = await harness([], null, undefined, null, rows, "monthly").readMonthly(2025, 9)
    const monthlySummary = (monthlyResponse.summaries as Array<{ person: { id: string }; codeTotals: Record<string, number>; balance: number }>).find(row => row.person.id === PERSON)!
    for (const totals of [annualSummary.codeTotals as Record<string, number>, monthlySummary.codeTotals]) {
      assert.equal(totals.HO, 0.5, "legacy whole-day HOME only counts the half not on annual leave")
      assert.equal(totals.ALS, 0.5)
    }
    assert.equal(annualSummary.closingBalanceUnits, 16.5)
    assert.equal(monthlySummary.balance, 16.5)
  })
}

test("annual totals read only the separate annual table and map a safe source-revision acknowledgement", async () => {
  const app = harness([annual])
  const response = await app.read()
  const summaries = response.annualSummaries as Array<Record<string, unknown>>
  const confirmation = summaries[0].confirmation as Record<string, unknown>
  assert.equal(confirmation.year, 2025)
  assert.equal(confirmation.confirmedSourceRevision, 7)
  assert.equal(confirmation.note, "Reviewed totals")
  assert.equal(response.annualConfirmationAvailable, true)
  assert.equal(Object.hasOwn(confirmation, "month"), false)
  assert.deepEqual(app.reads.filter((entry) => entry.table === "attendance_annual_confirmations"),
    [{ table: "attendance_annual_confirmations", filters: { year: 2025 } }])
})

test("a December monthly confirmation cannot manufacture an annual approval", async () => {
  const response = await harness().read()
  assert.ok((response.annualSummaries as Array<Record<string, unknown>>).every((summary) => summary.confirmation === null))
})

test("annual self-confirm permission requires a real linked identity and a closed year", async () => {
  const app = harness()
  const own = (await app.read()).annualSummaries as Array<Record<string, unknown>>
  assert.equal(own[0].canConfirm, true)
  assert.equal(own[1].canConfirm, false)
  for (const options of [{ adminUserId: null }, {}]) {
    assert.ok(((await app.read(2025, options)).annualSummaries as Array<Record<string, unknown>>).every((summary) => !summary.canConfirm))
  }
  assert.ok(((await app.read(2026, { canEdit: true })).annualSummaries as Array<Record<string, unknown>>).every((summary) => !summary.canConfirm))
  assert.ok(((await app.read(2025, { canEdit: true })).annualSummaries as Array<Record<string, unknown>>).every((summary) => summary.canConfirm))
})

test("annual storage errors and unsafe source revisions fail closed instead of inferring monthly data", async () => {
  await assert.rejects(harness([], { message: "synthetic annual outage" }).read(), /synthetic annual outage/)
  await assert.rejects(harness([{ ...annual, confirmed_source_revision: "9007199254740992" }]).read(), /source revision is invalid/)
  await assert.rejects(harness([{ ...annual, month: 12 }]).read(), /Annual confirmation record is invalid/)
})

test("pre-DDL all-time totals remain readable without querying a missing annual table or enabling confirmation", async () => {
  const app = harness([], null, { tables: [], appliedMigrations: [] })
  for (const canEdit of [false, true]) {
    const response = await app.read(2025, { adminUserId: USER, canEdit })
    assert.equal(response.annualConfirmationAvailable, false)
    assert.equal((response.people as unknown[]).length, 2)
    assert.ok((response.annualSummaries as Array<Record<string, unknown>>).every(summary => summary.confirmation === null && !summary.canConfirm))
  }
  assert.equal(app.reads.some(entry => entry.table === annualTable), false)
})

test("an unrelated later migration is not proof that annual confirmation is installed", async () => {
  const app = harness([], null, { tables: [], appliedMigrations: [{ version: "20271027023034", name: "unrelated_feature" }] })
  assert.equal((await app.read()).annualConfirmationAvailable, false)
  assert.equal(app.reads.some(entry => entry.table === annualTable), false)
})

test("annual capability metadata drift and failed reads are errors, never a December or disabled-feature fallback", async () => {
  for (const inventory of [null, {}, { tables: [annualTable], appliedMigrations: [] },
    { tables: [], appliedMigrations: [annualMigration] },
    { tables: [annualTable], appliedMigrations: [annualMigration], annualConfirmationColumns: [] }]) {
    const app = harness([], null, inventory)
    await assert.rejects(app.read(), /Backup attendance|Backup annual attendance/)
    assert.deepEqual(app.reads, [])
  }
  await assert.rejects(harness([], null, {}, "synthetic inventory outage").read(), /synthetic inventory outage/)
})
