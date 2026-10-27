import { ANNUAL_CONFIRMATION_MIGRATION, ATTENDANCE_BACKUP_SCHEMA } from "../../lib/backupAttendanceSchema.mjs"
export const annualTable = "attendance_annual_confirmations"
export const annualColumns = [
  ["confirmed_at", "timestamp with time zone", true], ["confirmed_by", "text", true],
  ["confirmed_source_revision", "bigint", true], ["created_at", "timestamp with time zone", false],
  ["created_by", "text", false], ["id", "uuid", false], ["note", "text", false],
  ["person_id", "uuid", false], ["status", "text", false], ["updated_at", "timestamp with time zone", false],
  ["updated_by", "text", false], ["year", "integer", false],
].map(([name, type, nullable]) => ({ name, type, nullable }))
export const annualMigration = { version: "20261027023034", name: ANNUAL_CONFIRMATION_MIGRATION }
export const annualSchema = { schema: ATTENDANCE_BACKUP_SCHEMA, appliedMigrations: [annualMigration], annualConfirmationColumns: annualColumns }
export const annualPersonId = "22222222-2222-4222-8222-222222222222"
export const annualConfirmation = { id: "33333333-3333-4333-8333-333333333333", person_id: annualPersonId, year: 2025,
  status: "confirmed", confirmed_at: "2026-01-01T00:00:00Z", confirmed_by: "Synthetic reviewer", confirmed_source_revision: 4,
  note: "", created_by: "Synthetic reviewer", updated_by: "Synthetic reviewer", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }
