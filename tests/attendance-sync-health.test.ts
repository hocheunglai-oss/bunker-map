import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"
import ts from "typescript"
import { hasCyDingTalkAutoConfirmException, hasJzDingTalkAutoConfirmException } from "../lib/attendanceAutoConfirmPolicy"
import { hktDateFromTimestamp } from "../lib/attendanceRules"

// Execute the actual health-check function, with read-only provider fixtures.
// Do not replace the real identity-pinned exception policy with a test stub.
const source = ts.createSourceFile("systemHealth.ts", readFileSync(new URL("../lib/systemHealth.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true)
const declaration = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "checkAttendanceSync")
assert.ok(declaration)
const compiled = transformSync(declaration.getText(source), { loader: "ts", format: "cjs", target: "node24" }).code
type Row = Record<string, unknown>
type Result = { status: string; message: string; details: Record<string, string | number | boolean | null> }
const current = Date.parse("2026-10-26T11:16:00.000Z")
const ordinary = Array.from({ length: 8 }, (_, index) => ({
  id: `ordinary-${index}`, admin_user_id: `admin-${index}`, staff_code: `P${index}`, dingtalk_user_id: `ding-${index}`,
}))
const cy = { id: "e2cd1a9d-95c1-4292-940a-884537f35cf3", admin_user_id: null, staff_code: "CY", dingtalk_user_id: null }
const jz = { id: "50988b84-4d6c-4089-9112-d6bfad1ed72d", admin_user_id: "3cf2bff0-4eda-4c36-8827-a8f7be0c764d", staff_code: "JZ", dingtalk_user_id: null }

async function invoke(input: {
  people?: Row[]; activeCount?: number | null; groupCount?: number; now?: number; configured?: boolean
  latest?: Row | null; queryError?: Error
} = {}) {
  const people = input.people ?? [...ordinary, cy, jz], now = input.now ?? current
  const latest = input.latest === undefined ? {
    started_at: new Date(now - 10 * 60_000).toISOString(), completed_at: new Date(now - 9 * 60_000).toISOString(),
    status: "succeeded", people_requested: 8, records_fetched: 8, records_inserted: 0,
  } : input.latest
  const reads: string[] = []
  class Query {
    constructor(readonly table: string) { reads.push(table) }
    select(fields: string, options?: { count?: string; head?: boolean }) {
      if (this.table === "attendance_people") {
        assert.equal(fields, "id,admin_user_id,staff_code,dingtalk_user_id")
        assert.equal(options?.count, "exact"); assert.notEqual(options?.head, true)
      }
      return this
    }
    eq(column: string, value: unknown) { assert.equal(this.table, "attendance_people"); assert.equal(column, "is_active"); assert.equal(value, true); return this }
    is(column: string, value: unknown) { assert.equal(this.table, "attendance_team_assignments"); assert.equal(column, "effective_to"); assert.equal(value, null); return this }
    order() { return this }
    limit(value: number) { assert.equal(value, this.table === "attendance_people" ? 1000 : 1); return this }
    maybeSingle() { return this }
    then(resolve: (value: { data: unknown; count: number | null; error: Error | null }) => unknown, reject?: (error: unknown) => unknown) {
      const data = this.table === "attendance_people" ? people : this.table === "attendance_sync_runs" ? latest : null
      const count = this.table === "attendance_people" ? input.activeCount === undefined ? people.length : input.activeCount
        : this.table === "attendance_team_assignments" ? input.groupCount ?? people.length : null
      return Promise.resolve({ data, count, error: input.queryError ?? null }).then(resolve, reject)
    }
  }
  const check = new Function("getSupabaseClient", "hasCyDingTalkAutoConfirmException", "hasJzDingTalkAutoConfirmException", "hktDateFromTimestamp", "Date", "process", "SUPABASE_HEALTH_PAGE_SIZE",
    `${compiled}; return checkAttendanceSync`)(
    () => ({ from: (table: string) => new Query(table) }), hasCyDingTalkAutoConfirmException, hasJzDingTalkAutoConfirmException,
    hktDateFromTimestamp, { now: () => now, parse: Date.parse },
    { env: input.configured === false ? {} : { DINGTALK_CLIENT_ID: "synthetic-client", DINGTALK_CLIENT_SECRET: "synthetic-secret" } }, 1000,
  ) as () => Promise<Result>
  return { result: await check(), reads }
}

test("the real checker distinguishes ten active people, eight mappings and two approved exceptions", async () => {
  const { result, reads } = await invoke()
  assert.equal(result.status, "ok")
  assert.equal(result.details.activePeople, 10); assert.equal(result.details.mappedPeople, 8)
  assert.equal(result.details.approvedMappingExceptions, 2); assert.equal(result.details.missingRequiredMappings, 0)
  assert.equal(reads.filter(table => table === "attendance_people").length, 1)
})

test("an ordinary missing mapping still warns even alongside both approved exceptions", async () => {
  const { result } = await invoke({ people: [...ordinary, cy, jz, { ...ordinary[0], id: "missing-person", dingtalk_user_id: null }] })
  assert.equal(result.status, "warning"); assert.match(result.message, /1 active people need a DingTalk user mapping/)
  assert.equal(result.details.approvedMappingExceptions, 2); assert.equal(result.details.missingRequiredMappings, 1)
})

test("staff codes alone, reassigned identities and JZ's wrong admin cannot inherit an exception", async () => {
  for (const person of [
    { ...cy, id: "not-cy" }, { ...cy, staff_code: "OTHER" },
    { ...jz, id: "not-jz" }, { ...jz, admin_user_id: "different-admin" }, { ...jz, staff_code: "OTHER" },
  ]) {
    const { result } = await invoke({ people: [person] })
    assert.equal(result.status, "warning"); assert.equal(result.details.approvedMappingExceptions, 0)
    assert.equal(result.details.missingRequiredMappings, 1)
  }
})

test("effective October policy follows the Hong Kong month boundary, not UTC month", async () => {
  const before = await invoke({ people: [cy, jz], now: Date.parse("2026-09-30T15:59:59.999Z") })
  const after = await invoke({ people: [cy, jz], now: Date.parse("2026-09-30T16:00:00.000Z") })
  assert.equal(before.result.details.approvedMappingExceptions, 0); assert.equal(before.result.details.missingRequiredMappings, 2)
  assert.equal(after.result.details.approvedMappingExceptions, 2); assert.equal(after.result.details.missingRequiredMappings, 0)
  assert.equal(after.result.status, "ok")
})

test("approved policy remains ongoing without changing any earlier month's confirmation", async () => {
  const { result } = await invoke({ now: Date.parse("2027-01-01T00:00:00.000Z") })
  assert.equal(result.status, "ok"); assert.equal(result.details.approvedMappingExceptions, 2)
})

test("blank ordinary DingTalk IDs remain genuine missing mappings", async () => {
  const { result } = await invoke({ people: [
    { ...ordinary[0], dingtalk_user_id: "" }, { ...ordinary[1], dingtalk_user_id: "   " },
    { ...cy, dingtalk_user_id: " " }, jz,
  ] })
  assert.equal(result.status, "warning"); assert.equal(result.details.mappedPeople, 0)
  assert.equal(result.details.approvedMappingExceptions, 2); assert.equal(result.details.missingRequiredMappings, 2)
})

test("actually mapped exception staff stay in the mapped count, not the unmapped exception count", async () => {
  const { result } = await invoke({ people: [{ ...cy, dingtalk_user_id: "ding-cy" }, { ...jz, dingtalk_user_id: "ding-jz" }] })
  assert.equal(result.status, "ok"); assert.equal(result.details.mappedPeople, 2)
  assert.equal(result.details.approvedMappingExceptions, 0); assert.equal(result.details.missingRequiredMappings, 0)
})

test("missing credentials still warn when every unmapped person has an approved exception", async () => {
  const { result } = await invoke({ configured: false })
  assert.equal(result.status, "warning"); assert.match(result.message, /DingTalk credentials are not configured/)
})

test("group-assignment mismatches remain visible", async () => {
  const { result } = await invoke({ groupCount: 9 })
  assert.equal(result.status, "warning"); assert.match(result.message, /current group history do not match/)
})

test("failed and partial syncs remain warnings rather than being hidden by exceptions", async () => {
  for (const status of ["failed", "partial"]) {
    const { result } = await invoke({ latest: { status, started_at: new Date(current - 1000).toISOString() } })
    assert.equal(result.status, "warning"); assert.match(result.message, new RegExp(`latest automatic sync is ${status}`))
  }
})

test("stale and never-run syncs remain warnings for mapped staff", async () => {
  const stale = await invoke({ latest: { status: "succeeded", started_at: new Date(current - 61 * 60_000).toISOString() } })
  const never = await invoke({ latest: null })
  assert.equal(stale.result.status, "warning"); assert.match(stale.result.message, /older than one hour/)
  assert.equal(never.result.status, "warning"); assert.match(never.result.message, /automatic sync has not run yet/)
})

test("an empty active roster still warns", async () => {
  const { result } = await invoke({ people: [], latest: null })
  assert.equal(result.status, "warning"); assert.match(result.message, /no active attendance people are configured/)
})

test("truncated or uncounted active-person reads cannot produce a false green check", async () => {
  await assert.rejects(invoke({ activeCount: 1001 }), /mapping inventory is incomplete/)
  await assert.rejects(invoke({ activeCount: null }), /mapping inventory is incomplete/)
})

test("duplicate or malformed identities cannot be treated as approved exceptions", async () => {
  for (const people of [[cy, cy], [{ ...jz, admin_user_id: undefined }], [{ ...cy, staff_code: null }]]) {
    await assert.rejects(invoke({ people }), /mapping inventory could not be verified/)
  }
})

test("provider read errors are propagated rather than presented as healthy", async () => {
  await assert.rejects(invoke({ queryError: new Error("synthetic provider unavailable") }), /synthetic provider unavailable/)
})
