import { createHash } from "node:crypto"
import fs from "node:fs"

const validatorSource = fs.readFileSync(new URL("../../scripts/validate-backup.mjs", import.meta.url), "utf8")
const constants = validatorSource.slice(validatorSource.indexOf("const MINIMUM_V2_MIGRATION_HEAD"), validatorSource.indexOf("const TOP_LEVEL_KEYS"))
const contract = new Function(`${constants};return getBackupContract`)
const hash = value => createHash("sha256").update(value).digest("hex")
export const fixtureRunId = "11111111-1111-4111-8111-111111111111"
const timestamp = "2026-10-14T00:00:00.000000Z"

function snapshot(kind, canonical) {
  const canonical_json = JSON.stringify(canonical)
  const collections = Object.fromEntries(Object.entries(canonical).filter(([,value]) => Array.isArray(value)).map(([key,value]) => [key,value.length]))
  return { snapshot_sha256: hash(canonical_json), snapshot_kind: kind, schema_version: 1, canonical_json, byte_length: Buffer.byteLength(canonical_json), item_counts: collections, created_at: timestamp }
}
function ledger(sequence, eventKey, eventType, payload, snapshotHash, previous) {
  const row = { ledger_sequence: sequence, entry_id: `entry-${sequence}`, event_key: eventKey, event_type: eventType,
    occurred_at: timestamp, occurred_at_canonical: timestamp, created_at: timestamp, run_id: fixtureRunId,
    audit_log_id: null, queue_row_id: null, snapshot_sha256: snapshotHash, previous_entry_sha256: previous,
    payload_canonical_json: JSON.stringify(payload) }
  row.payload_sha256 = hash(row.payload_canonical_json)
  row.hash_material = ["fcuno-exchange-truth/v1", `ledgerSequence=${sequence}`, `entryId=${row.entry_id}`, `eventKey=${eventKey}`,
    `eventType=${eventType}`, `occurredAt=${timestamp}`, `runId=${fixtureRunId}`, "auditLogId=", "queueRowId=",
    `snapshotSha256=${snapshotHash || ""}`, `previousEntrySha256=${previous || ""}`, `payloadSha256=${row.payload_sha256}`].join("\n")
  row.entry_sha256 = hash(row.hash_material)
  return row
}

