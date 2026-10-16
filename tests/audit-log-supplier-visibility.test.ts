import assert from "node:assert/strict"
import test from "node:test"
import type { AuditLogRecord } from "../lib/auditLog"
import { createAuditConsumers, supplierAuditRow, supplierAuditActor } from "./fixtures/audit-log-consumers.mjs"

const id = "11111111-1111-4111-8111-111111111111"
function eligibilityRecord(tableName: string, key?: string): AuditLogRecord {
  return { id, occurredAt: "2026-10-16T03:00:00.000Z", actorUserId: supplierAuditActor.userId,
    actorId: `spc:${supplierAuditActor.username}`, actorName: supplierAuditActor.displayName, actorSource: "app",
    tableSchema: "public", tableName, operation: "UPDATE", recordPk: key ? { key } : { id }, changedFields: ["payload"],
    beforeRow: key ? { key } : { id }, afterRow: key ? { key } : { id }, requestContext: {},
    undoOfLogId: null, undoneAt: null, undoneByLogId: null }
}
test("actual supplier RPC audit shape is visible in SPC list and detail without exposing whole-store undo", async () => {
  for (const operation of ["INSERT", "UPDATE"]) {
    const app = createAuditConsumers({ rows: [supplierAuditRow(id, operation)] })
    const list = await app.request("spc", "?page=spc-suppliers")
    assert.equal(list.status, 200); assert.equal(list.body.logs.length, 1)
    assert.equal(list.body.logs[0].id, id); assert.equal(list.body.logs[0].pageId, "spc-suppliers")
    assert.equal(list.body.logs[0].actorUserId, supplierAuditActor.userId)
    assert.equal(list.body.logs[0].summary, "Saved supplier details.")
    assert.equal(list.body.logs[0].undoable, false); assert.equal(list.body.logs[0].detailsLoaded, false)
    const detail = await app.request("spc", `?id=${id}`)
    assert.equal(detail.status, 200); assert.equal(detail.body.log.id, id)
    assert.equal(detail.body.log.undoable, false); assert.equal(detail.body.log.detailsLoaded, true)
    assert.equal(detail.body.log.summary, "Saved supplier details.")
    assert.equal(app.undoCalls(), 0)
  }
})
test("supplier summaries use the recorded action and validated target, never the first supplier in a whole-store snapshot", async () => {
  const summaries = { save: "Saved supplier details.", delete: "Deleted supplier.", "save-barges": "Updated supplier barges.", "save-contacts": "Updated supplier contacts." }
  const targeted = { save: 'Saved supplier "EDITED SUPPLIER".', delete: 'Deleted supplier "EDITED SUPPLIER".', "save-barges": 'Updated barges for supplier "EDITED SUPPLIER".', "save-contacts": 'Updated contacts for supplier "EDITED SUPPLIER".' }
  for (const action of Object.keys(summaries) as Array<keyof typeof summaries>) {
    for (const operation of ["INSERT", "UPDATE"]) {
      for (const withTarget of [false, true]) {
        const row = supplierAuditRow(id, operation)
        row.request_context = { ...row.request_context, supplierAction: action, ...(withTarget ? { targetType: "supplier", targetId: " EDITED SUPPLIER " } : {}) }
        const app = createAuditConsumers({ rows: [row] })
        const expected = withTarget ? targeted[action] : summaries[action]
        assert.equal((await app.request("spc")).body.logs[0].summary, expected)
        assert.equal((await app.request("spc", `?id=${id}`)).body.log.summary, expected)
      }
    }
  }
  for (const action of [undefined, null, {}, 12, "unknown"]) {
    const row = supplierAuditRow(id)
    row.request_context = { supplierAction: action }
    const app = createAuditConsumers({ rows: [row] })
    const result = (await app.request("spc")).body.logs[0]
    assert.equal(result.summary, "Supplier data updated."); assert.equal(result.pageId, "spc-suppliers")
    assert.doesNotMatch(result.summary, /Synthetic|calendar|shared store/)
  }
  for (const metadata of [{ targetType: "user", targetId: "WRONG" }, { targetType: "supplier", targetId: {} }, { targetType: "supplier", targetId: "\nFAKE" }, { targetType: "supplier", targetId: "X".repeat(181) }]) {
    const row = supplierAuditRow(id)
    row.request_context = { ...row.request_context, ...metadata }
    assert.equal((await createAuditConsumers({ rows: [row] }).request("spc")).body.logs[0].summary, "Saved supplier details.")
  }
})
test("supplier audit visibility remains SPC-only and unknown store keys stay excluded", async () => {
  const app = createAuditConsumers({ rows: [supplierAuditRow(id)] })
  assert.equal((await app.request("www")).body.logs.length, 0)
  assert.equal((await app.request("www", `?id=${id}`)).status, 404)
  const unknown = supplierAuditRow(id); unknown.after_row.key = "unrelated-store"; unknown.before_row!.key = "unrelated-store"
  const isolated = createAuditConsumers({ rows: [unknown] })
  assert.equal((await isolated.request("spc")).body.logs.length, 0)
  assert.equal((await isolated.request("spc", `?id=${id}`)).status, 404)
})
test("direct API attempts cannot undo the whole supplier store even with SPC Audit Edit", async () => {
  for (const operation of ["INSERT", "UPDATE"]) {
    const app = createAuditConsumers({ rows: [supplierAuditRow(id, operation)] })
    const denied = await app.request("spc", "", "POST", { action: "undo", id })
    assert.equal(denied.status, 400); assert.match(denied.body.message, /management page/)
    assert.equal(app.undoCalls(), 0)
    assert.equal((await app.request("www", "", "POST", { action: "undo", id })).status, 404)
    assert.equal(app.undoCalls(), 0)
  }
})
test("supplier visibility preserves sign-in and View/Edit permission guards before data reads or undo", async () => {
  for (const options of [{ signedIn: false }, { permission: "none" }]) {
    for (const scope of ["spc", "www"]) {
      const app = createAuditConsumers({ rows: [supplierAuditRow(id)], ...options })
      assert.equal((await app.request(scope)).status, options.signedIn === false ? 401 : 403)
      assert.equal((await app.request(scope, "", "POST", { action: "undo", id })).status, options.signedIn === false ? 401 : 403)
      assert.equal(app.reads(), 0); assert.equal(app.undoCalls(), 0)
    }
  }
  const view = createAuditConsumers({ rows: [supplierAuditRow(id)], permission: "view", role: "BUYER TRADER" })
  assert.equal((await view.request("spc", `?id=${id}`)).status, 200)
  assert.equal((await view.request("spc", "", "POST", { action: "undo", id })).status, 403)
  assert.equal(view.undoCalls(), 0)
})
test("known protected undo guards remain intact while ordinary single-row undo is not disabled", async () => {
  const app = createAuditConsumers({ rows: [] })
  for (const key of ["event-calendar", "task-calendar", "spc-permission-groups", "spc-supplier-overrides"]) {
    assert.equal(app.audit.canUndoAuditLogRecord(eligibilityRecord("office_calendar_store", key)), false)
  }
  for (const tableName of ["admin_users", "spc_users", "spc_user_management_events"]) {
    assert.equal(app.audit.canUndoAuditLogRecord(eligibilityRecord(tableName)), false)
  }
  const ordinary = { ...supplierAuditRow(id), actor_id: "synthetic-admin", table_name: "phonebook_companies", record_pk: { id }, before_row: { id, name: "BEFORE" }, after_row: { id, name: "AFTER" }, request_context: { pageId: "phonebook" } }
  const control = createAuditConsumers({ rows: [ordinary] })
  assert.equal((await control.request("www", `?id=${id}`)).body.log.undoable, true)
  assert.equal((await control.request("www", "", "POST", { action: "undo", id })).status, 200)
  assert.equal(control.undoCalls(), 1)
})
