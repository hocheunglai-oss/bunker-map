import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import {
  SPC_PRIVATE_NO_STORE,
  spcPrivateJson,
} from "../lib/spcResponse"

test("SPC private JSON responses override cacheability and preserve response metadata", async () => {
  const response = spcPrivateJson(
    { success: true },
    {
      status: 202,
      headers: {
        "Cache-Control": "public, max-age=3600",
        "X-SPC-Test": "preserved",
      },
    },
  )

  assert.equal(response.status, 202)
  assert.equal(response.headers.get("cache-control"), SPC_PRIVATE_NO_STORE)
  assert.equal(response.headers.get("x-spc-test"), "preserved")
  assert.deepEqual(await response.json(), { success: true })
})

test("sensitive SPC routes use the private response boundary on success and errors", async () => {
  const routePaths = [
    "../app/api/spc/session/route.ts",
    "../app/api/spc/logout/route.ts",
    "../app/api/spc/password/route.ts",
    "../app/api/spc/audit-logs/route.ts",
    "../app/api/spc/users/route.ts",
    "../app/api/spc/enquiry-history/route.ts",
    "../app/api/spc/chrome-extension/download/route.ts",
    "../app/api/spc/login/mfa/verify/route.ts",
    "../app/api/spc/login/mfa/cancel/route.ts",
  ]
  const [serverTiming, ...routes] = await Promise.all([
    readFile(new URL("../lib/serverTiming.ts", import.meta.url), "utf8"),
    ...routePaths.map((routePath) =>
      readFile(new URL(routePath, import.meta.url), "utf8"),
    ),
  ])

  assert.match(
    serverTiming,
    /const response = spcPrivateJson\(payload, init\)/,
    "timed SPC success responses should be private and no-store by default",
  )
  for (const [index, source] of routes.entries()) {
    assert.match(
      source,
      /spcPrivateJson/,
      `${routePaths[index]} should use the private response helper`,
    )
    assert.doesNotMatch(
      source,
      /NextResponse\.json/,
      `${routePaths[index]} should not bypass the private response helper`,
    )
  }

  assert.match(
    routes[6],
    /"Cache-Control": "private, no-store"/,
    "the protected extension download itself should also be private and no-store",
  )
})
