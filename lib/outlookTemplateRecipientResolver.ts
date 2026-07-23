import "server-only"

import { createClient } from "@supabase/supabase-js"

export type OutlookTemplateRecipientField = "to" | "cc" | "bcc"
export type OutlookTemplateRecipientKind = "contact" | "group" | "external" | "unresolved"
export type OutlookTemplateRecipientStatus = "resolved" | "external" | "ambiguous" | "missing"

export type OutlookTemplateRecipientRef = {
  field: OutlookTemplateRecipientField
  position: number
  literal: string
  displayName: string
  sourceValue: string
  kind: OutlookTemplateRecipientKind
  sourceId: string | null
  resolvedAddress: string | null
  status: OutlookTemplateRecipientStatus
}

export type OutlookTemplateRecipientResolution = {
  schema: "fcuno.outlook-template-recipient-resolution/v1"
  certificationRunId: string
  certifiedAt: string
  sourceFingerprint: string
  resolvedAt: string
  refs: Record<OutlookTemplateRecipientField, OutlookTemplateRecipientRef[]>
  counts: {
    total: number
    resolved: number
    external: number
    ambiguous: number
    missing: number
  }
}

export type OutlookTemplateRecipientResolver = {
  certificationRunId: string
  certifiedAt: string
  sourceFingerprint: string
  resolve: (fields: {
    to: string
    cc: string
    bcc: string
  }, previousResolution?: OutlookTemplateRecipientResolution | null) =>
    OutlookTemplateRecipientResolution
}

type ProjectionContact = {
  sourceContactId?: unknown
  alias?: unknown
  directoryName?: unknown
  displayName?: unknown
  externalEmailAddress?: unknown
  nickname?: unknown
}

type ProjectionGroup = {
  sourceGroupId?: unknown
  alias?: unknown
  smtpAddress?: unknown
  directoryName?: unknown
  groupName?: unknown
  memberCount?: unknown
}

type CertifiedProjection = {
  contacts?: ProjectionContact[]
  groups?: ProjectionGroup[]
}

