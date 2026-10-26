import { NextResponse } from "next/server"
import { performance } from "node:perf_hooks"
import { createClient } from "@supabase/supabase-js"
import { requireAdminPagePermission, requireAdminSession } from "@/lib/adminAuth"
import { isAdminRole } from "@/lib/adminPages"
import { observePhonebookCarddavSemanticShadow } from "@/lib/phonebookCarddavSemanticShadow"

import { SYNC_BATCH_SIZE, SyncError, safeSyncError, logSyncFailure, logVerifiedContacts, requireEnv, getCardDavConfig, getCardDavAddressBookUrl, readSavedContactIds, readCardDavInventoryXml, countAddressBookCards, inspectOtherCards, validateSyncRequest, deleteCard, fetchContacts, putContact, type SyncStage, acquireCardDavWriteLease, readCardDavQueueVersions, acknowledgeCardDavQueue } from "@/lib/phonebookCarddav"

export const maxDuration = 300

const PRIVATE_DIAGNOSTIC_HEADERS = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" }
const CONTENT_PROPERTIES = ["UID", "FN", "N", "ORG", "TITLE", "TEL", "EMAIL", "NOTE", "CATEGORIES", "X-BUNKER-MAP-CONTACT-ID", "X-BUNKER-MAP-SYNC-HASH"]
const COVERAGE_PROPERTIES = ["FN", "N", "ORG", "TITLE", "TEL", "EMAIL", "NOTE"]
const SHAPE_FLAGS = ["nonAsciiName", "escapedText", "multiplePhoneEndpoints", "multipleEmailEndpoints"]

function diagnosticJson(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: PRIVATE_DIAGNOSTIC_HEADERS })
}

