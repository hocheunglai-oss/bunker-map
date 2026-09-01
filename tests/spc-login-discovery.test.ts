import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  SPC_LOGIN_DISCOVERY_SOURCE_IP_LIMIT,
  SPC_LOGIN_DISCOVERY_USERNAME_LIMIT,
  SPC_LOGIN_DISCOVERY_WINDOW_SECONDS,
  beginSpcLoginDiscovery,
} from "@/lib/spcLoginDiscovery"
import { hashSpcLoginUsername } from "@/lib/spcLoginSecurity"

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260901031712_add_spc_login_discovery_rate_limit.sql",
    import.meta.url,
  ),
  "utf8",
)
const schema = readFileSync(
  new URL("../supabase/spc_schema.sql", import.meta.url),
  "utf8",
)

async function withMockedSupabaseFetch(
  responder: (url: string, body: Record<string, unknown>) => Response,
  operation: () => Promise<void>,
) {
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const previousFetch = globalThis.fetch
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://spc-discovery-test.supabase.co"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key"
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    return responder(url, JSON.parse(String(init?.body || "{}")))
  }

  try {
    await operation()
  } finally {
    globalThis.fetch = previousFetch
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey
  }
}

test("SPC login discovery uses a dedicated durable limiter", () => {
  assert.equal(SPC_LOGIN_DISCOVERY_WINDOW_SECONDS, 15 * 60)
  assert.equal(SPC_LOGIN_DISCOVERY_USERNAME_LIMIT, 20)
  assert.equal(SPC_LOGIN_DISCOVERY_SOURCE_IP_LIMIT, 100)
  assert.match(migration, /username_limit_value constant integer := 20/)
  assert.match(migration, /source_ip_limit_value constant integer := 100/)
  assert.match(migration, /pg_advisory_xact_lock/)
  assert.match(migration, /enable row level security/)
  assert.match(schema, /BEGIN SPC USERNAME-FIRST LOGIN ROUTING LIMITER/)
  assert.match(schema, /create or replace function public\.begin_spc_login_discovery/)
})

test("SPC login discovery sends only a username hash and trusted request evidence", async () => {
  await withMockedSupabaseFetch(
    (url, body) => {
      assert.match(url, /\/rest\/v1\/rpc\/begin_spc_login_discovery/)
      assert.equal(body.p_username_hash, hashSpcLoginUsername(" Otto@Cosulich.com.hk "))
      assert.equal(body.p_source_ip, "203.0.113.42")
      assert.equal(body.p_request_id, "10000000-0000-4000-8000-000000000001")
      assert.equal(JSON.stringify(body).includes("Otto@Cosulich.com.hk"), false)
      return new Response(
        JSON.stringify({
          allowed: true,
          retry_after_seconds: 0,
          blocked_by: null,
          blocked_count: "1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    },
    async () => {
      assert.deepEqual(
        await beginSpcLoginDiscovery({
          username: " Otto@Cosulich.com.hk ",
          trustedSourceIp: "203.0.113.42",
          requestId: "10000000-0000-4000-8000-000000000001",
        }),
        {
          allowed: true,
          retryAfterSeconds: 0,
          blockedBy: null,
          blockedCount: "1",
        },
      )
    },
  )
})

test("SPC login discovery validates blocked decisions and trusted IPs", async () => {
  await withMockedSupabaseFetch(
    () => new Response(
      JSON.stringify({
        allowed: false,
        retry_after_seconds: 420,
        blocked_by: "source_ip",
        blocked_count: "101",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
    async () => {
      assert.deepEqual(
        await beginSpcLoginDiscovery({
          username: "otto@cosulich.com.hk",
          trustedSourceIp: "2001:db8::42",
          requestId: "20000000-0000-4000-8000-000000000002",
        }),
        {
          allowed: false,
          retryAfterSeconds: 420,
          blockedBy: "source_ip",
          blockedCount: "101",
        },
      )
    },
  )

  await assert.rejects(
    beginSpcLoginDiscovery({
      username: "otto@cosulich.com.hk",
      trustedSourceIp: "not-an-ip",
      requestId: "30000000-0000-4000-8000-000000000003",
    }),
    /Trusted source IP/,
  )
})
