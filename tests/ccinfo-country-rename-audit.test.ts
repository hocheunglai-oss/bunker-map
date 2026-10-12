import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"
import {
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
      canUndoAuditLogRecord, isUserAuditRecord, matchesAuditScope,
      getAuditLogRecord: async () => { calls.read++; return target },
      undoAuditLog: async () => { calls.undo++; return "synthetic-undo" },
    },
    "@/lib/adminPageDiscovery": {},
    "@/lib/adminUsers": {},
    "@/lib/serverTiming": {},
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

function undoRequest() {
  return new Request("https://audit-fixture.invalid/api/admin/audit-logs", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "undo", id: "11111111-1111-4111-8111-111111111111" }),
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
