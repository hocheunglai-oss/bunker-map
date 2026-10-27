import assert from "node:assert/strict"
import test from "node:test"
import { attendanceBackupSchemaFromArtifact, attendanceBackupSchemaFromInventory, attendanceBackupSchemaVersion, parseAttendanceBackupSchemaVersion, validateAttendanceBackupSchema } from "../lib/backupAttendanceSchema.mjs"
import { annualColumns, annualMigration, annualSchema, annualTable } from "./fixtures/backup-annual.mjs"
const unrelated = { version: "20991231235959", name: "unrelated_later_update" }
const sparse = { migrationHead: unrelated.version, tables: [], appliedMigrations: [unrelated] }
const installed = { ...sparse, tables: [annualTable], appliedMigrations: [annualMigration, unrelated], annualConfirmationColumns: annualColumns }
test("annual schema uses the exact migration name and observed table/columns, never a maximum timestamp", () => {
  for (const input of [sparse, { ...sparse, annualConfirmationColumns: [] }]) assert.equal(attendanceBackupSchemaVersion(attendanceBackupSchemaFromInventory(input)), "none")
  assert.deepEqual(attendanceBackupSchemaFromInventory(installed), annualSchema)
  assert.equal(attendanceBackupSchemaVersion(annualSchema), "annual-v1")
  assert.deepEqual(attendanceBackupSchemaFromInventory({ ...installed, appliedMigrations: [{ ...annualMigration, version: "20261028123456" }, unrelated] }).appliedMigrations, [{ ...annualMigration, version: "20261028123456" }], "hosted versions are preserved without assuming local timestamps")
})
test("claimed or installed capability cannot hide a dropped table, column drift, duplicate migration or missing evidence", () => {
  for (const input of [
    { ...sparse, tables: [annualTable] }, { ...installed, tables: [] },
    { ...installed, annualConfirmationColumns: undefined }, { ...installed, annualConfirmationColumns: annualColumns.slice(1) },
    { ...installed, annualConfirmationColumns: [...annualColumns].reverse() },
    { ...installed, annualConfirmationColumns: annualColumns.map(column => column.name === "confirmed_source_revision" ? { ...column, nullable: false } : column) },
    { ...installed, annualConfirmationColumns: annualColumns.map(column => column.name === "year" ? { ...column, type: "text" } : column) },
    { ...installed, appliedMigrations: [annualMigration, { ...annualMigration, version: "20261028123456" }] },
    { ...sparse, appliedMigrations: undefined }, { ...sparse, appliedMigrations: ["invalid"] },
    { ...sparse, annualConfirmationColumns: null },
  ]) assert.throws(() => attendanceBackupSchemaFromInventory(input), /attendance|annual/i)
})
test("artifact evidence is exact and historical no-capability artifacts remain readable at a higher unrelated head", () => {
  assert.equal(attendanceBackupSchemaVersion(attendanceBackupSchemaFromArtifact({ liveTables: [], registeredTables: [] })), "none")
  assert.deepEqual(attendanceBackupSchemaFromArtifact({ liveTables: [annualTable], attendanceSchema: annualSchema }), annualSchema)
  for (const input of [{ liveTables: [annualTable] }, { liveTables: [], registeredTables: [annualTable] }, { liveTables: [annualTable], attendanceSchema: null }, { liveTables: [], attendanceSchema: annualSchema }, { liveTables: [annualTable], attendanceSchema: { ...annualSchema, extra: true } }]) assert.throws(() => attendanceBackupSchemaFromArtifact(input), /attendance|annual/i)
  assert.throws(() => validateAttendanceBackupSchema({ ...annualSchema, appliedMigrations: [{ ...annualMigration, name: "unrelated" }] }, [annualTable]), /invalid/)
})
test("Drive marker is bounded and only undefined is an accepted historical omission", () => {
  for (const value of ["none", "annual-v1"]) assert.equal(parseAttendanceBackupSchemaVersion(value), value)
  assert.equal(parseAttendanceBackupSchemaVersion(undefined), "none")
  for (const value of [null, "", "annual-v2", 1, true]) assert.throws(() => parseAttendanceBackupSchemaVersion(value), /metadata/)
})
