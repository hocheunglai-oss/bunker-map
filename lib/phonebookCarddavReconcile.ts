import { createHash } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  acquireCardDavWriteLease, cardDavRequest, cardHref, fetchContacts, getCardDavConfig,
  httpSyncError, putContact, readSavedContactIds, SyncError,
  type CardDavWriteLease,
} from "./phonebookCarddav"

const QUEUE_TABLE = "phonebook_carddav_queue"
const BACKUP_TABLE = "phonebook_carddav_quarantine"
const MAX_WRITES = 10
const MAX_REMOVALS = 20
const MAX_CARD_BYTES = 1_000_000
type Resource = { path: string; etag: string; contactId: string | null }
type QueueItem = { contact_id: string; version: string; attempts: number }

export type PhonebookReconcileResult = {
  saved: number; total: number; matched: number; missing: number; orphaned: number; other: number
  removed: number; repaired: number; pending: number; failed: number; verified: boolean
  blocked: string | null
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const idsHash = (ids: Set<string>) => hash([...ids].sort().join("\n"))
const safeError = () => new SyncError("Phonebook reconciliation could not be verified. The queued changes and recovery copies have been preserved.", "verification")

function decodeXml(value: string) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">" }
    if (named[entity]) return named[entity]
    const number = entity.startsWith("&#x") ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1))
    return String.fromCodePoint(number)
  })
}

// Cleanup deliberately uses a stricter parser than the non-mutating count UI:
// any partial/error/malformed member makes the entire deletion pass unsafe.
export function parseReconcileInventory(xml: string, addressBookUrl: string): Resource[] {
  if (Buffer.byteLength(xml) > 15_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml) || !/^\s*(?:<\?xml[^>]*>\s*)?<(?:[\w-]+:)?multistatus\b/i.test(xml) || !/<\/(?:[\w-]+:)?multistatus\s*>\s*$/i.test(xml)) throw safeError()
  const book = new URL(addressBookUrl)
  const responses = [...xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)]
  if ((xml.match(/<(?:[\w-]+:)?response\b/gi) || []).length !== responses.length) throw safeError()
  const resources = new Map<string, Resource>()
  for (const response of responses) {
    const statuses = [...response[1].matchAll(/<(?:[\w-]+:)?status\b[^>]*>HTTP\/[^\s]+\s+(\d{3})\b/gi)].map((match) => Number(match[1]))
    const hrefs = [...response[1].matchAll(/<(?:[\w-]+:)?href\b[^>]*>([^<]*)<\/(?:[\w-]+:)?href>/gi)]
    if (hrefs.length !== 1) throw safeError()
    const url = new URL(decodeXml(hrefs[0][1]), book)
    if (url.origin !== book.origin || !url.pathname.startsWith(book.pathname) || url.username || url.password || url.search || url.hash) throw safeError()
    const filename = decodeURIComponent(url.pathname.slice(book.pathname.length))
    if (!filename) continue
    if (statuses.length === 0 || statuses.some((status) => status < 200 || status >= 300)) throw safeError()
    if (filename.includes("/") || filename.includes("\\") || /<(?:[\w-]+:)?collection\b/i.test(response[1])) throw safeError()
    const etagMatch = /<(?:[\w-]+:)?getetag\b[^>]*>([^<]*)<\/(?:[\w-]+:)?getetag>/i.exec(response[1])
    const etag = etagMatch ? decodeXml(etagMatch[1]).trim() : ""
    if (!etag) throw safeError()
    // Only the single canonical name is authoritative; case/encoding aliases
    // remain extra resources and cannot conceal a duplicate contact.
    const candidate = /^bunker-map-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.vcf$/.exec(filename)?.[1]
    const contactId = candidate && url.pathname === new URL(cardHref(candidate), book).pathname ? candidate : null
    const item = { path: url.pathname, etag, contactId }
    const previous = resources.get(item.path)
    if (previous && previous.etag !== item.etag) throw safeError()
    resources.set(item.path, item)
  }
  return [...resources.values()].sort((a, b) => a.path.localeCompare(b.path))
}

export async function readReconcileInventory() {
  const response = await cardDavRequest("", {
    method: "PROPFIND", cache: "no-store",
    headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
    body: '<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>',
  })
  if (response.status !== 207) throw httpSyncError("verification", response.status)
  return parseReconcileInventory(await readBoundedText(response, 15_000_000), getCardDavConfig().addressBookUrl)
}

