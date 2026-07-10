"use client"

import { createContext, createElement, useContext, useEffect, useState } from "react"
import type { ReactNode } from "react"
import type { SpcPageDefinition, SpcPagePermissionMap, SpcRoleId } from "@/lib/spcPages"

type SpcAuthState = {
  loading: boolean
  authenticated: boolean
  username: string | null
  displayName: string | null
  role: SpcRoleId | null
  office: string | null
  mustChangePassword: boolean
  permissions: SpcPagePermissionMap
  pages: SpcPageDefinition[]
}

type SpcSessionPayload = {
  authenticated?: boolean
  username?: string | null
  displayName?: string | null
  role?: SpcRoleId | null
  office?: string | null
  mustChangePassword?: boolean
  permissions?: SpcPagePermissionMap
  pages?: SpcPageDefinition[]
}

const SpcAuthContext = createContext<SpcAuthState | null>(null)

let sharedSessionPromise: Promise<SpcSessionPayload> | null = null
let sharedSessionResult: { data: SpcSessionPayload; loadedAt: number } | null = null
let sharedSessionVersion = 0

const SPC_ACTOR_STORAGE_KEY = "spc_actor"
const SPC_SESSION_CHANGED_EVENT = "spc-session-changed"
const SPC_SESSION_CACHE_MS = 30_000

function emitSpcSessionChanged() {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(SPC_SESSION_CHANGED_EVENT))
}

function writeCachedSpcActor(data: SpcSessionPayload) {
  if (typeof window === "undefined") return

  if (data.authenticated && data.username) {
    window.localStorage.setItem(
      SPC_ACTOR_STORAGE_KEY,
      JSON.stringify({
        username: data.username,
        displayName: data.displayName || data.username,
        role: data.role || null,
        office: data.office || null,
        mustChangePassword: data.mustChangePassword === true,
        permissions: data.permissions || {},
        pages: data.pages || [],
      }),
    )
    return
  }

  window.localStorage.removeItem(SPC_ACTOR_STORAGE_KEY)
}

export function clearSpcClientSessionCache() {
  sharedSessionVersion += 1
  sharedSessionPromise = null
  sharedSessionResult = null
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(SPC_ACTOR_STORAGE_KEY)
    emitSpcSessionChanged()
  }
}

export function primeSpcClientSessionCache(data: SpcSessionPayload) {
  const nextData = { ...data, authenticated: Boolean(data.authenticated) }
  sharedSessionVersion += 1
  sharedSessionPromise = null
  sharedSessionResult = { data: nextData, loadedAt: Date.now() }
  writeCachedSpcActor(nextData)
  emitSpcSessionChanged()
}

function loadSpcSession() {
  if (sharedSessionResult && Date.now() - sharedSessionResult.loadedAt < SPC_SESSION_CACHE_MS) {
    return Promise.resolve(sharedSessionResult.data)
  }
  if (sharedSessionPromise) return sharedSessionPromise

  const requestVersion = sharedSessionVersion

  sharedSessionPromise = fetch("/api/spc/session", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error("Unable to load SPC session.")
      const data = (await response.json()) as SpcSessionPayload
      if (requestVersion !== sharedSessionVersion) {
        return sharedSessionResult?.data || { authenticated: false, pages: [] }
      }
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
    const raw = window.localStorage.getItem(SPC_ACTOR_STORAGE_KEY)
    if (!raw) return null
    const actor = JSON.parse(raw) as SpcSessionPayload
    if (!actor.username) return null
    return { ...actor, authenticated: true }
  } catch {
    return null
  }
}

function useSpcAuthState(): SpcAuthState {
  const [loading, setLoading] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const [username, setUsername] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [role, setRole] = useState<SpcRoleId | null>(null)
  const [office, setOffice] = useState<string | null>(null)
  const [mustChangePassword, setMustChangePassword] = useState(false)
  const [permissions, setPermissions] = useState<SpcPagePermissionMap>({})
  const [pages, setPages] = useState<SpcPageDefinition[]>([])

  useEffect(() => {
    function applySession(data: SpcSessionPayload) {
      const isAuthenticated = Boolean(data.authenticated)
      const nextUsername = typeof data.username === "string" ? data.username : null
      const nextDisplayName =
        typeof data.displayName === "string" ? data.displayName : nextUsername
      const nextRole = typeof data.role === "string" ? data.role : null
      const nextOffice = typeof data.office === "string" ? data.office : null
      const nextMustChangePassword = data.mustChangePassword === true
      const nextPermissions =
        data.permissions && typeof data.permissions === "object" ? data.permissions : {}
      const nextPages = Array.isArray(data.pages) ? data.pages : []

      setAuthenticated(isAuthenticated)
      setUsername(isAuthenticated ? nextUsername : null)
      setDisplayName(isAuthenticated ? nextDisplayName : null)
      setRole(isAuthenticated ? nextRole : null)
      setOffice(isAuthenticated ? nextOffice : null)
      setMustChangePassword(isAuthenticated ? nextMustChangePassword : false)
      setPermissions(isAuthenticated ? nextPermissions : {})
      setPages(isAuthenticated ? nextPages : [])
      setLoading(false)

      writeCachedSpcActor({
        authenticated: isAuthenticated,
        username: nextUsername,
        displayName: nextDisplayName,
        role: nextRole,
        office: nextOffice,
        mustChangePassword: nextMustChangePassword,
        permissions: nextPermissions,
        pages: nextPages,
      })
    }

    function applySignedOutSession() {
      setAuthenticated(false)
      setUsername(null)
      setDisplayName(null)
      setRole(null)
      setOffice(null)
      setMustChangePassword(false)
      setPermissions({})
      setPages([])
      setLoading(false)
      writeCachedSpcActor({ authenticated: false })
    }

    function handleSessionChanged() {
      const cachedActor = readCachedSpcActor()
      if (cachedActor) {
        applySession(cachedActor)
        return
      }

      applySignedOutSession()
    }

    async function checkSession() {
      const cachedActor = readCachedSpcActor()

      try {
        const data = await loadSpcSession()
        applySession(data)
      } catch {
        if (cachedActor) return
        applySignedOutSession()
      } finally {
        setLoading(false)
      }
    }

    window.addEventListener(SPC_SESSION_CHANGED_EVENT, handleSessionChanged)

    const cachedActor = readCachedSpcActor()
    if (cachedActor) applySession(cachedActor)
    void checkSession()

    return () => {
      window.removeEventListener(SPC_SESSION_CHANGED_EVENT, handleSessionChanged)
    }
  }, [])

  return { loading, authenticated, username, displayName, role, office, mustChangePassword, permissions, pages }
}

export function SpcAuthProvider({ children }: { children: ReactNode }) {
  const state = useSpcAuthState()
  return createElement(SpcAuthContext.Provider, { value: state }, children)
}

export function useSpcAuth(): SpcAuthState {
  const state = useContext(SpcAuthContext)
  if (!state) throw new Error("useSpcAuth must be used within SpcAuthProvider.")
  return state
}
