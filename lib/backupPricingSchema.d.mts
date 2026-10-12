export type PricingBackupSchema = {
  schema: "fcuno.pricing-backup-schema/v1"
  appliedMigrations: Array<{ version: string; name: string }>
  receiptColumns: Array<{ name: string; type: string; nullable: boolean }>
}
export type PricingBackupSchemaVersion = "none" | "creation-v1" | "recovery-v2"
export const PRICING_BACKUP_SCHEMA: "fcuno.pricing-backup-schema/v1"
export const CREATION_MIGRATION: "idempotent_price_setter_port_creation"
export const RECOVERY_MIGRATION: "durable_price_setter_creation_recovery"
export function validatePricingBackupSchema(value: unknown, liveTables: unknown): PricingBackupSchema
export function pricingBackupSchemaFromInventory(inventory: unknown): PricingBackupSchema
export function pricingBackupSchemaFromArtifact(inventory: unknown): PricingBackupSchema
export function pricingBackupSchemaVersion(schema: PricingBackupSchema): PricingBackupSchemaVersion
export function parsePricingBackupSchemaVersion(value: unknown): PricingBackupSchemaVersion
