import assert from "node:assert/strict"
import test from "node:test"
import { CREATION_MIGRATION, RECOVERY_MIGRATION, PRICING_BACKUP_SCHEMA, parsePricingBackupSchemaVersion, pricingBackupSchemaFromArtifact, pricingBackupSchemaFromInventory, pricingBackupSchemaVersion, validatePricingBackupSchema } from "../lib/backupPricingSchema.mjs"

const table = "price_setter_creation_receipts"
const base = [
  { name: "created_at", type: "timestamp with time zone", nullable: false },
  { name: "kind", type: "text", nullable: false },
  { name: "port_id", type: "uuid", nullable: false },
  { name: "request_id", type: "uuid", nullable: false },
]
const recovery = [{ name: "acknowledged_at", type: "timestamp with time zone", nullable: true }, { name: "actor_id", type: "uuid", nullable: true }, ...base]
const input = (names = [], columns = [], tables = []) => ({ migrationHead: "20991231235959", appliedMigrations: [...names.map((name, index) => ({ version: `2098010100000${index}`, name })), { version: "20991231235959", name: "unrelated_later_update" }], receiptColumns: columns, tables })

test("later unrelated migrations never imply the receipt table or recovery columns were installed", () => {
  const absent = pricingBackupSchemaFromInventory(input())
  assert.equal(pricingBackupSchemaVersion(absent), "none")
  const initial = pricingBackupSchemaFromInventory(input([CREATION_MIGRATION], base, [table]))
  assert.equal(pricingBackupSchemaVersion(initial), "creation-v1")
  const modern = pricingBackupSchemaFromInventory(input([CREATION_MIGRATION, RECOVERY_MIGRATION], recovery, [table]))
  assert.equal(pricingBackupSchemaVersion(modern), "recovery-v2")
  assert.deepEqual(modern.appliedMigrations.map((migration) => migration.name), [CREATION_MIGRATION, RECOVERY_MIGRATION], "artifact evidence keeps exact stable names and fresh hosted versions, not local timestamp assumptions or an unrelated maximum")
})

test("installed-but-missing table, missing recovery columns, unexpected table and drifted types/nullability fail closed", () => {
  for (const broken of [
    input([CREATION_MIGRATION]), input([], base, [table]),
    input([RECOVERY_MIGRATION], recovery, [table]),
    input([CREATION_MIGRATION, RECOVERY_MIGRATION], base, [table]),
    input([CREATION_MIGRATION], recovery, [table]),
    input([CREATION_MIGRATION], base.map((column) => column.name === "port_id" ? { ...column, type: "text" } : column), [table]),
    input([CREATION_MIGRATION], base.map((column) => column.name === "kind" ? { ...column, nullable: true } : column), [table]),
    input([CREATION_MIGRATION], [...base, { name: "unexpected", type: "text", nullable: true }], [table]),
  ]) assert.throws(() => pricingBackupSchemaFromInventory(broken), /Backup pricing/)
  const duplicateName = input([CREATION_MIGRATION, CREATION_MIGRATION], base, [table])
  assert.throws(() => pricingBackupSchemaFromInventory(duplicateName), /invalid/, "ambiguous duplicate capability names cannot certify a schema")
  for (const malformed of [{}, { ...input(), appliedMigrations: undefined }, { ...input(), appliedMigrations: ["bad"] }, { ...input(), appliedMigrations: [{ version: "20991231235959", name: null }, { version: "20991231235959", name: null }] }]) {
    assert.throws(() => pricingBackupSchemaFromInventory(malformed), /exact applied-migration evidence/)
  }
})

test("stable names retain exact fresh hosted versions even when creation and recovery are applied out of local timestamp order", () => {
  const inventory = input([RECOVERY_MIGRATION, CREATION_MIGRATION], recovery, [table])
  const proven = pricingBackupSchemaFromInventory(inventory)
  assert.equal(pricingBackupSchemaVersion(proven), "recovery-v2")
  assert.deepEqual(proven.appliedMigrations, inventory.appliedMigrations.slice(0, 2))
  assert.deepEqual(pricingBackupSchemaFromArtifact({ liveTables: [table], pricingSchema: proven }), proven)
})

test("artifact capability evidence is exact, while historical no-receipts artifacts remain valid despite a later sparse head", () => {
  const legacy = { liveTables: [], registeredTables: [] }
  assert.equal(pricingBackupSchemaVersion(pricingBackupSchemaFromArtifact(legacy)), "none")
  const modern = pricingBackupSchemaFromInventory(input([CREATION_MIGRATION, RECOVERY_MIGRATION], recovery, [table]))
  assert.deepEqual(pricingBackupSchemaFromArtifact({ liveTables: [table], pricingSchema: modern }), modern)
  for (const invalid of [
    { liveTables: [table] }, { ...legacy, registeredTables: [table] },
    { ...legacy, pricingSchema: null },
    { liveTables: [], pricingSchema: modern },
    { liveTables: [table], pricingSchema: { ...modern, unexpected: true } },
    { liveTables: [table], pricingSchema: { ...modern, receiptColumns: base } },
  ]) assert.throws(() => pricingBackupSchemaFromArtifact(invalid), /Backup pricing/)
  assert.throws(() => validatePricingBackupSchema({ schema: PRICING_BACKUP_SCHEMA, appliedMigrations: ["20991231235959"], receiptColumns: [] }, []), /invalid/)
})

test("Drive metadata marker distinguishes proven receipt schemas and explicitly permits only absent historical marker", () => {
  for (const value of ["none", "creation-v1", "recovery-v2"]) assert.equal(parsePricingBackupSchemaVersion(value), value)
  assert.equal(parsePricingBackupSchemaVersion(undefined), "none")
  for (const value of [null, "", "true", "future-v3", 1]) assert.throws(() => parsePricingBackupSchemaVersion(value), /invalid/)
})
