export const PHONEBOOK_SYNC_RETRY_KEY = "phonebook_carddav_pending:v2"
export const LEGACY_PHONEBOOK_SYNC_RETRY_KEY = "phonebook_last_carddav_sync_failed"
export const PHONEBOOK_SYNC_REQUEST_TIMEOUT_MS = 220_000
const SYNC_BATCH_SIZE = 2

export type PhonebookSyncOperation = "upsert" | "delete"
export type PendingPhonebookSync = {
  id: string
  label: string
  operation: PhonebookSyncOperation
  token: string
}
type RetryStorage = Pick<Storage, "getItem" | "setItem">
export type PhonebookSyncFailure = { id: string; label: string; error?: string }
export type PhonebookSyncResult = { verifiedCount: number; failed: PhonebookSyncFailure[] }

function storageError(detail: string) {
  return new Error(`Phonebook retry information ${detail}. Sync was not confirmed. Keep this page open and ask an administrator to check browser storage.`)
}

export function readPhonebookSyncRetries(storage: RetryStorage): PendingPhonebookSync[] {
  let raw: string | null
  let migrating = false
  try {
    raw = storage.getItem(PHONEBOOK_SYNC_RETRY_KEY)
    if (raw === null) {
      raw = storage.getItem(LEGACY_PHONEBOOK_SYNC_RETRY_KEY)
      migrating = raw !== null
    }
  } catch { throw storageError("could not be read") }
  if (raw === null) return []
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw storageError("is unreadable") }
  if (!Array.isArray(value)) throw storageError("is unreadable")
  const entries = new Map<string, PendingPhonebookSync>()
  for (const item of value) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id.trim()
      || (item.operation !== undefined && item.operation !== "upsert" && item.operation !== "delete")) {
      throw storageError("is unreadable")
    }
    entries.set(item.id, {
      id: item.id,
      label: typeof item.label === "string" ? item.label : "Contact",
      operation: item.operation || "upsert", // Previous versions stored upload failures only.
      token: typeof item.token === "string" ? item.token : `legacy:${item.id}`,
    })
  }
  const result = [...entries.values()]
  // Do not let an already-open old tab overwrite the new operation-aware ledger.
  // Leave the legacy value intact for recovery; after migration it is ignored.
  if (migrating) writeRetries(storage, result)
  return result
}

function writeRetries(storage: RetryStorage, entries: PendingPhonebookSync[]) {
  try { storage.setItem(PHONEBOOK_SYNC_RETRY_KEY, JSON.stringify(entries)) } catch { throw storageError("could not be saved") }
}

export function stagePhonebookSync(
  storage: RetryStorage,
  operations: Array<{ id: string; label?: string; operation: PhonebookSyncOperation }>,
  makeToken: () => string = () => crypto.randomUUID(),
) {
  const saved = new Map(readPhonebookSyncRetries(storage).map((entry) => [entry.id, entry]))
  const staged = new Map<string, PendingPhonebookSync>()
  for (const operation of operations) {
    if (!operation.id.trim()) throw new Error("A phonebook sync operation is missing its contact ID.")
    const entry = { ...operation, label: operation.label || "Contact", token: makeToken() }
    saved.set(entry.id, entry)
    staged.set(entry.id, entry)
  }
  writeRetries(storage, [...saved.values()])
  return [...staged.values()]
}

export function acknowledgePhonebookSync(storage: RetryStorage, requested: PendingPhonebookSync[], verifiedIds: string[]) {
  const verified = new Set(verifiedIds)
  const original = new Map(requested.map((entry) => [entry.id, entry]))
  const remaining = readPhonebookSyncRetries(storage).filter((entry) => {
    const request = original.get(entry.id)
    // An older request must never clear a newer saved edit or a pending deletion.
    return !verified.has(entry.id) || request?.token !== entry.token || request.operation !== entry.operation
  })
  writeRetries(storage, remaining)
}

export function enqueuePhonebookSync<T>(queue: { current: Promise<unknown> }, operation: () => Promise<T>) {
  const result = queue.current.catch(() => undefined).then(operation)
  queue.current = result.catch(() => undefined)
  return result
}

