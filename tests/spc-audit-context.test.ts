import assert from "node:assert/strict"
import test from "node:test"
import { undoAuditLog } from "../lib/auditLog"
import type { SpcSession } from "../lib/spcAuth"
import {
  buildSpcUserManagementAuditEvent,
  createSpcAuditContext,
  createSpcAuditHeaders,
  recordSpcUserManagementAuditEvent,
  type SpcAuditContext,
} from "../lib/spcAudit"

const REQUEST_ID = "11111111-1111-4111-8111-111111111111"

function session(): SpcSession {
  return {
    authenticated: true,
    username: "admin@example.com",
    displayName: "SPC ADMINISTRATOR",
    role: "ADMIN",
    office: "HONG KONG",
    mustChangePassword: false,
    permissions: {},
  }
}

function auditContext(
  input: Partial<SpcAuditContext> = {},
): SpcAuditContext {
  return {
    username: "admin@example.com",
    displayName: "SPC ADMINISTRATOR",
    role: "ADMIN",
    actorRole: "ADMIN",
    pageId: "spc-user-management",
    pageLabel: "SPC USER MANAGEMENT",
    pagePath: "/spc/usermanagement",
    sourceIp: "203.0.113.19",
    correlationId: REQUEST_ID,
    requestId: REQUEST_ID,
    platformRequestId: "hkg1::iad1::request-123",
    action: "update-user",
    targetType: "spc-user",
    targetId: "user-123",
    targetUsername: "buyer@example.com",
    outcome: "success",
    approvalReference: "CHANGE-2042",
    passwordChanged: true,
    ...input,
  }
}

test("SPC audit context generates correlation and action metadata before a write", () => {
  const context = createSpcAuditContext(
    session(),
    new Request("https://spc.fcuno.com/api/spc/users", {
      headers: { referer: "https://spc.fcuno.com/spc/usermanagement" },
    }),
    "spc-user-management",
    {
      action: "create-user",
      targetType: "spc-user",
      targetUsername: "new.user@example.com",
      outcome: "success",
    },
  )

  assert.match(context.requestId, /^[0-9a-f-]{36}$/i)
  assert.equal(context.correlationId, context.requestId)
  assert.equal(context.action, "create-user")
  assert.equal(context.targetUsername, "new.user@example.com")
  assert.equal(context.actorRole, "ADMIN")
  assert.equal(context.pagePath, "/spc/usermanagement")
})

test("audited Supabase headers carry investigation and safe password-change metadata", () => {
  const headers = createSpcAuditHeaders(auditContext())

  assert.equal(headers["x-bunker-admin-user"], "spc:admin@example.com")
  assert.equal(headers["x-bunker-audit-source-ip"], "203.0.113.19")
  assert.equal(headers["x-bunker-audit-correlation-id"], REQUEST_ID)
  assert.equal(headers["x-bunker-audit-request-id"], REQUEST_ID)
  assert.equal(headers["x-bunker-audit-platform-request-id"], "hkg1::iad1::request-123")
  assert.equal(headers["x-bunker-audit-actor-role"], "ADMIN")
  assert.equal(headers["x-bunker-audit-action"], "update-user")
  assert.equal(headers["x-bunker-audit-target-type"], "spc-user")
  assert.equal(headers["x-bunker-audit-target-id"], "user-123")
  assert.equal(headers["x-bunker-audit-target-username"], "buyer@example.com")
  assert.equal(headers["x-bunker-audit-outcome"], "success")
  assert.equal(headers["x-bunker-audit-approval-reference"], "CHANGE-2042")
  assert.equal(headers["x-bunker-audit-password-changed"], "true")
})

test("synthetic denied events contain only allowlisted investigation metadata", () => {
  const event = buildSpcUserManagementAuditEvent(
    auditContext({ outcome: "denied", passwordChanged: false }),
    { operation: "UPDATE", errorCode: "admin-required" },
  )

  assert.equal(event.table_schema, "app")
  assert.equal(event.table_name, "spc_user_management_events")
  assert.equal(event.after_row.outcome, "denied")
  assert.equal(event.after_row.errorCode, "admin-required")
  assert.equal(event.request_context.sourceIp, "203.0.113.19")
  assert.equal(event.request_context.correlationId, REQUEST_ID)
  assert.equal(event.request_context.targetUsername, "buyer@example.com")
  assert.doesNotMatch(JSON.stringify(event), /credential-value|bearer-value|raw-db-message/i)
  assert.throws(
    () =>
      buildSpcUserManagementAuditEvent(
        auditContext({ outcome: "denied" }),
        { operation: "UPDATE", errorCode: "invalid\nraw-db-message" },
      ),
    /Invalid audit event code/,
  )
  assert.throws(
    () =>
      buildSpcUserManagementAuditEvent(auditContext(), {
        operation: "UPDATE",
        errorCode: "unexpected",
      }),
    /only for failed or denied/,
  )
})

test("synthetic audit insertion fails loudly without exposing the database response", async () => {
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const previousFetch = globalThis.fetch
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://audit-test.supabase.co"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key"
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: "raw-db-message credential-value" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })

  try {
    await assert.rejects(
      recordSpcUserManagementAuditEvent(
        auditContext({ outcome: "failed", passwordChanged: false }),
        { operation: "UPDATE", errorCode: "write-failed" },
      ),
      (error: unknown) => {
        assert.match(String(error), new RegExp(REQUEST_ID))
        assert.doesNotMatch(String(error), /raw-db-message|credential-value/)
        return true
      },
    )
  } finally {
    globalThis.fetch = previousFetch
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey
  }
})

test("SPC undo RPC carries the same trusted investigation headers", async () => {
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const previousFetch = globalThis.fetch
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://audit-test.supabase.co"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key"

  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    assert.equal(
      request.headers.get("x-bunker-audit-correlation-id"),
      REQUEST_ID,
    )
    assert.equal(request.headers.get("x-bunker-audit-source-ip"), "203.0.113.19")
    assert.equal(request.headers.get("x-bunker-audit-action"), "update-user")
    assert.equal(request.headers.get("x-bunker-audit-outcome"), "success")
    return new Response(JSON.stringify("undo-log-id"), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  try {
    const undoLogId = await undoAuditLog(
      "99999999-9999-4999-8999-999999999999",
      {
        username: "spc:admin@example.com",
        displayName: "SPC ADMINISTRATOR",
      },
      auditContext(),
    )
    assert.equal(undoLogId, "undo-log-id")
  } finally {
    globalThis.fetch = previousFetch
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey
  }
})
