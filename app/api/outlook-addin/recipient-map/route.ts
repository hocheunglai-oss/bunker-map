import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server"
import { requireOutlookAddinPagePermissionForRequest } from "@/lib/adminAuth"
import {
  isCertifiedRecipientProjectionAvailable,
  type OutlookExchangeTruthVerification,
} from "@/lib/outlookRecipientMapAvailability"

export const dynamic = "force-dynamic"
export const revalidate = 0

const RECIPIENT_MAP_TTL_SECONDS = 120
const DEFAULT_CERTIFICATION_MAX_AGE_SECONDS = 36 * 60 * 60
const MAX_CERTIFICATION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
type ProjectionContact = {
  sourceContactId?: unknown
  directoryName?: unknown
  displayName?: unknown
  externalEmailAddress?: unknown
}

type ProjectionGroup = {
  sourceGroupId?: unknown
  directoryName?: unknown
  groupName?: unknown
  alias?: unknown
  smtpAddress?: unknown
  memberCount?: unknown
}

type CertifiedProjection = {
  contacts?: ProjectionContact[]
  groups?: ProjectionGroup[]
}

type CertifiedRecipientMapEntry = {
  kind: "contact" | "group"
  sourceId: string
  displayName: string
  emailAddress: string
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function getSupabaseClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

function cleanText(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function cleanEmail(value: unknown) {
  const email = cleanText(value).toLowerCase()
  return /^[^@\s]+@[^@\s]+$/.test(email) ? email : ""
}

function privateHeaders() {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  }
}

function certificationMaxAgeSeconds() {
  const configured = Number(process.env.OUTLOOK_ADDIN_CERTIFICATION_MAX_AGE_SECONDS)
  if (!Number.isFinite(configured)) return DEFAULT_CERTIFICATION_MAX_AGE_SECONDS
  return Math.max(
    RECIPIENT_MAP_TTL_SECONDS,
    Math.min(Math.floor(configured), MAX_CERTIFICATION_MAX_AGE_SECONDS),
  )
}

function buildCertifiedRecipientMap(projection: CertifiedProjection) {
  const recipientsBySourceKey: Record<string, CertifiedRecipientMapEntry> = {}
  let contactCount = 0
  let groupCount = 0

  for (const contact of projection.contacts || []) {
    const sourceId = cleanText(contact.sourceContactId)
    const emailAddress = cleanEmail(contact.externalEmailAddress)
    if (!sourceId || !emailAddress) {
      throw new Error("Certified projection contains an unusable contact.")
    }
    const sourceKey = `contact:${sourceId}`
    if (recipientsBySourceKey[sourceKey]) {
      throw new Error("Certified projection contains a duplicate contact identity.")
    }
    recipientsBySourceKey[sourceKey] = {
      kind: "contact",
      sourceId,
      displayName: cleanText(contact.displayName || contact.directoryName || emailAddress),
      emailAddress,
    }
    contactCount += 1
  }

  for (const group of projection.groups || []) {
    const sourceId = cleanText(group.sourceGroupId)
    const alias = cleanText(group.alias).toLowerCase()
    const rawEmailAddress = cleanText(group.smtpAddress)
    const emailAddress = cleanEmail(rawEmailAddress)
    const memberCount = Number(group.memberCount || 0)
    if (
      !sourceId ||
      !alias ||
      !emailAddress ||
      rawEmailAddress !== emailAddress ||
      emailAddress.slice(0, emailAddress.lastIndexOf("@")) !== alias ||
      !Number.isSafeInteger(memberCount) ||
      memberCount <= 0 ||
      !/^[a-z0-9._-]{1,64}$/.test(alias)
    ) {
      throw new Error(
        "Certified projection does not contain an exact usable group SMTP address.",
      )
    }
    const sourceKey = `group:${sourceId}`
    if (recipientsBySourceKey[sourceKey]) {
      throw new Error("Certified projection contains a duplicate group identity.")
    }
    recipientsBySourceKey[sourceKey] = {
      kind: "group",
      sourceId,
      displayName: cleanText(group.groupName || group.directoryName || alias),
      emailAddress,
    }
    groupCount += 1
  }

  return {
    recipientsBySourceKey,
    counts: {
      contacts: contactCount,
      groups: groupCount,
      mappedSourceIds: contactCount + groupCount,
    },
  }
}

function authError(error: unknown) {
  if (!(error instanceof Error)) return null
  if (error.message === "Unauthorized") {
    return NextResponse.json(
      { code: "SIGN_IN_REQUIRED", message: "Sign in to FC Uno to use Outlook Templates." },
      { status: 401, headers: privateHeaders() },
    )
  }
  if (error.message === "Forbidden") {
    return NextResponse.json(
      { code: "OUTLOOK_TEMPLATES_FORBIDDEN", message: "Outlook Templates view permission is required." },
      { status: 403, headers: privateHeaders() },
    )
  }
  return null
}

export async function GET(request: Request) {
  try {
    await requireOutlookAddinPagePermissionForRequest(
      request,
      "email-templates",
      "view",
    )
    const supabase = getSupabaseClient()
    const now = new Date()
    const maxAgeSeconds = certificationMaxAgeSeconds()
    const { data: verificationData, error: verificationError } = await supabase.rpc(
      "verify_outlook_exchange_truth_ledger",
    )
    if (verificationError) throw verificationError

    const verification = (verificationData || {}) as OutlookExchangeTruthVerification
    if (
      !isCertifiedRecipientProjectionAvailable(
        verification,
        now.getTime(),
        maxAgeSeconds,
      )
    ) {
      return NextResponse.json(
        {
          code: "RECIPIENT_TRUTH_UNAVAILABLE",
          message: "The certified FCUNO-to-Exchange address book is not current and settled.",
        },
        { status: 503, headers: privateHeaders() },
      )
    }

    const certificationRunId = cleanText(verification.latestCertificationRunId)
    const certifiedAt = new Date(cleanText(verification.latestCertificationAt)).toISOString()
    const sourceFingerprint = cleanText(verification.latestSourceFingerprint).toLowerCase()
    const { data: snapshot, error: snapshotError } = await supabase
      .from("outlook_exchange_truth_snapshots")
      .select("snapshot_sha256,snapshot_kind,schema_version,canonical_json,created_at")
      .eq("snapshot_kind", "fcuno_exchange_projection")
      .eq("snapshot_sha256", sourceFingerprint)
      .maybeSingle()

    if (snapshotError) throw snapshotError
    if (
      !snapshot ||
      snapshot.snapshot_sha256 !== sourceFingerprint ||
      snapshot.snapshot_kind !== "fcuno_exchange_projection"
    ) {
      return NextResponse.json(
        {
          code: "RECIPIENT_PROJECTION_MISSING",
          message: "The certified Exchange projection is unavailable.",
        },
        { status: 503, headers: privateHeaders() },
      )
    }

    const projection = (
      typeof snapshot.canonical_json === "string"
        ? JSON.parse(snapshot.canonical_json)
        : snapshot.canonical_json
    ) as CertifiedProjection
    const map = buildCertifiedRecipientMap(projection)
    const expiresAt = new Date(now.getTime() + RECIPIENT_MAP_TTL_SECONDS * 1000)

    return NextResponse.json(
      {
        schema: "fcuno.outlook-certified-recipient-map/v2",
        generatedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        ttlSeconds: RECIPIENT_MAP_TTL_SECONDS,
        certification: {
          runId: certificationRunId,
          certifiedAt,
          sourceFingerprint,
          projectionSnapshotSha256: snapshot.snapshot_sha256,
          projectionCreatedAt: snapshot.created_at,
          maxAgeSeconds,
        },
        ...map,
      },
      { headers: privateHeaders() },
    )
  } catch (error) {
    const response = authError(error)
    if (response) return response

    return NextResponse.json(
      {
        code: "RECIPIENT_MAP_FAILED",
        message: "The certified Outlook recipient map is temporarily unavailable.",
      },
      { status: 503, headers: privateHeaders() },
    )
  }
}
