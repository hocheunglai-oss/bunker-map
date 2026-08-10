import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  SpcWhatsappLoginMfaDeliveryError,
  SPC_WHATSAPP_LOGIN_MFA_PILOT_USERNAME,
  SPC_WHATSAPP_LOGIN_MFA_TEMPLATE_LANGUAGE,
  SPC_WHATSAPP_LOGIN_MFA_TEMPLATE_NAME,
  createSpcWhatsappLoginMfaPendingToken,
  generateSpcWhatsappLoginMfaCode,
  hashSpcWhatsappLoginMfaCode,
  hashSpcWhatsappLoginMfaPendingToken,
  isPlausibleSpcWhatsappLoginMfaPendingToken,
  isSpcWhatsappLoginMfaConfigured,
  requiresSpcWhatsappLoginMfa,
  sendSpcWhatsappLoginMfaCode,
} from "../lib/spcWhatsappLoginMfa"

const USER_ID = "11111111-1111-4111-8111-111111111111"
const CHALLENGE_ID = "22222222-2222-4222-8222-222222222222"

function withEnvironment(
  values: Record<string, string | undefined>,
  run: () => void,
) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  )
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    run()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test("WhatsApp login MFA is fail-closed and hard-bound to Otto", () => {
  assert.equal(SPC_WHATSAPP_LOGIN_MFA_PILOT_USERNAME, "otto@cosulich.com.hk")
  withEnvironment({ SPC_WHATSAPP_LOGIN_MFA_OTTO_ENABLED: undefined }, () => {
    assert.equal(requiresSpcWhatsappLoginMfa("otto@cosulich.com.hk"), false)
  })
  withEnvironment({ SPC_WHATSAPP_LOGIN_MFA_OTTO_ENABLED: "1" }, () => {
    assert.equal(requiresSpcWhatsappLoginMfa(" OTTO@COSULICH.COM.HK "), true)
    assert.equal(requiresSpcWhatsappLoginMfa("another@cosulich.com.hk"), false)
    assert.equal(requiresSpcWhatsappLoginMfa("MFA_TEST"), false)
  })
})

test("WhatsApp login MFA configuration requires a separate strong secret and sender", () => {
  const base = {
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    SPC_WHATSAPP_LOGIN_MFA_SECRET: "l".repeat(32),
    WHATSAPP_ACCESS_TOKEN: "token",
    WHATSAPP_GRAPH_API_VERSION: "v23.0",
    SPC_WHATSAPP_LOGIN_MFA_PHONE_NUMBER_ID: "1137471446122498",
    SPC_WHATSAPP_MFA_TEST_PHONE_NUMBER_ID: "999999999999999",
  }
  withEnvironment(base, () => assert.equal(isSpcWhatsappLoginMfaConfigured(), true))
  withEnvironment(
    { ...base, SPC_WHATSAPP_LOGIN_MFA_SECRET: "too-short" },
    () => assert.equal(isSpcWhatsappLoginMfaConfigured(), false),
  )
  withEnvironment(
    { ...base, SPC_WHATSAPP_LOGIN_MFA_PHONE_NUMBER_ID: undefined },
    () => assert.equal(isSpcWhatsappLoginMfaConfigured(), false),
  )
  withEnvironment(
    {
      ...base,
      SPC_WHATSAPP_LOGIN_MFA_PHONE_NUMBER_ID:
        base.SPC_WHATSAPP_MFA_TEST_PHONE_NUMBER_ID,
    },
    () => assert.equal(isSpcWhatsappLoginMfaConfigured(), false),
  )
})

