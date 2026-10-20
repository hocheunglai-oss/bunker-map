import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  createAuditBrowsingClient, isUserAuditRecord, matchesAuditActor, matchesAuditScope,
  presentAuditLogs, type AuditLogRecord, type PresentedAuditLogRecord,
} from "@/lib/auditLog"
import {
  AuditBrowsingError, auditBrowseDigest, loadAuditBrowseKeyring, openAuditBrowseCursor,
  sealAuditBrowseCursor, startAuditBrowseGeneration, type AuditBrowseGeneration,
} from "@/lib/auditBrowsingCursor"
import { loadAuditBrowsingPortNames, readAuditBrowsingBatch } from "@/lib/auditBrowsingSource"
import { createAuditBrowsingTransport } from "@/lib/auditBrowsingTransport"

type Pages = Parameters<typeof presentAuditLogs>[1]
export type AuditBrowsePageInfo = {
  pageSize: number; returnedMatches: number; state: "more" | "scan-pending" | "exhausted"
  hasMoreMatches: boolean | null; nextCursor: string | null; consistency: "live-keyset"
}
export function auditBrowseFilters(url: URL, aliases: Record<string, string> = {}) {
  const limit = url.searchParams.get("limit") || "100"
  if (!/^\d{1,6}$/.test(limit) || Number(limit) < 1) throw new AuditBrowsingError(400)
  const page = url.searchParams.get("page") || url.searchParams.get("table") || "all"
  const operation = (url.searchParams.get("operation") || "ALL").toUpperCase()
  const actor = (url.searchParams.get("actor") || "all").trim().toLowerCase()
  if (page.length > 200 || actor.length > 300 || !["ALL", "INSERT", "UPDATE", "DELETE"].includes(operation)) throw new AuditBrowsingError(400)
  return { pageId: aliases[page] || page, operation, actor, pageSize: Math.min(Number(limit), 150) }
}

/** Pure scanner seam; budgets limit one request, never the history lifetime. */
export async function scanAuditBrowsePage(options: {
  generation: AuditBrowseGeneration; pageSize: number
  read: (after: AuditBrowseGeneration["position"], limit: number) => Promise<{ records: AuditLogRecord[]; exhausted: boolean }>
  present: (records: AuditLogRecord[]) => Promise<PresentedAuditLogRecord[]>
  accept: (record: PresentedAuditLogRecord) => boolean
  batchSize?: number; maxBatches?: number
}) {
  const generation = { ...options.generation }
  const matches: PresentedAuditLogRecord[] = []
  let lastEmitted = generation.position
  for (let batch = 0; batch < (options.maxBatches ?? 4); batch++) {
    const source = await options.read(generation.position, options.batchSize ?? 250)
    if (!source.records.length && !source.exhausted) throw new AuditBrowsingError(503)
    const presented = await options.present(source.records)
    if (presented.length !== source.records.length) throw new AuditBrowsingError(503)
    for (let index = 0; index < source.records.length; index++) {
      const raw = source.records[index], record = presented[index]
      if (raw.id !== record.id || raw.occurredAt !== record.occurredAt) throw new AuditBrowsingError(503)
      const position = { occurredAt: raw.occurredAt, id: raw.id }
      generation.watermark ??= position
      if (options.accept(record)) {
        if (matches.length === options.pageSize) {
          // Lookahead is deliberately NOT consumed. Resume after the last
          // returned match; intervening hidden rows can safely be rescanned.
          return { records: matches, state: "more" as const, generation: { ...generation, position: lastEmitted } }
        }
        matches.push(record)
        lastEmitted = position
      }
      generation.position = position
    }
    if (source.exhausted) return { records: matches, state: "exhausted" as const, generation }
  }
  return { records: matches, state: "scan-pending" as const, generation }
}

export async function browseAuditLogs<Context>(options: {
  request: Request; scope: "www" | "spc"; viewerId: string; permissionState: unknown; pages: Pages
  includeDetails?: boolean
  aliases?: Record<string, string>
  loadContext: (client: SupabaseClient) => Promise<Context>
  contextFingerprint: (context: Context) => unknown
  normalize?: (records: PresentedAuditLogRecord[], context: Context) => PresentedAuditLogRecord[]
  visible?: (record: PresentedAuditLogRecord) => boolean
}) {
  // Caller MUST have completed its ordinary authorization before entering.
  // Misconfiguration fails before raw audit or classification reads.
  const ring = loadAuditBrowseKeyring()
  const url = new URL(options.request.url), filters = auditBrowseFilters(url, options.aliases)
  const full = options.includeDetails === true
  const binding = { scope: options.scope, viewerId: options.viewerId, permissionDigest: auditBrowseDigest(options.permissionState),
    filterDigest: auditBrowseDigest({ ...filters, responseMode: full ? "full" : "index" }), pageSize: filters.pageSize }
  const cursor = url.searchParams.get("cursor")
  const resumed = cursor === null ? null : openAuditBrowseCursor(cursor, binding, ring)
  const transport = createAuditBrowsingTransport(options.request.signal)
  try {
    const client = createAuditBrowsingClient(transport.fetch)
    const [portNames, context] = await transport.wait(Promise.all([loadAuditBrowsingPortNames(client), options.loadContext(client)]))
    const mappingDigest = auditBrowseDigest({ deployment: process.env.VERCEL_GIT_COMMIT_SHA || "local-audit-browsing/v1",
      pages: options.pages, ports: [...portNames], context: options.contextFingerprint(context) })
    if (resumed && resumed.mappingDigest !== mappingDigest) throw new AuditBrowsingError(400)
    const generation = resumed || startAuditBrowseGeneration(mappingDigest)
    const result = await transport.wait(scanAuditBrowsePage({
      generation, pageSize: filters.pageSize,
      // Full mode is deliberately one private raw row per request, not the
      // old bulk read. A single oversized row fails without advancing/skipping.
      batchSize: full ? 1 : 250, maxBatches: full ? 1 : 4,
      read: (after, limit) => readAuditBrowsingBatch(client, after, limit, { compact: !full }),
      present: async records => {
        const presented = await presentAuditLogs(records, options.pages, { portNames, client, includeDetails: full })
        return options.normalize ? options.normalize(presented, context) : presented
      },
      accept: record => isUserAuditRecord(record) && matchesAuditScope(record, options.scope)
        && (!options.visible || options.visible(record))
        && (filters.pageId === "all" || record.pageId === filters.pageId)
        && (filters.operation === "ALL" || record.displayOperation === filters.operation)
        && matchesAuditActor(record, filters.actor),
    }))
    const pageInfo: AuditBrowsePageInfo = {
      pageSize: filters.pageSize, returnedMatches: result.records.length, state: result.state,
      hasMoreMatches: result.state === "more" ? true : result.state === "exhausted" ? false : null,
      nextCursor: result.state === "exhausted" ? null : sealAuditBrowseCursor(result.generation, binding, ring), consistency: "live-keyset",
    }
    return { records: result.records, pageInfo, totalMatches: null, context }
  } catch (error) {
    if (error instanceof AuditBrowsingError) throw error
    throw new AuditBrowsingError(503)
  } finally { transport.finish() }
}
