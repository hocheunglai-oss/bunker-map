import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { makeBackupFixture, rehashBackupFixture } from "./fixtures/backup-validation.mjs"
import { annualConfirmation, annualPersonId, annualSchema, annualTable } from "./fixtures/backup-annual.mjs"
const root = new URL("../", import.meta.url)
function fixture() {
  const backup = makeBackupFixture("20991231235959")
  backup.databaseInventory.liveTables = [...backup.databaseInventory.liveTables, annualTable].sort()
  backup.databaseInventory.registeredTables = [...backup.databaseInventory.registeredTables, annualTable].sort()
  backup.databaseInventory.attendanceSchema = structuredClone(annualSchema)
  backup.data.attendanceAnnualConfirmations = [structuredClone(annualConfirmation)]
  backup.data.attendancePeople = [{ id: annualPersonId }, { id: "44444444-4444-4444-8444-444444444444" }]
  return backup
}
function validate(backup) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fcuno-annual-validation-")), file = path.join(directory, "synthetic.json")
  try {
    fs.writeFileSync(file, JSON.stringify(rehashBackupFixture(backup)), { mode: 0o600 })
    const result = spawnSync(process.execPath, ["--max-old-space-size=256", new URL("scripts/validate-backup.mjs", root).pathname, file], { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 })
    return { status: result.status, output: result.stdout + result.stderr }
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}
test("actual disk-backed CLI validates annual and pending rows and preserves historical sparse higher-head backups", () => {
  for (const row of [annualConfirmation, { ...annualConfirmation, status: "pending", confirmed_at: null, confirmed_by: null, confirmed_source_revision: null },
    { ...annualConfirmation, confirmed_source_revision: "9223372036854775807" }]) {
    const backup = fixture(); backup.data.attendanceAnnualConfirmations = [row]
    const result = validate(backup); assert.equal(result.status, 0, result.output)
  }
  const old = validate(makeBackupFixture("20991231235959")); assert.equal(old.status, 0, old.output)
})
test("actual CLI rejects incomplete annual capability, absent section and invalid person/year, shape or source revision", () => {
  const edits = [
    backup => { delete backup.databaseInventory.attendanceSchema },
    backup => { backup.databaseInventory.attendanceSchema.annualConfirmationColumns.pop() },
    backup => { delete backup.data.attendanceAnnualConfirmations },
    backup => { backup.data.attendanceAnnualConfirmations[0].person_id = "55555555-5555-4555-8555-555555555555" },
    ...[{ year: 1999 }, { year: "2025" }, { year: 2201 }, { status: "unknown" }, { month: 12 }, { confirmed_at: null }, { confirmed_by: " " },
      { confirmed_source_revision: null }, { confirmed_source_revision: -1 }, { confirmed_source_revision: 9007199254740992 },
      { confirmed_source_revision: "01" }, { confirmed_source_revision: "9223372036854775808" }, { created_by: "" }, { updated_at: null },
      { confirmed_at: "2025" }, { created_at: "2025-02-30T00:00:00Z" },
      { status: "pending" }].map(patch => backup => Object.assign(backup.data.attendanceAnnualConfirmations[0], patch)),
    backup => { backup.data.attendanceAnnualConfirmations.push({ ...annualConfirmation, id: "55555555-5555-4555-8555-555555555555" }) },
  ]
  for (const edit of edits) {
    const backup = fixture(); edit(backup)
    const result = validate(backup); assert.equal(result.status, 1, result.output)
    assert.match(result.output, /annual|attendanceAnnualConfirmations/i)
  }
})
test("annual confirmations reject unresolved correction evidence on either raw or incoming person/year and missing raw person/year", () => {
  const rawId = "55555555-5555-4555-8555-555555555555", anomalyId = "66666666-6666-4666-8666-666666666666", other = "44444444-4444-4444-8444-444444444444"
  const changed = { id: anomalyId, existing_raw_punch_id: rawId, kind: "changed-user", incoming_source_record_key: "a".repeat(64), incoming_source_record_id: "synthetic",
    incoming_person_id: other, incoming_dingtalk_user_id: "synthetic", incoming_check_type: "OffDuty", incoming_punch_time: "2024-12-31T09:00:00Z", incoming_work_date: "2024-12-31", first_seen_at: "2026-01-01T00:00:00Z" }
  for (const side of ["raw", "incoming", "missing"]) {
    const backup = fixture()
    backup.data.attendanceRawPunches = [{ id: rawId, person_id: side === "incoming" ? other : annualPersonId, work_date: side === "incoming" ? "2024-12-31" : "2025-12-31" }]
    if (side === "missing") backup.data.attendanceDingtalkMissingPunchAnomalies = [{ id: anomalyId, existing_raw_punch_id: rawId,
      observed_window_from: "2025-12-31T00:00:00Z", observed_window_to: "2026-01-01T00:00:00Z", first_seen_at: "2026-01-01T00:00:00Z" }]
    else backup.data.attendanceDingtalkPunchAnomalies = [{ ...changed, ...(side === "incoming" ? { incoming_person_id: annualPersonId, incoming_work_date: "2025-01-01" } : {}) }]
    let result = validate(backup); assert.equal(result.status, 1, result.output); assert.match(result.output, /open (?:correction|omission) has a confirmed year/)
    const section = side === "missing" ? "attendanceDingtalkMissingPunchResolutions" : "attendanceDingtalkPunchAnomalyResolutions"
    backup.data[section] = [{ anomaly_id: anomalyId, resolved_at: "2026-01-01T00:00:00Z", resolved_by: "Synthetic reviewer", resolution_note: "Reviewed" }]
    result = validate(backup); assert.equal(result.status, 0, result.output)
  }
})
