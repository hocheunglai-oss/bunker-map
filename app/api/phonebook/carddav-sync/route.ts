import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { requireAdminPagePermission } from "@/lib/adminAuth"

import { SYNC_BATCH_SIZE, SyncError, safeSyncError, httpSyncError, logSyncFailure, logVerifiedContacts, requireEnv, getCardDavConfig, readSavedContactIds, cardDavRequest, countAddressBookCards, inspectOtherCards, validateSyncRequest, deleteCard, fetchContacts, putContact, type SyncStage, acquireCardDavWriteLease, readCardDavQueueVersions, acknowledgeCardDavQueue } from "@/lib/phonebookCarddav"

export const maxDuration = 300

export async function GET(request: Request) {
  try {
    await requireAdminPagePermission("phonebook", "view")
    const supabase = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"))
    const { addressBookUrl } = getCardDavConfig()
    const [saved, remote] = await Promise.all([
      readSavedContactIds(supabase),
      cardDavRequest("", {
        method: "PROPFIND",
        headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
        body: '<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>',
        cache: "no-store",
      }),
    ])
    if (remote.status !== 207) throw httpSyncError("verification", remote.status)
    const xml = await remote.text()
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
      return NextResponse.json({ message: error.message }, { status: error.message === "Unauthorized" ? 401 : 403 })
    }
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
