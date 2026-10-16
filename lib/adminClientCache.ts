type AdminClientCacheEntry = {
  value?: unknown
  loadedAt?: number
  pending?: Promise<unknown>
  controller?: AbortController
}

export const OUTLOOK_ADDRESS_BOOK_CACHE_KEY = "outlook-address-book-bootstrap"
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
    if (entry && !entry.pending) adminClientCache.delete(key)
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
  if (cached !== null) return cached

  const existing = adminClientCache.get(key)
  if (existing?.pending) return existing.pending as Promise<T>

  const controller = new AbortController()
  const entry: AdminClientCacheEntry = { ...existing, controller }
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = fetch(url, { cache: "no-store", signal: controller.signal })
    .then(async (response) => {
      if (response.status === 401 || response.status === 403) {
        throw new Error("Your sign-in or access changed. Refresh the page to continue.")
      }
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload.message || `Unable to load ${url}.`)
      }
      return payload
    })
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("The data request timed out. Please try again."))
      controller.abort()
    }, 30_000)
  })
  const pending = Promise.race([work, timeout])
    .then(payload => {
      if (adminClientCache.get(key) !== entry) {
        throw new Error("This data request was replaced. Refresh the page to continue.")
      }
      adminClientCache.set(key, { value: payload, loadedAt: Date.now() })
      return payload as T
    })
    .catch((error) => {
      if (adminClientCache.get(key) === entry) adminClientCache.delete(key)
      throw error
    })
    .finally(() => { if (timer) clearTimeout(timer) })

  entry.pending = pending
  adminClientCache.set(key, entry)
  return pending
}

export function clearAdminClientCache(key?: string) {
  if (key) {
    adminClientCache.get(key)?.controller?.abort()
    adminClientCache.delete(key)
    return
  }

  for (const entry of adminClientCache.values()) entry.controller?.abort()
  adminClientCache.clear()
}
