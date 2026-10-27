// Exact capability evidence shared by export, health and offline validation.
// A later unrelated migration must never introduce an annual backup section.
export const ATTENDANCE_BACKUP_SCHEMA = "fcuno.attendance-backup-schema/v1"
export const ANNUAL_CONFIRMATION_MIGRATION = "separate_attendance_annual_confirmations"
const ANNUAL_TABLE = "attendance_annual_confirmations"
const ANNUAL_COLUMNS = [
  { name: "confirmed_at", type: "timestamp with time zone", nullable: true },
  { name: "confirmed_by", type: "text", nullable: true },
  { name: "confirmed_source_revision", type: "bigint", nullable: true },
  { name: "created_at", type: "timestamp with time zone", nullable: false },
  { name: "created_by", type: "text", nullable: false },
  { name: "id", type: "uuid", nullable: false },
  { name: "note", type: "text", nullable: false },
  { name: "person_id", type: "uuid", nullable: false },
  { name: "status", type: "text", nullable: false },
  { name: "updated_at", type: "timestamp with time zone", nullable: false },
  { name: "updated_by", type: "text", nullable: false },
  { name: "year", type: "integer", nullable: false },
]
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value) }
function exactKeys(value, expected) {
  return record(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
}
function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string") && JSON.stringify(value) === JSON.stringify([...new Set(value)].sort())
}
function migrations(value) {
  return Array.isArray(value) && value.every((item) => exactKeys(item, ["version", "name"]) && typeof item.version === "string" && /^\d{14}$/.test(item.version) && (item.name === null || typeof item.name === "string"))
    && strings(value.map((item) => item.version))
}
export function validateAttendanceBackupSchema(value, liveTables) {
  if (!exactKeys(value, ["schema", "appliedMigrations", "annualConfirmationColumns"]) || value.schema !== ATTENDANCE_BACKUP_SCHEMA
    || !migrations(value.appliedMigrations) || value.appliedMigrations.length > 1
    || value.appliedMigrations.some((migration) => migration.name !== ANNUAL_CONFIRMATION_MIGRATION)
    || !strings(liveTables) || !Array.isArray(value.annualConfirmationColumns)) throw new Error("Backup attendance schema evidence is invalid.")
  const installed = value.appliedMigrations.length === 1
  if (liveTables.includes(ANNUAL_TABLE) !== installed) throw new Error("Backup annual attendance table does not match its exact applied migration.")
  const expected = installed ? ANNUAL_COLUMNS : []
  if (value.annualConfirmationColumns.length !== expected.length || value.annualConfirmationColumns.some((column, index) =>
    !exactKeys(column, ["name", "type", "nullable"]) || column.name !== expected[index].name || column.type !== expected[index].type || column.nullable !== expected[index].nullable)) {
    throw new Error("Backup annual attendance columns do not match their exact applied migration.")
  }
  return { schema: ATTENDANCE_BACKUP_SCHEMA, appliedMigrations: value.appliedMigrations.map((migration) => ({ ...migration })), annualConfirmationColumns: value.annualConfirmationColumns.map((column) => ({ ...column })) }
}
export function attendanceBackupSchemaFromInventory(inventory) {
  if (!record(inventory) || !migrations(inventory.appliedMigrations)) throw new Error("Backup attendance inventory needs exact applied-migration evidence.")
  const appliedMigrations = inventory.appliedMigrations.filter((migration) => migration.name === ANNUAL_CONFIRMATION_MIGRATION)
  // Older RPCs have no column key. Accept only the proven pre-capability case;
  // a claimed migration or installed table still requires its physical columns.
  const columns = !Object.hasOwn(inventory, "annualConfirmationColumns") && appliedMigrations.length === 0 ? [] : inventory.annualConfirmationColumns
  return validateAttendanceBackupSchema({ schema: ATTENDANCE_BACKUP_SCHEMA, appliedMigrations, annualConfirmationColumns: columns }, inventory.tables)
}
export function attendanceBackupSchemaFromArtifact(inventory) {
  if (!record(inventory)) throw new Error("Backup database inventory is invalid.")
  if (Object.hasOwn(inventory, "attendanceSchema")) return validateAttendanceBackupSchema(inventory.attendanceSchema, inventory.liveTables)
  if (!strings(inventory.liveTables) || inventory.liveTables.includes(ANNUAL_TABLE) || Array.isArray(inventory.registeredTables) && inventory.registeredTables.includes(ANNUAL_TABLE)) {
    throw new Error("Backup annual attendance export has no exact schema evidence.")
  }
  return { schema: ATTENDANCE_BACKUP_SCHEMA, appliedMigrations: [], annualConfirmationColumns: [] }
}
export function attendanceBackupSchemaVersion(schema) { return schema.appliedMigrations.length === 1 ? "annual-v1" : "none" }
export function parseAttendanceBackupSchemaVersion(value) {
  if (value === undefined) return "none" // Historical Drive metadata only.
  if (!["none", "annual-v1"].includes(value)) throw new Error("Backup attendance schema metadata is invalid.")
  return value
}