type TruthVerification = {
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

type ResolverCandidate = {
  kind: "contact" | "group"
  sourceId: string
  displayName: string
  resolvedAddress: string
}

const MIN_CERTIFICATION_MAX_AGE_SECONDS = 120
const DEFAULT_CERTIFICATION_MAX_AGE_SECONDS = 36 * 60 * 60
const MAX_CERTIFICATION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
const CLOCK_SKEW_MS = 5 * 60 * 1000

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured.`)
  return value
}

function getServiceClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  )
}

function cleanText(value: unknown) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
}

export function normaliseOutlookRecipientKey(value: unknown) {
  return cleanText(value)
    .replace(/^"+|"+$/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9@._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function splitOutlookRecipientText(value: string) {
  const text = String(value || "").replace(/\r?\n/g, " ")
  const parts: string[] = []
  let current = ""
  let inQuote = false
  let angleDepth = 0

  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index)
    if (char === "\"" && text.charAt(index - 1) !== "\\") inQuote = !inQuote
    if (!inQuote && char === "<") angleDepth += 1
    if (!inQuote && char === ">" && angleDepth > 0) angleDepth -= 1
    if (!inQuote && angleDepth === 0 && (char === "," || char === ";")) {
      if (current.trim()) parts.push(current.trim())
      current = ""
      continue
    }
    current += char
  }

  if (current.trim()) parts.push(current.trim())
  return parts
}

function parseRecipientLiteral(literal: string) {
  const trimmed = cleanText(literal)
  const angleMatch = trimmed.match(/^(.*?)\s*<([^<>]+)>\s*$/)
  if (!angleMatch) {
    return {
      displayName: trimmed.includes("@") ? "" : trimmed.replace(/^"+|"+$/g, ""),
      sourceValue: trimmed.replace(/^"+|"+$/g, ""),
    }
  }

  return {
    displayName: cleanText(angleMatch[1]).replace(/^"+|"+$/g, ""),
    sourceValue: cleanText(angleMatch[2]).replace(/^"+|"+$/g, ""),
  }
}

function addCandidate(
  lookup: Map<string, ResolverCandidate[]>,
  keyValue: unknown,
  candidate: ResolverCandidate,
) {
  const key = normaliseOutlookRecipientKey(keyValue)
  if (!key) return
  const current = lookup.get(key) || []
  if (!current.some((item) => item.kind === candidate.kind && item.sourceId === candidate.sourceId)) {
    current.push(candidate)
    lookup.set(key, current)
  }
}

function cleanProjectedEmail(value: unknown) {
  const raw = cleanText(value)
  const email = raw.toLowerCase()
  return raw === email && /^[^@\s]+@[^@\s]+$/.test(email) ? email : ""
}

function certificationMaxAgeSeconds() {
  const configured = Number(process.env.OUTLOOK_ADDIN_CERTIFICATION_MAX_AGE_SECONDS)
  if (!Number.isFinite(configured)) return DEFAULT_CERTIFICATION_MAX_AGE_SECONDS
  return Math.max(
    MIN_CERTIFICATION_MAX_AGE_SECONDS,
    Math.min(Math.floor(configured), MAX_CERTIFICATION_MAX_AGE_SECONDS),
  )
}

function buildResolverLookups(projection: CertifiedProjection) {
  const named = new Map<string, ResolverCandidate[]>()
  const addresses = new Map<string, ResolverCandidate[]>()
  const bySourceKey = new Map<string, ResolverCandidate>()

  for (const contact of projection.contacts || []) {
    const sourceId = cleanText(contact.sourceContactId)
    const address = cleanProjectedEmail(contact.externalEmailAddress)
    const sourceKey = `contact:${sourceId}`
    if (!sourceId || !address) {
      throw new Error("The certified projection contains an unusable contact.")
    }
    if (bySourceKey.has(sourceKey)) {
      throw new Error("The certified projection contains a duplicate contact identity.")
    }
    const displayName = cleanText(
      contact.displayName ||
        contact.directoryName ||
        contact.nickname ||
        address,
    )
    const candidate: ResolverCandidate = {
      kind: "contact",
      sourceId,
      displayName,
      resolvedAddress: address,
    }
    bySourceKey.set(sourceKey, candidate)
    addCandidate(addresses, address, candidate)
    addCandidate(named, contact.displayName, candidate)
    addCandidate(named, contact.directoryName, candidate)
    addCandidate(named, contact.nickname, candidate)
  }

  for (const group of projection.groups || []) {
    const sourceId = cleanText(group.sourceGroupId)
    const alias = cleanText(group.alias).toLowerCase()
    const address = cleanProjectedEmail(group.smtpAddress)
    const memberCount = Number(group.memberCount)
    const sourceKey = `group:${sourceId}`
    if (
      !sourceId ||
      !/^[a-z0-9._-]{1,64}$/.test(alias) ||
      !address ||
      address.slice(0, address.lastIndexOf("@")) !== alias ||
      !Number.isSafeInteger(memberCount) ||
      memberCount <= 0
    ) {
      throw new Error(
        "The certified projection does not contain an exact usable group SMTP address.",
      )
    }
    if (bySourceKey.has(sourceKey)) {
      throw new Error("The certified projection contains a duplicate group identity.")
    }
    const displayName = cleanText(
      group.groupName || group.directoryName || alias,
    )
    const candidate: ResolverCandidate = {
      kind: "group",
      sourceId,
      displayName,
      resolvedAddress: address,
    }
    bySourceKey.set(sourceKey, candidate)
    addCandidate(addresses, address, candidate)
    addCandidate(named, group.groupName, candidate)
    addCandidate(named, group.directoryName, candidate)
    addCandidate(named, group.alias, candidate)
  }

  return { named, addresses, bySourceKey }
}

function resolveField(
  field: OutlookTemplateRecipientField,
  value: string,
  lookups: ReturnType<typeof buildResolverLookups>,
  previousRefs: OutlookTemplateRecipientRef[] = [],
) {
  return splitOutlookRecipientText(value).map<OutlookTemplateRecipientRef>((literal, position) => {
    const { displayName, sourceValue } = parseRecipientLiteral(literal)
    const previousRef = previousRefs[position]
    const previousStableSourceId =
      previousRef &&
      previousRef.field === field &&
      previousRef.position === position &&
      previousRef.literal === literal &&
      previousRef.sourceValue === sourceValue &&
      ["contact", "group"].includes(previousRef.kind) &&
      ["resolved", "missing"].includes(previousRef.status)
        ? cleanText(previousRef.sourceId)
        : ""

    if (previousRef && previousStableSourceId) {
      const stableCandidate = lookups.bySourceKey.get(
        `${previousRef.kind}:${previousStableSourceId}`,
      )
      if (stableCandidate) {
        return {
          field,
          position,
          literal,
          displayName: displayName || stableCandidate.displayName,
          sourceValue,
          kind: stableCandidate.kind,
          sourceId: stableCandidate.sourceId,
          resolvedAddress: stableCandidate.resolvedAddress,
          status: "resolved",
        }
      }

      return {
        field,
        position,
        literal,
        displayName: displayName || cleanText(previousRef.displayName),
        sourceValue,
        kind: previousRef.kind,
        sourceId: previousStableSourceId,
        resolvedAddress: null,
        status: "missing",
      }
    }

    const explicitAddress = sourceValue.includes("@")
    const candidates =
      (explicitAddress ? lookups.addresses : lookups.named).get(
        normaliseOutlookRecipientKey(sourceValue),
      ) || []

    if (candidates.length === 1) {
      const candidate = candidates[0]
      return {
        field,
        position,
        literal,
        displayName: displayName || candidate.displayName,
        sourceValue,
        kind: candidate.kind,
        sourceId: candidate.sourceId,
        resolvedAddress: candidate.resolvedAddress,
        status: "resolved",
      }
    }

    if (candidates.length > 1) {
      return {
        field,
        position,
        literal,
        displayName,
        sourceValue,
        kind: "unresolved",
        sourceId: null,
        resolvedAddress: explicitAddress ? sourceValue.toLowerCase() : null,
        status: "ambiguous",
      }
    }

    if (explicitAddress) {
      return {
        field,
        position,
        literal,
        displayName,
        sourceValue,
        kind: "external",
        sourceId: null,
        resolvedAddress: sourceValue.toLowerCase(),
        status: "external",
      }
    }

    return {
      field,
      position,
      literal,
      displayName,
      sourceValue,
      kind: "unresolved",
      sourceId: null,
      resolvedAddress: null,
      status: "missing",
    }
  })
}

function isHealthyTruthState(
  value: TruthVerification,
  nowMs = Date.now(),
  maxAgeSeconds = certificationMaxAgeSeconds(),
) {
  const queue = value.queue || {}
  const certifiedAtMs = Date.parse(cleanText(value.latestCertificationAt))
  const certificationAgeMs = nowMs - certifiedAtMs
  return (
    value.valid === true &&
    value.integrityValid === true &&
    value.ledgerValid === true &&
    value.snapshotsValid === true &&
    value.referencesValid === true &&
    value.operationallyConsistent === true &&
    value.latestCertificationHasProjectionEvidence === true &&
    Number(queue.pending || 0) === 0 &&
    Number(queue.processing || 0) === 0 &&
    Number(queue.failed || 0) === 0 &&
    Number(queue.terminalFailed || 0) === 0 &&
    Number.isFinite(certifiedAtMs) &&
    certificationAgeMs >= -CLOCK_SKEW_MS &&
    certificationAgeMs <= maxAgeSeconds * 1000
  )
}

export async function loadOutlookTemplateRecipientResolver(): Promise<OutlookTemplateRecipientResolver> {
  const supabase = getServiceClient()
  const { data: verificationData, error: verificationError } = await supabase.rpc(
    "verify_outlook_exchange_truth_ledger",
  )
  if (verificationError) throw verificationError

  const verification = (verificationData || {}) as TruthVerification
  if (!isHealthyTruthState(verification)) {
    throw new Error(
      "The certified FCUNO-to-Exchange projection is not current and settled. Recipient resolution is disabled.",
    )
  }

  const certificationRunId = cleanText(verification.latestCertificationRunId)
  const certifiedAt = cleanText(verification.latestCertificationAt)
  const sourceFingerprint = cleanText(verification.latestSourceFingerprint).toLowerCase()
  const projectionSnapshotSha256 = cleanText(
    verification.latestProjectionSnapshotSha256,
  ).toLowerCase()

  if (
    !certificationRunId ||
    !certifiedAt ||
    !/^[0-9a-f]{64}$/.test(sourceFingerprint) ||
    projectionSnapshotSha256 !== sourceFingerprint
  ) {
    throw new Error("The latest Exchange certification is missing canonical projection evidence.")
  }

  const { data: snapshot, error: snapshotError } = await supabase
    .from("outlook_exchange_truth_snapshots")
    .select("canonical_json")
    .eq("snapshot_kind", "fcuno_exchange_projection")
    .eq("snapshot_sha256", sourceFingerprint)
    .maybeSingle()
  if (snapshotError) throw snapshotError
  if (!snapshot?.canonical_json) {
    throw new Error("The certified Exchange projection snapshot is unavailable.")
  }

  const projection =
    typeof snapshot.canonical_json === "string"
      ? (JSON.parse(snapshot.canonical_json) as CertifiedProjection)
      : (snapshot.canonical_json as CertifiedProjection)
  const lookups = buildResolverLookups(projection)

  return {
    certificationRunId,
    certifiedAt,
    sourceFingerprint,
    resolve(fields, previousResolution = null) {
      const refs = {
        to: resolveField(
          "to",
          fields.to,
          lookups,
          previousResolution?.refs.to,
        ),
        cc: resolveField(
          "cc",
          fields.cc,
          lookups,
          previousResolution?.refs.cc,
        ),
        bcc: resolveField(
          "bcc",
          fields.bcc,
          lookups,
          previousResolution?.refs.bcc,
        ),
      }
      const allRefs = [...refs.to, ...refs.cc, ...refs.bcc]

      return {
        schema: "fcuno.outlook-template-recipient-resolution/v1",
        certificationRunId,
        certifiedAt,
        sourceFingerprint,
        resolvedAt: new Date().toISOString(),
        refs,
        counts: {
          total: allRefs.length,
          resolved: allRefs.filter((item) => item.status === "resolved").length,
          external: allRefs.filter((item) => item.status === "external").length,
          ambiguous: allRefs.filter((item) => item.status === "ambiguous").length,
          missing: allRefs.filter((item) => item.status === "missing").length,
        },
      }
    },
  }
}

export async function resolveOutlookTemplateRecipients(fields: {
  to: string
  cc: string
  bcc: string
}): Promise<OutlookTemplateRecipientResolution> {
  const resolver = await loadOutlookTemplateRecipientResolver()
  return resolver.resolve(fields)
}

export function formatResolvedOutlookRecipient(ref: OutlookTemplateRecipientRef) {
  if (!ref.resolvedAddress) return ""
  const displayName = cleanText(ref.displayName)
  return displayName ? `${displayName} <${ref.resolvedAddress}>` : ref.resolvedAddress
}
