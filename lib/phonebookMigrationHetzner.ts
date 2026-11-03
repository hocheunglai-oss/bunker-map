import { createHash } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { fcunoConnectionPolicy } from "../config/fcunoConnections"
import {
  buildCompanyPhone, buildVCard, cardHref, compareManagedVCard, normalizeCompanyKey, UUID_PATTERN,
  type PhonebookContact, type PhonebookCompany,
} from "./phonebookCarddav"
import { parseReconcileInventory } from "./phonebookCarddavReconcile"

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const CONTACT_FIELDS = "id,full_name,company,title,position,department,direct_line,mobile_1,mobile_2,personal_email,general_email,private_email,notes"
const COMPANY_FIELDS = "id,name,other_name,country,tel_country,tel_area,tel_no_1,phone"
const PROPERTIES = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>'
const COLLECTION_PROPERTIES = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'

export const migrationSourceUrl = `https://${fcunoConnectionPolicy.supabase.projectRef}.supabase.co`
export type MigrationTarget = { addressBookUrl: string; expectedOrigin: string; expectedUsername: string }
export type MigrationCard = { id: string; vcard: string; contentHash: string }
export type MigrationSnapshot = { cards: MigrationCard[]; hash: string }
export type MigrationCheckpoint = { version: 1; sourceProject: string; targetHash: string; verified: Record<string, string> }

export class PhonebookMigrationError extends Error {}
function fail(message: string): never { throw new PhonebookMigrationError(message) }

export function validateMigrationSourceCredential(key: string) {
  // A browser/publishable credential may return an RLS-filtered subset. Never
  // mistake that subset for the complete company phonebook during migration.
  if (/^sb_secret_[A-Za-z0-9_-]+$/.test(key)) return
  try {
    const parts = key.split(".")
    if (parts.length !== 3) fail("invalid")
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
    if (payload.role !== "service_role" || payload.ref !== fcunoConnectionPolicy.supabase.projectRef) fail("invalid")
  } catch { fail("Migration requires a server credential for the pinned FCUNO project, never a browser or user key.") }
  // The pinned Supabase endpoint verifies the credential signature on use.
}

/** No generic host override: custom domains need a separately reviewed policy change. */
export function validateMigrationTarget(value: MigrationTarget, username: string, currentAddressBookUrl?: string) {
  let url: URL
  let origin: URL
  try { url = new URL(value.addressBookUrl); origin = new URL(value.expectedOrigin) }
  catch { return fail("Invalid migration target lock.") }
  if (url.protocol !== "https:" || url.href !== value.addressBookUrl || url.port || url.username || url.password || url.search || url.hash
    || !/^nx[a-z0-9-]+\.your-storageshare\.de$/.test(url.hostname)
    || origin.href !== `${origin.origin}/` || value.expectedOrigin !== origin.origin || url.origin !== origin.origin
    || username !== value.expectedUsername || !username || /[\u0000-\u001f\u007f:/\\]/.test(username)) fail("Migration target/account does not match the Hetzner lock.")
  const parts = url.pathname.split("/")
  if (parts.length !== 8 || parts.slice(0, 5).join("/") !== "/remote.php/dav/addressbooks/users"
    || !parts[5] || !parts[6] || parts[7] !== "") fail("Target must be an exact Nextcloud address-book collection URL ending in /.")
  try {
    if (decodeURIComponent(parts[5]) !== username || /[/\\\u0000-\u001f\u007f]/.test(decodeURIComponent(parts[6]))) fail("Target address-book account does not match.")
  } catch { fail("Invalid target path encoding.") }
  if (currentAddressBookUrl && new URL(currentAddressBookUrl).origin === url.origin) fail("Migration destination must differ from the current production origin.")
  return Object.freeze({ ...value, addressBookUrl: url.href })
}

export function canonicalMigrationVCard(vcard: string) {
  if (Buffer.byteLength(vcard) > 1_000_000 || vcard.includes("\0")) fail("Invalid destination contact.")
  const lines = vcard.replace(/\r?\n[ \t]/g, "").split(/\r?\n/).filter(Boolean)
  if (lines[0] !== "BEGIN:VCARD" || lines.at(-1) !== "END:VCARD"
    || lines.filter(line => line === "BEGIN:VCARD").length !== 1
    || lines.filter(line => line === "END:VCARD").length !== 1) fail("Invalid destination contact.")
  return lines.filter(line => !line.startsWith("REV:")).sort().join("\n")
}

