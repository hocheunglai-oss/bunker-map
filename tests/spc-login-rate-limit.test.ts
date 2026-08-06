import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  SPC_LOGIN_ATTEMPT_RETENTION_DAYS,
  SPC_LOGIN_PENDING_TIMEOUT_SECONDS,
  SPC_LOGIN_RATE_LIMIT_WINDOW_SECONDS,
  SPC_LOGIN_SOURCE_IP_FAILURE_LIMIT,
  SPC_LOGIN_USERNAME_FAILURE_LIMIT,
  beginSpcLoginAttempt,
  cancelSpcLoginAttempt,
  completeSpcLoginAttempt,
  hashSpcLoginUsername,
  normalizeSpcLoginUsername,
  shouldLogSpcRateLimitCount,
} from "@/lib/spcLoginSecurity"

const MIGRATION_PATH = new URL(
  "../supabase/migrations/20260806110842_harden_spc_login_rate_limits.sql",
  import.meta.url,
)
const POLICY_MIGRATION_PATH = new URL(
  "../supabase/migrations/20260806193316_add_spc_login_attempts_no_public_policy.sql",
  import.meta.url,
)
const OPERATIONS_MIGRATION_PATH = new URL(
  "../supabase/migrations/20260806201000_harden_spc_login_limit_operations.sql",
  import.meta.url,
)
const SPC_SCHEMA_PATH = new URL("../supabase/spc_schema.sql", import.meta.url)

async function withMockedSupabaseFetch(
  responder: (
    url: string,
    body: Record<string, unknown>,
  ) => Response | Promise<Response>,
  operation: () => Promise<void>,
) {
  const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const originalServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const originalFetch = globalThis.fetch

  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://spc-login-test.supabase.co"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key"
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>
    return responder(url, body)
  }

  try {
    await operation()
  } finally {
    globalThis.fetch = originalFetch
    if (originalSupabaseUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl
    }
    if (originalServiceRoleKey === undefined) {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY
    } else {
      process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceRoleKey
    }
  }
}

test("SPC login usernames are normalized and stored only as stable SHA-256 hashes", () => {
  assert.equal(normalizeSpcLoginUsername("  Captain@FCUNO.COM "), "captain@fcuno.com")
  assert.match(hashSpcLoginUsername(" Captain@FCUNO.COM "), /^[0-9a-f]{64}$/)
  assert.equal(
    hashSpcLoginUsername(" Captain@FCUNO.COM "),
    hashSpcLoginUsername("captain@fcuno.com"),
  )
  assert.notEqual(
    hashSpcLoginUsername("captain@fcuno.com"),
    hashSpcLoginUsername("other@fcuno.com"),
  )
})

test("SPC login limits are fixed to the security-review thresholds", () => {
  assert.equal(SPC_LOGIN_RATE_LIMIT_WINDOW_SECONDS, 15 * 60)
  assert.equal(SPC_LOGIN_USERNAME_FAILURE_LIMIT, 5)
  assert.equal(SPC_LOGIN_SOURCE_IP_FAILURE_LIMIT, 20)
  assert.equal(SPC_LOGIN_PENDING_TIMEOUT_SECONDS, 2 * 60)
  assert.equal(SPC_LOGIN_ATTEMPT_RETENTION_DAYS, 30)
})

