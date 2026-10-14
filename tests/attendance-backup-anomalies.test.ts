import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
function load(file: string, start: string, end: string, result: string, args: string[] = [], values: unknown[] = []) {
  const content = source(file), from = content.indexOf(start), to = content.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `Missing production declaration in ${file}`)
  const code = transformSync(content.slice(from, to), { loader: "ts", format: "cjs", target: "node24" }).code
  return new Function(...args, `${code}; return ${result};`)(...values)
}

const sections = [
  "attendanceDingtalkPunchAnomalies",
  "attendanceDingtalkPunchAnomalyResolutions",
  "attendanceDingtalkMissingPunchAnomalies",
  "attendanceDingtalkMissingPunchResolutions",
]

test("backup, offline validator, and health require the private evidence from its migration head", () => {
  const exporter = load("app/api/backups/bunker-map-drive/route.ts",
    "const RETAINED_VERIFIED_BACKUP_COUNT", "function requireEnv", "PRIVATE_ATTENDANCE_SECTIONS") as Array<{ key: string; primaryKey: string }>
  assert.deepEqual(exporter.map(({ key }) => key), sections)
  assert.deepEqual(exporter.map(({ primaryKey }) => primaryKey), ["id", "anomaly_id", "id", "anomaly_id"])
  const health = load("lib/systemHealth.ts", "const BACKUP_FOLDER_NAME", "function requireEnv", "getBackupArtifactContract") as (head: string) => { requiredSectionKeys: string[]; registeredTables: string[] }
  const validator = load("scripts/validate-backup.mjs", "const MINIMUM_V2_MIGRATION_HEAD", "const TOP_LEVEL_KEYS", "getBackupContract") as (head: string) => { requiredSections: string[]; expectedRegisteredTables: string[] }
  for (const head of ["20261014044008", "20261014044009", "20261201000000"]) {
    const expected = head >= "20261014044009"
    for (const contract of [health(head).requiredSectionKeys, validator(head).requiredSections]) {
      for (const key of sections) assert.equal(contract.includes(key), expected)
    }
    assert.equal(health(head).registeredTables.some((name) => name.includes("attendance_dingtalk")), false,
      "private tables are exported by RPC, not counted as public inventory tables")
    assert.equal(validator(head).expectedRegisteredTables.some((name) => name.includes("attendance_dingtalk")), false)
  }
})

test("private export pages reject a missing, malformed, or reordered page", async () => {
  const stream = load("app/api/backups/bunker-map-drive/route.ts",
    "async function streamPrivateAttendanceRows", "async function getBackupInventory", "streamPrivateAttendanceRows",
    ["retrySupabaseRead", "BACKUP_EXPORT_PAGE_SIZE"], [(request: () => unknown) => request(), 2]) as
    (client: { rpc: (name: string, args: Record<string, unknown>) => unknown }, config: { key: string; primaryKey: string }, append: (rows: unknown[]) => Promise<void>) => Promise<void>
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"]
  const config = { key: sections[0], primaryKey: "id" }
  const calls: Array<Record<string, unknown>> = [], exported: unknown[] = []
  await stream({ rpc: (name, args) => {
    assert.equal(name, "get_attendance_dingtalk_anomaly_backup_page")
    calls.push(args)
    return ids.filter((id) => !args.p_after || id > String(args.p_after)).slice(0, 2).map((id) => ({ id }))
  } }, config, async (page) => { exported.push(...page) })
  assert.deepEqual(exported, ids.map((id) => ({ id })))
  assert.deepEqual(calls.map(({ p_after }) => p_after), [null, ids[1]])
  for (const bad of [null, {}, [{ id: "invalid" }], [{ id: ids[1] }, { id: ids[0] }]]) {
    await assert.rejects(stream({ rpc: () => bad }, config, async () => {}), /Invalid private attendance backup|Private attendance backup order/)
  }
})

