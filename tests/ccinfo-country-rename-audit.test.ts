import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"
import {
  approvedCountryLabelNormalizationUndoMessage,
  canUndoAuditLogRecord,
  isUserAuditRecord,
  matchesAuditScope,
  presentAuditLogs,
  type AuditLogRecord,
} from "../lib/auditLog"

function record(fields: Partial<AuditLogRecord> = {}): AuditLogRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    occurredAt: "2026-10-12T10:00:00.000Z",
    actorUserId: null, actorId: "SYNTHETIC ADMIN", actorName: "Synthetic Admin", actorSource: "header",
    tableSchema: "public", tableName: "cc_countries", operation: "UPDATE",
    recordPk: { id: "22222222-2222-4222-8222-222222222222" },
    changedFields: ["name"], beforeRow: { name: "SYNTHETIC OLD COUNTRY" }, afterRow: { name: "SYNTHETIC NEW COUNTRY" },
    requestContext: { pageId: "ccinfo", action: "ccinfo_country_rename" },
    undoOfLogId: null, undoneAt: null, undoneByLogId: null,
    ...fields,
  }
}

test("atomic country rename audit rows cannot be undone independently, including index previews", () => {
  for (const tableName of ["cc_countries", "cc_ports"]) {
    assert.equal(canUndoAuditLogRecord(record({ tableName })), false)
    assert.equal(canUndoAuditLogRecord(record({ tableName, beforeRow: null, afterRow: null, changedFields: [] })), false)
  }
})

test("rename exclusion leaves ordinary CCINFO content and unrelated audit undo unchanged", () => {
  for (const tableName of ["cc_countries", "cc_ports", "cc_companies"]) {
    assert.equal(canUndoAuditLogRecord(record({ tableName, requestContext: { pageId: "ccinfo" }, changedFields: ["notes"] })), true)
    assert.equal(canUndoAuditLogRecord(record({ tableName, requestContext: { pageId: "ccinfo", action: "update_content" } })), true)
  }
  assert.equal(canUndoAuditLogRecord(record({ tableName: "cc_companies" })), true)
  assert.equal(canUndoAuditLogRecord(record({ tableSchema: "unrelated_schema" })), true)
  assert.equal(canUndoAuditLogRecord(record({ tableName: "phonebook_contacts" })), true)
})

test("approved country-label normalization stays visible but cannot undo to its inconsistent old label", async () => {
  const normalization = record({
    tableName: "cc_ports",
    actorId: "codex-maintenance", actorName: "Approved maintenance", actorSource: "app",
    changedFields: ["country_name"],
    beforeRow: { name: "SYNTHETIC PORT", country_name: "OLD INCONSISTENT LABEL" },
    afterRow: { name: "SYNTHETIC PORT", country_name: "CANONICAL COUNTRY" },
    requestContext: { pageId: "ccinfo", action: "approved_country_label_normalization" },
  })
  assert.equal(canUndoAuditLogRecord(normalization), false)
  assert.equal(canUndoAuditLogRecord({ ...normalization, beforeRow: null, afterRow: null, changedFields: [] }), false)
  for (const unrelated of [
    { ...normalization, tableName: "cc_countries" },
    { ...normalization, tableName: "cc_companies" },
    { ...normalization, tableName: "phonebook_contacts" },
    { ...normalization, tableSchema: "unrelated_schema" },
    { ...normalization, requestContext: { pageId: "ccinfo", action: "approved_country_label_normalization_other" } },
    { ...normalization, requestContext: { pageId: "ccinfo", action: "update_content" } },
  ]) assert.equal(canUndoAuditLogRecord(unrelated), true)
  const presented = await presentAuditLogs([normalization], [
    { id: "ccinfo", label: "CCINFO", group: "Trading Tools", path: "/admin/ccinfo" },
  ])
  assert.equal(presented.length, 1)
  assert.equal(presented[0].undoable, false)
  assert.equal(presented[0].auditAction, "approved_country_label_normalization")
  assert.match(presented[0].details.join(" "), /OLD INCONSISTENT LABEL/)
  assert.match(presented[0].details.join(" "), /CANONICAL COUNTRY/)
})

test("audit presentation disables Undo for both sides of a rename without hiding the history", async () => {
  const country = record()
  const port = record({
    tableName: "cc_ports",
    changedFields: ["country_name"],
    beforeRow: { name: "SYNTHETIC PORT", country_name: "SYNTHETIC OLD COUNTRY" },
    afterRow: { name: "SYNTHETIC PORT", country_name: "SYNTHETIC NEW COUNTRY" },
  })
  const ordinaryContent = record({ requestContext: { pageId: "ccinfo" }, changedFields: ["notes"] })
  const presented = await presentAuditLogs([country, port, ordinaryContent], [
    { id: "ccinfo", label: "CCINFO", group: "Trading Tools", path: "/admin/ccinfo" },
  ])
  assert.equal(presented.length, 3)
  assert.deepEqual(presented.map(item => item.undoable), [false, false, true])
  assert.equal(presented[0].auditAction, "ccinfo_country_rename")
  assert.equal(presented[1].auditAction, "ccinfo_country_rename")
  assert.match(presented[0].details.join(" "), /SYNTHETIC OLD COUNTRY/)
  assert.match(presented[1].details.join(" "), /SYNTHETIC NEW COUNTRY/)
})