export function migrationSnapshot(contacts: PhonebookContact[]): MigrationSnapshot {
  if (!contacts.length) fail("Source phonebook is empty; migration is blocked.")
  const ids = new Set<string>()
  const cards = contacts.map(contact => {
    if (!UUID_PATTERN.test(contact.id) || contact.id !== contact.id.toLowerCase() || ids.has(contact.id)) fail("Source contact IDs are invalid or duplicated.")
    ids.add(contact.id)
    const vcard = buildVCard(contact)
    return { id: contact.id, vcard, contentHash: digest(canonicalMigrationVCard(vcard)) }
  }).sort((a, b) => a.id.localeCompare(b.id))
  return { cards, hash: digest(cards.map(card => `${card.id}:${card.contentHash}`).join("\n")) }
}

/** Keyset reads avoid offset drift; matching repeated snapshots detect concurrent edits. */
export async function loadMigrationSnapshot(client: SupabaseClient): Promise<MigrationSnapshot> {
  async function rows<T extends { id: string }>(table: string, fields: string): Promise<T[]> {
    const result: T[] = []
    let after: string | undefined
    let expectedCount: number | undefined
    for (;;) {
      let query = client.from(table).select(fields, after ? undefined : { count: "exact" }).order("id", { ascending: true }).limit(1000)
      if (after) query = query.gt("id", after)
      const { data, error, count } = await query
      if (error || !data) fail("Unable to read the pinned FCUNO source.")
      if (expectedCount === undefined) {
        if (count === null || !Number.isSafeInteger(count) || count < 0) fail("Unable to verify the complete source row count.")
        expectedCount = count
      }
      const batch = data as unknown as T[]
      for (const row of batch) {
        if (!UUID_PATTERN.test(row.id) || row.id !== row.id.toLowerCase() || (after && row.id <= after)) fail("Source pagination is invalid or did not advance.")
        after = row.id
      }
      result.push(...batch)
      if (result.length === expectedCount) return result
      if (!batch.length || result.length > expectedCount) fail("Source row count changed or pagination was incomplete; retry the snapshot.")
      // Continue even when the server caps a page below 1,000 rows.
    }
  }
  const [contacts, companies] = await Promise.all([
    rows<Omit<PhonebookContact, "company_phone" | "company_other_name">>("phonebook_contacts", CONTACT_FIELDS),
    rows<PhonebookCompany & { id: string }>("phonebook_companies", COMPANY_FIELDS),
  ])
  const companyMap = new Map<string, { phone: string; other: string | null }>()
  for (const company of companies) {
    const key = normalizeCompanyKey(company.name)
    const projected = { phone: buildCompanyPhone(company), other: company.other_name || null }
    const previous = companyMap.get(key)
    if (previous && JSON.stringify(previous) !== JSON.stringify(projected)) fail("Ambiguous company telephone mapping; review the source before migration.")
    companyMap.set(key, projected)
  }
  return migrationSnapshot(contacts.map(contact => ({ ...contact,
    company_phone: companyMap.get(normalizeCompanyKey(contact.company))?.phone || null,
    company_other_name: companyMap.get(normalizeCompanyKey(contact.company))?.other || null,
  })))
}

async function boundedText(response: Response, maximum: number) {
  if (Number(response.headers.get("content-length")) > maximum || !response.body) fail("Destination response exceeded its bound or was empty.")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maximum) { await reader.cancel(); fail("Destination response exceeded its bound.") }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
}

function strongEtag(response: Response) {
  const etag = response.headers.get("etag") || ""
  if (!/^"[\x21\x23-\x7e]+"$/.test(etag)) fail("Destination requires strong ETags for safe updates.")
  return etag
}

export type MigrationOptions = {
  target: MigrationTarget; username: string; password: string; apply?: boolean; concurrency?: number
  currentAddressBookUrl?: string; checkpoint?: MigrationCheckpoint
  loadSource: () => Promise<MigrationSnapshot>
  saveCheckpoint?: (checkpoint: MigrationCheckpoint) => Promise<void>
  /** Dependency injection for synthetic tests; CLI always uses native fetch and HTTPS. */
  transport?: typeof fetch
}

