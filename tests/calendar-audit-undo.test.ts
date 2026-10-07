import assert from "node:assert/strict"
import test from "node:test"
import { canUndoAuditLogRecord, type AuditLogRecord } from "../lib/auditLog"

function record(fields: Partial<AuditLogRecord> = {}): AuditLogRecord {
  return {
    id: "audit-1", occurredAt: "2026-10-07T10:00:00.000Z",
    actorUserId: null, actorId: "admin", actorName: "Administrator", actorSource: "app",
    tableSchema: "public", tableName: "office_calendar_store", operation: "UPDATE",
    recordPk: {}, changedFields: ["payload"], beforeRow: null, afterRow: null,
    requestContext: {}, undoOfLogId: null, undoneAt: null, undoneByLogId: null,
    ...fields,
  }
}

test("Task and Event Calendar snapshot undo stays unavailable for every audit operation", () => {
  for (const key of ["task-calendar", "event-calendar", "spc-permission-groups"]) {
    assert.equal(canUndoAuditLogRecord(record({ operation: "INSERT", afterRow: { key } })), false)
    assert.equal(canUndoAuditLogRecord(record({ operation: "UPDATE", afterRow: { key }, beforeRow: { key } })), false)
    assert.equal(canUndoAuditLogRecord(record({ operation: "DELETE", beforeRow: { key } })), false)
    assert.equal(canUndoAuditLogRecord(record({ recordPk: { key } })), false)
  }
})

test("snapshot-undo exclusion does not disable unrelated records", () => {
  assert.equal(canUndoAuditLogRecord(record({ afterRow: { key: "unrelated-store" } })), true)
  assert.equal(canUndoAuditLogRecord(record({ tableName: "phonebook_contacts", recordPk: { id: "contact-1" } })), true)
})
