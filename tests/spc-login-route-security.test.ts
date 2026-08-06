import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const route = readFileSync(
  new URL("../app/api/spc/login/route.ts", import.meta.url),
  "utf8",
)

test("SPC login reserves the persistent limiter before checking credentials", () => {
  const beginIndex = route.indexOf("await beginSpcLoginAttempt")
  const validateIndex = route.indexOf("await validateSpcCredentials")
  const sessionIndex = route.indexOf("await setSpcSession")

  assert.ok(beginIndex > 0)
  assert.ok(validateIndex > beginIndex)
  assert.ok(sessionIndex > validateIndex)
  assert.match(route, /await completeSpcLoginAttempt\(\{[\s\S]*?succeeded: false/)
  assert.match(route, /await completeSpcLoginAttempt\(\{[\s\S]*?succeeded: true/)
})

test("SPC login fails closed and keeps authentication responses generic", () => {
  assert.match(route, /if \(!sourceIp\)/)
  assert.match(route, /status,?[\s\S]*?"Cache-Control": "private, no-store"/)
  assert.match(route, /"Retry-After": String\(attempt\.retryAfterSeconds\)/)
  assert.match(route, /Too many sign-in attempts\. Please try again later\./)
  assert.match(route, /Invalid username or password\./)
  assert.match(route, /Sign-in is temporarily unavailable\. Please try again\./)
  assert.doesNotMatch(route, /message:\s*error instanceof Error/)
})

test("SPC login monitoring uses hashes and trace IDs rather than raw usernames", () => {
  assert.match(route, /hashSpcLoginUsername\(limitedUsername\)/)
  assert.match(route, /requestId: requestContext\.requestId/)
  assert.match(route, /platformRequestId: requestContext\.platformRequestId/)
  assert.match(route, /usernameHash/)
  assert.doesNotMatch(route, /console\.(?:info|warn|error)\([^\n]*username[,}]/)
  assert.doesNotMatch(route, /sourceIp:\s*details\.sourceIp/)
  assert.doesNotMatch(route, /usernameHash:\s*details\.usernameHash/)
})

test("SPC login exponentially samples repeated rate-limit logs", () => {
  assert.match(route, /if \(attempt\.shouldLogRateLimit\)/)
  assert.match(route, /blockedCount: attempt\.blockedCount/)
})

test("SPC login best-effort cancels every reserved attempt on infrastructure errors", () => {
  assert.match(
    route,
    /catch \(error\) \{[\s\S]*?bestEffortCancelSpcLoginAttempt\([\s\S]*?"authentication_unavailable"/,
  )
  assert.match(
    route,
    /catch \(error\) \{[\s\S]*?bestEffortCancelSpcLoginAttempt\([\s\S]*?"session_unavailable"/,
  )
  assert.ok(
    route.split('"attempt_monitoring_unavailable"').length - 1 >= 4,
    "monitoring failures and both cancellation paths stay explicit",
  )
})
