import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"
import { deliverHealthAlerts, healthAlertObservation, type HealthAlertStore } from "../lib/systemHealthAlerts"
import type { HealthCheck, HealthCheckResult, SystemHealth } from "../lib/systemHealth"

const NOW = Date.parse("2026-10-16T02:00:00.000Z")
const fingerprint = "a".repeat(64), runId = "11111111-1111-4111-8111-111111111111"
const raw = readFileSync(new URL("../lib/systemHealth.ts", import.meta.url), "utf8")
const source = ts.createSourceFile("systemHealth.ts", raw, ts.ScriptTarget.Latest, true)
const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "checkExchangeTruth")
assert.ok(fn)
const code = ts.transpileModule(fn.getText(source), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

async function check(options: { queue?: Partial<Record<"pending" | "processing" | "failed" | "terminalFailed", number>>; checkpoint?: Record<string, unknown>; verification?: Record<string, unknown>; ageMs?: number; operationallyConsistent?: boolean } = {}) {
  const latestCertificationAt = new Date(NOW - (options.ageMs ?? 60000)).toISOString()
  const queue = { pending: 0, processing: 0, failed: 0, terminalFailed: 0, ...options.queue }
  const certification = { latestCertificationHasProjectionEvidence: true, latestCertificationRunId: runId, latestCertificationAt, latestSourceFingerprint: fingerprint }
  const checkpoint = { checkpointValid: true, headSequence: 1, headSha256: fingerprint, queue, latestProjectionSnapshotSha256: fingerprint, ...certification, ...options.checkpoint }
  const verification = { valid: true, integrityValid: true, ledgerValid: true, snapshotsValid: true, referencesValid: true, headSequence: 1, headSha256: fingerprint, queue, ...certification, latestProjectionSnapshotSha256: fingerprint, operationallyConsistent: options.operationallyConsistent ?? (!queue.pending && !queue.processing && !queue.failed && !queue.terminalFailed), ...options.verification }
  const calls: string[] = []
  class Clock extends Date { static now() { return NOW } }
  const context = {
    Date: Clock, Number, String, Boolean, EXCHANGE_CERTIFICATION_WARNING_AGE_HOURS: 36,
    getNumber: (value: unknown) => Number(value || 0),
    asRecord: (value: unknown) => value,
    getSupabaseClient: () => ({ async rpc(name: string) { calls.push(name); assert.ok(["get_outlook_exchange_truth_checkpoint", "verify_outlook_exchange_truth_ledger"].includes(name)); return { data: name === "get_outlook_exchange_truth_checkpoint" ? checkpoint : verification, error: null } } }),
  }
  vm.createContext(context); vm.runInContext(code, context)
  const result = await (context as typeof context & { checkExchangeTruth(): Promise<HealthCheckResult> }).checkExchangeTruth()
  assert.deepEqual(calls, ["get_outlook_exchange_truth_checkpoint", "verify_outlook_exchange_truth_ledger"], "full verification is still performed, never replaced by cached evidence")
  return { id: "exchange-truth", label: "Exchange Truth Chain", checkedAt: new Date(NOW).toISOString(), ...result } satisfies HealthCheck
}

test("actual Exchange helper keeps intact recent pending and processing work quiet without claiming recovery", async () => {
  for (const queue of [{ pending: 1 }, { processing: 1 }, { pending: 12, processing: 3 }]) {
    const result = await check({ queue })
    assert.equal(result.status, "warning"); assert.match(result.message, /Address book updating/)
    assert.equal(result.details?.notificationEligible, false); assert.equal(result.details?.incidentResolved, false)
    assert.equal(healthAlertObservation(result, false).alert_level, null)
  }
})
test("actual helper preserves real failed/terminal, integrity, reference, missing evidence and checkpoint mismatch alerts even with pending work", async () => {
  for (const options of [
    { queue: { pending: 1, failed: 1 } }, { queue: { processing: 1, terminalFailed: 1 } },
    { checkpoint: { checkpointValid: false } }, { verification: { valid: false } }, { verification: { integrityValid: false } },
    { verification: { ledgerValid: false } }, { verification: { snapshotsValid: false } }, { verification: { referencesValid: false } },
    { verification: { firstInvalidReferenceLedgerSequence: 1 } },
    { verification: { referencesValid: false, firstInvalidReferenceKind: "group_smtp" } },
    { verification: { firstInvalidSnapshotSha256: "bad" } }, { verification: { firstInvalidLedgerSequence: 1 } },
    { verification: { latestCertificationHasProjectionEvidence: false } }, { checkpoint: { latestCertificationHasProjectionEvidence: false } },
    { checkpoint: { latestProjectionSnapshotSha256: "b".repeat(64) } },
    { verification: { latestProjectionSnapshotSha256: "b".repeat(64) } }, { verification: { latestSourceFingerprint: "" } },
    { verification: { headSha256: "b".repeat(64) } },
    { checkpoint: { latestSourceFingerprint: "b".repeat(64) } }, { checkpoint: { latestCertificationRunId: "different-run" } },
    { verification: { latestCertificationAt: new Date(NOW - 120000).toISOString() } },
  ]) {
    const result = await check({ queue: { pending: 1 }, ...options })
    assert.equal(result.status, "error", JSON.stringify(options)); assert.notEqual(result.details?.notificationEligible, false)
    assert.equal(healthAlertObservation(result, false).alert_level, 2)
  }
  const newQueue = await check({ verification: { queue: { pending: 2, processing: 1, failed: 0, terminalFailed: 0 }, operationallyConsistent: false } })
  assert.equal(healthAlertObservation(newQueue, false).alert_level, null)
  assert.equal(newQueue.details?.pending, 2); assert.equal(newQueue.details?.processing, 1)
})
test("individually valid moving RPC heads are quiet uncertainty, not corruption or recovery", async () => {
  for (const queue of [{}, { pending: 1 }, { processing: 1 }]) {
    const result = await check({ queue, verification: { headSequence: 2, headSha256: "b".repeat(64) } })
    assert.equal(result.status, "warning"); assert.match(result.message, /Checking the latest address book changes/)
    assert.equal(result.details?.notificationEligible, false); assert.equal(result.details?.incidentResolved, false)
    assert.equal(result.details?.projectionCurrent, false); assert.equal(healthAlertObservation(result, false).alert_level, null)
  }
  for (const verification of [
    { headSequence: 2, referencesValid: false }, { headSequence: 2, integrityValid: false },
    { headSequence: 2, latestCertificationHasProjectionEvidence: false },
    { headSequence: 2, latestProjectionSnapshotSha256: "b".repeat(64) },
    { headSequence: 2, queue: { failed: 1, terminalFailed: 0 } },
    { headSequence: 2, queue: { failed: 0, terminalFailed: 1 } },
    { headSequence: 0 }, { headSequence: 2, headSha256: "bad" },
  ]) {
    const result = await check({ verification })
    assert.equal(result.status, "error", JSON.stringify(verification))
    assert.equal(healthAlertObservation(result, false).alert_level, 2)
  }
  const staleMoving = await check({ ageMs: 37 * 3600000, verification: { headSequence: 2 } })
  assert.notEqual(healthAlertObservation(staleMoving, false).alert_level, null)
  const badCheckpointProof = await check({ checkpoint: { latestProjectionSnapshotSha256: "b".repeat(64) }, verification: { headSequence: 2 } })
  assert.equal(healthAlertObservation(badCheckpointProof, false).alert_level, 2)
})
test("stale certification remains actionable during pending work, including the exact 36-hour boundary", async () => {
  const limit = 36 * 60 * 60 * 1000
  assert.equal(healthAlertObservation(await check({ queue: { pending: 1 }, ageMs: limit }), false).alert_level, null)
  for (const ageMs of [limit + 1, limit + 3600000, -5 * 60000 - 1]) {
    const result = await check({ queue: { pending: 1 }, ageMs })
    assert.equal(result.status, "warning"); assert.notEqual(result.details?.notificationEligible, false)
    assert.equal(healthAlertObservation(result, false).alert_level, 1)
  }
})
test("zero-queue operational inconsistency still errors; only verified settled health resolves an incident", async () => {
  assert.equal(healthAlertObservation(await check({ operationallyConsistent: false }), false).alert_level, 2)
  const healthy = await check()
  assert.equal(healthy.status, "ok"); assert.equal(healthAlertObservation(healthy, false).alert_level, 0)
  assert.equal(healthAlertObservation(await check({ ageMs: 37 * 3600000 }), false).alert_level, 1)
})
test("actual delivery path sends and acknowledges nothing for pending work, and preserves an already-notified incident", async () => {
  let incidentLevel = 2, claims = 0
  const store: HealthAlertStore = {
    async claim(observations) {
      claims += 1
      for (const observation of observations) {
        assert.equal(observation.check_id, "exchange-truth")
        if (observation.alert_level !== null) incidentLevel = observation.alert_level
      }
      return []
    },
    async finish() { assert.fail("Pending work has no delivery acknowledgement") },
  }
  for (const queue of [{ pending: 1 }, { processing: 1 }]) {
    assert.deepEqual(await deliverHealthAlerts({ checks: [await check({ queue })], muted: () => false, token: "synthetic", store, send: async () => assert.fail("No email for normal updating") }), [])
    assert.equal(incidentLevel, 2, "pending must not clear/rearm the existing incident")
  }
  assert.deepEqual(await deliverHealthAlerts({ checks: [await check({ verification: { headSequence: 2, headSha256: "b".repeat(64) } })], muted: () => false, token: "synthetic", store, send: async () => assert.fail("No email for a moving read snapshot") }), [])
  assert.equal(incidentLevel, 2); assert.equal(claims, 3)
  await store.claim([healthAlertObservation(await check(), false)], "synthetic")
  assert.equal(incidentLevel, 0, "a real verified recovery may resolve it")
})

// Execute the real assessment and both real Outlook checks. Only unrelated
// providers and the RPC transport are substituted; a source-text assertion
// alone would not catch accidentally sharing evidence between assessments.
function healthAssessmentHarness(options: {
  exchange?: Record<string, unknown>
  template?: Record<string, unknown>
  response?: unknown
  rpcError?: unknown
  checkpointError?: unknown
  waitForProof?: Promise<void>
  proofTimeoutMs?: number
} = {}) {
  const names = [
    "getErrorMessage", "combineStatus", "runCheck", "asRecord", "getNumber",
    "createOutlookTemplateTruthReader", "checkExchangeTruth",
    "checkOutlookTemplateRecipientTruth", "getSystemHealth",
  ]
  const functions = names.map(name => {
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
    assert.ok(declaration, `Missing actual production function ${name}`)
    return declaration.getText(source)
  }).join("\n")
  const actual = ts.transpileModule(functions, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const certification = {
    latestCertificationHasProjectionEvidence: true,
    latestCertificationRunId: runId,
    latestCertificationAt: new Date(NOW - 60000).toISOString(),
    latestSourceFingerprint: fingerprint,
    latestProjectionSnapshotSha256: fingerprint,
  }
  const queue = { pending: 0, processing: 0, failed: 0, terminalFailed: 0 }
  const checkpoint = { checkpointValid: true, headSequence: 1, headSha256: fingerprint, queue, ...certification }
  const exchangeTruth = {
    valid: true, integrityValid: true, ledgerValid: true, snapshotsValid: true,
    referencesValid: true, operationallyConsistent: true,
    headSequence: 1, headSha256: fingerprint, queue, ...certification, ...options.exchange,
  }
  const response = Object.hasOwn(options, "response") ? options.response : {
    schema: "fcuno.outlook-template-recipient-truth/v2", valid: true,
    certificationRunId: runId, certifiedAt: certification.latestCertificationAt,
    sourceFingerprint: fingerprint,
    templates: { total: 2, sendable: 2, unresolved: 0, stale: 0, invalidShape: 0, withMissingRecipients: 0, withAmbiguousRecipients: 0 },
    exchangeTruth, ...options.template,
  }
  const calls: string[] = []
  class Clock extends Date { static now() { return NOW } }
  const unrelated = Object.fromEntries([
    "checkSupabase", "checkOptionalSchema", "checkAttendanceSync", "checkDriveBackup",
    "checkDriveFileContentBackup", "checkStorageMediaBackup", "checkGoogleCalendar",
    "checkGoogleContacts", "checkExchangeConfig", "checkEmailNoticeConfig", "checkCronConfig",
  ].map(name => [name, async () => ({ status: "ok", message: "Unrelated provider fixture" })]))
  const context = {
    ...unrelated, exports: {}, Date: Clock, setTimeout, clearTimeout,
    process: { env: {} }, getPostgresSourceMaintenanceCheck: () => null, getPostgresRecoveryMaintenanceCheck: () => null,
    CHECK_TIMEOUT_MS: 1000, BACKUP_CHECK_TIMEOUT_MS: 1000, OUTLOOK_TRUTH_CHECK_TIMEOUT_MS: options.proofTimeoutMs ?? 1000,
    OUTLOOK_TEMPLATE_TRUTH_SCHEMA: "fcuno.outlook-template-recipient-truth/v2",
    EXCHANGE_CERTIFICATION_WARNING_AGE_HOURS: 36,
    BackupProtectionObservationError: class extends Error {},
    getDeployment: () => ({ commit: "synthetic", shortCommit: "synthetic", branch: "synthetic", deployedAt: "synthetic", environment: "test" }),
    getSupabaseClient: () => ({ async rpc(name: string) {
      calls.push(name)
      if (name === "get_outlook_exchange_truth_checkpoint") return { data: checkpoint, error: options.checkpointError ?? null }
      assert.equal(name, "verify_outlook_template_recipient_truth", "No duplicate independent ledger RPC in a combined assessment")
      await options.waitForProof
      return { data: response, error: options.rpcError ?? null }
    } }),
  }
  vm.createContext(context); vm.runInContext(actual, context)
  const getSystemHealth = (context as typeof context & { getSystemHealth(): Promise<SystemHealth> }).getSystemHealth
  return { calls, getSystemHealth }
}

function outlookChecks(health: SystemHealth) {
  const exchange = health.checks.find(check => check.id === "exchange-truth")
  const template = health.checks.find(check => check.id === "outlook-template-recipient-truth")
  assert.ok(exchange); assert.ok(template)
  return { exchange, template }
}

test("actual combined health assessment shares one fresh complete proof and keeps the independent checkpoint", async () => {
  let release!: () => void
  const waitForProof = new Promise<void>(resolve => { release = resolve })
  const harness = healthAssessmentHarness({ waitForProof })
  const first = harness.getSystemHealth()
  assert.deepEqual(harness.calls, ["get_outlook_exchange_truth_checkpoint", "verify_outlook_template_recipient_truth"])
  release()
  const healthy = await first
  assert.equal(healthy.status, "ok")
  assert.equal(outlookChecks(healthy).exchange.details?.fullLedgerValid, true)
  assert.equal(outlookChecks(healthy).exchange.details?.projectionCurrent, true)
  assert.equal(outlookChecks(healthy).template.details?.totalTemplates, 2)
  await harness.getSystemHealth()
  assert.deepEqual(harness.calls, [
    "get_outlook_exchange_truth_checkpoint", "verify_outlook_template_recipient_truth",
    "get_outlook_exchange_truth_checkpoint", "verify_outlook_template_recipient_truth",
  ], "A later assessment must not reuse an earlier result")
})

test("overlapping actual assessments own separate evidence and share only within each assessment", async () => {
  let release!: () => void
  const waitForProof = new Promise<void>(resolve => { release = resolve })
  const harness = healthAssessmentHarness({ waitForProof })
  const first = harness.getSystemHealth(), second = harness.getSystemHealth()
  assert.equal(harness.calls.filter(name => name === "verify_outlook_template_recipient_truth").length, 2)
  release()
  for (const result of await Promise.all([first, second])) assert.equal(result.status, "ok")
})

test("shared full-proof failures cannot become a healthy result or silently retry expensive work", async () => {
  for (const options of [
    { rpcError: { message: "Synthetic full-proof timeout" } },
    { response: null }, { response: [] },
    { template: { exchangeTruth: undefined } },
    { template: { exchangeTruth: [] } }, { template: { exchangeTruth: {} } },
    { template: { schema: undefined } }, { template: { schema: "old-contract" } },
    { template: { valid: "true" } },
    { exchange: { ledgerValid: false } },
    { exchange: { valid: false, integrityValid: false, snapshotsValid: false, firstInvalidSnapshotSha256: "bad" }, template: { valid: false } },
  ]) {
    const harness = healthAssessmentHarness(options)
    const result = await harness.getSystemHealth()
    assert.equal(result.status, "error", JSON.stringify(options))
    assert.equal(outlookChecks(result).exchange.status, "error", JSON.stringify(options))
    assert.equal(outlookChecks(result).template.status, "error", JSON.stringify(options))
    assert.equal(harness.calls.filter(name => name === "verify_outlook_template_recipient_truth").length, 1)
    // A failed shared promise must not poison a subsequent assessment's scope.
    await harness.getSystemHealth()
    assert.equal(harness.calls.filter(name => name === "verify_outlook_template_recipient_truth").length, 2)
  }
})

test("both real Outlook health checks time out without duplicate work or late healthy results", async () => {
  let release!: () => void
  const waitForProof = new Promise<void>(resolve => { release = resolve })
  const harness = healthAssessmentHarness({ waitForProof, proofTimeoutMs: 1 })
  const result = await harness.getSystemHealth()
  const checks = outlookChecks(result)
  for (const check of [checks.exchange, checks.template]) {
    assert.equal(check.status, "error")
    assert.match(check.message, /timed out/)
  }
  assert.equal(harness.calls.filter(name => name === "verify_outlook_template_recipient_truth").length, 1)
  release()
  await Promise.resolve()
  assert.equal(checks.exchange.status, "error", "A late response cannot mutate an already returned failure")
  assert.equal(checks.template.status, "error")
  assert.equal((await harness.getSystemHealth()).status, "ok", "A later assessment starts a new proof")
})

test("shared evidence preserves separate template, checkpoint and moving-head results", async () => {
  const templateFailure = outlookChecks(await healthAssessmentHarness({ template: { valid: false } }).getSystemHealth())
  assert.equal(templateFailure.exchange.status, "ok")
  assert.equal(templateFailure.template.status, "error")
  const malformedTemplates = outlookChecks(await healthAssessmentHarness({ template: { templates: null } }).getSystemHealth())
  assert.equal(malformedTemplates.exchange.status, "ok")
  assert.equal(malformedTemplates.template.status, "error")
  const checkpointFailure = outlookChecks(await healthAssessmentHarness({ checkpointError: { message: "Synthetic checkpoint unavailable" } }).getSystemHealth())
  assert.equal(checkpointFailure.exchange.status, "error")
  assert.equal(checkpointFailure.template.status, "ok")
  const moving = outlookChecks(await healthAssessmentHarness({ exchange: { headSequence: 2, headSha256: "b".repeat(64) } }).getSystemHealth())
  assert.equal(moving.exchange.status, "warning")
  assert.equal(moving.exchange.details?.notificationEligible, false)
  assert.equal(moving.exchange.details?.incidentResolved, false)
  assert.equal(moving.template.status, "ok")
})