export function makeBackupFixture(migrationHead = "20260723080326", { extraSnapshots = 0, snapshotPadding = 0 } = {}) {
  const spec = contract()(migrationHead)
  const raw = snapshot("fcuno_raw", { contacts: [], groups: [], members: [], schema: "fcuno.addressbook.raw/v1" })
  const projection = snapshot("fcuno_exchange_projection", { contacts: [], groups: [], members: [], invalidContacts: [], skippedInvalidContacts: [], duplicateContacts: [] })
  const certification = { run_id: fixtureRunId, sync_mode: "full", queue_high_water_sequence: 0, queue_high_water_updated_at: null,
    source_fingerprint: projection.snapshot_sha256, certified_at: timestamp, result: { certified: true }, created_at: timestamp }
  const receipt = ledger(1, `certification:${fixtureRunId}`, "full_certification", {
    schema: "fcuno.exchange.full-certification/v1", certification: { run_id: fixtureRunId }, rawSourceSnapshotSha256: raw.snapshot_sha256,
  }, raw.snapshot_sha256, null)
  const projectionRow = ledger(2, `projection:${fixtureRunId}`, "full_projection_evidence", {
    schema: "fcuno.exchange.projection-evidence/v1", runId: fixtureRunId, sourceFingerprint: projection.snapshot_sha256,
    projectionSnapshotSha256: projection.snapshot_sha256, rawSourceSnapshotSha256: raw.snapshot_sha256,
    certificationLedgerSequence: 1, certificationLedgerSha256: receipt.entry_sha256,
    projectionCounts: projection.item_counts, verificationSummary: { status: "match", mismatchCount: 0, sourceFenceStable: true,
      sourceFingerprint: projection.snapshot_sha256, verifiedManagedContacts: 0, verifiedManagedGroups: 0, verifiedMembershipGroups: 0, verifiedMemberships: 0 },
    workerVersion: "fcuno-exchange-runbook/2026-10-14.1",
  }, projection.snapshot_sha256, receipt.entry_sha256)
  const data = Object.fromEntries(spec.requiredSections.map(key => [key, []]))
  data.outlookExchangeSyncCertifications = [certification]
  data.outlookExchangeTruthSnapshots = [raw, projection]
  data.outlookExchangeTruthLedger = [receipt, projectionRow]
  for (let index = 0; index < extraSnapshots; index++) {
    const extra = snapshot("fcuno_raw", { contacts: [{ synthetic: index, padding: "A".repeat(snapshotPadding) }], groups: [], members: [], schema: "fcuno.addressbook.raw/v1" })
    data.outlookExchangeTruthSnapshots.push(extra)
    const previous = data.outlookExchangeTruthLedger.at(-1)
    data.outlookExchangeTruthLedger.push(ledger(previous.ledger_sequence + 1, `synthetic-snapshot:${index}`, "run_status", { synthetic: index }, extra.snapshot_sha256, previous.entry_sha256))
  }
  const tail = data.outlookExchangeTruthLedger.at(-1)
  const state = { headSequence: tail.ledger_sequence, headSha256: tail.entry_sha256,
    ledgerEntries: data.outlookExchangeTruthLedger.length, snapshots: data.outlookExchangeTruthSnapshots.length,
    latestCertificationRunId: fixtureRunId, latestCertificationAt: timestamp, latestSourceFingerprint: projection.snapshot_sha256,
    latestCertificationHasProjectionEvidence: true, latestProjectionSnapshotSha256: projection.snapshot_sha256 }
  const verification = { integrityValid: true, valid: true, ledgerValid: true, snapshotsValid: true, referencesValid: true,
    operationallyConsistent: true, ...state, queue: { pending: 0, processing: 0, failed: 0, terminalFailed: 0 } }
  const checkpoint = { checkpointValid: true, ...state }
  const backup = { schemaVersion: 2, backupRunId: "22222222-2222-4222-8222-222222222222", generatedAt: timestamp, project: "bunker-map",
    source: "vercel-cron", requestedBy: "Vercel Cron", migrationHead, deploymentCommit: "a".repeat(40), previousVerifiedBackup: null,
    databaseInventory: { schema: "bunker-map.backup-inventory/v1", liveTables: spec.requiredLiveTables, registeredTables: spec.expectedRegisteredTables,
      explicitlyEphemeralTables: spec.explicitlyEphemeralTables, excludedCredentialFields: ["admin_users.password_hash", "spc_users.password_hash"] },
    counts: {}, data, warnings: [], integrity: { schema: "bunker-map-backup-integrity/v2", algorithm: "sha256", serialization: "JSON.stringify/v1",
      artifactHashScope: "top-level-without-integrity/v1", artifactSha256: "", sections: {}, truth: {
        schema: "fcuno-exchange-backup-checkpoint/v1", verificationBeforeExport: verification, checkpointBeforeExport: checkpoint,
        checkpointAfterExport: checkpoint, verificationAfterExport: verification,
        exportedLedger: { entries: state.ledgerEntries, headSequence: state.headSequence, headSha256: state.headSha256 }, exportedSnapshots: { count: state.snapshots },
      } } }
  if (migrationHead >= "20260723124045") {
    const templateVerifier = { schema: "fcuno.outlook-template-recipient-truth/v2", valid: true, sourceTruthValid: true, allTemplatesSendable: true,
      certificationRunId: fixtureRunId, certifiedAt: timestamp, sourceFingerprint: projection.snapshot_sha256,
      templates: { total: 0, unresolved: 0, stale: 0, invalidShape: 0, withMissingRecipients: 0, withAmbiguousRecipients: 0, sendable: 0 },
      queue: { pending: 0, processing: 0, failed: 0, terminalFailed: 0 } }
    const { exportedLedger, exportedSnapshots, ...truth } = backup.integrity.truth
    backup.integrity.truth = { ...truth, templateRecipientVerificationBeforeExport: templateVerifier, templateRecipientVerificationAfterExport: templateVerifier,
      templateRecipientTruth: { certificationRunId: fixtureRunId, certifiedAt: timestamp, sourceFingerprint: projection.snapshot_sha256,
        total: 0, sendable: 0, missing: 0, ambiguous: 0, unresolved: 0, stale: 0, invalidShape: 0, allTemplatesSendable: true }, exportedLedger, exportedSnapshots }
  }
  return rehashBackupFixture(backup)
}

