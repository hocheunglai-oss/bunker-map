export type AttendanceBackupSchema = {
  schema: "fcuno.attendance-backup-schema/v1"
  appliedMigrations: Array<{ version: string; name: string }>
  annualConfirmationColumns: Array<{ name: string; type: string; nullable: boolean }>
}
export type AttendanceBackupSchemaVersion = "none" | "annual-v1"
export const ATTENDANCE_BACKUP_SCHEMA: "fcuno.attendance-backup-schema/v1"
export const ANNUAL_CONFIRMATION_MIGRATION: "separate_attendance_annual_confirmations"
export function validateAttendanceBackupSchema(value: unknown, liveTables: unknown): AttendanceBackupSchema
export function attendanceBackupSchemaFromInventory(inventory: unknown): AttendanceBackupSchema
export function attendanceBackupSchemaFromArtifact(inventory: unknown): AttendanceBackupSchema
export function attendanceBackupSchemaVersion(schema: AttendanceBackupSchema): AttendanceBackupSchemaVersion
export function parseAttendanceBackupSchemaVersion(value: unknown): AttendanceBackupSchemaVersion
