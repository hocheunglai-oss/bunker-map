import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  SpcMfaTestDeliveryError,
  buildSpcMfaAuthenticationMessage,
  buildSpcMfaTestAuditEvent,
  generateSpcMfaTestCode,
  hashSpcMfaTestCode,
  isSameOriginSpcMfaTestRequest,
  isSpcMfaTestConfigured,
  maskSpcWhatsappPhone,
  sendSpcMfaTestCode,
} from "../lib/spcMfaTest"
import type { SpcAuditContext } from "../lib/spcAudit"
import { hasSpcAdminPagePermission, type SpcSession } from "../lib/spcAuth"
import {
  constrainSpcPermissionForRole,
  getDefaultSpcPermissionsForRole,
} from "../lib/spcPages"

const CHALLENGE_ID = "11111111-1111-4111-8111-111111111111"
const TARGET_ID = "22222222-2222-4222-8222-222222222222"
const ACTOR_ID = "33333333-3333-4333-8333-333333333333"
const TEST_SECRET = "s".repeat(48)

function restoreEnvironment(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function adminSession(role = "ADMIN"): SpcSession {
  return {
    authenticated: true,
    userId: ACTOR_ID,
    username: "admin@example.com",
    displayName: "SPC ADMIN",
    role,
    office: "HONG KONG",
    mustChangePassword: false,
    permissions: { "spc-mfa-test": "edit" },
  }
}

function auditContext(): SpcAuditContext {
  return {
    actorUserId: ACTOR_ID,
    username: "admin@example.com",
    displayName: "SPC ADMIN",
    role: "ADMIN",
    actorRole: "ADMIN",
    pageId: "spc-mfa-test",
    pageLabel: "SPC MFA TEST",
    pagePath: "/spc/mfa-test",
    sourceIp: "203.0.113.4",
    correlationId: CHALLENGE_ID,
    requestId: CHALLENGE_ID,
    platformRequestId: "hkg1::mfa-test",
    action: "send-whatsapp-mfa-test-code",
    targetType: "spc-user",
    targetId: TARGET_ID,
    targetUsername: "MFA_TEST",
    outcome: "success",
    approvalReference: null,
    passwordChanged: false,
  }
}

test("SPC MFA pilot generates six digits and stores a secret-bound HMAC", () => {
  for (let index = 0; index < 1_000; index += 1) {
    assert.match(generateSpcMfaTestCode(), /^[0-9]{6}$/)
  }

  const first = hashSpcMfaTestCode(CHALLENGE_ID, TARGET_ID, "004219", TEST_SECRET)
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.equal(
    first,
    hashSpcMfaTestCode(CHALLENGE_ID, TARGET_ID, "004219", TEST_SECRET),
  )
  assert.notEqual(
    first,
    hashSpcMfaTestCode(CHALLENGE_ID, TARGET_ID, "004220", TEST_SECRET),
  )
  assert.notEqual(
    first,
    hashSpcMfaTestCode(CHALLENGE_ID, ACTOR_ID, "004219", TEST_SECRET),
  )
  assert.throws(
    () => hashSpcMfaTestCode(CHALLENGE_ID, TARGET_ID, "004219", "short"),
    /not configured securely/i,
  )
})

test("SPC MFA pilot masks the destination and enforces exact same-origin POSTs", () => {
  assert.equal(maskSpcWhatsappPhone("+852 9123 4567"), "+85•••••4567")
  assert.equal(maskSpcWhatsappPhone(null), "")
  assert.equal(
    isSameOriginSpcMfaTestRequest(
      new Request("https://spc.fcuno.com/api/spc/mfa-test/send", {
        headers: { Origin: "https://spc.fcuno.com" },
      }),
    ),
    true,
  )
  assert.equal(
    isSameOriginSpcMfaTestRequest(
      new Request("https://spc.fcuno.com/api/spc/mfa-test/send", {
        headers: { Origin: "https://attacker.example" },
      }),
    ),
    false,
  )
  assert.equal(
    isSameOriginSpcMfaTestRequest(
      new Request("https://spc.fcuno.com/api/spc/mfa-test/send"),
    ),
    false,
  )
})

test("SPC MFA configuration check validates the HMAC and Meta endpoint fields", () => {
  const keys = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SPC_WHATSAPP_MFA_TEST_SECRET",
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_GRAPH_API_VERSION",
    "WHATSAPP_PHONE_NUMBER_ID",
  ]
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  try {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co"
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role"
    process.env.SPC_WHATSAPP_MFA_TEST_SECRET = TEST_SECRET
    process.env.WHATSAPP_ACCESS_TOKEN = "meta-token"
    process.env.WHATSAPP_GRAPH_API_VERSION = "v23.0"
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789012345"
    assert.equal(isSpcMfaTestConfigured(), true)

    process.env.SPC_WHATSAPP_MFA_TEST_SECRET = "short"
    assert.equal(isSpcMfaTestConfigured(), false)
    process.env.SPC_WHATSAPP_MFA_TEST_SECRET = TEST_SECRET
    process.env.WHATSAPP_GRAPH_API_VERSION = "latest"
    assert.equal(isSpcMfaTestConfigured(), false)
  } finally {
    restoreEnvironment(original)
  }
})

