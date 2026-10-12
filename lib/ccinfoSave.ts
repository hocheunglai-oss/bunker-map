export type CcinfoRecordKind = "company" | "country" | "port"
export type CcinfoSaveTarget = { kind: CcinfoRecordKind; id: string }
export type CcinfoSavedRecord = { id: string; updated_at: string; [key: string]: unknown }
export type CcinfoRecordChanges = Record<string, string | null>

export const CCINFO_CONFLICT_MESSAGE = "This entry changed or was removed. Your edits are still here. Copy your changes before reopening the entry."
export class CcinfoSaveConflict extends Error {
  constructor() { super(CCINFO_CONFLICT_MESSAGE) }
}

type SaveState = { version: string; tail: Promise<unknown>; pending: number; failedGeneration: number }

/** Serializes this page's writes without rebasing an old draft onto somebody else's version. */
export function createCcinfoSaveQueue(write: (target: CcinfoSaveTarget, version: string, changes: CcinfoRecordChanges) => Promise<CcinfoSavedRecord>) {
  const states = new Map<string, SaveState>()
  const key = (target: CcinfoSaveTarget) => `${target.kind}:${target.id}`
  return {
    loaded(target: CcinfoSaveTarget, version: string | null | undefined) {
      if (!version || !Number.isFinite(Date.parse(version))) throw new Error("This entry has no valid saved version. Reopen it before editing.")
      if (states.get(key(target))?.pending) throw new Error("Wait for the current save before reopening this entry.")
      states.set(key(target), { version, tail: Promise.resolve(), pending: 0, failedGeneration: 0 })
    },
    pending() { return [...states.values()].some((state) => state.pending > 0) },
    save(target: CcinfoSaveTarget, changes: CcinfoRecordChanges) {
      const state = states.get(key(target))
      if (!state) return Promise.reject(new Error("Reopen this entry before saving."))
      const generation = state.failedGeneration
      const capturedChanges = { ...changes }
      state.pending += 1
      const result = state.tail.then(async () => {
        // A preceding failed request must not silently discard or send a queued stale draft.
        if (generation !== state.failedGeneration) throw new Error("An earlier save did not finish. Your edits are still here. Please save again.")
        const expected = state.version
        try {
          const row = await write(target, expected, capturedChanges)
          if (row.id !== target.id || !row.updated_at || !Number.isFinite(Date.parse(row.updated_at)) || row.updated_at === expected) {
            throw new Error("The saved entry could not be verified. Your edits are still here.")
          }
          state.version = row.updated_at // Keep the raw PostgreSQL microseconds, not a JS Date round-trip.
          return row
        } catch (error) {
          state.failedGeneration += 1
          throw error
        }
      })
      state.tail = result.catch(() => undefined)
      return result.finally(() => { state.pending -= 1 })
    },
  }
}

const RECORD_TABLES = new Set(["cc_companies", "cc_countries", "cc_ports"])

/** Old tabs must not bypass the version check through the privileged database proxy. */
export function ccinfoLegacyContentWriteMessage(pageId: string, table: string, method: string, target: URL, prefer: string | null, body: ArrayBuffer | undefined) {
  if (pageId !== "ccinfo" || !RECORD_TABLES.has(table) || method !== "PATCH" || !body) return null
  let payload: unknown
  try { payload = JSON.parse(new TextDecoder().decode(body)) } catch { return null }
  const refresh = "Refresh this page before saving. Your edits have not been saved; copy them first."
  const needsVersion = (item: object) => "summary" in item || "notes" in item || (table === "cc_ports" && ("country_name" in item || "country_id" in item))
  if (Array.isArray(payload)) return payload.some((item) => item && typeof item === "object" && (needsVersion(item) || (table === "cc_countries" && "name" in item))) ? refresh : null
  if (!payload || typeof payload !== "object") return null
  // A rename is no longer a country PATCH followed by best-effort port writes.
  if (table === "cc_countries" && "name" in payload) return refresh
  if (!needsVersion(payload)) return null
  const id = target.searchParams.getAll("id")
  const versions = target.searchParams.getAll("updated_at")
  const version = versions[0]?.slice(3)
  const returning = prefer?.split(",").some((item) => item.trim() === "return=representation")
  const selected = target.searchParams.get("select")?.split(",") || []
  const hasReturnFields = selected.includes("*") || (selected.includes("id") && selected.includes("updated_at"))
  if (id.length !== 1 || !/^eq\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id[0]) || versions.length !== 1 || !versions[0].startsWith("eq.") || !version || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(version) || !Number.isFinite(Date.parse(version)) || !returning || !hasReturnFields) {
    return "Refresh this page before saving. Your edits have not been saved; copy them first."
  }
  return null
}
