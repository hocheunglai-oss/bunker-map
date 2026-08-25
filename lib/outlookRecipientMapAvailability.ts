export type OutlookExchangeTruthVerification = {
  valid?: unknown
  integrityValid?: unknown
  ledgerValid?: unknown
  snapshotsValid?: unknown
  referencesValid?: unknown
  operationallyConsistent?: unknown
  latestCertificationRunId?: unknown
  latestCertificationAt?: unknown
  latestSourceFingerprint?: unknown
  latestCertificationHasProjectionEvidence?: unknown
  latestProjectionSnapshotSha256?: unknown
  queue?: {
    pending?: unknown
    processing?: unknown
    failed?: unknown
    terminalFailed?: unknown
  }
}

const CLOCK_SKEW_MS = 5 * 60 * 1000

function cleanText(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

export function isCertifiedRecipientProjectionAvailable(
  value: OutlookExchangeTruthVerification,
  nowMs: number,
  maxAgeSeconds: number,
) {
  const queue = value.queue || {}
  const certifiedAtMs = Date.parse(cleanText(value.latestCertificationAt))
  const certificationAgeMs = nowMs - certifiedAtMs
  const sourceFingerprint = cleanText(value.latestSourceFingerprint).toLowerCase()

  return (
    value.valid === true &&
    value.integrityValid === true &&
    value.ledgerValid === true &&
    value.snapshotsValid === true &&
    value.referencesValid === true &&
    value.latestCertificationHasProjectionEvidence === true &&
    cleanText(value.latestCertificationRunId) !== "" &&
    /^[0-9a-f]{64}$/.test(sourceFingerprint) &&
    cleanText(value.latestProjectionSnapshotSha256).toLowerCase() ===
      sourceFingerprint &&
    // Normal background delivery must not interrupt existing templates. A
    // failed row remains blocking because Exchange may be only partly updated.
    Number(queue.failed || 0) === 0 &&
    Number(queue.terminalFailed || 0) === 0 &&
    Number.isFinite(certifiedAtMs) &&
    certificationAgeMs >= -CLOCK_SKEW_MS &&
    certificationAgeMs <= maxAgeSeconds * 1000
  )
}
