import { quotePostgrestFilterValue } from "./queryEscaping"

export type CcinfoIndexKind = "company" | "country" | "port"
export type CcinfoIndexRow = {
  id: string
  name: string
  notes: string | null
  updated_at: string
  country_name?: string | null
}

export const CCINFO_INDEX_PAGE_SIZE = 200
export const CCINFO_INDEX_MAX_QUERY_BYTES = 1024
export const CCINFO_INDEX_CONFIG = {
  company: { table: "cc_companies", select: "id,name,notes,updated_at", searchFields: ["name", "notes"], orderFields: ["name", "id"] },
  country: { table: "cc_countries", select: "id,name,notes,updated_at", searchFields: ["name", "notes"], orderFields: ["name", "id"] },
  port: { table: "cc_ports", select: "id,name,country_name,notes,updated_at", searchFields: ["name", "country_name", "notes"], orderFields: ["country_name", "name", "id"] },
} as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VERSION = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
const unavailable = () => new Error("These results could not be verified. Please retry; your last checked results have not been replaced.")

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isKind(value: unknown): value is CcinfoIndexKind {
  return typeof value === "string" && Object.hasOwn(CCINFO_INDEX_CONFIG, value)
}

function version(value: unknown): value is string {
  if (typeof value !== "string") return false
  const match = VERSION.exec(value)
  if (!match || !Number.isFinite(Date.parse(value))) return false
  return new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) === match[1]
}

export function normalizeCcinfoIndexQuery(value: string) {
  if (typeof value !== "string") throw new Error("Enter a valid search.")
  const query = value.trim()
  // Reject invalid Unicode and control characters rather than silently changing
  // the requested literal when UTF-8/PostgREST encodes it.
  if (!query.isWellFormed() || /[\u0000-\u001f\u007f]/.test(query)) throw new Error("Enter a search without control characters.")
  if (new TextEncoder().encode(query).byteLength > CCINFO_INDEX_MAX_QUERY_BYTES) throw new Error("This search is too long. Please shorten it.")
  return query
}

/**
 * IMATCH passes its parameter unchanged, unlike PostgREST LIKE's * → % alias.
 * PostgreSQL's ***= director makes the entire remaining value literal; quoting
 * separately protects PostgREST's commas, parentheses, quotes and backslashes.
 */
export function buildCcinfoIndexSearchFilter(kind: CcinfoIndexKind, value: string) {
  if (!isKind(kind)) throw new Error("Select a valid index.")
  const query = normalizeCcinfoIndexQuery(value)
  if (!query) return ""
  const literal = quotePostgrestFilterValue(`***=${query}`)
  return CCINFO_INDEX_CONFIG[kind].searchFields.map(field => `${field}.imatch.${literal}`).join(",")
}

export function parseCcinfoIndexResult(value: unknown, kind: CcinfoIndexKind, requestedPage: number): { rows: CcinfoIndexRow[]; count: number; page: number; totalPages: number } {
  if (!isKind(kind) || !Number.isSafeInteger(requestedPage) || requestedPage < 1
    || requestedPage > Math.floor(Number.MAX_SAFE_INTEGER / CCINFO_INDEX_PAGE_SIZE)) throw unavailable()
  if (!record(value) || value.error !== undefined && value.error !== null || !Array.isArray(value.data)
    || typeof value.count !== "number" || !Number.isSafeInteger(value.count) || value.count < 0) throw unavailable()
  const count = value.count
  const expectedRows = Math.min(CCINFO_INDEX_PAGE_SIZE, Math.max(0, count - (requestedPage - 1) * CCINFO_INDEX_PAGE_SIZE))
  if (value.data.length !== expectedRows) throw unavailable()
  const ids = new Set<string>()
  const rows: CcinfoIndexRow[] = value.data.map(item => {
    if (!record(item) || typeof item.id !== "string" || !UUID.test(item.id) || ids.has(item.id.toLowerCase())
      || typeof item.name !== "string" || !(typeof item.notes === "string" || item.notes === null) || !version(item.updated_at)
      || kind === "port" && !(typeof item.country_name === "string" || item.country_name === null)) throw unavailable()
    ids.add(item.id.toLowerCase())
    return { id: item.id, name: item.name, notes: item.notes, updated_at: item.updated_at,
      ...(kind === "port" ? { country_name: item.country_name as string | null } : {}) }
  })
  const totalPages = Math.max(1, Math.ceil(count / CCINFO_INDEX_PAGE_SIZE))
  // Rows still describe the requested page. A caller must reload if this page
  // changed; never label an out-of-range empty response as the last valid page.
  return { rows, count, page: Math.min(requestedPage, totalPages), totalPages }
}
