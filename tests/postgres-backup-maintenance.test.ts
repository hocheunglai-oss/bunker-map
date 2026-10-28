import test from "node:test"
import assert from "node:assert/strict"
import { fcunoConnectionPolicy as pins } from "../config/fcunoConnections"
import { getPostgresSourceMaintenanceCheck, getPostgresRecoveryMaintenanceCheck, postgresBackupMaintenanceCheck, deliverPostgresBackupMaintenance, getPostgresBackupMaintenanceRecipients } from "../lib/postgresBackupMaintenance"
import { healthAlertObservation, type HealthAlertStore } from "../lib/systemHealthAlerts"
import { recoveryMaintenanceFixture } from "./fixtures/postgres-maintenance-receipt"

const day = 86400000, now = Date.parse("2026-10-28T06:30:00.000Z")
const role = { email: "admin@example.invalid", role: "ADMIN", isActive: true, emailVerified: true }
const check = (expiresAt = now + 10 * day, checkedAt = now) => postgresBackupMaintenanceCheck({ kind: "credential", enabled: true, now: checkedAt, validFrom: expiresAt - 90 * day, validUntil: expiresAt })
test("renewal warning begins fourteen days before expiry, and expiry never creates a second severity email", () => {
  assert.equal(check(now + 14 * day + 1).status, "ok")
  assert.equal(check(now + 14 * day).status, "warning")
  assert.equal(check(now - 1).status, "error")
  assert.equal(healthAlertObservation(check(), false).alert_level, 1)
  assert.equal(healthAlertObservation(check(now - 1), false).alert_level, 1)
  assert.equal(healthAlertObservation(check(now + 80 * day), false).alert_level, 0)
})
test("missing, invalid, future or disabled evidence preserves an incident and never fabricates recovery", () => {
  for (const change of [{ enabled: false }, { validFrom: null, validUntil: null }, { validFrom: now + day },
    { validFrom: now - 91 * day, validUntil: now + day }, { validUntil: Number.NaN }]) {
    const result = postgresBackupMaintenanceCheck({ kind: "credential", enabled: true, now, validFrom: now - 80 * day, validUntil: now + 10 * day, ...change })
    assert.equal(result.details?.notificationEligible, false)
    assert.equal(healthAlertObservation(result, false).alert_level, null)
  }
})
test("credential and isolated-recovery renewal have separate stable incident IDs and honest scope", () => {
  const recovery = postgresBackupMaintenanceCheck({ kind: "recovery", enabled: true, now, validFrom: now - 80 * day, validUntil: now + 10 * day })
  assert.notEqual(recovery.id, check().id)
  assert.match(recovery.message, /recovery test/)
  assert.equal(recovery.details?.evidence, "verified-cloud-recovery-receipt")
  assert.equal(check().details?.evidence, "configured-source-credential-expiry")
})
test("source renewal metadata never exports its password or executes a database operation", () => {
  const password = "synthetic-local-password-" + "a".repeat(40)
  const runtime = { POSTGRES_BACKUP_SOURCE_ENABLED: "1", VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_ID: pins.vercel.projectId,
    POSTGRES_BACKUP_MAINTENANCE_EMAIL_RECIPIENTS: role.email,
    POSTGRES_BACKUP_SOURCE_CREDENTIAL_JSON: JSON.stringify({ issuedAt: now - 80 * day, expiresAt: now + 10 * day, password }) }
  const result = getPostgresSourceMaintenanceCheck(runtime, now)
  assert.equal(result?.status, "warning"); assert.doesNotMatch(JSON.stringify(result), /synthetic-local-password|password|SOURCE_CREDENTIAL/)
  assert.equal(getPostgresSourceMaintenanceCheck({ ...runtime, POSTGRES_BACKUP_SOURCE_ENABLED: "0" }, now), null)
  for (const change of [{ VERCEL_ENV: "preview" }, { VERCEL_PROJECT_ID: "other" }, { POSTGRES_BACKUP_SOURCE_CREDENTIAL_JSON: "bad" },
    { POSTGRES_BACKUP_SOURCE_CREDENTIAL_JSON: JSON.stringify({ issuedAt: now - 80 * day, expiresAt: now + 10 * day, password, extra: "bad" }) }]) {
    const invalid = getPostgresSourceMaintenanceCheck({ ...runtime, ...change }, now)!
    assert.equal(healthAlertObservation(invalid, false).alert_level, null)
  }
})
test("the dedicated maintenance recipient list is bounded, explicit and never falls back to staff configuration", () => {
  assert.deepEqual(getPostgresBackupMaintenanceRecipients({ POSTGRES_BACKUP_MAINTENANCE_EMAIL_RECIPIENTS: " Admin@example.invalid ; admin@example.invalid\n second@example.invalid " }), ["admin@example.invalid", "second@example.invalid"])
  for (const value of [undefined, "", "not-an-email", "x".repeat(16385), "Admin <admin@example.invalid>"]) {
    assert.throws(() => getPostgresBackupMaintenanceRecipients({ POSTGRES_BACKUP_MAINTENANCE_EMAIL_RECIPIENTS: value, SYSTEM_HEALTH_EMAIL_RECIPIENTS: role.email, EVENT_CALENDAR_EMAIL_RECIPIENTS: role.email }), /not configured/)
  }
  assert.equal(getPostgresSourceMaintenanceCheck({ POSTGRES_BACKUP_SOURCE_ENABLED: "0" }), null)
  assert.equal(getPostgresSourceMaintenanceCheck({ POSTGRES_BACKUP_SOURCE_ENABLED: "1" }, now)?.status, "error")
})
test("only explicitly configured, active, verified FCUNO administrators receive maintenance messages", async () => {
  const sent: string[] = [], claimed: string[] = []
  const accounts = [role, { ...role, email: "staff@example.invalid", role: "AC" }, { ...role, email: "inactive@example.invalid", isActive: false }, { ...role, email: "unverified@example.invalid", emailVerified: false }]
  const result = await deliverPostgresBackupMaintenance({ checks: [check()], accounts,
    configuredRecipients: accounts.map(item => item.email).concat("unknown@example.invalid"), token: () => "token",
    createStore: recipient => { claimed.push(recipient); return { claim: async observations => observations.map(item => item.check_id), finish: async () => {} } },
    send: async recipient => { sent.push(recipient) } })
  assert.deepEqual(sent, [role.email]); assert.deepEqual(claimed, [role.email]); assert.equal(result.recipients, 1)
})
test("durable acknowledged incident is not resent daily or at expiry; genuine renewal rearms it", async () => {
  let notified = 0, sends = 0, observations = 0
  const store: HealthAlertStore = { claim: async items => { observations++; const item = items[0]; if (item.alert_level === 0) notified = 0
    return item.alert_level !== null && item.alert_level > notified ? [item.check_id] : [] }, finish: async (_, delivered) => { if (delivered) notified = 1 } }
  for (const current of [check(), check(now + 10 * day, now + day), check(now - 1), check(now + 80 * day), check()]) {
    await deliverPostgresBackupMaintenance({ checks: [current], accounts: [role], configuredRecipients: [role.email], token: () => "token", createStore: () => store, send: async () => { sends++ } })
  }
  assert.equal(observations, 5); assert.equal(sends, 2)
})
test("unavailable deduplication, no verified administrator or ambiguous address never falls back to staff email", async () => {
  const base = { checks: [check()], accounts: [role], configuredRecipients: [role.email], token: () => "token",
    createStore: () => ({ claim: async () => { throw Error("store unavailable") }, finish: async () => {} }), send: async () => assert.fail("must not send") }
  await assert.rejects(deliverPostgresBackupMaintenance(base), /store unavailable/)
  await assert.rejects(deliverPostgresBackupMaintenance({ ...base, accounts: [{ ...role, role: "AC" }] }), /administrator/)
  await assert.rejects(deliverPostgresBackupMaintenance({ ...base, accounts: [role, { ...role, role: "AC" }] }), /administrator/)
  await assert.rejects(deliverPostgresBackupMaintenance({ ...base, checks: [{ ...check(), id: "other-system-check" }] }), /maintenance/)
})

