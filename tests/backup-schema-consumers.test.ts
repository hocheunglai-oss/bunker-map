import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"
import { CREATION_MIGRATION, RECOVERY_MIGRATION, parsePricingBackupSchemaVersion, pricingBackupSchemaFromArtifact, pricingBackupSchemaFromInventory, pricingBackupSchemaVersion } from "../lib/backupPricingSchema.mjs"

const exporter = readFileSync(new URL("../app/api/backups/bunker-map-drive/route.ts", import.meta.url), "utf8")
const health = readFileSync(new URL("../lib/systemHealth.ts", import.meta.url), "utf8")
const validator = readFileSync(new URL("../scripts/validate-backup.mjs", import.meta.url), "utf8")
const sha = "ab".repeat(32), head = "20991231235959"
const receiptTable = "price_setter_creation_receipts"
const baseColumns = [
  { name: "created_at", type: "timestamp with time zone", nullable: false },
  { name: "kind", type: "text", nullable: false },
  { name: "port_id", type: "uuid", nullable: false },
  { name: "request_id", type: "uuid", nullable: false },
]
function slice(source: string, start: string, end: string) {
  const from = source.indexOf(start), to = source.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `Missing bounded production code: ${start} → ${end}`)
  return source.slice(from, to)
}
function bind(code: string, result: string, bindings: Record<string, unknown> = {}) {
  const js = transformSync(code, { loader: "ts", format: "cjs", target: "node24" }).code
  return new Function(...Object.keys(bindings), `${js};return ${result};`)(...Object.values(bindings))
}
const exporterConstants = slice(exporter, "const RETAINED_VERIFIED_BACKUP_COUNT", "function requireEnv")
const healthConstants = slice(health, "const BACKUP_FOLDER_NAME", "function requireEnv")
const validatorConstants = slice(validator, "const MINIMUM_V2_MIGRATION_HEAD", "const TOP_LEVEL_KEYS")
const shared = { pricingBackupSchemaFromInventory, pricingBackupSchemaFromArtifact, pricingBackupSchemaVersion, parsePricingBackupSchemaVersion }
const getContract = bind(healthConstants, "getBackupArtifactContract")
const validatorContract = bind(validatorConstants, "getBackupContract")

function clients(inventory: unknown) {
  const rpc = async (name: string) => {
    assert.equal(name, "get_bunker_map_backup_inventory")
    return { data: inventory, error: null }
  }
  const exportRead = bind([
    exporterConstants,
    slice(exporter, "function asRecord", "function getDeploymentCommit"),
    slice(exporter, "async function getBackupInventory", "function isRetryableSupabaseReadError"),
  ].join("\n"), "getBackupInventory", { ...shared, retrySupabaseRead: async (read: () => Promise<{ data: unknown }>) => (await read()).data })
  const healthRead = bind([
    healthConstants,
    slice(health, "function asRecord", "function requireExactKeys"),
    slice(health, "async function getCurrentBackupInventory", "async function listActiveDriveBackupFiles"),
  ].join("\n"), "getCurrentBackupInventory", { ...shared, getSupabaseClient: () => ({ rpc }) })
  return { exportRead: () => exportRead({ rpc }), healthRead }
}
const validateInventory = bind([
  validatorConstants,
  slice(validator, "function addError", "function isPresentPrimaryKeyValue"),
  slice(validator, "function isPlainObject", "function isValidTimestamp"),
  slice(validator, "function validateDatabaseInventory", "function validateSourceWarnings"),
].join("\n"), "validateDatabaseInventory", shared)

function inventory(schema: "none" | "creation-v1" | "recovery-v2") {
  const names = schema === "none" ? [] : schema === "creation-v1" ? [CREATION_MIGRATION] : [CREATION_MIGRATION, RECOVERY_MIGRATION]
  return {
    schema: "bunker-map.backup-inventory/v1", migrationHead: head,
    tables: getContract(head, schema).registeredTables, unfencedTables: [], catalogSha256: sha,
    appliedMigrations: [...names.map((name, index) => ({ version: `2098010100000${index}`, name })), { version: head, name: "unrelated_later_update" }],
    receiptColumns: schema === "none" ? [] : schema === "creation-v1" ? baseColumns : [
      { name: "acknowledged_at", type: "timestamp with time zone", nullable: true },
      { name: "actor_id", type: "uuid", nullable: true }, ...baseColumns,
    ],
  }
}

test("actual exporter → artifact inventory → offline validator and live health agree for sparse, creation and recovery schemas", async () => {
  for (const version of ["none", "creation-v1", "recovery-v2"] as const) {
    const input = inventory(version), online = clients(input)
    const exported = await online.exportRead(), checked = await online.healthRead()
    assert.deepEqual(exported.pricingSchema, checked.pricingSchema)
    assert.equal(pricingBackupSchemaVersion(exported.pricingSchema), version)
    assert.deepEqual(exported.pricingSchema.appliedMigrations, input.appliedMigrations.filter(row => row.name !== "unrelated_later_update"))
    const contract = validatorContract(head, version)
    assert.deepEqual(exported.registeredTables, contract.expectedRegisteredTables)
    assert.equal(exported.tableConfigs.some((row: { table: string }) => row.table === receiptTable), version !== "none")
    const artifact = { migrationHead: head, databaseInventory: {
      schema: "bunker-map.backup-inventory/v1", liveTables: [...exported.liveTables].sort(),
      registeredTables: exported.registeredTables, explicitlyEphemeralTables: exported.explicitlyEphemeralTables,
      excludedCredentialFields: ["admin_users.password_hash", "spc_users.password_hash"], pricingSchema: exported.pricingSchema,
    } }
    const errors: string[] = []
    validateInventory(artifact, errors)
    assert.deepEqual(errors, [])
    if (version === "none") {
      delete (artifact.databaseInventory as { pricingSchema?: unknown }).pricingSchema
      validateInventory(artifact, errors)
      assert.deepEqual(errors, [], "real historical no-receipt artifacts remain valid at a sparse later head")
    }
  }
})