test("offline validation preserves unresolved evidence and rejects confirmed or orphaned discrepancies", () => {
  const rows = (data: Record<string, unknown[]>, key: string) => Array.isArray(data[key]) ? data[key] : []
  const plain = (row: unknown): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row)
  const idSet = (data: Record<string, unknown[]>, key: string) => new Set(rows(data, key).filter(plain).map((row) => row.id))
  const validTime = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value))
  const validate = load("scripts/validate-backup.mjs", "function validateAttendanceDingtalkEvidence", "function validateSections", "validateAttendanceDingtalkEvidence",
    ["rows", "isPlainObject", "idSet", "isValidTimestamp", "ATTENDANCE_DINGTALK_ANOMALY_MIGRATION_HEAD"],
    [rows, plain, idSet, validTime, "20261014044009"]) as (data: Record<string, unknown[]>, head: string) => string[]
  const rawId = "11111111-1111-4111-8111-111111111111", personId = "22222222-2222-4222-8222-222222222222", anomalyId = "33333333-3333-4333-8333-333333333333"
  const evidence = {
    attendancePeople: [{ id: personId }],
    attendanceRawPunches: [{ id: rawId, person_id: personId, work_date: "2026-09-10" }],
    attendanceDingtalkPunchAnomalies: [{ id: anomalyId, existing_raw_punch_id: rawId,
      kind: "changed-fields", incoming_source_record_key: "a".repeat(64), incoming_source_record_id: "1",
      incoming_person_id: personId, incoming_dingtalk_user_id: "ding", incoming_check_type: "OffDuty",
      incoming_punch_time: "2026-09-10T09:00:00Z", incoming_work_date: "2026-09-10",
      first_seen_at: "2026-10-14T00:00:00Z" }],
    attendanceDingtalkPunchAnomalyResolutions: [] as unknown[],
    attendanceDingtalkMissingPunchAnomalies: [] as unknown[],
    attendanceDingtalkMissingPunchResolutions: [] as unknown[],
    attendanceMonthlyConfirmations: [{ person_id: personId, year: 2026, month: 9, status: "pending" }],
  }
  assert.deepEqual(validate(evidence, "20261014044009"), [])
  assert.deepEqual(validate(evidence, "20261014044008"), [])
  const confirmed = { ...evidence, attendanceMonthlyConfirmations: [{ ...evidence.attendanceMonthlyConfirmations[0], status: "confirmed" }] }
  assert.match(validate(confirmed, "20261014044009").join(" "), /open correction has a confirmed month/)
  const resolution = { anomaly_id: anomalyId, resolved_at: "2026-10-14T01:00:00Z", resolved_by: "reviewer", resolution_note: "Reviewed against source" }
  assert.deepEqual(validate({ ...confirmed, attendanceDingtalkPunchAnomalyResolutions: [resolution] }, "20261014044009"), [])
  assert.match(validate({ ...evidence, attendanceDingtalkPunchAnomalyResolutions: [{ ...resolution, anomaly_id: rawId }] }, "20261014044009").join(" "), /orphaned resolution/)
  assert.match(validate({ ...evidence, attendanceRawPunches: [] }, "20261014044009").join(" "), /incomplete punch-correction evidence/)
  const omission = { id: anomalyId, existing_raw_punch_id: rawId,
    observed_window_from: "2026-09-10T00:00:00Z", observed_window_to: "2026-09-11T00:00:00Z",
    first_seen_at: "2026-10-14T00:00:00Z" }
  const missingEvidence = { ...evidence, attendanceDingtalkPunchAnomalies: [],
    attendanceDingtalkMissingPunchAnomalies: [omission] }
  assert.deepEqual(validate(missingEvidence, "20261014044009"), [])
  assert.match(validate({ ...missingEvidence, attendanceMonthlyConfirmations: confirmed.attendanceMonthlyConfirmations }, "20261014044009").join(" "), /open omission has a confirmed month/)
  assert.deepEqual(validate({ ...missingEvidence, attendanceDingtalkMissingPunchResolutions: [resolution] }, "20261014044009"), [])
})