test("operator-verified recovery advice derives ninety days from exact receipt bytes, never from a newer check date", () => {
  const f = recoveryMaintenanceFixture(now - 80 * day, now - day)
  const current = getPostgresRecoveryMaintenanceCheck(f.runtime, now)!
  assert.equal(current.status, "warning")
  assert.equal(current.details?.expiresAt, new Date(now + 10 * day).toISOString())
  assert.equal(current.details?.evidence, "operator-verified-recovery-receipt-copy")
  assert.equal(current.details?.operatorCheckedAt, new Date(now - day).toISOString())
  assert.equal(current.details?.remoteReadbackCurrent, false); assert.equal(current.details?.provesCurrentBackupSuccess, false)
  assert.doesNotMatch(JSON.stringify(current), /acceptanceBase64|recovery\.json|archiveSha256|generation/)
  const laterCheck = f.record(); laterCheck.checkedAt = new Date(now).toISOString()
  assert.equal(getPostgresRecoveryMaintenanceCheck({ ...f.runtime, POSTGRES_BACKUP_RECOVERY_MAINTENANCE_JSON: JSON.stringify(laterCheck) }, now)?.details?.expiresAt, current.details?.expiresAt)
  const expired = getPostgresRecoveryMaintenanceCheck(f.runtime, now + 11 * day)!
  assert.equal(expired.status, "error")
  assert.equal(healthAlertObservation(current, false).alert_level, healthAlertObservation(expired, false).alert_level)
})