export function rehashBackupFixture(backup) {
  backup.counts = Object.fromEntries(Object.entries(backup.data).map(([key,rows]) => [key,rows.length]))
  backup.integrity.sections = Object.fromEntries(Object.entries(backup.data).map(([key,rows]) => [key,{ rowCount: rows.length, sha256: hash(JSON.stringify(rows)) }]))
  const { integrity, ...payload } = backup
  integrity.artifactSha256 = hash(JSON.stringify(payload))
  return backup
}

export function writeLargeBackupFixture(filePath, targetBytes, rowCount = 65000) {
  const backup = makeBackupFixture("20261014082839", { extraSnapshots: 67, snapshotPadding: 2650000 })
  backup.counts.auditLogs = rowCount
  backup.integrity.sections.auditLogs.rowCount = rowCount
  const makeRow = (index, blob) => ({ id: `synthetic-audit-${index}`, table_name: "ports", before_row: null,
    after_row: { blob }, undo_of_log_id: null, undone_by_log_id: null })
  let fixedRowBytes = rowCount - 1
  for (let index = 0; index < rowCount; index++) fixedRowBytes += Buffer.byteLength(JSON.stringify(makeRow(index, "")))
  const payloadBytes = targetBytes - Buffer.byteLength(JSON.stringify(backup)) - fixedRowBytes
  if (payloadBytes < rowCount) throw new Error("Synthetic target is too small")
  const each = Math.floor(payloadBytes / rowCount), extra = payloadBytes % rowCount
  const fd = fs.openSync(filePath, "wx", 0o600), fileHash = createHash("sha256"), artifactHash = createHash("sha256")
  let written = 0
  const write = (text, logical = true) => {
    const buffer = Buffer.from(text); let done = 0
    while (done < buffer.length) done += fs.writeSync(fd, buffer, done, buffer.length - done)
    written += buffer.length; fileHash.update(buffer); if (logical) artifactHash.update(buffer)
  }
  try {
    const { integrity, data, ...prefix } = backup
    delete prefix.warnings
    write(JSON.stringify(prefix).slice(0, -1) + ',"data":{')
    let firstSection = true
    for (const [key, rows] of Object.entries(data)) {
      write(`${firstSection ? "" : ","}${JSON.stringify(key)}:[`); firstSection = false
      const sectionHash = createHash("sha256").update("[")
      const count = key === "auditLogs" ? rowCount : rows.length
      for (let index = 0; index < count; index++) {
        const row = key === "auditLogs" ? makeRow(index, "A".repeat(each + (index < extra ? 1 : 0))) : rows[index]
        const text = `${index ? "," : ""}${JSON.stringify(row)}`
        write(text); sectionHash.update(text)
      }
      write("]"); sectionHash.update("]")
      integrity.sections[key] = { rowCount: count, sha256: sectionHash.digest("hex") }
    }
    write('},"warnings":[]')
    artifactHash.update("}")
    integrity.artifactSha256 = artifactHash.digest("hex")
    write(',"integrity":' + JSON.stringify(integrity) + "}", false)
    if (written !== targetBytes) throw new Error(`Synthetic byte count mismatch: ${written} != ${targetBytes}`)
    return { bytes: written, fileSha256: fileHash.digest("hex"), artifactSha256: integrity.artifactSha256, rows: rowCount }
  } finally { fs.closeSync(fd) }
}