export async function runHetznerMigration(options: MigrationOptions) {
  const startedAt = performance.now()
  const target = validateMigrationTarget(options.target, options.username, options.currentAddressBookUrl)
  if (!options.password || /[\r\n]/.test(options.password)) fail("Migration writer credentials are missing or invalid.")
  const concurrency = options.concurrency ?? 4
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) fail("Concurrency must be between 1 and 8.")
  const targetHash = digest(`${target.addressBookUrl}\n${target.expectedUsername}`)
  const checkpoint: MigrationCheckpoint = options.checkpoint || { version: 1, sourceProject: fcunoConnectionPolicy.supabase.projectRef, targetHash, verified: {} }
  if (checkpoint.version !== 1 || checkpoint.sourceProject !== fcunoConnectionPolicy.supabase.projectRef || checkpoint.targetHash !== targetHash
    || !checkpoint.verified || typeof checkpoint.verified !== "object" || Array.isArray(checkpoint.verified)) fail("Checkpoint belongs to a different source or destination.")
  const transport = options.transport || fetch
  async function request(member: string, method: "PROPFIND" | "GET" | "PUT", init: RequestInit = {}) {
    if (member && !/^bunker-map-[0-9a-f-]{36}\.vcf$/.test(member)) fail("Destination request escaped the locked collection.")
    const response = await transport(new URL(member, target.addressBookUrl), {
      ...init, method, redirect: "error", signal: AbortSignal.timeout(30_000), cache: "no-store",
      headers: { ...init.headers, Authorization: `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}` },
    })
    if (response.status >= 300 && response.status < 400) fail("Destination redirects are forbidden.")
    return response
  }
  async function inventory() {
    const response = await request("", "PROPFIND", { headers: { Depth: "1", "Content-Type": "application/xml" }, body: PROPERTIES })
    if (response.status !== 207) fail(`Destination inventory failed (HTTP ${response.status}).`)
    return parseReconcileInventory(await boundedText(response, 15_000_000), target.addressBookUrl)
  }
  // Prove this exact account path is an address book, rather than a DAV root or file collection.
  const probe = await request("", "PROPFIND", { headers: { Depth: "0", "Content-Type": "application/xml" }, body: COLLECTION_PROPERTIES })
  if (probe.status !== 207) fail(`Destination preflight failed (HTTP ${probe.status}).`)
  const xml = await boundedText(probe, 1_000_000)
  if (parseReconcileInventory(xml, target.addressBookUrl).length !== 0) fail("Preflight did not return the exact locked collection.")
  const responses = [...xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)]
  const propertyStatuses = responses.length === 1
    ? [...responses[0][1].matchAll(/<(?:[\w-]+:)?propstat\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?propstat>/gi)] : []
  const verifiedCollection = propertyStatuses.some(block => {
    const statuses = [...block[1].matchAll(/<(?:[\w-]+:)?status\b[^>]*>HTTP\/[^\s]+\s+(\d{3})\b/gi)]
    const resourceType = /<(?:[\w-]+:)?resourcetype\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?resourcetype>/i.exec(block[1])?.[1] || ""
    return statuses.length === 1 && statuses[0][1] === "200"
      && /<(?:[\w-]+:)?addressbook\s*\/?\s*>/i.test(resourceType)
      && /<(?:[\w-]+:)?collection\s*\/?\s*>/i.test(resourceType)
  })
  // A collection may return 404 for unrelated properties such as getetag.
  if (!verifiedCollection || !/urn:ietf:params:xml:ns:carddav/.test(xml)) fail("The locked destination is not a verified CardDAV address book.")
  const source = await options.loadSource()
  const repeated = await options.loadSource()
  if (source.hash !== repeated.hash) fail("Source changed while taking the snapshot. Retry before uploading.")
  const expected = new Set(source.cards.map(card => card.id))
  const before = await inventory()
  if (before.some(item => !item.contactId || !expected.has(item.contactId))) fail("Destination contains extra contacts. Nothing was deleted; use an empty dedicated book or review extras.")
  const present = new Set(before.map(item => item.contactId))
  let uploaded = 0, unchanged = 0, wouldUpload = 0, cursor = 0, failed = 0
  const errors = new Set<string>()
  const verifiedEtags = new Map<string, string>()
  let checkpointWrites = Promise.resolve()
  let pendingCheckpointRecords = 0
  async function flushCheckpoint() {
    if (!options.apply || !options.saveCheckpoint || !pendingCheckpointRecords) return
    pendingCheckpointRecords = 0
    const saved = structuredClone(checkpoint)
    // Keep writes ordered, and keep a failed save rejected until the run stops.
    checkpointWrites = checkpointWrites.then(() => options.saveCheckpoint!(saved))
    await checkpointWrites
  }
  async function check(card: MigrationCard, write: boolean) {
    const member = cardHref(card.id)
    // A missing inventory member can go straight to a conditional create. A
    // concurrent creation still produces 412; every successful PUT is read back.
    const remote = present.has(card.id) ? await request(member, "GET", { headers: { "Cache-Control": "no-cache" } }) : null
    let etag: string | null = null
    let equal = false
    if (remote?.status === 200) {
      etag = strongEtag(remote)
      const comparison = compareManagedVCard(card.vcard, await boundedText(remote, 1_000_000))
      if (comparison.status === "unsupported" || comparison.differingProperties.some(property => ["UID", "X-BUNKER-MAP-CONTACT-ID"].includes(property))) fail("Existing destination resource is not this managed FCUNO contact; review the collision.")
      equal = comparison.status === "match"
    } else if (remote && remote.status !== 404) fail(`Destination read failed (HTTP ${remote.status}).`)
    if (equal) { unchanged += 1; verifiedEtags.set(card.id, etag!) }
    else if (!write) { wouldUpload += 1; return }
    else {
      const response = await request(member, "PUT", { headers: { "Content-Type": "text/vcard; charset=utf-8", ...(etag ? { "If-Match": etag } : { "If-None-Match": "*" }) }, body: card.vcard })
      if (![200, 201, 204].includes(response.status)) fail(`Conditional upload failed (HTTP ${response.status}); rerun to resume safely.`)
      uploaded += 1
      const readback = await request(member, "GET", { headers: { "Cache-Control": "no-cache" } })
      if (readback.status !== 200 || compareManagedVCard(card.vcard, await boundedText(readback, 1_000_000)).status !== "match") fail("Full destination contact verification failed.")
      verifiedEtags.set(card.id, strongEtag(readback))
    }
    checkpoint.verified[card.id] = card.contentHash
    // Checkpoints never skip remote verification on restart, so batching them
    // avoids rewriting a growing map for every contact without changing safety.
    if (options.apply && options.saveCheckpoint) {
      pendingCheckpointRecords += 1
      if (pendingCheckpointRecords >= 50) await flushCheckpoint()
    }
  }
  // Failures never trigger deletion or blind retries. Completed records are rechecked on restart.
  const contactPhaseStartedAt = performance.now()
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!failed && cursor < source.cards.length) {
      const card = source.cards[cursor++]
      try { await check(card, Boolean(options.apply)) } catch (error) {
        failed += 1
        errors.add(error instanceof PhonebookMigrationError ? error.message : "Contact request or checkpoint persistence failed; rerun to recheck safely.")
      }
    }
  }))
  // Preserve verified progress even when another contact failed before a batch
  // filled. Workers have settled, so this includes all successful in-flight work.
  await flushCheckpoint()
  await checkpointWrites
  const uploadAndVerificationMs = Math.round(performance.now() - contactPhaseStartedAt)
  const finalSource = await options.loadSource()
  const after = await inventory()
  const exact = after.length === source.cards.length && after.every(item => item.contactId && expected.has(item.contactId)
    && verifiedEtags.get(item.contactId) === item.etag)
  const sourceUnchanged = source.hash === finalSource.hash
  return {
    mode: options.apply ? "apply" : "dry-run", sourceProject: fcunoConnectionPolicy.supabase.projectRef,
    sourceCount: source.cards.length, destinationCount: after.length, uploaded, unchanged, wouldUpload, failed,
    errors: [...errors], elapsedMs: Math.round(performance.now() - startedAt), uploadAndVerificationMs,
    verifiedCount: verifiedEtags.size, sourceUnchanged, exactInventoryVerified: exact,
    candidateVerified: failed === 0 && sourceUnchanged && exact,
    sourceHash: source.hash, targetHash,
    cutoverPerformed: false,
    nextStep: "Pause source edits for the final verification and production cutover. This runner never changes production configuration or deletes contacts.",
  }
}
