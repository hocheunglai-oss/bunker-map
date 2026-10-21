import { createHash } from "node:crypto"
import { performance } from "node:perf_hooks"
import { createClient } from "@supabase/supabase-js"
import { fcunoConnectionPolicy } from "../config/fcunoConnections"
import { buildContactSyncHash, buildVCard, cardHref, compareManagedVCard, fetchContacts, getCardDavConfig, UUID_PATTERN, type PhonebookContact } from "./phonebookCarddav"

// Root must choose a short actual window only after review/tests. This shipped
// preparation placeholder cannot cause observations in any environment.
export const PHONEBOOK_SEMANTIC_SHADOW_WINDOW = Object.freeze({
  approved: false,
  startsAt: "1970-01-01T00:00:00.000Z",
  expiresAt: "1970-01-01T00:00:00.000Z",
})
const VERSION = "fcuno-vcard3-shadow/2026-10-21.1"
const CONTACT_COLUMNS = "id,full_name,company,title,position,department,direct_line,mobile_1,mobile_2,personal_email,general_email,private_email,notes"
const COMPANY_COLUMNS = "name,other_name,country,tel_country,tel_area,tel_no_1,phone"
const COVERAGE_FIELDS = ["FN", "N", "ORG", "TITLE", "TEL", "EMAIL", "NOTE"] as const
type Coverage = Record<typeof COVERAGE_FIELDS[number], number>
type Input = { sourceUrl: string; serviceRoleKey: string; requestStartedMonotonicMs: number }
type Dependencies = {
  window?: { approved: boolean; startsAt: string; expiresAt: string }
  metadata?: { environment: string; commit: string }
  now?: () => number
  wallNow?: () => number
  fetch?: typeof fetch
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  createClient?: typeof createClient
  log?: (event: string, summary: Record<string, unknown>) => void
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const blankCoverage = (): Coverage => ({ FN: 0, N: 0, ORG: 0, TITLE: 0, TEL: 0, EMAIL: 0, NOTE: 0 })
function coverage(card: string): Coverage {
  const counts = blankCoverage()
  for (const line of card.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
    const colon = line.indexOf(":")
    const field = line.slice(0, colon).split(";", 1)[0].split(".").at(-1)?.toUpperCase() as keyof Coverage
    if (colon < 1 || !COVERAGE_FIELDS.includes(field)) continue
    const value = line.slice(colon + 1)
    if ((field === "N" || field === "ORG" ? value.replace(/[;,]/g, "") : value).trim()) counts[field] += 1
  }
  return counts
}

// Observation is always non-authoritative. It never ACKs, writes, renews a
// lease, changes sync results or notifies a person, including on errors.
export async function observePhonebookCarddavSemanticShadow(input: Input, deps: Dependencies = {}): Promise<void> {
  const now = deps.now || (() => performance.now()), wallNow = deps.wallNow || Date.now
  const window = deps.window || PHONEBOOK_SEMANTIC_SHADOW_WINDOW
  const metadata = deps.metadata || {
    environment: process.env.VERCEL_ENV || "unknown",
    commit: process.env.DEPLOY_COMMIT || process.env.NEXT_PUBLIC_DEPLOY_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || "unknown",
  }
  const opens = Date.parse(window.startsAt), expires = Date.parse(window.expiresAt), wall = wallNow()
  if (!window.approved || !Number.isFinite(opens) || !Number.isFinite(expires) || !Number.isFinite(wall) || expires <= opens || expires - opens > 900_000 || wall < opens || wall >= expires) return
  if (metadata.environment !== "production" || !/^[a-f0-9]{40}$/.test(metadata.commit)) return
  const started = now()
  if (!Number.isFinite(started) || !Number.isFinite(input.requestStartedMonotonicMs) || input.requestStartedMonotonicMs > started || started - input.requestStartedMonotonicMs > 270_000) return
  const send = deps.fetch || fetch, setTimer = deps.setTimer || setTimeout, clearTimer = deps.clearTimer || clearTimeout
  const total = new AbortController(), deadline = started + 10_000
  const totalTimer = setTimer(() => total.abort(), 10_000)
  const summary = {
    version: VERSION, commit: metadata.commit, sampleSize: 0, match: 0, different: 0, unsupported: 0, incompleteCards: 0, observationIncomplete: false,
    sourceChanged: false, sourceBeforeSha256: null as string | null, sourceAfterSha256: null as string | null,
    differingProperties: [] as string[], expectedNonempty: blankCoverage(), observedNonempty: blankCoverage(), comparableCards: 0,
    expectedShapeFlags: { nonAsciiName: false, escapedText: false, multiplePhoneEndpoints: false, multipleEmailEndpoints: false },
    wholeBookContentVerified: false, physicalDeviceVerified: false,
  }
  // The installed PostgREST client otherwise retries transient HTTP/network
  // failures outside fetch with backoff. AbortError explicitly disables those
  // retries; this independent observer must not extend the normal worker.
  const incomplete = () => new DOMException("Shadow observation incomplete.", "AbortError")
  async function boundedRequest(resource: string | URL, init: RequestInit, maxBytes: number): Promise<Response> {
    if (total.signal.aborted || now() >= deadline) throw incomplete()
    const controller = new AbortController()
    const abortTotal = () => controller.abort()
    total.signal.addEventListener("abort", abortTotal, { once: true })
    const requestTimer = setTimer(() => controller.abort(), Math.max(1, Math.min(3000, deadline - now())))
    let rejectAbort: (() => void) | undefined
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(incomplete()); controller.signal.addEventListener("abort", rejectAbort, { once: true }) })
    const operation = (async () => {
      const response = await send(resource, { ...init, redirect: "error", cache: "no-store", signal: controller.signal })
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw incomplete() }
      const length = response.headers.get("content-length")
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { void response.body?.cancel().catch(() => {}); throw incomplete() }
      const reader = response.body?.getReader(); if (!reader) throw incomplete()
      const chunks: Uint8Array[] = []; let size = 0
      const cancelBody = () => { void reader.cancel().catch(() => {}) }
      controller.signal.addEventListener("abort", cancelBody, { once: true })
      try {
        while (true) {
          if (controller.signal.aborted) throw incomplete()
          const chunk = await reader.read(); if (chunk.done) break
          size += chunk.value.byteLength
          if (size > maxBytes) { cancelBody(); throw incomplete() }
          chunks.push(chunk.value)
        }
      } finally { controller.signal.removeEventListener("abort", cancelBody); reader.releaseLock() }
      const bytes = Buffer.concat(chunks)
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers })
    })()
    try { return await Promise.race([operation, aborted]) }
    finally {
      clearTimer(requestTimer); total.signal.removeEventListener("abort", abortTotal)
      if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort)
      controller.abort()
    }
  }
  try {
    const source = new URL(input.sourceUrl)
    if (source.origin !== `https://${fcunoConnectionPolicy.supabase.projectRef}.supabase.co` || source.pathname !== "/" || source.username || source.password || source.search || source.hash || !input.serviceRoleKey) throw incomplete()
    let sourceRequests = 0
    const sourceFetch: typeof fetch = async (resource, init) => {
      if (resource instanceof Request) throw incomplete()
      const url = new URL(String(resource)), query = url.searchParams
      if (url.origin !== source.origin || url.username || url.password || url.hash || String(init?.method || "GET").toUpperCase() !== "GET" || init?.body) throw incomplete()
      if (++sourceRequests > 4) throw incomplete()
      const contact = url.pathname === "/rest/v1/phonebook_contacts", company = url.pathname === "/rest/v1/phonebook_companies"
      if (!contact && !company) throw incomplete()
      if (query.get("select") !== (contact ? CONTACT_COLUMNS : COMPANY_COLUMNS)) throw incomplete()
      const allowedKeys = contact ? ["select", "order", "offset", "limit", "id"] : ["select", "name"]
      if ([...query.keys()].some((key) => !allowedKeys.includes(key))) throw incomplete()
      if (contact && (query.get("order") !== "id.asc" || query.get("offset") !== "0" || query.get("limit") !== "2")) throw incomplete()
      if (company && !query.get("name")?.startsWith("in.(")) throw incomplete() // No fallback scan of the company book.
      const headers = new Headers(init?.headers)
      if (headers.get("apikey") !== input.serviceRoleKey || headers.get("authorization") !== `Bearer ${input.serviceRoleKey}`) throw incomplete()
      try {
        const response = await boundedRequest(url, { ...init, method: "GET" }, 1_000_000)
        if (!response.ok) throw incomplete()
        return response
      } catch { throw incomplete() }
    }
    const client = (deps.createClient || createClient)(source.origin, input.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: sourceFetch } })
    const before = await fetchContacts(client)
    if (before.contacts.length < 1 || before.contacts.length > 2) throw incomplete()
    const ids = before.contacts.map((row) => row.id)
    if (new Set(ids).size !== ids.length || ids.some((id) => !UUID_PATTERN.test(id))) throw incomplete()
    const canonicalCards = new Map(before.contacts.map((row) => [row.id, buildVCard(row)]))
    summary.sampleSize = ids.length
    summary.sourceBeforeSha256 = hash(JSON.stringify(before.contacts.map((row) => [row.id, buildContactSyncHash(row)])))
    for (const contact of before.contacts) {
      const card = canonicalCards.get(contact.id)!, counts = coverage(card)
      for (const field of COVERAGE_FIELDS) summary.expectedNonempty[field] += counts[field]
      summary.expectedShapeFlags.nonAsciiName ||= /[^\x00-\x7f]/.test(contact.full_name || "")
      summary.expectedShapeFlags.escapedText ||= /[;,\\\n\r]/.test([contact.full_name, contact.company, contact.notes].filter(Boolean).join(""))
      summary.expectedShapeFlags.multiplePhoneEndpoints ||= counts.TEL > 1
      summary.expectedShapeFlags.multipleEmailEndpoints ||= counts.EMAIL > 1
    }
    const { addressBookUrl, auth } = getCardDavConfig(), book = new URL(addressBookUrl)
    if (!/^(?:p\d+-)?contacts\.icloud\.com$/.test(book.hostname) || book.port || !/^\/[0-9]+\/carddavhome\/card\/$/.test(book.pathname)) throw incomplete()
    const differences = new Set<string>()
    await Promise.all(before.contacts.map(async (contact: PhonebookContact) => {
      try {
        const target = new URL(cardHref(contact.id), book)
        if (target.origin !== book.origin || !target.pathname.startsWith(book.pathname) || target.search || target.hash) throw incomplete()
        const response = await boundedRequest(target, { method: "GET", headers: { Authorization: `Basic ${auth}`, Accept: "text/vcard, text/x-vcard, */*", "Cache-Control": "no-cache" } }, 1_000_000)
        if (response.status !== 200) throw incomplete()
        const actual = await response.text(), result = compareManagedVCard(canonicalCards.get(contact.id)!, actual)
        if (result.status === "match") summary.match += 1
        else if (result.status === "different") { summary.different += 1; for (const field of result.differingProperties) differences.add(field) }
        else summary.unsupported += 1
        if (result.status !== "unsupported") {
          summary.comparableCards += 1
          const counts = coverage(actual); for (const field of COVERAGE_FIELDS) summary.observedNonempty[field] += counts[field]
        }
      } catch { summary.incompleteCards += 1; summary.observationIncomplete = true }
    }))
    summary.differingProperties = [...differences].sort()
    const after = await fetchContacts(client, { contactIds: ids })
    summary.sourceAfterSha256 = hash(JSON.stringify(after.contacts.map((row) => [row.id, buildContactSyncHash(row)])))
    summary.sourceChanged = summary.sourceBeforeSha256 !== summary.sourceAfterSha256
  } catch { summary.observationIncomplete = true }
  finally {
    total.abort(); clearTimer(totalTimer)
    try { (deps.log || console.info)("phonebook_carddav_semantic_shadow", { ...summary, elapsedMs: Math.max(0, Math.round(now() - started)) }) } catch {}
  }
}