test("Meta authentication message contains the approved body and Copy Code parameters", () => {
  assert.deepEqual(buildSpcMfaAuthenticationMessage("85291234567", "004219"), {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "85291234567",
    type: "template",
    template: {
      name: "spc_mfa_test_code",
      language: { code: "en_US" },
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: "004219" }],
        },
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: "004219" }],
        },
      ],
    },
  })
})

test("Meta send uses the configured endpoint and sanitizes upstream failures", async () => {
  const keys = [
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_GRAPH_API_VERSION",
    "WHATSAPP_PHONE_NUMBER_ID",
  ]
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  try {
    process.env.WHATSAPP_ACCESS_TOKEN = "top-secret-token"
    process.env.WHATSAPP_GRAPH_API_VERSION = "v23.0"
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789012345"
    let capturedUrl = ""
    let capturedInit: RequestInit | undefined
    const acceptedFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedInit = init
      return new Response(JSON.stringify({ messages: [{ id: "wamid.test-123" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    assert.deepEqual(
      await sendSpcMfaTestCode(
        { to: "85291234567", code: "004219" },
        acceptedFetch,
      ),
      { messageId: "wamid.test-123" },
    )
    assert.equal(
      capturedUrl,
      "https://graph.facebook.com/v23.0/123456789012345/messages",
    )
    assert.equal(new Headers(capturedInit?.headers).get("authorization"), "Bearer top-secret-token")
    assert.equal(capturedInit?.cache, "no-store")
    assert.deepEqual(
      JSON.parse(String(capturedInit?.body)),
      buildSpcMfaAuthenticationMessage("85291234567", "004219"),
    )

    const rejectedFetch = (async () => new Response(
      JSON.stringify({ error: { code: 131000, message: "raw private upstream detail" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch
    await assert.rejects(
      () => sendSpcMfaTestCode({ to: "85291234567", code: "004219" }, rejectedFetch),
      (error: unknown) => {
        assert.ok(error instanceof SpcMfaTestDeliveryError)
        assert.equal(error.category, "rejected")
        assert.equal(error.upstreamStatus, 400)
        assert.equal(error.upstreamCode, "131000")
        assert.doesNotMatch(error.message, /private upstream|token/i)
        return true
      },
    )

    const timeoutFetch = (async () => {
      throw new DOMException("timed out", "TimeoutError")
    }) as typeof fetch
    await assert.rejects(
      () => sendSpcMfaTestCode({ to: "85291234567", code: "004219" }, timeoutFetch),
      (error: unknown) => {
        assert.ok(error instanceof SpcMfaTestDeliveryError)
        assert.equal(error.category, "timeout")
        return true
      },
    )

    const invalidFetch = (async () => new Response("not-json", { status: 200 })) as typeof fetch
    await assert.rejects(
      () => sendSpcMfaTestCode({ to: "85291234567", code: "004219" }, invalidFetch),
      (error: unknown) => {
        assert.ok(error instanceof SpcMfaTestDeliveryError)
        assert.equal(error.category, "invalid-response")
        return true
      },
    )
  } finally {
    restoreEnvironment(original)
  }
})

test("MFA audit evidence contains only masked delivery metadata", () => {
  const event = buildSpcMfaTestAuditEvent(auditContext(), {
    status: "delivery_accepted",
    outcome: "success",
    challengeId: CHALLENGE_ID,
    target: {
      id: TARGET_ID,
      username: "MFA_TEST",
      phoneHint: "+85•••••4567",
    },
    messageId: "wamid.test-123",
  })
  const serialized = JSON.stringify(event)

  assert.equal(event.table_schema, "app")
  assert.equal(event.table_name, "spc_mfa_test_events")
  assert.deepEqual(event.changed_fields, ["status", "outcome"])
  assert.match(serialized, /\+85•••••4567/)
  assert.doesNotMatch(serialized, /85291234567|004219|top-secret-token|code_hash/i)
})

test("MFA test page is ADMIN-only and direct routes bind the dedicated inactive account", () => {
  const admin = adminSession()
  assert.equal(hasSpcAdminPagePermission(admin, "edit", "spc-mfa-test"), true)
  assert.equal(
    hasSpcAdminPagePermission(adminSession("BUYER TRADER"), "edit", "spc-mfa-test"),
    false,
  )
  assert.equal(getDefaultSpcPermissionsForRole("ADMIN")["spc-mfa-test"], "edit")
  assert.equal(getDefaultSpcPermissionsForRole("BUYER TRADER")["spc-mfa-test"], "none")
  assert.equal(
    constrainSpcPermissionForRole("SUPPLIER TRADER", "spc-mfa-test", "edit"),
    "none",
  )

  const library = readFileSync(new URL("../lib/spcMfaTest.ts", import.meta.url), "utf8")
  const routes = [
    "../app/api/spc/mfa-test/route.ts",
    "../app/api/spc/mfa-test/send/route.ts",
    "../app/api/spc/mfa-test/verify/route.ts",
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
  const auditRoute = readFileSync(
    new URL("../app/api/spc/audit-logs/route.ts", import.meta.url),
    "utf8",
  )

  assert.match(library, /\.eq\("username", SPC_MFA_TEST_ACCOUNT_USERNAME\)/)
  assert.doesNotMatch(library, /\.ilike\("username", SPC_MFA_TEST_ACCOUNT_USERNAME\)/)
  for (const route of routes) {
    assert.match(route, /requireSpcAdminPagePermission\("spc-mfa-test", "edit"\)/)
    assert.match(route, /spcPrivateJson/)
  }
  assert.match(routes[1], /isSameOriginSpcMfaTestRequest/)
  assert.match(routes[1], /targetUserId/)
  assert.match(routes[2], /isSameOriginSpcMfaTestRequest/)
  assert.match(routes[2], /targetUserId/)
  assert.doesNotMatch(routes[1], /console\.(?:log|info|warn)\([^)]*code/)
  assert.doesNotMatch(routes[2], /console\.(?:log|info|warn)\([^)]*code/)
  assert.match(auditRoute, /!viewerIsAdmin && presented\.pageId === "spc-mfa-test"/)
  assert.match(auditRoute, /viewerIsAdmin \|\| record\.pageId !== "spc-mfa-test"/)
  assert.match(auditRoute, /viewerIsAdmin \|\| id !== "spc-mfa-test"/)
})

test("MFA migration is private, atomic, rate-limited, append-only and canonical", () => {
  const migration = readFileSync(
    new URL(
      "../supabase/migrations/20260810042303_spc_whatsapp_mfa_test_pilot.sql",
      import.meta.url,
    ),
    "utf8",
  )
  const canonical = readFileSync(new URL("../supabase/spc_schema.sql", import.meta.url), "utf8")
  const marker = "-- Isolated SPC WhatsApp MFA proof of concept."
  const actorIndexMarker = "-- Cover administrator-bound challenge status and verification lookups."
  const actorIndexMigration = readFileSync(
    new URL(
      "../supabase/migrations/20260810050008_add_spc_whatsapp_mfa_test_actor_index.sql",
      import.meta.url,
    ),
    "utf8",
  )

  assert.equal(
    canonical
      .slice(canonical.lastIndexOf(marker), canonical.lastIndexOf(actorIndexMarker))
      .trim(),
    migration.trim(),
  )
  assert.equal(
    canonical.slice(canonical.lastIndexOf(actorIndexMarker)).trim(),
    actorIndexMigration.trim(),
  )
  assert.match(migration, /create table if not exists private\.spc_whatsapp_mfa_test_challenges/)
  assert.match(migration, /enable row level security/)
  assert.match(migration, /revoke all on table[\s\S]*from public, anon, authenticated, service_role/)
  assert.match(migration, /grant execute on function public\.begin_spc_whatsapp_mfa_test_challenge[\s\S]*to service_role/)
  assert.match(migration, /'MFA_TEST'[\s\S]*'disabled:mfa-test-account'[\s\S]*false/)
  assert.match(migration, /users\.is_active = false[\s\S]*lower\(users\.username\) = 'mfa_test'/)
  assert.match(migration, /pg_advisory_xact_lock/)
  assert.match(migration, /interval '60 seconds'/)
  assert.doesNotMatch(migration, /delivery_status in \('pending', 'accepted'\)/)
  assert.match(migration, /interval '4 minutes'[\s\S]*interval '6 minutes'/)
  assert.match(migration, /attempt_count between 0 and 5/)
  assert.match(migration, /for update/)
  assert.match(migration, /verified_at is not null[\s\S]*'already_used'/)
  assert.match(migration, /created_by_user_id = p_created_by_user_id[\s\S]*target_user_id = p_target_user_id/)
  const completeDeliveryFunction = migration.match(
    /create or replace function public\.complete_spc_whatsapp_mfa_test_delivery[\s\S]*?\n\$\$;/,
  )?.[0] || ""
  assert.match(completeDeliveryFunction, /now_value := pg_catalog\.clock_timestamp\(\)/)
  assert.match(migration, /p_succeeded = false or challenges\.expires_at > now_value/)
  assert.match(migration, /daily_send_count >= 20/)
  assert.match(migration, /hourly_send_count >= 10/)
  assert.match(migration, /interval '24 hours'/)
  assert.match(migration, /interval '1 hour'/)
  assert.match(migration, /spc_mfa_test_events/)
  assert.match(migration, /validate_spc_mfa_test_audit_record/)
  assert.match(migration, /Invalid SPC WhatsApp MFA test audit event/)
  assert.match(migration, /SPC user-management audit records are append-only|is_spc_user_management_audit_record/)
  assert.match(actorIndexMigration, /created_by_user_id,[\s\S]*created_at desc/)
})
