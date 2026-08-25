import assert from "node:assert/strict"
import test from "node:test"
import {
  isCertifiedRecipientProjectionAvailable,
  type OutlookExchangeTruthVerification,
} from "../lib/outlookRecipientMapAvailability"

const NOW_MS = Date.parse("2026-08-25T04:00:00.000Z")
const MAX_AGE_SECONDS = 36 * 60 * 60
const FINGERPRINT = "a".repeat(64)

function healthyTruth(
  overrides: Partial<OutlookExchangeTruthVerification> = {},
): OutlookExchangeTruthVerification {
  return {
    valid: true,
    integrityValid: true,
    ledgerValid: true,
    snapshotsValid: true,
    referencesValid: true,
    operationallyConsistent: true,
    latestCertificationRunId: "11111111-1111-4111-8111-111111111111",
    latestCertificationAt: "2026-08-25T03:00:00.000Z",
    latestSourceFingerprint: FINGERPRINT,
    latestCertificationHasProjectionEvidence: true,
    latestProjectionSnapshotSha256: FINGERPRINT,
    queue: {
      pending: 0,
      processing: 0,
      failed: 0,
      terminalFailed: 0,
    },
    ...overrides,
  }
}

test("normal pending and processing sync work does not block a certified map", () => {
  for (const queue of [
    { pending: 1, processing: 0, failed: 0, terminalFailed: 0 },
    { pending: 0, processing: 1, failed: 0, terminalFailed: 0 },
  ]) {
    assert.equal(
      isCertifiedRecipientProjectionAvailable(
        healthyTruth({ operationallyConsistent: false, queue }),
        NOW_MS,
        MAX_AGE_SECONDS,
      ),
      true,
    )
  }
})

test("failed sync work still blocks the certified map", () => {
  for (const queue of [
    { pending: 0, processing: 0, failed: 1, terminalFailed: 0 },
    { pending: 0, processing: 0, failed: 1, terminalFailed: 1 },
  ]) {
    assert.equal(
      isCertifiedRecipientProjectionAvailable(
        healthyTruth({ operationallyConsistent: false, queue }),
        NOW_MS,
        MAX_AGE_SECONDS,
      ),
      false,
    )
  }
})

test("invalid, mismatched, future, and stale certifications remain blocked", () => {
  for (const truth of [
    healthyTruth({ valid: false }),
    healthyTruth({ integrityValid: false }),
    healthyTruth({ ledgerValid: false }),
    healthyTruth({ snapshotsValid: false }),
    healthyTruth({ referencesValid: false }),
    healthyTruth({ latestCertificationHasProjectionEvidence: false }),
    healthyTruth({ latestCertificationRunId: "" }),
    healthyTruth({ latestSourceFingerprint: "not-a-fingerprint" }),
    healthyTruth({ latestProjectionSnapshotSha256: "b".repeat(64) }),
    healthyTruth({ latestCertificationAt: "2026-08-25T04:06:00.000Z" }),
    healthyTruth({ latestCertificationAt: "2026-08-23T15:59:59.000Z" }),
  ]) {
    assert.equal(
      isCertifiedRecipientProjectionAvailable(
        truth,
        NOW_MS,
        MAX_AGE_SECONDS,
      ),
      false,
    )
  }
})
