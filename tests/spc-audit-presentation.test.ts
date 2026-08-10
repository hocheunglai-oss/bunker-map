import assert from "node:assert/strict"
import test from "node:test"
import {
  presentAuditLogs,
  redactSpcUserManagementInvestigation,
  type AuditLogRecord,
  type AuditOperation,
} from "../lib/auditLog"
import { SPC_PAGE_DEFINITIONS } from "../lib/spcPages"

function auditRecord(input: {
  tableName: string
  tableSchema?: string
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
    actorUserId: "22222222-2222-4222-8222-222222222222",
    actorId: "spc:otto@cosulich.com.hk",
    actorName: "OTTO LAI",
    actorSource: "app",
    tableSchema: input.tableSchema || "public",
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
  assert.equal(presented.undoable, false)
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

test("SPC password changes are described without storing the credential hash", async () => {
  const [presented] = await presentAuditLogs(
    [
      auditRecord({
        tableName: "spc_users",
        operation: "UPDATE",
        recordPk: { id: "user-1" },
        changedFields: [],
        beforeRow: { id: "user-1", display_name: "FILIPPO MATTIOLI" },
        afterRow: { id: "user-1", display_name: "FILIPPO MATTIOLI" },
        requestContext: {
          pageId: "spc-user-management",
          pageLabel: "SPC USER MANAGEMENT",
          pagePath: "/spc/usermanagement",
          passwordChanged: true,
        },
      }),
    ],
    SPC_PAGE_DEFINITIONS,
  )

  assert.equal(presented.summary, 'Changed password for SPC user "FILIPPO MATTIOLI".')
  assert.deepEqual(presented.details, ["Changed the password."])
})

test("failed SPC user-management events expose investigation references without secrets", async () => {
  const [presented] = await presentAuditLogs(
    [
      auditRecord({
        tableName: "spc_user_management_events",
        operation: "UPDATE",
        recordPk: {
          requestId: "11111111-1111-4111-8111-111111111111",
          targetType: "spc-user",
          targetId: "user-1",
        },
        afterRow: {
          schema: "fcuno.spc-user-management-audit/v1",
          action: "update-user",
          outcome: "denied",
          errorCode: "admin-required",
          targetType: "spc-user",
          targetId: "user-1",
          targetUsername: "buyer@example.com",
        },
        requestContext: {
          pageId: "spc-user-management",
          pageLabel: "SPC USER MANAGEMENT",
          pagePath: "/spc/usermanagement",
          sourceIp: "203.0.113.19",
          correlationId: "11111111-1111-4111-8111-111111111111",
          requestId: "11111111-1111-4111-8111-111111111111",
          platformRequestId: "hkg1::iad1::request-123",
          actorRole: "BUYER TRADER",
          action: "update-user",
          targetType: "spc-user",
          targetId: "user-1",
          targetUsername: "buyer@example.com",
          outcome: "denied",
          approvalReference: "CHANGE-2042",
        },
      }),
    ],
    SPC_PAGE_DEFINITIONS,
  )

  assert.equal(presented.pageId, "spc-user-management")
  assert.equal(presented.recordLabel, "buyer@example.com")
  assert.equal(presented.summary, 'Denied update user for "buyer@example.com".')
  assert.equal(presented.auditOutcome, "denied")
  assert.equal(presented.auditAction, "update-user")
  assert.equal(presented.sourceIp, "203.0.113.19")
  assert.equal(presented.errorCode, "admin-required")
  assert.equal(presented.undoable, false)
  assert.ok(presented.details.includes("Outcome: DENIED."))
  assert.ok(presented.details.includes("Source IP: 203.0.113.19."))
  assert.ok(
    presented.details.includes(
      "Correlation ID: 11111111-1111-4111-8111-111111111111.",
    ),
  )
  assert.ok(presented.details.includes("Vercel request ID: hkg1::iad1::request-123."))
  assert.ok(presented.details.includes("Error code: admin-required."))
  assert.doesNotMatch(JSON.stringify(presented), /password_hash|credential-value|token-value/)
})

test("SPC user-management investigation identifiers are visible only to administrators", async () => {
  const [presented] = await presentAuditLogs(
    [
      auditRecord({
        tableName: "spc_user_management_events",
        operation: "UPDATE",
        recordPk: {
          requestId: "55555555-5555-4555-8555-555555555555",
          targetType: "spc-user",
        },
        afterRow: {
          schema: "fcuno.spc-user-management-audit/v1",
          action: "change-password",
          outcome: "failed",
          errorCode: "invalid_request",
          targetType: "spc-user",
        },
        requestContext: {
          pageId: "spc-user-management",
          pageLabel: "SPC USER MANAGEMENT",
          pagePath: "/spc/usermanagement",
          sourceIp: "203.0.113.21",
          correlationId: "55555555-5555-4555-8555-555555555555",
          requestId: "55555555-5555-4555-8555-555555555555",
          platformRequestId: "hkg1::restricted-request",
          actorRole: "BUYER TRADER",
          action: "change-password",
          targetType: "spc-user",
          outcome: "failed",
        },
      }),
    ],
    SPC_PAGE_DEFINITIONS,
  )

  const normalUserView = redactSpcUserManagementInvestigation(presented, false)
  assert.equal(normalUserView.sourceIp, null)
  assert.equal(normalUserView.correlationId, null)
  assert.equal(normalUserView.requestId, null)
  assert.equal(normalUserView.platformRequestId, null)
  assert.doesNotMatch(
    JSON.stringify(normalUserView.details),
    /203\.0\.113\.21|55555555-5555-4555-8555-555555555555|restricted-request/,
  )

  const adminView = redactSpcUserManagementInvestigation(presented, true)
  assert.equal(adminView.sourceIp, "203.0.113.21")
  assert.equal(
    adminView.correlationId,
    "55555555-5555-4555-8555-555555555555",
  )
  assert.equal(adminView.platformRequestId, "hkg1::restricted-request")
  assert.ok(adminView.details.includes("Source IP: 203.0.113.21."))
})

test("WhatsApp MFA audit presents the outcome without OTP or full-phone data", async () => {
  const [presented] = await presentAuditLogs(
    [
      auditRecord({
        tableSchema: "app",
        tableName: "spc_mfa_test_events",
        operation: "INSERT",
        recordPk: {
          requestId: "11111111-1111-4111-8111-111111111111",
          challengeId: "44444444-4444-4444-8444-444444444444",
          status: "delivery_accepted",
        },
        changedFields: ["status", "outcome"],
        afterRow: {
          schema: "fcuno.spc-whatsapp-mfa-test-audit/v1",
          title: "WhatsApp MFA test",
          action: "send-whatsapp-mfa-test-code",
          status: "delivery_accepted",
          outcome: "success",
          target_id: "22222222-2222-4222-8222-222222222222",
          target_username: "MFA_TEST",
          phone_hint: "+85•••••4567",
          whatsapp_message_id: "wamid.test-123",
        },
        requestContext: {
          pageId: "spc-mfa-test",
          pageLabel: "SPC MFA TEST",
          pagePath: "/spc/mfa-test",
          actorRole: "ADMIN",
          action: "send-whatsapp-mfa-test-code",
          outcome: "success",
          targetType: "spc-user",
          targetId: "22222222-2222-4222-8222-222222222222",
          targetUsername: "MFA_TEST",
        },
      }),
    ],
    SPC_PAGE_DEFINITIONS,
  )

  assert.equal(presented.pageId, "spc-mfa-test")
  assert.equal(presented.pageLabel, "SPC MFA TEST")
  assert.equal(
    presented.summary,
    "WhatsApp accepted the MFA test code for MFA_TEST.",
  )
  assert.equal(presented.undoable, false)
  assert.ok(presented.details.includes("Masked WhatsApp destination: +85•••••4567."))
  assert.ok(presented.details.includes("WhatsApp message ID: wamid.test-123."))
  assert.doesNotMatch(
    JSON.stringify(presented),
    /85291234567|004219|code_hash|access_token/i,
  )
})

test("every WhatsApp MFA lifecycle status keeps the ADMIN page and masked-only details", async () => {
  const cases = [
    ["challenge_created", "success", /Created a WhatsApp MFA test challenge/],
    ["delivery_accepted", "success", /WhatsApp accepted the MFA test code/],
    ["delivery_failed", "failed", /could not confirm WhatsApp accepted/],
    ["activation_failed", "failed", /could not activate/],
    ["verification_requested", "success", /Started WhatsApp MFA test verification/],
    ["verified", "success", /Verified the WhatsApp MFA test code/],
    ["mismatch", "failed", /incorrect WhatsApp MFA test code/],
    ["locked", "failed", /Locked the WhatsApp MFA test challenge/],
    ["expired", "failed", /expired WhatsApp MFA test code/],
    ["already_used", "failed", /reused WhatsApp MFA test code/],
    ["unavailable", "failed", /unavailable WhatsApp MFA test challenge/],
  ] as const

  for (const [status, outcome, expectedSummary] of cases) {
    const [presented] = await presentAuditLogs(
      [
        auditRecord({
          tableSchema: "app",
          tableName: "spc_mfa_test_events",
          operation: "INSERT",
          recordPk: {
            requestId: "11111111-1111-4111-8111-111111111111",
            challengeId: "44444444-4444-4444-8444-444444444444",
            status,
          },
          changedFields: ["status", "outcome"],
          afterRow: {
            schema: "fcuno.spc-whatsapp-mfa-test-audit/v1",
            title: "WhatsApp MFA test",
            action: status === "verification_requested" || [
              "verified",
              "mismatch",
              "locked",
              "expired",
              "already_used",
              "unavailable",
            ].includes(status)
              ? "verify-whatsapp-mfa-test-code"
              : "send-whatsapp-mfa-test-code",
            status,
            outcome,
            target_id: "22222222-2222-4222-8222-222222222222",
            target_username: "MFA_TEST",
            phone_hint: "+85•••••4567",
          },
          requestContext: {
            pageId: "spc-mfa-test",
            pageLabel: "SPC MFA TEST",
            pagePath: "/spc/mfa-test",
            actorRole: "ADMIN",
            outcome,
          },
        }),
      ],
      SPC_PAGE_DEFINITIONS,
    )

    assert.equal(presented.pageId, "spc-mfa-test")
    assert.equal(presented.pageLabel, "SPC MFA TEST")
    assert.equal(presented.undoable, false)
    assert.match(presented.summary, expectedSummary)
    assert.ok(presented.details.includes("Masked WhatsApp destination: +85•••••4567."))
    assert.doesNotMatch(JSON.stringify(presented), /85291234567|004219|code_hash/i)
  }
})