async function readBoundedText(response: Response, maxBytes = MAX_CARD_BYTES) {
  if (Number(response.headers.get("content-length")) > maxBytes) throw safeError()
  const reader = response.body?.getReader()
  if (!reader) throw safeError()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) { await reader.cancel(); throw safeError() }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  // Preserve a BOM rather than silently altering the backed-up bytes. The
  // strict vCard validator then rejects it, leaving the original untouched.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))
}

function compare(saved: Set<string>, resources: Resource[]) {
  const present = new Set(resources.flatMap((resource) => resource.contactId ? [resource.contactId] : []))
  const missing = [...saved].filter((id) => !present.has(id))
  const extras = resources.filter((resource) => !resource.contactId || !saved.has(resource.contactId))
  return { missing, extras, matched: saved.size - missing.length, orphaned: extras.filter((resource) => resource.contactId).length, other: extras.filter((resource) => !resource.contactId).length }
}

async function checkSourceUnchanged(supabase: SupabaseClient, snapshotHash: string) {
  const current = await readSavedContactIds(supabase)
  if (!current.size || idsHash(current) !== snapshotHash) throw new SyncError("The phonebook changed during reconciliation. Cleanup is deferred safely.", "source-check")
}

export async function quarantineAndDelete(
  supabase: SupabaseClient, resource: Resource, snapshotHash: string, lease: CardDavWriteLease,
) {
  const original = await cardDavRequest(resource.path, { method: "GET", cache: "no-store", headers: { "Cache-Control": "no-cache" } })
  if (!original.ok) throw httpSyncError("verification", original.status)
  const etag = original.headers.get("etag") || ""
  if (!/^"[\x21\x23-\x7e]+"$/.test(etag) || etag !== resource.etag) throw safeError()
  const vcard = await readBoundedText(original)
  if (!/^BEGIN:VCARD\r?\n(?:[\s\S]*\r?\n)?END:VCARD\r?\n?$/.test(vcard) || (vcard.match(/^BEGIN:VCARD\r?$/gm) || []).length !== 1) throw safeError()
  const contentHash = hash(vcard)
  const bookHash = hash(getCardDavConfig().addressBookUrl)
  const row = {
    address_book_hash: bookHash, resource_path: resource.path, etag, vcard,
    content_sha256: contentHash, reason: resource.contactId ? "orphan" : "unmanaged",
    source_ids_sha256: snapshotHash,
  }
  const stored = await supabase.from(BACKUP_TABLE).upsert(row, { onConflict: "address_book_hash,resource_path,content_sha256", ignoreDuplicates: true })
  if (stored.error) throw safeError()
  const proof = await supabase.from(BACKUP_TABLE).select("id,vcard,content_sha256")
    .eq("address_book_hash", bookHash).eq("resource_path", resource.path).eq("content_sha256", contentHash).single()
  if (proof.error || !proof.data?.id || proof.data.vcard !== vcard || proof.data.content_sha256 !== hash(proof.data.vcard)) throw safeError()
  await checkSourceUnchanged(supabase, snapshotHash)
  await lease.beforeWrite()
  const deleted = await cardDavRequest(resource.path, { method: "DELETE", headers: { "If-Match": etag }, cache: "no-store" })
  if (!deleted.ok && deleted.status !== 404) throw httpSyncError("delete", deleted.status)
  const verified = await cardDavRequest(resource.path, { method: "GET", cache: "no-store", headers: { "Cache-Control": "no-cache" } })
  if (verified.status !== 404) throw safeError()
  const marked = await supabase.from(BACKUP_TABLE).update({ deleted_at: new Date().toISOString() }).eq("id", proof.data.id)
  if (marked.error) throw safeError()
}

async function acknowledge(supabase: SupabaseClient, item: QueueItem) {
  const { error } = await supabase.from(QUEUE_TABLE).delete().eq("contact_id", item.contact_id).eq("version", item.version)
  if (error) throw safeError()
}

async function defer(supabase: SupabaseClient, item: QueueItem) {
  const attempts = item.attempts + 1
  const delay = Math.min(3600, 30 * 2 ** Math.min(attempts, 7))
  const { error } = await supabase.from(QUEUE_TABLE).update({
    attempts, next_attempt_at: new Date(Date.now() + delay * 1000).toISOString(),
    last_error: "CardDAV verification failed; retry scheduled.",
  }).eq("contact_id", item.contact_id).eq("version", item.version)
  if (error) throw safeError()
}

