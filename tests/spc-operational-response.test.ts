import assert from "node:assert/strict"
import test from "node:test"
import { fcunoConnectionPolicy } from "../config/fcunoConnections"
import { formatSpcOperationalTime, parseSpcHealthResponse, parseSpcTechStackResponse } from "../lib/spcOperationalResponse"

const checkedAt = "2026-10-16T12:00:00.000Z"
const health = () => ({
  status: "ok", checkedAt, deployment: { commit: "a".repeat(40), shortCommit: "aaaaaaa", branch: "synthetic", deployedAt: "unknown", environment: "synthetic" },
  freshness: { state: "fresh", attemptedAt: checkedAt },
  checks: [{ id: "database", label: "SYNTHETIC", status: "ok", message: "Synthetic access check", checkedAt, details: { n: 0, text: "", bool: false, missing: null } }],
})
const tech = () => ({
  generatedAt: checkedAt,
  deployment: { platform: "VERCEL", project: fcunoConnectionPolicy.vercel.project, productionUrl: fcunoConnectionPolicy.vercel.productionOrigins[1], gitRepository: fcunoConnectionPolicy.github.repository, branch: "unknown", commit: "unknown" },
  verification: { environmentValues: "Presence only; credentials and external services are not checked." },
  secrets: [{ name: "SYNTHETIC", configured: true, value: "MASKED", status: "PRESENT — NOT VALIDATED", storage: "SYNTHETIC" }],
})

test("SPC operational contracts accept real shaped fresh/cached/stale checks and Hong Kong timestamps", () => {
  for (const state of ["fresh", "cached", "stale"]) {
    const payload = health(); payload.freshness.state = state
    assert.deepEqual(parseSpcHealthResponse(payload), payload)
  }
  assert.deepEqual(parseSpcTechStackResponse(tech()), tech())
  assert.match(formatSpcOperationalTime(checkedAt), /16 Oct 2026.*20:00 HKT/)
})

test("SPC health does not accept malformed or inconsistent green checks", () => {
  const value = health()
  for (const patch of [
    null, [], {}, { ...value, status: ["ok"] }, { ...value, status: "ok", checks: [{ ...value.checks[0], status: "error" }] },
    { ...value, deployment: null }, { ...value, deployment: { ...value.deployment, shortCommit: null } },
    { ...value, checkedAt: "2026-02-30T12:00:00.000Z" }, { ...value, freshness: null },
    { ...value, freshness: { state: ["fresh"], attemptedAt: checkedAt } },
    { ...value, freshness: { state: "fresh", attemptedAt: "2026-10-15T12:00:00.000Z" } },
    { ...value, checks: [] }, { ...value, checks: [null] }, { ...value, checks: [value.checks[0], value.checks[0]] },
    { ...value, checks: [{ ...value.checks[0], checkedAt: "2026-10-15T12:00:00.000Z" }] },
    { ...value, checks: [{ ...value.checks[0], details: [] }] },
    { ...value, checks: [{ ...value.checks[0], details: { count: Infinity } }] },
    { ...value, checks: [{ ...value.checks[0], details: { count: { nested: true } } }] },
  ]) assert.throws(() => parseSpcHealthResponse(patch), /Invalid|Inconsistent/)
})

test("SPC tech stack cannot render an unmasked credential or unusable/cross-project URL", () => {
  const value = tech()
  for (const patch of [
    null, {}, { ...value, deployment: null }, { ...value, generatedAt: "not a date" },
    { ...value, deployment: { ...value.deployment, productionUrl: "not-a-url" } },
    { ...value, deployment: { ...value.deployment, productionUrl: "https://unrelated.invalid" } },
    { ...value, deployment: { ...value.deployment, gitRepository: "unrelated/repo" } },
    { ...value, verification: null }, { ...value, verification: { environmentValues: "Credentials verified" } },
    { ...value, secrets: [] }, { ...value, secrets: [null] }, { ...value, secrets: [value.secrets[0], value.secrets[0]] },
    { ...value, secrets: [{ ...value.secrets[0], value: "never-display-this" }] },
    { ...value, secrets: [{ ...value.secrets[0], configured: "true" }] },
    { ...value, secrets: [{ ...value.secrets[0], status: "CONFIGURED" }] },
  ]) assert.throws(() => parseSpcTechStackResponse(patch), /Invalid/)
  for (const status of ["NOT PRESENT", "PLACEHOLDER — NOT VALIDATED"]) {
    assert.equal(parseSpcTechStackResponse({ ...value, secrets: [{ ...value.secrets[0], configured: false, status }] }).secrets[0].configured, false)
  }
})