test("disabled recovery advice reads no evidence and wrong deployment cannot assert operator verification", () => {
  const disabled = new Proxy({}, { get(_target, key) {
    assert.equal(key, "POSTGRES_BACKUP_SOURCE_ENABLED"); return "0"
  } })
  assert.equal(getPostgresRecoveryMaintenanceCheck(disabled, now), null)
  const f = recoveryMaintenanceFixture(now - day)
  for (const change of [{ VERCEL: "0" }, { VERCEL_ENV: "preview" }, { VERCEL_PROJECT_ID: "other" },
    { POSTGRES_BACKUP_RECOVERY_MAINTENANCE_JSON: undefined }, { POSTGRES_BACKUP_RECOVERY_MAINTENANCE_JSON: "x".repeat(32769) }]) {
    const result = getPostgresRecoveryMaintenanceCheck({ ...f.runtime, ...change }, now)!
    assert.equal(result.details?.notificationEligible, false); assert.equal(result.details?.incidentResolved, false)
    assert.equal(result.details?.operatorCheckedAt, null)
  }
})

test("bad cached receipt bytes, descriptor scope, dates or copy-only/unsafe recovery evidence remain unknown", () => {
  const f = recoveryMaintenanceFixture(now - 80 * day, now - day)
  for (const change of [(x: ReturnType<typeof f.record>) => { x.acceptanceBase64 += "=" },
    (x: ReturnType<typeof f.record>) => { x.descriptor.byteSha256 = "0".repeat(64) },
    (x: ReturnType<typeof f.record>) => { x.descriptor.crc32c = "AAAAAA==" },
    (x: ReturnType<typeof f.record>) => { x.descriptor.target.bucket = "other" },
    (x: ReturnType<typeof f.record>) => { x.descriptor.target.objectName = x.descriptor.target.objectName.replace("fixture", "other") },
    (x: ReturnType<typeof f.record>) => { x.descriptor.target.generation = "0" },
    (x: ReturnType<typeof f.record>) => { x.descriptor.sizeBytes++ },
    (x: ReturnType<typeof f.record>) => { x.checkedAt = new Date(now + 1).toISOString() },
    (x: ReturnType<typeof f.record>) => { x.checkedAt = new Date(now - 81 * day).toISOString() },
    (x: ReturnType<typeof f.record>) => { x.projectRef = "other" }]) {
    const value = f.record(); change(value)
    const result = getPostgresRecoveryMaintenanceCheck({ ...f.runtime, POSTGRES_BACKUP_RECOVERY_MAINTENANCE_JSON: JSON.stringify(value) }, now)!
    assert.equal(result.details?.notificationEligible, false); assert.equal(result.details?.incidentResolved, false)
  }
  for (const change of [(x: typeof f.acceptance) => { x.status = "copied-and-byte-verified" },
    (x: typeof f.acceptance) => { x.build.network = "default" },
    (x: typeof f.acceptance) => { x.build.projectId = "other" },
    (x: typeof f.acceptance) => { x.build.credentialsDelegatedToDatabase = true },
    (x: typeof f.acceptance) => { x.result.verifiedAt = new Date(now + day).toISOString() },
    (x: typeof f.acceptance) => { x.result.projectRef = "other" },
    (x: typeof f.acceptance) => { x.result.runId = "other" },
    (x: typeof f.acceptance) => { x.result.runtime = "other" },
    (x: typeof f.acceptance) => { x.result.productionConnections = 1 },
    (x: typeof f.acceptance) => { x.result.unaccountedTocEntries = 1 }]) {
    const value = structuredClone(f.acceptance); change(value)
    const result = getPostgresRecoveryMaintenanceCheck({ ...f.runtime, POSTGRES_BACKUP_RECOVERY_MAINTENANCE_JSON: JSON.stringify(f.record(value)) }, now)!
    assert.equal(result.details?.notificationEligible, false); assert.equal(result.details?.operatorCheckedAt, null)
  }
})