test("WhatsApp login MFA uses the dedicated HK sender and approved login template", async () => {
  const keys = [
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_GRAPH_API_VERSION",
    "SPC_WHATSAPP_LOGIN_MFA_PHONE_NUMBER_ID",
    "SPC_WHATSAPP_MFA_TEST_PHONE_NUMBER_ID",
  ]
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  try {
    process.env.WHATSAPP_ACCESS_TOKEN = "meta-token"
    process.env.WHATSAPP_GRAPH_API_VERSION = "v23.0"
    process.env.SPC_WHATSAPP_LOGIN_MFA_PHONE_NUMBER_ID = "123456789012345"
    process.env.SPC_WHATSAPP_MFA_TEST_PHONE_NUMBER_ID = "999999999999999"
    let capturedUrl = ""
    let capturedInit: RequestInit | undefined
    const acceptedFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedInit = init
      return new Response(JSON.stringify({ messages: [{ id: "wamid.login-mfa" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    assert.deepEqual(
      await sendSpcWhatsappLoginMfaCode(
        { to: "85291234567", code: "004219" },
        acceptedFetch,
      ),
      { messageId: "wamid.login-mfa" },
    )
    assert.equal(
      capturedUrl,
      "https://graph.facebook.com/v23.0/123456789012345/messages",
    )
    assert.equal(
      new Headers(capturedInit?.headers).get("authorization"),
      "Bearer meta-token",
    )
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "85291234567",
      type: "template",
      template: {
        name: SPC_WHATSAPP_LOGIN_MFA_TEMPLATE_NAME,
        language: { code: SPC_WHATSAPP_LOGIN_MFA_TEMPLATE_LANGUAGE },
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

    process.env.SPC_WHATSAPP_LOGIN_MFA_PHONE_NUMBER_ID =
      process.env.SPC_WHATSAPP_MFA_TEST_PHONE_NUMBER_ID
    let collapsedSenderCalled = false
    await assert.rejects(
      () => sendSpcWhatsappLoginMfaCode(
        { to: "85291234567", code: "004219" },
        (async () => {
          collapsedSenderCalled = true
          return new Response()
        }) as typeof fetch,
      ),
      (error: unknown) => {
        assert.ok(error instanceof SpcWhatsappLoginMfaDeliveryError)
        assert.equal(error.category, "configuration")
        return true
      },
    )
    assert.equal(collapsedSenderCalled, false)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("login MFA codes and pre-authentication tokens use bounded secure formats", () => {
  const codes = Array.from({ length: 200 }, () => generateSpcWhatsappLoginMfaCode())
  for (const code of codes) assert.match(code, /^[0-9]{6}$/)
  assert.ok(new Set(codes).size > 190)

  const first = createSpcWhatsappLoginMfaPendingToken()
  const second = createSpcWhatsappLoginMfaPendingToken()
  assert.equal(isPlausibleSpcWhatsappLoginMfaPendingToken(first), true)
  assert.notEqual(first, second)
  assert.match(hashSpcWhatsappLoginMfaPendingToken(first), /^[0-9a-f]{64}$/)
  assert.notEqual(
    hashSpcWhatsappLoginMfaPendingToken(first),
    hashSpcWhatsappLoginMfaPendingToken(second),
  )
})

test("login OTP hashes are keyed, user-bound, challenge-bound and domain-separated", () => {
  const secret = "login-only-secret-material-32-bytes-minimum"
  const pendingHash = "a".repeat(64)
  const first = hashSpcWhatsappLoginMfaCode(
    CHALLENGE_ID,
    USER_ID,
    pendingHash,
    "004219",
    secret,
  )
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.equal(
    first,
    hashSpcWhatsappLoginMfaCode(
      CHALLENGE_ID,
      USER_ID,
      pendingHash,
      "004219",
      secret,
    ),
  )
  assert.notEqual(
    first,
    hashSpcWhatsappLoginMfaCode(
      "33333333-3333-4333-8333-333333333333",
      USER_ID,
      pendingHash,
      "004219",
      secret,
    ),
  )
  assert.notEqual(
    first,
    hashSpcWhatsappLoginMfaCode(
      CHALLENGE_ID,
      "44444444-4444-4444-8444-444444444444",
      pendingHash,
      "004219",
      secret,
    ),
  )
  assert.notEqual(
    first,
    hashSpcWhatsappLoginMfaCode(
      CHALLENGE_ID,
      USER_ID,
      "b".repeat(64),
      "004219",
      secret,
    ),
  )
})

test("Otto password success cannot create a session before WhatsApp verification", () => {
  const loginRoute = readFileSync(
    new URL("../app/api/spc/login/route.ts", import.meta.url),
    "utf8",
  )
  const verifyRoute = readFileSync(
    new URL("../app/api/spc/login/mfa/verify/route.ts", import.meta.url),
    "utf8",
  )
  const cancelRoute = readFileSync(
    new URL("../app/api/spc/login/mfa/cancel/route.ts", import.meta.url),
    "utf8",
  )
  const pilotStart = loginRoute.indexOf("if (requiresSpcWhatsappLoginMfa(user.username))")
  const normalSessionStart = loginRoute.indexOf("\n  try {\n    await setSpcSession(user)", pilotStart)
  const pilotBranch = loginRoute.slice(pilotStart, normalSessionStart)

  assert.ok(pilotStart > 0)
  assert.ok(normalSessionStart > pilotStart)
  assert.doesNotMatch(pilotBranch, /setSpcSession\(/)
  assert.match(pilotBranch, /!isSameOriginSpcWhatsappLoginMfaRequest\(request\)/)
  assert.match(pilotBranch, /beginSpcWhatsappLoginMfaChallenge/)
  assert.match(pilotBranch, /setSpcWhatsappLoginMfaPendingCookie/)
  assert.match(pilotBranch, /mfaRequired: true/)
  assert.match(pilotBranch, /\n      202,/)
  assert.match(verifyRoute, /verifySpcWhatsappLoginMfaCode\(code\)/)
  assert.match(verifyRoute, /await setSpcVerifiedSession/)
  assert.ok(
    verifyRoute.indexOf("verifySpcWhatsappLoginMfaCode(code)") <
      verifyRoute.indexOf("await setSpcVerifiedSession"),
  )
  for (const route of [loginRoute, verifyRoute, cancelRoute]) {
    assert.match(route, /isSameOriginSpcWhatsappLoginMfaRequest/)
  }
})

test("assured session enforcement and password rotation remain explicit", () => {
  const auth = readFileSync(new URL("../lib/spcAuth.ts", import.meta.url), "utf8")
  const sessions = readFileSync(new URL("../lib/spcSessions.ts", import.meta.url), "utf8")
  const passwordRoute = readFileSync(
    new URL("../app/api/spc/password/route.ts", import.meta.url),
    "utf8",
  )

  assert.match(auth, /requiresSpcWhatsappLoginMfa\(databaseUser\.username\)/)
  assert.match(auth, /!databaseSession\.mfaVerifiedAt/)
  assert.match(auth, /await revokeDatabaseSpcSession\(token\)/)
  assert.match(sessions, /mfa_verified_at/)
  assert.match(sessions, /create_spc_session_from_assured_session/)
  assert.match(passwordRoute, /preserveMfaFromCurrentSession: Boolean\(session\.mfaVerifiedAt\)/)
})

test("login MFA responses and logs never include OTP, token hash or full phone", () => {
  const files = [
    "../app/api/spc/login/route.ts",
    "../app/api/spc/login/mfa/verify/route.ts",
    "../app/api/spc/login/mfa/cancel/route.ts",
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
  const serialized = files.join("\n")
  const successResponse = files[0].slice(
    files[0].indexOf('logLoginSecurityEvent("mfa_challenge_issued"'),
    files[0].indexOf("\n  try {\n    await setSpcSession(user)"),
  )

  assert.doesNotMatch(serialized, /console\.(?:log|info|warn|error)\([^\n]*(?:code|pendingToken|phone)/)
  assert.doesNotMatch(serialized, /phoneHint:\s*challenge\.user\.whatsappPhone/)
  assert.doesNotMatch(successResponse, /pendingToken|pendingTokenHash|whatsappPhone|\bcode\b/)
})

test("SPC login page provides a bounded accessible WhatsApp-code step", () => {
  const page = readFileSync(new URL("../app/spc/page.tsx", import.meta.url), "utf8")
  assert.match(page, /response\.status === 202 && data\.mfaRequired === true/)
  assert.match(page, /autoComplete="one-time-code"/)
  assert.match(page, /inputMode="numeric"/)
  assert.match(page, /pattern="\[0-9\]\{6\}"/)
  assert.match(page, /role="timer"/)
  assert.match(page, /\/api\/spc\/login\/mfa\/verify/)
  assert.match(page, /\/api\/spc\/login\/mfa\/cancel/)
  assert.match(page, /setPassword\(""\)/)
})

test("login MFA migration is private, pinned, atomic, rate-limited and canonical", () => {
  const migration = readFileSync(
    new URL(
      "../supabase/migrations/20260810082029_add_spc_whatsapp_login_mfa_pilot.sql",
      import.meta.url,
    ),
    "utf8",
  )
  const canonical = readFileSync(
    new URL("../supabase/spc_schema.sql", import.meta.url),
    "utf8",
  )

  assert.match(migration, /add column if not exists mfa_verified_at timestamptz/)
  assert.match(migration, /private\.spc_whatsapp_login_mfa_enrollment/)
  assert.match(migration, /pg_catalog\.lower\(users\.username\) = 'otto@cosulich\.com\.hk'/)
  assert.match(migration, /extensions\.digest\(users\.whatsapp_phone, 'sha256'\)/)
  assert.match(migration, /otto_count <> 1 or eligible_count <> 1 or enrolled_count <> 1/)
  assert.match(migration, /whatsapp_phone_hash ~ '\^\[0-9a-f\]\{64\}\$'/)
  assert.doesNotMatch(migration, /[0-9a-f]{64}/)
  assert.match(
    migration,
    /enrollment\.whatsapp_phone_hash = pg_catalog\.encode\(\s*extensions\.digest\(users\.whatsapp_phone, 'sha256'\)/,
  )
  assert.match(migration, /create table if not exists private\.spc_whatsapp_login_mfa_challenges/)
  assert.match(migration, /alter table private\.spc_whatsapp_login_mfa_challenges enable row level security/)
  assert.match(
    migration,
    /revoke all privileges on table private\.spc_whatsapp_login_mfa_challenges[\s\S]*from public, anon, authenticated, service_role/,
  )
  assert.match(migration, /security definer\nset search_path = pg_catalog, pg_temp/g)
  assert.match(migration, /interval '60 seconds'/)
  assert.match(migration, /daily_send_count >= 20/)
  assert.match(migration, /hourly_send_count >= 10/)
  assert.match(migration, /attempt_count between 0 and 5/)
  assert.match(migration, /user_mismatch_count \+ 1 >= 10/)
  assert.match(migration, /source_ip_mismatch_count \+ 1 >= 20/)
  assert.match(
    migration,
    /create or replace function public\.verify_spc_whatsapp_login_mfa_challenge[\s\S]*?for update;[\s\S]*?insert into public\.spc_sessions[\s\S]*?mfa_verified_at/,
  )
  assert.match(migration, /create_spc_session_from_assured_session/)
  assert.match(migration, /previous_session\.expires_at/)
  assert.match(migration, /invalidation_reason is not null/)
  assert.match(
    migration,
    /revoke all on function public\.verify_spc_whatsapp_login_mfa_challenge[\s\S]*?from public, anon, authenticated, service_role;[\s\S]*?grant execute[\s\S]*?to service_role/,
  )
  assert.equal(canonical.includes(migration.trim()), true)
})
