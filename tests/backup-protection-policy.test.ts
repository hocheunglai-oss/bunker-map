import assert from "node:assert/strict"
import test from "node:test"
import { backupDeadlineForFileChange, backupDueWindow, evaluateDatabaseBackupProtection, unknownBackupProtection, type BackupProtectionGap } from "../lib/backupProtectionPolicy"

const ms = Date.parse
const morning = ms("2026-10-15T08:30:00+08:00")
const gap = (key: string, due: string): BackupProtectionGap => ({ key, firstDueAt: due, firstUncoveredAt: "2026-10-14T08:30:00+08:00" })
const db = (input: Partial<Parameters<typeof evaluateDatabaseBackupProtection>[0]> = {}) => evaluateDatabaseBackupProtection({
  now: morning, receiptCreatedAt: "2026-10-15T03:10:00+08:00", inventoryCurrent: true, ...input,
})

test("closed protection window switches only at06:15, not06:00", () => {
  const before = backupDueWindow(ms("2026-10-15T06:14:59.999+08:00"))
  const exact = backupDueWindow(ms("2026-10-15T06:15:00+08:00"))
  assert.equal(before.deadlineAt, ms("2026-10-14T06:15:00+08:00"))
  assert.equal(exact.deadlineAt, ms("2026-10-15T06:15:00+08:00"))
  assert.equal(exact.snapshotAt, ms("2026-10-15T02:00:00+08:00"))
  assert.equal(exact.databaseFinalAttemptAt, ms("2026-10-15T05:02:00+08:00"))
  assert.equal(exact.databaseEarliestReceiptAt, ms("2026-10-14T23:02:00+08:00"))
})

test("database manual receipts honor all three six-hour retry reuse opportunities", () => {
  for (const created of ["2026-10-14T23:02:00+08:00", "2026-10-15T00:01:00+08:00", "2026-10-15T05:15:20+08:00"]) {
    const result = db({ receiptCreatedAt: created })
    assert.equal(result.details.notificationEligible, false, created)
    assert.equal(result.details.incidentResolved, true, created)
  }
  assert.equal(db({ receiptCreatedAt: "2026-10-14T23:01:59.999+08:00" }).details.notificationEligible, true)
})

test("database missed availability warns once eligible and raises severity after48h", () => {
  assert.equal(db({ receiptCreatedAt: "2026-10-14T03:10:00+08:00" }).details.alertLevel, 1)
  const old = db({ receiptCreatedAt: "2026-10-13T03:10:00+08:00" })
  assert.equal(old.status, "error")
  assert.equal(old.details.alertLevel, 2)
  assert.equal(old.details.notificationEligible, true)
})

test("zero restore points retain their first observed due clock instead of restarting each day", () => {
  const result = db({ receiptCreatedAt: null, inventoryCurrent: null, gaps: [gap("availability", "2026-10-13T06:15:00+08:00")] })
  assert.equal(result.details.alertLevel, 2)
  assert.equal(result.details.incidentResolved, false)
})

test("new schema mismatch waits for the next deadline, durable mismatch cannot postpone it", () => {
  const pending = db({ inventoryCurrent: false })
  assert.equal(pending.details.notificationEligible, false)
  assert.equal(pending.details.incidentResolved, false)
  assert.equal(pending.details.schemaBackupDeadline, "2026-10-15T22:15:00.000Z")
  const overdue = db({ inventoryCurrent: false, gaps: [gap("inventory", "2026-10-15T06:15:00+08:00")] })
  assert.equal(overdue.details.notificationEligible, true)
  assert.equal(overdue.details.alertLevel, 1)
  assert.equal(db({ inventoryCurrent: false, gaps: [gap("inventory", "2026-10-13T06:15:00+08:00")] }).details.alertLevel, 2)
})

test("unverified leftovers and incomplete old provenance are advice, not loss of verified protection", () => {
  const result = db({ advisory: true })
  assert.equal(result.status, "warning")
  assert.equal(result.details.notificationEligible, false)
  assert.equal(result.details.incidentResolved, true)
})

test("file timestamps at and just after02:00 select the correct future snapshot plus grace", () => {
  assert.equal(backupDeadlineForFileChange(ms("2026-10-15T02:00:00+08:00")), ms("2026-10-15T06:15:00+08:00"))
  assert.equal(backupDeadlineForFileChange(ms("2026-10-15T02:00:00.001+08:00")), ms("2026-10-16T06:15:00+08:00"))
})

test("unknown backup protection is not called corruption, does not alert or recover", () => {
  const result = unknownBackupProtection()
  assert.equal(result.status, "warning")
  assert.equal(result.details.notificationEligible, false)
  assert.equal(result.details.incidentResolved, false)
  assert.doesNotMatch(result.message, /corrupt|failed|lost/i)
})
