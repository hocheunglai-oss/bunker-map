/** Best-effort browser metadata/preferences only. Never use this as authorization.
 * If persistence is blocked or full, keep the latest value in this document so
 * session metadata still reaches the authenticated server proxy. Nothing is
 * retained on the server or shared across browser documents/users.
 */
const documentFallback = new Map<string, string | null>()

export function readClientStorage(key: string): string | null {
  if (typeof window === "undefined") return null
  if (documentFallback.has(key)) return documentFallback.get(key) ?? null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeClientStorage(key: string, value: string): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(key, value)
    documentFallback.delete(key)
  } catch {
    documentFallback.set(key, value)
  }
}

export function removeClientStorage(key: string): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(key)
    documentFallback.delete(key)
  } catch {
    // Mask any stale persisted actor after sign-out in this document.
    documentFallback.set(key, null)
  }
}