test("beginning an SPC login attempt sends only the username hash and trusted IP", async () => {
  const requestId = "10000000-0000-4000-8000-000000000001"
  const attemptId = "20000000-0000-4000-8000-000000000002"
  const rawUsername = " Captain@FCUNO.COM "

  await withMockedSupabaseFetch(
    (url, body) => {
      assert.match(url, /\/rest\/v1\/rpc\/begin_spc_login_attempt/)
      assert.equal(body.p_username_hash, hashSpcLoginUsername(rawUsername))
      assert.equal(body.p_source_ip, "203.0.113.42")
      assert.equal(body.p_request_id, requestId)
      assert.equal(JSON.stringify(body).includes(rawUsername.trim()), false)
      assert.equal(JSON.stringify(body).includes("password"), false)

      return new Response(
        JSON.stringify({
          attempt_id: attemptId,
          allowed: true,
          retry_after_seconds: 0,
          blocked_by: null,
          blocked_count: 0,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    },
    async () => {
      const decision = await beginSpcLoginAttempt({
        username: rawUsername,
        trustedSourceIp: "203.0.113.42",
        requestId,
      })

      assert.deepEqual(decision, {
        attemptId,
        allowed: true,
        retryAfterSeconds: 0,
        blockedBy: null,
        blockedCount: "0",
        shouldLogRateLimit: false,
      })
    },
  )
})

test("blocked SPC login attempts return a bounded retry period and scope", async () => {
  await withMockedSupabaseFetch(
    () => new Response(
      JSON.stringify({
        attempt_id: "30000000-0000-4000-8000-000000000003",
        allowed: false,
        retry_after_seconds: 731,
        blocked_by: "username",
        blocked_count: 8,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
    async () => {
      const decision = await beginSpcLoginAttempt({
        username: "captain@fcuno.com",
        trustedSourceIp: "2001:db8::42",
        requestId: "40000000-0000-4000-8000-000000000004",
      })

      assert.equal(decision.allowed, false)
      assert.equal(decision.retryAfterSeconds, 731)
      assert.equal(decision.blockedBy, "username")
      assert.equal(decision.blockedCount, "8")
      assert.equal(decision.shouldLogRateLimit, true)
    },
  )
})

test("repeated block logging is sampled at powers of two", () => {
  const sampled = [1, 2, 4, 8, 16, 1024]
  const skipped = [0, 3, 5, 6, 7, 9, 1023]

  for (const count of sampled) {
    assert.equal(shouldLogSpcRateLimitCount(count), true, String(count))
  }
  for (const count of skipped) {
    assert.equal(shouldLogSpcRateLimitCount(count), false, String(count))
  }
  assert.equal(shouldLogSpcRateLimitCount("18446744073709551616"), true)
  assert.equal(shouldLogSpcRateLimitCount("not-a-count"), false)
})

test("SPC login limiter fails closed for missing trust evidence and database errors", async () => {
  await assert.rejects(
    beginSpcLoginAttempt({
      username: "captain@fcuno.com",
      trustedSourceIp: "unknown",
      requestId: "50000000-0000-4000-8000-000000000005",
    }),
    /Trusted source IP is unavailable or invalid/,
  )

  await withMockedSupabaseFetch(
    () => new Response(
      JSON.stringify({ message: "database unavailable" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    ),
    async () => {
      await assert.rejects(
        beginSpcLoginAttempt({
          username: "captain@fcuno.com",
          trustedSourceIp: "203.0.113.42",
          requestId: "60000000-0000-4000-8000-000000000006",
        }),
      )
    },
  )
})

test("SPC login completion must update a pending database attempt", async () => {
  const attemptId = "70000000-0000-4000-8000-000000000007"

  await withMockedSupabaseFetch(
    (url, body) => {
      assert.match(url, /\/rest\/v1\/rpc\/complete_spc_login_attempt/)
      assert.equal(body.p_attempt_id, attemptId)
      assert.equal(body.p_succeeded, false)
      return new Response("true", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    },
    async () => {
      await completeSpcLoginAttempt({ attemptId, succeeded: false })
    },
  )

  await withMockedSupabaseFetch(
    () => new Response("false", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    async () => {
      await assert.rejects(
        completeSpcLoginAttempt({ attemptId, succeeded: true }),
        /completion was rejected/,
      )
    },
  )
})

test("SPC login infrastructure failures cancel pending attempts", async () => {
  const attemptId = "80000000-0000-4000-8000-000000000008"

  await withMockedSupabaseFetch(
    (url, body) => {
      assert.match(url, /\/rest\/v1\/rpc\/cancel_spc_login_attempt/)
      assert.equal(body.p_attempt_id, attemptId)
      assert.equal(body.p_reason, "authentication_unavailable")
      return new Response("true", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    },
    async () => {
      await cancelSpcLoginAttempt({
        attemptId,
        reason: "authentication_unavailable",
      })
    },
  )

  await withMockedSupabaseFetch(
    () => new Response("false", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    async () => {
      await assert.rejects(
        cancelSpcLoginAttempt({
          attemptId,
          reason: "attempt_monitoring_unavailable",
        }),
        /cancellation was rejected/,
      )
    },
  )
})

test("database login throttling is atomic, private, monitored, and retained for 30 days", () => {
  const migration = readFileSync(MIGRATION_PATH, "utf8")
  const policyMigration = readFileSync(POLICY_MIGRATION_PATH, "utf8")
  const operationsMigration = readFileSync(OPERATIONS_MIGRATION_PATH, "utf8")
  const canonicalSchema = readFileSync(SPC_SCHEMA_PATH, "utf8")

  assert.match(migration, /create table private\.spc_login_attempts/)
  assert.match(migration, /alter table private\.spc_login_attempts enable row level security/)
  assert.match(
    migration,
    /revoke all privileges on table private\.spc_login_attempts[\s\S]*?from public, anon, authenticated, service_role;[\s\S]*?grant select, insert, update, delete[\s\S]*?to service_role;/,
  )
  assert.match(migration, /username_hash ~ '\^\[0-9a-f\]\{64\}\$'/)
  assert.doesNotMatch(migration, /\busername\s+text\b/)
  assert.match(
    migration,
    /create or replace function public\.begin_spc_login_attempt\([\s\S]*?username_limit_value constant integer := 5;[\s\S]*?source_ip_limit_value constant integer := 20;[\s\S]*?pg_advisory_xact_lock/,
  )
  assert.match(migration, /window_value constant interval := interval '15 minutes'/)
  assert.match(migration, /pending_timeout_value constant interval := interval '2 minutes'/)
  assert.match(migration, /retention_value constant interval := interval '30 days'/)
  assert.match(
    migration,
    /where retained\.started_at < now_value - retention_value[\s\S]*?limit 1000/,
  )
  assert.match(migration, /outcome = 'failed',[\s\S]*?failure_reason = 'stale_pending'/)
  assert.match(migration, /outcome,[\s\S]*?blocked_by,[\s\S]*?retry_after_seconds[\s\S]*?'blocked'/)
  assert.match(
    migration,
    /revoke all on function public\.begin_spc_login_attempt\(text, inet, uuid\)[\s\S]*?from public, anon, authenticated, service_role;[\s\S]*?grant execute[\s\S]*?to service_role;/,
  )
  assert.match(
    migration,
    /revoke all on function public\.complete_spc_login_attempt\(uuid, boolean\)[\s\S]*?from public, anon, authenticated, service_role;[\s\S]*?grant execute[\s\S]*?to service_role;/,
  )
  assert.match(
    policyMigration,
    /create policy "spc_login_attempts_no_public_access"[\s\S]*?for all[\s\S]*?using \(false\)[\s\S]*?with check \(false\)/,
  )
  assert.match(
    operationsMigration,
    /add column if not exists blocked_count bigint not null default 0[\s\S]*?add column if not exists last_blocked_at timestamptz/,
  )
  assert.match(
    operationsMigration,
    /where outcome = 'blocked'[\s\S]*?and \(blocked_count = 0 or last_blocked_at is null\)/,
  )
  assert.match(
    operationsMigration,
    /returns table \([\s\S]*?blocked_count text[\s\S]*?blocked_count := blocked_count_value::text/,
  )
  assert.match(
    operationsMigration,
    /if found then[\s\S]*?blocked_count = attempts\.blocked_count \+ 1[\s\S]*?else[\s\S]*?blocked_count,[\s\S]*?last_blocked_at/,
  )
  assert.match(
    operationsMigration,
    /attempts\.last_blocked_at > now_value - window_value/,
  )
  assert.match(
    operationsMigration,
    /outcome = 'system_error',[\s\S]*?failure_reason = 'stale_pending'/,
  )
  assert.match(
    operationsMigration,
    /create or replace function public\.cancel_spc_login_attempt\([\s\S]*?outcome = 'system_error'[\s\S]*?attempts\.outcome = 'pending'/,
  )
  assert.match(
    operationsMigration,
    /create or replace function public\.cleanup_spc_login_attempts\(\)[\s\S]*?interval '30 days'[\s\S]*?limit 10000[\s\S]*?get diagnostics deleted_count = row_count/,
  )
  for (const functionSignature of [
    "cancel_spc_login_attempt\\(uuid, text\\)",
    "cleanup_spc_login_attempts\\(\\)",
  ]) {
    assert.match(
      operationsMigration,
      new RegExp(
        `revoke all on function public\\.${functionSignature}[\\s\\S]*?` +
        "from public, anon, authenticated, service_role;[\\s\\S]*?" +
        `grant execute on function public\\.${functionSignature}[\\s\\S]*?to service_role;`,
      ),
    )
  }
  for (const sql of [operationsMigration, canonicalSchema]) {
    assert.match(sql, /blocked_count = attempts\.blocked_count \+ 1/)
    assert.match(sql, /create or replace function public\.cancel_spc_login_attempt/)
    assert.match(sql, /create or replace function public\.cleanup_spc_login_attempts\(\)/)
    assert.match(sql, /outcome = 'system_error'/)
    assert.match(
      sql,
      /when expired\.outcome = 'blocked'[\s\S]*?coalesce\(expired\.last_blocked_at, expired\.started_at\)/,
    )
    assert.match(
      sql,
      /when retained\.outcome = 'blocked'[\s\S]*?coalesce\(retained\.last_blocked_at, retained\.started_at\)/,
    )
  }
})