function fixedDiagnosticWindow(params: URLSearchParams) {
  const keys = ["verifyContent", "startsAt", "expiresAt"]
  if ([...params.keys()].some((key) => !keys.includes(key)) || keys.some((key) => params.getAll(key).length !== 1)) return null
  const startsAt = params.get("startsAt")!, expiresAt = params.get("expiresAt")!
  const strictTime = (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
  if (!strictTime(startsAt) || !strictTime(expiresAt)) return null
  const starts = Date.parse(startsAt), expires = Date.parse(expiresAt), now = Date.now()
  if (expires <= starts || expires - starts > 900_000 || now < starts || now >= expires) return null
  return { approved: true, startsAt, expiresAt }
}

function safeDiagnosticSummary(value: Record<string, unknown> | null, commit: string) {
  if (!value || value.commit !== commit || typeof value.version !== "string" || !/^fcuno-vcard3-shadow\/\d{4}-\d{2}-\d{2}\.\d+$/.test(value.version)) return null
  const countKeys = ["match", "different", "unsupported", "incompleteCards", "comparableCards"]
  const integer = (item: unknown, max: number) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0 && item <= max
  if (![1, 2].includes(Number(value.sampleSize)) || typeof value.sampleSize !== "number" || countKeys.some((key) => !integer(value[key], 2))) return null
  if (Number(value.match) + Number(value.different) + Number(value.unsupported) + Number(value.incompleteCards) !== value.sampleSize || Number(value.comparableCards) !== Number(value.match) + Number(value.different)) return null
  if (value.observationIncomplete !== false || value.incompleteCards !== 0 || value.wholeBookContentVerified !== false || value.physicalDeviceVerified !== false || !integer(value.elapsedMs, 300_000)) return null
  const hash = (item: unknown) => typeof item === "string" && /^[a-f0-9]{64}$/.test(item)
  if (!hash(value.sourceBeforeSha256) || !hash(value.sourceAfterSha256) || value.sourceChanged !== (value.sourceBeforeSha256 !== value.sourceAfterSha256)) return null
  if (!Array.isArray(value.differingProperties) || value.differingProperties.length > CONTENT_PROPERTIES.length || value.differingProperties.some((item) => typeof item !== "string" || !CONTENT_PROPERTIES.includes(item))) return null
  const coverage = (item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null
    const record = item as Record<string, unknown>
    return COVERAGE_PROPERTIES.every((key) => integer(record[key], 10_000)) ? Object.fromEntries(COVERAGE_PROPERTIES.map((key) => [key, record[key]])) : null
  }
  const expectedNonempty = coverage(value.expectedNonempty), observedNonempty = coverage(value.observedNonempty)
  const flags = value.expectedShapeFlags as Record<string, unknown> | null
  if (!expectedNonempty || !observedNonempty || !flags || SHAPE_FLAGS.some((key) => typeof flags[key] !== "boolean")) return null
  const keys = ["version", "commit", "sampleSize", ...countKeys, "observationIncomplete", "sourceChanged", "sourceBeforeSha256", "sourceAfterSha256", "differingProperties", "wholeBookContentVerified", "physicalDeviceVerified", "elapsedMs"]
  return { ...Object.fromEntries(keys.map((key) => [key, value[key]])), expectedNonempty, observedNonempty, expectedShapeFlags: Object.fromEntries(SHAPE_FLAGS.map((key) => [key, flags[key]])) }
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const configurationRequested = params.has("configuration")
  const contentRequested = params.getAll("verifyContent").includes("1")
  const requestStartedMonotonicMs = contentRequested ? performance.now() : 0
  try {
    if (configurationRequested) {
      // Authenticate the actual ADMIN role before query validation or reading
      // configuration. Phonebook View/Edit alone must not disclose it.
      const session = await requireAdminSession()
      if (!isAdminRole(session.role)) throw new Error("Forbidden")
      if (params.getAll("configuration").length !== 1 || params.get("configuration") !== "1" || [...params.keys()].some((key) => key !== "configuration")) {
        return diagnosticJson({ message: "Use configuration=1 without other parameters." }, 400)
      }
      // Configuration only: no credentials, business reads, provider requests,
      // synchronization, or claim that the provider connection is healthy.
      const hostname = new URL(getCardDavAddressBookUrl()).hostname
      const environment = process.env.VERCEL_ENV
      const commit = process.env.DEPLOY_COMMIT || process.env.NEXT_PUBLIC_DEPLOY_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || ""
      return diagnosticJson({
        hostname,
        deployment: {
          environment: ["production", "preview", "development"].includes(environment || "") ? environment : null,
          commit: /^[a-f0-9]{40}$/.test(commit) ? commit : null,
        },
        connectivity: "not_checked",
        checkedAt: new Date().toISOString(),
      }, 200)
    }
    await requireAdminPagePermission("phonebook", "view")
    if (contentRequested) {
      const window = fixedDiagnosticWindow(params)
      if (!window) return diagnosticJson({ message: "A current fixed content-verification window of at most 15 minutes is required." }, 400)
      const environment = process.env.VERCEL_ENV
      const commit = process.env.DEPLOY_COMMIT || process.env.NEXT_PUBLIC_DEPLOY_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || ""
      if (environment !== "production" || !/^[a-f0-9]{40}$/.test(commit)) return diagnosticJson({ message: "CardDAV content verification is unavailable." }, 503)
      const captured: { summary: Record<string, unknown> | null } = { summary: null }
      // One explicit read-only observation inside the caller's fixed interval,
      // not monitoring, a sliding activation window, or a synchronization ACK.
      await observePhonebookCarddavSemanticShadow({ sourceUrl: requireEnv("NEXT_PUBLIC_SUPABASE_URL"), serviceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"), requestStartedMonotonicMs }, {
        window, metadata: { environment, commit },
        log: (event, summary) => { if (event === "phonebook_carddav_semantic_shadow") captured.summary = summary },
      })
      const summary = safeDiagnosticSummary(captured.summary, commit)
      return summary ? diagnosticJson({ contentVerification: summary }, 200) : diagnosticJson({ message: "CardDAV content verification did not complete." }, 503)
    }
    const supabase = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"))
    const { addressBookUrl } = getCardDavConfig()
    const [saved, xml] = await Promise.all([
      readSavedContactIds(supabase),
      readCardDavInventoryXml(request.signal),
    ])
    if (!/<(?:[\w-]+:)?multistatus\b/i.test(xml) || !/<\/(?:[\w-]+:)?multistatus\s*>\s*$/i.test(xml)) {
      throw new SyncError("Invalid CardDAV count response.", "verification")
    }
    const { managedIds, otherPaths, ...counts } = countAddressBookCards(xml, addressBookUrl)
    const missingContactIds = [...saved].filter((id) => !managedIds.has(id))
    const orphanedContactIds = [...managedIds].filter((id) => !saved.has(id))
    const comparison = {
      matched: saved.size - missingContactIds.length,
      missing: missingContactIds.length,
      orphaned: orphanedContactIds.length,
    }
    // Counts and bounded internal UUIDs only, never names or contact fields.
    // Equal totals alone do not prove the same contacts are present.
    console.info("phonebook_carddav_inventory", {
      saved: saved.size, ...counts, ...comparison,
      missingContactIds: missingContactIds.slice(0, 20),
      orphanedContactIds: orphanedContactIds.slice(0, 20),
    })
    const detailsRequested = new URL(request.url).searchParams.get("details") === "1"
    const otherContacts = detailsRequested ? await inspectOtherCards(otherPaths, saved) : undefined
    if (otherContacts) console.info("phonebook_carddav_other_inventory", {
      sampled: otherContacts.length,
      unreadable: otherContacts.filter((card) => !card.readable).length,
      referencingSavedContact: otherContacts.filter((card) => card.sourceExists).length,
      referencingAbsentContact: otherContacts.filter((card) => card.sourceContactId && !card.sourceExists).length,
      withoutFcUnoId: otherContacts.filter((card) => card.readable && !card.sourceContactId).length,
    })
    return NextResponse.json({
      savedContactCount: saved.size,
      carddavContactCount: counts.managed,
      carddavTotalCount: counts.total,
      carddavOtherCount: counts.other,
      carddavMatchedCount: comparison.matched,
      carddavMissingCount: comparison.missing,
      carddavOrphanCount: comparison.orphaned,
      missingContactIds: missingContactIds.slice(0, 20),
      orphanedContactIds: orphanedContactIds.slice(0, 20),
      ...(otherContacts ? { otherContacts, otherContactsTruncated: otherPaths.length > otherContacts.length } : {}),
      checkedAt: new Date().toISOString(),
    }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      const status = error.message === "Unauthorized" ? 401 : 403
      return contentRequested || configurationRequested ? diagnosticJson({ message: error.message }, status) : NextResponse.json({ message: error.message }, { status })
    }
    if (configurationRequested) return diagnosticJson({ message: "CardDAV configuration unavailable." }, 503)
    if (contentRequested) return diagnosticJson({ message: "CardDAV content verification did not complete." }, 503)
    const safeError = safeSyncError(error, "verification")
    logSyncFailure(undefined, safeError)
    return NextResponse.json({ message: "CardDAV count unavailable. Please retry." }, { status: 503 })
  }
}

export async function POST(request: Request) {
  let lease: Awaited<ReturnType<typeof acquireCardDavWriteLease>> | undefined
  try {
    await requireAdminPagePermission("phonebook", "edit")
    const body = validateSyncRequest(await request.json().catch(() => null))
    const supabase = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    )
    getCardDavConfig()
    const requestedIds = [...body.contactIds, ...body.deleteContactIds]
    if (requestedIds.length) {
      const queued = await supabase.rpc("enqueue_phonebook_carddav", { p_contact_ids: requestedIds })
      if (queued.error) throw new SyncError("Unable to queue phonebook synchronization. Please retry.", "source-read")
    }
    lease = await acquireCardDavWriteLease(supabase)
    const failed: Array<{ id: string; label: string; error: string; stage: SyncStage; status?: number }> = []
    const verifiedIds: string[] = []
    const recordFailure = (id: string, error: unknown, stage: SyncStage) => {
      const safeError = safeSyncError(error, stage)
      logSyncFailure(id, safeError)
      failed.push({
        id,
        label: `CONTACT ${id.slice(0, 8)}`,
        error: safeError.message,
        stage: safeError.stage,
        ...(safeError.status ? { status: safeError.status } : {}),
      })
    }
    if (body.deleteContactIds.length > 0) {
      const versions = await readCardDavQueueVersions(supabase, body.deleteContactIds)
      for (const id of body.deleteContactIds) {
        try {
          await deleteCard(supabase, id, lease)
          await acknowledgeCardDavQueue(supabase, versions.find((item) => item.contact_id === id))
          verifiedIds.push(id)
        } catch (error) {
          recordFailure(id, error, "delete")
        }
      }
      return NextResponse.json({
        message: failed.length ? `Verified ${verifiedIds.length} deletions. ${failed.length} contacts still need attention.` : `Verified ${verifiedIds.length} CardDAV deletions.`,
        failed,
        verifiedIds,
        verifiedCount: verifiedIds.length,
        syncedCount: verifiedIds.length,
        total: body.deleteContactIds.length,
        done: true,
        nextCursor: null,
        phase: "delete",
      }, { status: failed.length ? 207 : 200 })
    }

    const { contacts, total: sourceTotal } = await fetchContacts(supabase, body)
    // Old company-sync clients do not follow cursors. Fail before any write,
    // rather than silently claiming a two-contact partial sync is complete.
    if (body.company && sourceTotal > SYNC_BATCH_SIZE && !body.explicitCursor) {
      throw new SyncError("Refresh Phonebook and try Sync selected company again.", "input")
    }
    if (!requestedIds.length && contacts.length) {
      const queued = await supabase.rpc("enqueue_phonebook_carddav", { p_contact_ids: contacts.map((contact) => contact.id) })
      if (queued.error) throw new SyncError("Unable to queue phonebook synchronization. Please retry.", "source-read")
    }
    const total = body.contactIds.length || sourceTotal
    const versions = await readCardDavQueueVersions(supabase, contacts.map((contact) => contact.id))
    const foundIds = new Set(contacts.map((contact) => contact.id))
    for (const id of body.contactIds) {
      if (!foundIds.has(id)) recordFailure(id, new SyncError("Contact was not found in the saved phonebook.", "source-read"), "source-read")
    }
    for (const contact of contacts) {
      try {
        await putContact(supabase, contact, lease)
        await acknowledgeCardDavQueue(supabase, versions.find((item) => item.contact_id === contact.id))
        verifiedIds.push(contact.id)
      } catch (error) {
        recordFailure(contact.id, error, "upload")
      }
    }
    logVerifiedContacts(verifiedIds, body.contactIds.length > 0)
    // Legacy fullRebuild/phase:"delete" is intentionally a non-destructive
    // upsert pass. An interrupted resync must never erase the shared book.
    const done = body.contactIds.length > 0 || body.cursor + contacts.length >= total
    return NextResponse.json({
      message: failed.length
        ? `Verified ${verifiedIds.length} CardDAV contacts. ${failed.length} contacts still need retry.`
        : `Verified ${verifiedIds.length} contacts in CardDAV.`,
      failed,
      verifiedIds,
      verifiedCount: verifiedIds.length,
      total,
      done,
      nextCursor: done ? null : body.cursor + contacts.length,
      syncedCount: verifiedIds.length,
      phase: "upload",
    }, { status: failed.length ? 207 : 200 })
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 }
      )
    }
    const safeError = safeSyncError(error, "source-read")
    logSyncFailure(undefined, safeError)
    return NextResponse.json(
      { message: safeError.message, stage: safeError.stage },
      { status: safeError.stage === "input" ? 400 : 503 },
    )
  } finally {
    await lease?.release()
  }
}