const routeSource = readFileSync(new URL("../app/api/admin/audit-logs/route.ts", import.meta.url), "utf8")
const routeOutput = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function loadRoute(target: AuditLogRecord, permissionError?: "Unauthorized" | "Forbidden") {
  const calls = { read: 0, undo: 0, permissions: [] as Array<[string, string]> }
  const exports: Record<string, (request: Request) => Promise<Response>> = {}
  const dependencies: Record<string, unknown> = {
    "next/server": { NextResponse: Response },
    "@/lib/adminAuth": { requireAdminPagePermission: async (page: string, permission: string) => {
      calls.permissions.push([page, permission])
      if (permissionError) throw new Error(permissionError)
      return { username: "SYNTHETIC ADMIN", displayName: "Synthetic Admin", role: "ADMIN" }
    } },
    "@/lib/auditLog": {
      approvedCountryLabelNormalizationUndoMessage, canUndoAuditLogRecord, isUserAuditRecord, matchesAuditScope,
      getAuditLogRecord: async () => { calls.read++; return target },
      undoAuditLog: async () => { calls.undo++; return "synthetic-undo" },
    },
    "@/lib/adminPageDiscovery": {},
    "@/lib/adminUsers": {},
    "@/lib/serverTiming": {},
    "@/lib/auditBrowsing": { browseAuditLogs: () => assert.fail("Undo must not invoke list browsing") },
    "@/lib/auditBrowsingCursor": {},
    "@/lib/auditBrowsingSource": {},
    "@/lib/legacyAdminAuditFullList": { readLegacyAdminAuditFullList: () => assert.fail("Undo must not invoke legacy list browsing") },
  }
  vm.runInNewContext(routeOutput, {
    exports, Error, URL,
    require: (name: string) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
      return dependencies[name]
    },
  })
  return { exports, calls }
}

function undoRequest(clientFields: Record<string, unknown> = {}) {
  return new Request("https://audit-fixture.invalid/api/admin/audit-logs", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "undo", id: "11111111-1111-4111-8111-111111111111", ...clientFields }),
  })
}

test("actual audit route refuses partial rename undo before calling the database", async () => {
  for (const tableName of ["cc_countries", "cc_ports"]) {
    const { exports, calls } = loadRoute(record({ tableName }))
    const response = await exports.POST(undoRequest())
    assert.equal(response.status, 400)
    assert.equal((await response.json()).message, "This audit record cannot be undone.")
    assert.equal(calls.read, 1)
    assert.equal(calls.undo, 0)
    assert.deepEqual(calls.permissions, [["audit-log", "edit"]])
  }
})

test("actual audit route refuses persisted approved label-normalization undo before privileged RPC", async () => {
  const { exports, calls } = loadRoute(record({
    tableName: "cc_ports",
    actorId: "codex-maintenance", actorName: "Approved maintenance", actorSource: "app",
    changedFields: ["country_name"],
    requestContext: { pageId: "ccinfo", action: "approved_country_label_normalization" },
  }))
  const response = await exports.POST(undoRequest())
  assert.equal(response.status, 400)
  assert.equal((await response.json()).message, "This country label correction cannot be undone because the old label does not match its country.")
  assert.equal(calls.read, 1)
  assert.equal(calls.undo, 0)
  assert.deepEqual(calls.permissions, [["audit-log", "edit"]])
})

test("actual audit route bases normalization guard on saved evidence, not client-supplied audit fields", async () => {
  const protectedRecord = record({
    tableName: "cc_ports",
    requestContext: { pageId: "ccinfo", action: "approved_country_label_normalization" },
  })
  const protectedRoute = loadRoute(protectedRecord)
  const denied = await protectedRoute.exports.POST(undoRequest({
    tableName: "phonebook_contacts", requestContext: { action: "update_content" },
    beforeRow: null, afterRow: null, changedFields: [],
  }))
  assert.equal(denied.status, 400)
  assert.equal(protectedRoute.calls.undo, 0)

  const ordinaryRoute = loadRoute({ ...protectedRecord, requestContext: { pageId: "ccinfo", action: "update_content" } })
  const permitted = await ordinaryRoute.exports.POST(undoRequest({ requestContext: { action: "approved_country_label_normalization" } }))
  assert.equal(permitted.status, 200)
  assert.equal(ordinaryRoute.calls.undo, 1)
})

test("actual audit route still permits ordinary CCINFO undo and checks sign-in first", async () => {
  const { exports, calls } = loadRoute(record({ requestContext: { pageId: "ccinfo" }, changedFields: ["notes"] }))
  assert.equal((await exports.POST(undoRequest())).status, 200)
  assert.equal(calls.undo, 1)

  for (const [permissionError, status] of [["Unauthorized", 401], ["Forbidden", 403]] as const) {
    const denied = loadRoute(record(), permissionError)
    assert.equal((await denied.exports.POST(undoRequest())).status, status)
    assert.equal(denied.calls.read, 0)
    assert.equal(denied.calls.undo, 0)
  }
})
