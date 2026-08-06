import assert from "node:assert/strict"
import test from "node:test"
import { createTrustedRequestContext } from "../lib/trustedRequestContext"

const REQUEST_ID = "11111111-1111-4111-8111-111111111111"
const VERCEL_RUNTIME = { nodeEnv: "production", vercel: "1" }

function request(headers: Record<string, string>) {
  return new Request("https://spc.fcuno.com/api/spc/users", { headers })
}

test("trusted request context accepts validated Vercel proxy metadata", () => {
  const context = createTrustedRequestContext(
    request({
      "x-vercel-forwarded-for": "203.0.113.19",
      "x-forwarded-for": "198.51.100.11",
      "x-vercel-id": "hkg1::iad1::request-123",
    }),
    { runtime: VERCEL_RUNTIME, createId: () => REQUEST_ID },
  )

  assert.deepEqual(context, {
    sourceIp: "203.0.113.19",
    correlationId: REQUEST_ID,
    requestId: REQUEST_ID,
    platformRequestId: "hkg1::iad1::request-123",
  })
})

test("trusted request context supports Vercel previews and IPv6", () => {
  const context = createTrustedRequestContext(
    request({
      "x-forwarded-for": "2001:db8::42",
      "x-vercel-id": "hkg1::preview-request",
    }),
    { runtime: VERCEL_RUNTIME, createId: () => REQUEST_ID },
  )

  assert.equal(context.sourceIp, "2001:db8::42")
  assert.equal(context.platformRequestId, "hkg1::preview-request")
})

test("forwarded headers are ignored outside a genuine Vercel runtime", () => {
  const headers = request({
    "x-vercel-forwarded-for": "203.0.113.19",
    "x-forwarded-for": "198.51.100.11",
    "x-vercel-id": "spoofed-request",
  })

  for (const runtime of [
    { nodeEnv: "development", vercel: "1" },
    { nodeEnv: "production", vercel: undefined },
    { nodeEnv: "production", vercel: "0" },
  ]) {
    const context = createTrustedRequestContext(headers, {
      runtime,
      createId: () => REQUEST_ID,
    })
    assert.equal(context.sourceIp, null)
    assert.equal(context.platformRequestId, null)
  }
})

test("malformed proxy metadata is rejected rather than partially trusted", () => {
  for (const value of [
    "203.0.113.19, 198.51.100.11",
    "203.0.113.19:443",
    "not-an-ip",
    "",
  ]) {
    const context = createTrustedRequestContext(
      request({
        "x-vercel-forwarded-for": value,
        "x-forwarded-for": value,
        "x-vercel-id": "contains spaces",
      }),
      { runtime: VERCEL_RUNTIME, createId: () => REQUEST_ID },
    )
    assert.equal(context.sourceIp, null)
    assert.equal(context.platformRequestId, null)
  }
})

test("request and correlation IDs are the same generated UUID", () => {
  const context = createTrustedRequestContext(undefined, {
    runtime: {},
    createId: () => REQUEST_ID,
  })

  assert.equal(context.requestId, REQUEST_ID)
  assert.equal(context.correlationId, REQUEST_ID)
  assert.throws(
    () =>
      createTrustedRequestContext(undefined, {
        runtime: {},
        createId: () => "not-a-uuid",
      }),
    /invalid UUID/,
  )
})
