// Shared by the online exporter/health checks and the dependency-free offline
// validator. A later unrelated migration is not proof that pricing was installed.
export const PRICING_BACKUP_SCHEMA = "fcuno.pricing-backup-schema/v1"
export const CREATION_MIGRATION = "idempotent_price_setter_port_creation"
export const RECOVERY_MIGRATION = "durable_price_setter_creation_recovery"
const PRICING_MIGRATIONS = [CREATION_MIGRATION, RECOVERY_MIGRATION]
const RECEIPT_TABLE = "price_setter_creation_receipts"
const BASE_COLUMNS = [
  { name: "created_at", type: "timestamp with time zone", nullable: false },
  { name: "kind", type: "text", nullable: false },
  { name: "port_id", type: "uuid", nullable: false },
  { name: "request_id", type: "uuid", nullable: false },
]
const RECOVERY_COLUMNS = [
  { name: "acknowledged_at", type: "timestamp with time zone", nullable: true },
  { name: "actor_id", type: "uuid", nullable: true },
  ...BASE_COLUMNS,
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
function applied(value, name) { return value.some((item) => item.name === name) }

export function validatePricingBackupSchema(value, liveTables) {
  if (!exactKeys(value, ["schema", "appliedMigrations", "receiptColumns"]) || value.schema !== PRICING_BACKUP_SCHEMA
    || !migrations(value.appliedMigrations) || value.appliedMigrations.some((migration) => !PRICING_MIGRATIONS.includes(migration.name))
    || new Set(value.appliedMigrations.map((migration) => migration.name)).size !== value.appliedMigrations.length
    || !strings(liveTables) || !Array.isArray(value.receiptColumns)) throw new Error("Backup pricing schema evidence is invalid.")
  const creation = applied(value.appliedMigrations, CREATION_MIGRATION)
  const recovery = applied(value.appliedMigrations, RECOVERY_MIGRATION)
  if (recovery && !creation) throw new Error("Backup pricing recovery migration has no creation migration.")
  if (liveTables.includes(RECEIPT_TABLE) !== creation) throw new Error("Backup pricing receipt table does not match its exact applied migration.")
  const expected = recovery ? RECOVERY_COLUMNS : creation ? BASE_COLUMNS : []
  if (value.receiptColumns.length !== expected.length || value.receiptColumns.some((column, index) =>
    !exactKeys(column, ["name", "type", "nullable"]) || column.name !== expected[index].name || column.type !== expected[index].type || column.nullable !== expected[index].nullable)) {
    throw new Error("Backup pricing receipt columns do not match their exact applied migrations.")
  }
  return { schema: PRICING_BACKUP_SCHEMA, appliedMigrations: value.appliedMigrations.map((migration) => ({ ...migration })), receiptColumns: value.receiptColumns.map((column) => ({ ...column })) }
}

export function pricingBackupSchemaFromInventory(inventory) {
  if (!record(inventory) || !migrations(inventory.appliedMigrations)) {
    throw new Error("Backup inventory needs exact applied-migration evidence. Update the inventory function before exporting.")
  }
  return validatePricingBackupSchema({ schema: PRICING_BACKUP_SCHEMA, appliedMigrations: inventory.appliedMigrations.filter((migration) => PRICING_MIGRATIONS.includes(migration.name)), receiptColumns: inventory.receiptColumns }, inventory.tables)
}

export function pricingBackupSchemaFromArtifact(inventory) {
  if (!record(inventory)) throw new Error("Backup database inventory is invalid.")
  if (Object.hasOwn(inventory, "pricingSchema")) return validatePricingBackupSchema(inventory.pricingSchema, inventory.liveTables)
  // Historical artifacts had no pricing receipts. Do not retrofit newer live
  // migration dates onto an older artifact, or accept unproven receipt exports.
  if (!strings(inventory.liveTables) || inventory.liveTables.includes(RECEIPT_TABLE) || Array.isArray(inventory.registeredTables) && inventory.registeredTables.includes(RECEIPT_TABLE)) {
    throw new Error("Backup pricing receipt export has no exact schema evidence.")
  }
  return { schema: PRICING_BACKUP_SCHEMA, appliedMigrations: [], receiptColumns: [] }
}

export function pricingBackupSchemaVersion(schema) {
  return applied(schema.appliedMigrations, RECOVERY_MIGRATION) ? "recovery-v2" : applied(schema.appliedMigrations, CREATION_MIGRATION) ? "creation-v1" : "none"
}

export function parsePricingBackupSchemaVersion(value) {
  if (value === undefined) return "none" // Historical Drive metadata only.
  if (!["none", "creation-v1", "recovery-v2"].includes(value)) throw new Error("Backup pricing schema metadata is invalid.")
  return value
}
