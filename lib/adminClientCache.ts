type AdminClientCacheEntry = {
  value?: unknown
  loadedAt?: number
  pending?: Promise<unknown>
}

export const OUTLOOK_ADDRESS_BOOK_CACHE_KEY = "outlook-address-book-bootstrap"
export const OUTLOOK_TEMPLATES_CACHE_KEY = "outlook-templates-bootstrap"
export const OUTLOOK_TEMPLATES_INDEX_CACHE_KEY = "outlook-templates-index-v1"
export const OUTLOOK_TEMPLATES_RECIPIENTS_CACHE_KEY = "outlook-templates-recipients-v1"

const adminClientCache = new Map<string, AdminClientCacheEntry>()

export function readAdminClientCache<T>(
  key: string,
  maxAgeMs = 5 * 60 * 1000,
): T | null {
  const entry = adminClientCache.get(key)
  if (
    entry?.value === undefined ||
    entry.loadedAt === undefined ||
    Date.now() - entry.loadedAt > maxAgeMs
  ) {
    return null
  }

  return entry.value as T
}

export async function fetchAdminClientJson<T>(
  key: string,
  url: string,
  maxAgeMs = 5 * 60 * 1000,
): Promise<T> {
  const cached = readAdminClientCache<T>(key, maxAgeMs)
  if (cached) return cached

  const existing = adminClientCache.get(key)
  if (existing?.pending) return existing.pending as Promise<T>

  const pending = fetch(url, { cache: "no-store" })
    .then(async (response) => {
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload.message || `Unable to load ${url}.`)
      }
      adminClientCache.set(key, {
        value: payload,
        loadedAt: Date.now(),
      })
      return payload as T
    })
    .catch((error) => {
      adminClientCache.delete(key)
      throw error
    })

  adminClientCache.set(key, { ...existing, pending })
  return pending
}

export function clearAdminClientCache(key?: string) {
  if (key) {
    adminClientCache.delete(key)
    return
  }

  adminClientCache.clear()
}