export async function runPhonebookCarddavReconcile(supabase: SupabaseClient): Promise<PhonebookReconcileResult> {
  const lease = await acquireCardDavWriteLease(supabase)
  let phase = "source"
  const result: PhonebookReconcileResult = { saved: 0, total: 0, matched: 0, missing: 0, orphaned: 0, other: 0, removed: 0, repaired: 0, pending: 0, failed: 0, verified: false, blocked: null }
  try {
    const source = await readSavedContactIds(supabase)
    const snapshotHash = idsHash(source)
    if (!source.size) throw new SyncError("The saved phonebook is empty. Automatic cleanup is disabled.", "source-check")
    phase = "inventory"
    const initial = compare(source, await readReconcileInventory())
    // Persist repair intent before doing network work. An interrupted worker
    // or browser can never be the sole owner of an unsent saved change.
    if (initial.missing.length) {
      const enqueued = await supabase.from(QUEUE_TABLE).upsert(initial.missing.slice(0, 5000).map((contact_id) => ({ contact_id })), { onConflict: "contact_id", ignoreDuplicates: true })
      if (enqueued.error) throw safeError()
    }
    phase = "queue"
    const queue = await supabase.from(QUEUE_TABLE).select("contact_id,version,attempts")
      .lte("next_attempt_at", new Date().toISOString()).order("queued_at", { ascending: true }).order("contact_id", { ascending: true }).limit(MAX_WRITES)
    if (queue.error || !queue.data) throw safeError()
    const waitingDeletes: QueueItem[] = []
    for (const item of queue.data as QueueItem[]) {
      if (Date.now() > lease.deadline - 40_000) { result.blocked = "time-budget"; break }
      try {
        const current = await fetchContacts(supabase, { contactIds: [item.contact_id] })
        if (current.contacts.length) {
          await putContact(supabase, current.contacts[0], lease)
          await acknowledge(supabase, item)
          result.repaired += 1
        } else {
          const remote = await cardDavRequest(cardHref(item.contact_id), { method: "GET", cache: "no-store" })
          if (remote.status === 404) await acknowledge(supabase, item)
          else if (remote.ok) waitingDeletes.push(item)
          else throw httpSyncError("verification", remote.status)
        }
      } catch {
        result.failed += 1
        await defer(supabase, item)
      }
    }
    phase = "stable-inventory"
    await checkSourceUnchanged(supabase, snapshotHash)
    let resources = await readReconcileInventory()
    const beforeCleanup = compare(source, resources)
    const removalLimit = Math.min(MAX_REMOVALS, Math.max(5, Math.floor(source.size * 0.01)))
    if (beforeCleanup.missing.length) result.blocked = "missing-contacts"
    else if (beforeCleanup.extras.length > removalLimit) result.blocked = "removal-safety-limit"
    else if (beforeCleanup.extras.length && !result.blocked) {
      const repeated = await readReconcileInventory()
      if (JSON.stringify(resources) !== JSON.stringify(repeated)) result.blocked = "remote-changed"
      else for (const resource of beforeCleanup.extras) {
        if (Date.now() > lease.deadline - 40_000) { result.blocked = "time-budget"; break }
        phase = "quarantine-and-delete"
        await quarantineAndDelete(supabase, resource, snapshotHash, lease)
        result.removed += 1
      }
    }
    phase = "delete-acknowledgment"
    for (const item of waitingDeletes) {
      const current = await fetchContacts(supabase, { contactIds: [item.contact_id] })
      if (current.contacts.length) continue
      const remote = await cardDavRequest(cardHref(item.contact_id), { method: "GET", cache: "no-store" })
      if (remote.status === 404) await acknowledge(supabase, item)
    }
    phase = "final-verification"
    await checkSourceUnchanged(supabase, snapshotHash)
    resources = await readReconcileInventory()
    await checkSourceUnchanged(supabase, snapshotHash)
    const final = compare(source, resources)
    const pending = await supabase.from(QUEUE_TABLE).select("contact_id", { count: "exact", head: true })
    if (pending.error || pending.count == null) throw safeError()
    Object.assign(result, { saved: source.size, total: resources.length, matched: final.matched,
      missing: final.missing.length, orphaned: final.orphaned, other: final.other, pending: pending.count })
    result.verified = result.saved === result.total && !result.missing && !result.orphaned && !result.other && !result.pending && !result.failed && !result.blocked
    console.info("phonebook_carddav_reconcile", result)
    return result
  } catch (error) {
    console.error("phonebook_carddav_reconcile_phase_failed", { phase, ...(error instanceof SyncError ? { stage: error.stage, status: error.status } : {}) })
    throw error instanceof SyncError ? error : safeError()
  } finally { await lease.release() }
}