export async function loadPhonebookSyncScope(company: string | null, fetcher: typeof fetch = fetch) {
  const query = company === null ? "all=1" : `company=${encodeURIComponent(company)}`
  const response = await fetcher(`/api/phonebook/contacts?${query}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  })
  const value: unknown = await response.json().catch(() => null)
  if (!response.ok || !value || typeof value !== "object" || !("contacts" in value)
    || !Array.isArray(value.contacts)
    || value.contacts.some((contact) => !contact || typeof contact !== "object" || typeof contact.id !== "string" || !contact.id)) {
    throw new Error("The complete saved contact list could not be verified. Please refresh and retry.")
  }
  return value.contacts.map((contact: { id: string; full_name?: unknown }) => ({
    id: contact.id,
    label: typeof contact.full_name === "string" ? contact.full_name : "Contact",
    operation: "upsert" as const,
  }))
}

type SyncPayload = {
  message?: string
  failed: PhonebookSyncFailure[]
  verifiedIds: string[]
  verifiedCount: number
  total: number
  done: boolean
  nextCursor: number | null
}

function parseSyncPayload(value: unknown): SyncPayload {
  if (!value || typeof value !== "object") throw new Error("CardDAV returned an invalid verification response. The contacts remain queued for retry.")
  const payload = value as Record<string, unknown>
  if (!Array.isArray(payload.verifiedIds) || payload.verifiedIds.some((id) => typeof id !== "string" || !id)
    || new Set(payload.verifiedIds).size !== payload.verifiedIds.length
    || payload.verifiedCount !== payload.verifiedIds.length
    || !Array.isArray(payload.failed)
    || payload.failed.some((failure) => !failure || typeof failure !== "object" || typeof failure.id !== "string" || !failure.id)
    || typeof payload.done !== "boolean" || !Number.isSafeInteger(payload.total) || (payload.total as number) < 0
    || (payload.nextCursor !== null && (!Number.isSafeInteger(payload.nextCursor) || (payload.nextCursor as number) < 0))) {
    throw new Error("CardDAV returned an incomplete verification response. The contacts remain queued for retry.")
  }
  const failedIds = new Set(payload.failed.map((failure) => failure.id))
  if (failedIds.size !== payload.failed.length || payload.verifiedIds.some((id) => failedIds.has(id))) {
    throw new Error("CardDAV returned conflicting verification results. The contacts remain queued for retry.")
  }
  return payload as unknown as SyncPayload
}

async function requestSync(fetcher: typeof fetch, body: Record<string, unknown>) {
  const response = await fetcher("/api/phonebook/carddav-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PHONEBOOK_SYNC_REQUEST_TIMEOUT_MS),
  })
  const value: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = value && typeof value === "object" && "message" in value && typeof value.message === "string" ? value.message : "CardDAV request failed."
    throw new Error(`${message} Unverified contacts remain queued for retry.`)
  }
  return parseSyncPayload(value)
}

export async function runPhonebookSync(options: {
  entries: PendingPhonebookSync[]
  storage: RetryStorage
  fetcher?: typeof fetch
  fullResync?: boolean
  onProgress?: (completed: number, total: number) => void
}): Promise<PhonebookSyncResult> {
  const { entries, storage, onProgress } = options
  const fetcher = options.fetcher || fetch
  const verified = new Set<string>()
  const failures = new Map<string, PhonebookSyncFailure>()
  const expected = new Set(entries.map((entry) => entry.id))
  const record = (payload: SyncPayload, batch: PendingPhonebookSync[]) => {
    const batchIds = new Set(batch.map((entry) => entry.id))
    if (payload.verifiedIds.some((id) => !batchIds.has(id)) || payload.failed.some((failure) => !batchIds.has(failure.id))) {
      throw new Error("CardDAV returned results for an unexpected contact. The requested contacts remain queued for retry.")
    }
    acknowledgePhonebookSync(storage, batch, payload.verifiedIds)
    payload.verifiedIds.forEach((id) => verified.add(id))
    payload.failed.forEach((failure) => failures.set(failure.id, failure))
    onProgress?.(verified.size + failures.size, expected.size)
  }

  if (options.fullResync) {
    if (entries.some((entry) => entry.operation !== "upsert")) throw new Error("A full resync cannot delete contacts.")
    let cursor = 0
    while (true) {
      const payload = await requestSync(fetcher, { fullRebuild: true, phase: "upload", cursor })
      record(payload, entries)
      if (payload.done) {
        if (payload.nextCursor !== null) throw new Error("CardDAV returned an invalid completion cursor. Resync was not confirmed.")
        break
      }
      const processedCount = payload.verifiedIds.length + payload.failed.length
      if (payload.nextCursor === null || processedCount === 0
        || payload.nextCursor !== cursor + processedCount || payload.nextCursor > payload.total) {
        throw new Error("CardDAV resync did not make progress. Unverified contacts remain queued for retry.")
      }
      cursor = payload.nextCursor
    }
  } else {
    for (const operation of ["upsert", "delete"] as const) {
      const sameOperation = entries.filter((entry) => entry.operation === operation)
      for (let offset = 0; offset < sameOperation.length; offset += SYNC_BATCH_SIZE) {
        const batch = sameOperation.slice(offset, offset + SYNC_BATCH_SIZE)
        const ids = batch.map((entry) => entry.id)
        const payload = await requestSync(fetcher, { [operation === "delete" ? "deleteContactIds" : "contactIds"]: ids })
        if (!payload.done || payload.nextCursor !== null || payload.total !== ids.length
          || payload.verifiedIds.length + payload.failed.length !== ids.length) {
          throw new Error("CardDAV did not verify the complete requested batch. The contacts remain queued for retry.")
        }
        record(payload, batch)
      }
    }
  }
  for (const entry of entries) {
    if (!verified.has(entry.id) && !failures.has(entry.id)) {
      failures.set(entry.id, { id: entry.id, label: entry.label, error: "This contact was not verified and remains queued for retry." })
    }
  }
  return { verifiedCount: verified.size, failed: [...failures.values()] }
}
