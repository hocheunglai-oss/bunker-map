import assert from "node:assert/strict"
import test from "node:test"
import {
  presentAuditLogs,
  type AuditLogRecord,
  type AuditOperation,
} from "../lib/auditLog"
import { SPC_PAGE_DEFINITIONS } from "../lib/spcPages"

function auditRecord(input: {
  tableName: string
  operation: AuditOperation
  recordPk?: Record<string, unknown>
  changedFields?: string[]
  beforeRow?: Record<string, unknown> | null
  afterRow?: Record<string, unknown> | null
  requestContext?: Record<string, unknown>
}): AuditLogRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    occurredAt: "2026-08-03T10:15:00.000Z",
    actorId: "spc:otto@cosulich.com.hk",
    actorName: "OTTO LAI",
    actorSource: "app",
    tableSchema: "public",
    tableName: input.tableName,
    operation: input.operation,
    recordPk: input.recordPk || {},
    changedFields: input.changedFields || [],
    beforeRow: input.beforeRow ?? null,
    afterRow: input.afterRow ?? null,
    requestContext: input.requestContext || {},
    undoOfLogId: null,
    undoneAt: null,
    undoneByLogId: null,
  }
}

test("deleted SPC fixture audit identifies the vessel and deleted business fields", async () => {
  const [presented] = await presentAuditLogs(
    [
      auditRecord({
        tableName: "spc_fixtures",
        operation: "DELETE",
        recordPk: { id: "fixture-1" },
        beforeRow: {
          id: "fixture-1",
          vessel_name: "LONG PU 16",
          fixture_date: "2026-08-03",
          earliest_eta: "10 - 18 aug",
          supplier_name: "BP MARINE",
          supplier_trader_display_name: "OTTO LAI",
          buyer_trader_display_name: "MICHELLE ANTHONEY",
          account: "SINGAPORE",
          vlsfo: "230",
          price: "595",
          barging: "7",
        },
        requestContext: {
          pageId: "spc-fixtures",
          pageLabel: "SPC FIXTURES",
          pagePath: "/spc/fixtures",
        },
      }),
    ],
    SPC_PAGE_DEFINITIONS,
  )

  assert.equal(presented.pageId, "spc-fixtures")
  assert.equal(presented.recordLabel, "LONG PU 16")
  assert.equal(presented.summary, 'Deleted SPC fixture "LONG PU 16".')
  assert.ok(presented.details.includes('Deleted SPC fixture "LONG PU 16".'))
  assert.ok(presented.details.includes("supplier: BP MARINE."))
  assert.ok(presented.details.includes("supplier trader: OTTO LAI."))
  assert.ok(presented.details.includes("buyer trader: MICHELLE ANTHONEY."))
  assert.ok(presented.details.includes("VLSFO quantity: 230."))
})

test("SPC permission store audit is presented as user management with semantic changes", async () => {
  const beforePayload = {
    userRoles: [{ userId: "user-1", username: "michelle@example.com", role: "BUYER TRADER" }],
    userProfiles: [
      {
        userId: "user-1",
        username: "michelle@example.com",
        office: "HONG KONG",
        mustChangePassword: false,
      },
    ],
    groups: [
      {
        role: "SUPPLIER TRADER",
        permissions: { "spc-fixtures": "view" },
      },
    ],
    offices: ["HONG KONG", "SINGAPORE"],
  }
  const afterPayload = {
    userRoles: [{ userId: "user-1", username: "michelle@example.com", role: "ADMIN" }],
    userProfiles: [
      {
        userId: "user-1",
        username: "michelle@example.com",
        office: "SINGAPORE",
        mustChangePassword: true,
      },
    ],
    groups: [
      {
        role: "SUPPLIER TRADER",
        permissions: { "spc-fixtures": "edit" },
      },
    ],
    offices: ["HONG KONG", "SINGAPORE", "JAPAN"],
  }

  const [presented] = await presentAuditLogs(
    [
      auditRecord({
        tableName: "office_calendar_store",
        operation: "UPDATE",
        recordPk: { key: "spc-permission-groups" },
        changedFields: ["payload"],
        beforeRow: { key: "spc-permission-groups", payload: beforePayload },
        afterRow: { key: "spc-permission-groups", payload: afterPayload },
        requestContext: {
          pageId: "spc-user-management",
          pageLabel: "SPC USER MANAGEMENT",
          pagePath: "/spc/usermanagement",
        },
      }),
    ],
    SPC_PAGE_DEFINITIONS,
  )

  assert.equal(presented.pageId, "spc-user-management")
  assert.equal(presented.pageLabel, "SPC USER MANAGEMENT")
  assert.equal(presented.recordLabel, "SPC permission groups")
  assert.doesNotMatch(presented.summary, /calendar/i)
  assert.ok(
    presented.details.includes(
      "Changed michelle@example.com's role from BUYER TRADER to ADMIN.",
    ),
  )
  assert.ok(
    presented.details.includes(
      "Changed michelle@example.com's office from HONG KONG to SINGAPORE.",
    ),
  )
  assert.ok(
    presented.details.includes(
      "Changed SPC FIXTURES access for SUPPLIER TRADER from VIEW to EDIT.",
    ),
  )
  assert.ok(presented.details.includes("Added the JAPAN office."))
})

test("SPC user-management page is inferred from the record key in audit previews", async () => {
  const [presented] = await presentAuditLogs(
    [
      auditRecord({
        tableName: "office_calendar_store",
        operation: "UPDATE",
        recordPk: { key: "spc-permission-groups" },
        changedFields: ["payload"],
      }),
    ],
    SPC_PAGE_DEFINITIONS,
  )

  assert.equal(presented.pageId, "spc-user-management")
  assert.equal(presented.pageLabel, "SPC USER MANAGEMENT")
  assert.equal(presented.summary, "Updated SPC user management settings.")
  assert.doesNotMatch(presented.summary, /calendar/i)
})
