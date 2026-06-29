"use client"

import { useEffect, useState } from "react"
import type { SpcPageDefinition, SpcPagePermissionMap, SpcRoleId } from "@/lib/spcPages"

type SpcAuthState = {
  loading: boolean
  authenticated: boolean
  username: string | null
  displayName: string | null
  role: SpcRoleId | null
  permissions: SpcPagePermissionMap
  pages: SpcPageDefinition[]
}

type SpcSessionPayload = {
  authenticated?: boolean
  username?: string | null
  displayName?: string | null
  role?: SpcRoleId | null
  permissions?: SpcPagePermissionMap
  pages?: SpcPageDefinition[]
}

let sharedSessionPromise: Promise<SpcSessionPayload> | null = null
let sharedSessionResult: { data: SpcSessionPayload; loadedAt: number } | null = null

export function clearSpcClientSessionCache() {
  sharedSessionPromise = null
  sharedSessionResult = null
  if (typeof window !== "undefined") window.localStorage.removeItem("spc_actor")
}

function loadSpcSession() {
  if (sharedSessionResult && Date.now() - sharedSessionResult.loadedAt < 5000) {
    return Promise.resolve(sharedSessionResult.data)
  }
  if (sharedSessionPromise) return sharedSessionPromise

  sharedSessionPromise = fetch("/api/spc/session", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error("Unable to load SPC session.")
      const data = (await response.json()) as SpcSessionPayload
      sharedSessionResult = { data, loadedAt: Date.now() }
      return data
    })
    .finally(() => {
      sharedSessionPromise = null
    })

  return sharedSessionPromise
}

function readCachedSpcActor(): SpcSessionPayload | null {
  if (typeof window === "undefined") return null

  try {
    const raw = window.localStorage.getItem("spc_actor")
    if (!raw) return null
    const actor = JSON.parse(raw) as SpcSessionPayload
    if (!actor.username) return null
    return { ...actor, authenticated: true }
  } catch {
    return null
  }
}

export function useSpcAuth(): SpcAuthState {
  const [loading, setLoading] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const [username, setUsername] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [role, setRole] = useState<SpcRoleId | null>(null)
  const [permissions, setPermissions] = useState<SpcPagePermissionMap>({})
  const [pages, setPages] = useState<SpcPageDefinition[]>([])

  useEffect(() => {
    const cachedActor = readCachedSpcActor()

    function applySession(data: SpcSessionPayload) {
      const isAuthenticated = Boolean(data.authenticated)
      const nextUsername = typeof data.username === "string" ? data.username : null
      const nextDisplayName =
        typeof data.displayName === "string" ? data.displayName : nextUsername
      const nextRole = typeof data.role === "string" ? data.role : null
      const nextPermissions =
        data.permissions && typeof data.permissions === "object" ? data.permissions : {}
      const nextPages = Array.isArray(data.pages) ? data.pages : []

      setAuthenticated(isAuthenticated)
      setUsername(isAuthenticated ? nextUsername : null)
      setDisplayName(isAuthenticated ? nextDisplayName : null)
      setRole(isAuthenticated ? nextRole : null)
      setPermissions(isAuthenticated ? nextPermissions : {})
      setPages(isAuthenticated ? nextPages : [])
      setLoading(false)

      if (isAuthenticated && nextUsername) {
        window.localStorage.setItem(
          "spc_actor",
          JSON.stringify({
            username: nextUsername,
            displayName: nextDisplayName || nextUsername,
            role: nextRole,
            permissions: nextPermissions,
            pages: nextPages,
          }),
        )
      } else {
        window.localStorage.removeItem("spc_actor")
      }
    }

    async function checkSession() {
      try {
        const data = await loadSpcSession()
        applySession(data)
      } catch {
        if (cachedActor) return
        setAuthenticated(false)
        setUsername(null)
        setDisplayName(null)
        setRole(null)
        setPermissions({})
        setPages([])
        if (typeof window !== "undefined") {
          window.localStorage.removeItem("spc_actor")
        }
      } finally {
        setLoading(false)
      }
    }

    if (cachedActor) applySession(cachedActor)
    void checkSession()
  }, [])

  return { loading, authenticated, username, displayName, role, permissions, pages }
}
