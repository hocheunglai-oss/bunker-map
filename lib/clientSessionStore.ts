export type BrowserSessionPayload = {
  authenticated: boolean
  actorKey: string | null
  username: string | null
  displayName: string | null
  role: string | null
  office: string | null
  resetRequired: boolean
  mustChangePassword: boolean
  permissions: Record<string, "none" | "view" | "edit">
  pages: Array<{ id: string; label: string; group: string; path: string; matchPrefixes?: string[]; external?: boolean }>
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

export function parseBrowserSessionPayload(value: unknown): BrowserSessionPayload {
  if (!record(value) || typeof value.authenticated !== "boolean") {
    throw new Error("The session response could not be verified.")
  }
  const empty: BrowserSessionPayload = {
    authenticated: false, actorKey: null, username: null, displayName: null, role: null,
    office: null, resetRequired: false, mustChangePassword: false, permissions: {}, pages: [],
  }
  if (!value.authenticated) return empty
  if (typeof value.username !== "string" || !value.username.trim() ||
      typeof value.role !== "string" || !value.role.trim()) {
    throw new Error("The session identity could not be verified.")
  }
  for (const key of ["displayName", "office", "actorKey"] as const) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "string") {
      throw new Error("The session identity could not be verified.")
    }
  }
  if (typeof value.actorKey === "string" &&
      !/^[0-9a-f]{64}$/.test(value.actorKey)) {
    throw new Error("The session identity could not be verified.")
  }
  const permissions = value.permissions ?? {}
  if (!record(permissions) || Object.values(permissions).some(item => typeof item !== "string" || !["none", "view", "edit"].includes(item))) {
    throw new Error("The session permissions could not be verified.")
  }
  const pages = value.pages ?? []
  if (!Array.isArray(pages) || pages.some(page => !record(page) ||
      ["id", "label", "group", "path"].some(key => typeof page[key] !== "string" || !page[key]) ||
      (page.matchPrefixes !== undefined && (!Array.isArray(page.matchPrefixes) || page.matchPrefixes.some(item => typeof item !== "string"))) ||
      (page.external !== undefined && typeof page.external !== "boolean"))) {
    throw new Error("The session pages could not be verified.")
  }
  return {
    authenticated: true, actorKey: typeof value.actorKey === "string" ? value.actorKey : null,
    username: value.username, displayName: typeof value.displayName === "string" ? value.displayName : value.username,
    role: value.role, office: typeof value.office === "string" ? value.office : null,
    resetRequired: value.resetRequired === true, mustChangePassword: value.mustChangePassword === true,
    permissions: permissions as BrowserSessionPayload["permissions"], pages: pages as BrowserSessionPayload["pages"],
  }
}

export function browserSessionOwnerKey(value: Partial<BrowserSessionPayload>) {
  if (!value.authenticated) return "signed-out"
  return JSON.stringify([
    value.actorKey || null, value.username || null, value.role || null, value.office || null,
    value.resetRequired === true, value.mustChangePassword === true,
    Object.entries(value.permissions || {}).sort(([left], [right]) => left.localeCompare(right)),
    (value.pages || []).map(page => [page.id, page.path, page.group, page.external === true, page.matchPrefixes || []]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  ])
}

/** Shared within one document only. Never authorizes a server request. */
export function createBrowserSessionStore(url: string, defaultCacheMs: number) {
  let version = 0
  let result: { data: BrowserSessionPayload; loadedAt: number } | null = null
  let pending: Promise<BrowserSessionPayload> | null = null
  let controller: AbortController | null = null

  function invalidate() {
    version += 1
    result = null
    pending = null
    controller?.abort()
    controller = null
  }

  return {
    version: () => version,
    current: () => result?.data || null,
    invalidate,
    prime(value: unknown) {
      const data = parseBrowserSessionPayload(value)
      invalidate()
      result = { data, loadedAt: Date.now() }
      return data
    },
    load(cacheMs = defaultCacheMs) {
      if (result && Date.now() - result.loadedAt < cacheMs) return Promise.resolve(result.data)
      if (pending) return pending
      const requestVersion = version
      const requestController = new AbortController()
      controller = requestController
      let timer: ReturnType<typeof setTimeout> | undefined
      const work = fetch(url, { cache: "no-store", signal: requestController.signal }).then(async response => {
        if (response.status === 401 || response.status === 403) return parseBrowserSessionPayload({ authenticated: false })
        if (!response.ok) throw new Error("Unable to verify the session. Please try again.")
        return parseBrowserSessionPayload(await response.json())
      })
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("The session check timed out. Please try again."))
          requestController.abort()
        }, 30_000)
      })
      const request = Promise.race([work, timeout]).then(data => {
        if (requestVersion !== version) throw new Error("This session check was replaced.")
        result = { data, loadedAt: Date.now() }
        return data
      }).finally(() => {
        if (timer) clearTimeout(timer)
        if (pending === request) pending = null
        if (controller === requestController) controller = null
      })
      pending = request
      return request
    },
  }
}
