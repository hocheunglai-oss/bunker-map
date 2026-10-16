import assert from "node:assert/strict"
import test from "node:test"
import { operationalRuntime } from "./fixtures/spc-operational-api.mjs"

test("SPC health fresh responses satisfy the browser contract while the real clock advances", async () => {
  const f = operationalRuntime()
  f.state.clockStepMs = 1
  const response = await f.get()
  assert.equal(response.status, 200)
  assert.deepEqual(f.load("@/lib/spcOperationalResponse").parseSpcHealthResponse(response.body), response.body)
  assert.equal(response.body.freshness.attemptedAt, response.body.checkedAt, "One captured start timestamp owns the complete health attempt.")
})

test("SPC health never presents a failed refresh as a current successful check", async () => {
  const f = operationalRuntime()
  const first = await f.get()
  assert.deepEqual(f.load("@/lib/spcOperationalResponse").parseSpcHealthResponse(first.body), first.body)
  assert.equal(first.status, 200)
  assert.equal(first.body.status, "ok")
  const checkedAt = first.body.checkedAt
  f.state.now += 90_000; f.state.mode = "error"
  const failed = await f.get("system-health", true)
  assert.equal(failed.status, 200, "The previous verified check remains readable, explicitly marked stale.")
  assert.equal(failed.body.checkedAt, checkedAt)
  assert.deepEqual(failed.body.freshness, { state: "stale", attemptedAt: new Date(f.state.now).toISOString() })
  assert.deepEqual(f.load("@/lib/spcOperationalResponse").parseSpcHealthResponse(failed.body), failed.body)
  assert.equal(failed.headers["cache-control"], "private, no-store")
})

test("SPC health cache hits and in-flight reads never bypass current permissions", async () => {
  const f = operationalRuntime()
  assert.equal((await f.get()).body.freshness.state, "fresh")
  assert.equal((await f.get()).body.freshness.state, "cached")
  assert.equal(f.requests.length, 3)
  for (const permission of ["none", "signed-out"]) {
    f.state.permission = permission
    const denied = await f.get()
    assert.equal(denied.status, permission === "none" ? 403 : 401)
    assert.equal(denied.body.checks, undefined)
    assert.equal(denied.headers["cache-control"], "private, no-store")
  }
  assert.equal(f.authChecks.length, 4)
  assert.equal(f.requests.length, 3)
})

test("SPC health recovers after stale and does not replace a verified cache on failure", async () => {
  const f = operationalRuntime()
  const first = await f.get()
  f.state.now += 1_000; f.state.mode = "error"
  assert.equal((await f.get("system-health", true)).body.freshness.state, "stale")
  const hit = await f.get()
  assert.equal(hit.body.checkedAt, first.body.checkedAt)
  assert.equal(hit.body.freshness.state, "stale", "A later cache hit must still disclose the failed refresh until a new check succeeds.")
  f.state.now += 90_000; f.state.mode = "ok"; f.state.counts.spc_users = 7
  const recovered = await f.get()
  assert.equal(recovered.body.freshness.state, "fresh")
  assert.equal(recovered.body.checks.find(check => check.id === "spc-auth-users").details.users, 7)
  assert.equal(f.timers.size, 0)
})

test("SPC health errors and invalid counts are not fabricated as zero or green", async () => {
  for (const mode of ["error", "invalid-count"]) {
    const f = operationalRuntime()
    if (mode === "error") f.state.mode = mode
    else f.state.counts.spc_users = Number.NaN
    const failed = await f.get()
    assert.equal(failed.status, 500)
    assert.equal(failed.body.checks, undefined)
    assert.equal(failed.headers["cache-control"], "private, no-store")
    assert.equal(f.timers.size, 0)
  }
})

test("SPC health has a bounded deadline even when the transport ignores abort", async () => {
  const f = operationalRuntime()
  f.state.mode = "defer"
  const held = f.get()
  while (f.pending.length !== 3) await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.timers.size, 1)
  assert.equal([...f.timers.values()][0].ms, 15_000, "The server deadline is exactly15seconds.")
  f.expireDeadline()
  const expired = await held
  assert.equal(expired.status, 500)
  assert.ok(f.pending.every(request => request.signal.aborted))
  f.state.mode = "ok"; f.state.counts.spc_users = 8
  const fresh = await f.get()
  assert.equal(fresh.body.freshness.state, "fresh")
  f.state.counts.spc_users = 99
  f.pending.splice(0).forEach(request => request.resolve())
  await new Promise(resolve => setImmediate(resolve))
  const hit = await f.get()
  assert.equal(hit.body.checks.find(check => check.id === "spc-auth-users").details.users, 8)
  assert.equal(f.timers.size, 0)
})

test("SPC health coalesces concurrent reads but still checks each actor and marks a timed-out refresh stale", async () => {
  const f = operationalRuntime()
  const first = await f.get()
  f.state.now += 90_000; f.state.mode = "defer"
  const left = f.get("system-health", true), right = f.get("system-health", true)
  while (f.pending.length !== 3) await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.authChecks.length, 3)
  assert.equal(f.requests.length, 6)
  f.expireDeadline()
  const [a, b] = await Promise.all([left, right])
  assert.deepEqual(a.body, b.body)
  assert.equal(a.body.freshness.state, "stale")
  assert.equal(a.body.checkedAt, first.body.checkedAt)
  f.pending.splice(0).forEach(request => request.resolve())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.timers.size, 0)
})

test("SPC tech stack uses canonical identity, masked presence only, and private errors", async () => {
  const secret = "synthetic-never-return-this-value"
  const f = operationalRuntime({ WHATSAPP_ACCESS_TOKEN: secret, GOOGLE_OAUTH_CLIENT_SECRET: " [redacted] ", EXCHANGE_SMTP_PASSWORD: "   " })
  const config = f.load("@/config/fcunoConnections").fcunoConnectionPolicy
  const response = await f.get("tech-stack")
  assert.equal(response.status, 200)
  assert.deepEqual(f.load("@/lib/spcOperationalResponse").parseSpcTechStackResponse(response.body), response.body)
  assert.equal(response.body.deployment.project, config.vercel.project)
  assert.equal(response.body.deployment.productionUrl, config.vercel.productionOrigins[1])
  assert.equal(response.body.deployment.gitRepository, config.github.repository)
  assert.equal(response.body.deployment.branch, "unknown")
  assert.equal(response.headers["cache-control"], "private, no-store")
  assert.equal(response.body.verification.environmentValues, "Presence only; credentials and external services are not checked.")
  assert.ok(!JSON.stringify(response.body).includes(secret))
  assert.ok(response.body.secrets.every(item => item.value === "MASKED"))
  assert.equal(response.body.secrets.find(item => item.name === "WHATSAPP_ACCESS_TOKEN").status, "PRESENT — NOT VALIDATED")
  assert.equal(response.body.secrets.find(item => item.name === "GOOGLE_OAUTH_CLIENT_SECRET").configured, false)
  assert.equal(response.body.secrets.find(item => item.name === "EXCHANGE_SMTP_PASSWORD").configured, false)
  for (const permission of ["none", "signed-out"]) {
    f.state.permission = permission
    const denied = await f.get("tech-stack")
    assert.equal(denied.status, permission === "none" ? 403 : 401)
    assert.equal(denied.headers["cache-control"], "private, no-store")
    assert.equal(denied.body.secrets, undefined)
  }
  assert.equal(f.requests.length, 0, "The register does not probe or spend on external services.")
})