test("actual online consumers and offline schema proof reject dropped tables, missing recovery columns and unproven legacy receipts", async () => {
  const dropped = inventory("recovery-v2")
  dropped.tables = dropped.tables.filter((name: string) => name !== receiptTable)
  const missing = inventory("recovery-v2")
  missing.receiptColumns = baseColumns
  const unexpected = inventory("none")
  unexpected.tables = [...unexpected.tables, receiptTable].sort()
  const unfenced = { ...inventory("creation-v1"), unfencedTables: [receiptTable] }
  const oldRpc = { ...inventory("none"), appliedMigrations: undefined }
  for (const broken of [dropped, missing, unexpected, unfenced, oldRpc]) {
    const online = clients(broken)
    await assert.rejects(online.exportRead(), /pricing|evidence|unfenced/i)
    await assert.rejects(online.healthRead(), /pricing|evidence|unfenced/i)
  }
  for (const broken of [dropped, missing, unexpected]) {
    const proof = { schema: "fcuno.pricing-backup-schema/v1", appliedMigrations: broken.appliedMigrations.filter(row => row.name !== "unrelated_later_update"), receiptColumns: broken.receiptColumns }
    assert.throws(() => validateInventory({ migrationHead: head, databaseInventory: { liveTables: broken.tables, pricingSchema: proof } }, []), /pricing/)
  }
  assert.throws(() => validateInventory({ migrationHead: head, databaseInventory: { liveTables: [receiptTable], registeredTables: [receiptTable] } }, []), /no exact schema evidence/)
})

test("actual Drive receipt writer and streamed verifier use bounded capability metadata and preserve historical no-marker checks", async () => {
  const mark = bind(exporterConstants + slice(exporter, "async function markBackupVerified", "async function listDriveBackupCandidates"), "markBackupVerified")
  let downloaded = 0
  const verify = bind([
    healthConstants,
    slice(health, "function asRecord", "function requireExactKeys"),
    slice(health, "function requireStreamBackupProperties", "function verifyBackupArtifact"),
  ].join("\n"), "verifyStreamedBackupFile", { ...shared, readDriveFileDigest: async () => { downloaded++; return { uploadedFileSha256: sha, fileByteLength: 4096 } } })
  for (const version of ["none", "creation-v1", "recovery-v2"] as const) {
    let properties: Record<string, string> = {}
    const drive = { files: { update: async (request: { requestBody: { appProperties: Record<string, string> } }) => { properties = request.requestBody.appProperties; return { data: {} } } } }
    const contract = getContract(head, version)
    const prepared = {
      artifactPrefix: { backupRunId: "11111111-1111-4111-8111-111111111111", source: "vercel-cron", deploymentCommit: "a".repeat(40) },
      migrationHead: head, pricingSchemaVersion: version, databaseEpoch: 12, inventorySha256: sha, catalogSha256: sha,
      liveTableCount: contract.requiredLiveTables.length, sectionCount: contract.requiredDataKeys.length, totalRecordCount: 5,
      truthHeadSequence: 1, truthHeadSha256: sha, generatedAt: "2026-10-12T11:00:00Z",
      latestCertificationRunId: "22222222-2222-4222-8222-222222222222", latestProjectionSnapshotSha256: sha,
    }
    await mark(drive, "owned-synthetic-file", prepared, { artifactSha256: sha, uploadedFileSha256: sha, fileByteLength: 4096 }, null)
    assert.equal(properties.pricingSchemaVersion, version)
    assert.ok(Object.keys(properties).length <= 30, "within Drive's per-app private-property count limit")
    for (const [key, value] of Object.entries(properties)) assert.ok(Buffer.byteLength(key + value, "utf8") <= 124, key)
    const verified = await verify({}, { id: "owned-synthetic-file", appProperties: properties }, "Synthetic")
    assert.equal(verified.sectionCount, contract.requiredDataKeys.length)
    if (version === "none") {
      const historical = { ...properties }; delete historical.pricingSchemaVersion
      assert.equal((await verify({}, { id: "owned-synthetic-file", appProperties: historical }, "Historical")).sectionCount, contract.requiredDataKeys.length)
    } else {
      const unproven = { ...properties }; delete unproven.pricingSchemaVersion
      await assert.rejects(verify({}, { id: "owned-synthetic-file", appProperties: unproven }, "Unproven"), /inventory contract/)
    }
    const before = downloaded
    await assert.rejects(verify({}, { id: "owned-synthetic-file", appProperties: { ...properties, pricingSchemaVersion: "future-v3" } }, "Invalid"), /schema metadata/)
    assert.equal(downloaded, before, "bad metadata is rejected before file reads")
  }
})
