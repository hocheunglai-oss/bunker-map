"use client"

import { createContext, createElement, useContext, useEffect, useState } from "react"
import type { ReactNode } from "react"
import {
  ADMIN_PAGE_DEFINITIONS,
  normaliseAdminPagePermissions,
  type AdminPageDefinition,
  type AdminPagePermissionMap,
} from "@/lib/adminPages"
import { normaliseAdminPageDefinitions } from "@/lib/adminPageRegistry"

type AuthState = {
  loading: boolean
  authenticated: boolean
  username: string | null
  displayName: string | null
  role: string | null
  permissions: AdminPagePermissionMap
  pages: AdminPageDefinition[]
}

type AdminSessionPayload = {
  authenticated?: boolean
  username?: string | null
  displayName?: string | null
  role?: string | null
  permissions?: AdminPagePermissionMap
  pages?: AdminPageDefinition[]
}

const AdminAuthContext = createContext<AuthState | null>(null)

let sharedSessionPromise: Promise<AdminSessionPayload> | null = null
let sharedSessionResult: { data: AdminSessionPayload; loadedAt: number } | null = null

function loadAdminSession() {
  if (sharedSessionResult && Date.now() - sharedSessionResult.loadedAt < 5000) {
    return Promise.resolve(sharedSessionResult.data)
  }
  if (sharedSessionPromise) return sharedSessionPromise

  sharedSessionPromise = fetch("/api/admin/session", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error("Unable to load admin session.")
      const data = (await response.json()) as AdminSessionPayload
      sharedSessionResult = { data, loadedAt: Date.now() }
      return data
    })
    .finally(() => {
      sharedSessionPromise = null
    })

  return sharedSessionPromise
}

function readCachedAdminActor(): AdminSessionPayload | null {
  if (typeof window === "undefined") return null

  try {
    const raw = window.localStorage.getItem("bunker_admin_actor")
    if (!raw) return null
    const actor = JSON.parse(raw) as AdminSessionPayload
    if (!actor.username) return null
    return { ...actor, authenticated: true }
  } catch {
    return null
  }
}

function useSimpleAdminAuthState(): AuthState {
  const [loading, setLoading] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const [username, setUsername] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [role, setRole] = useState<string | null>(null)
  const [permissions, setPermissions] = useState<AdminPagePermissionMap>(
    normaliseAdminPagePermissions(null)
  )
  const [pages, setPages] = useState<AdminPageDefinition[]>(ADMIN_PAGE_DEFINITIONS)

  useEffect(() => {
    const cachedActor = readCachedAdminActor()

    function applySession(data: AdminSessionPayload) {
      const isAuthenticated = Boolean(data.authenticated)
      const nextUsername = typeof data.username === "string" ? data.username : null
      const nextDisplayName =
        typeof data.displayName === "string" ? data.displayName : nextUsername
      const nextRole = typeof data.role === "string" ? data.role : null
      const nextPages = normaliseAdminPageDefinitions(data.pages)
      const nextPermissions = normaliseAdminPagePermissions(
        data.permissions,
        "none",
        nextPages
      )

      setAuthenticated(isAuthenticated)
      setUsername(isAuthenticated ? nextUsername : null)
      setDisplayName(isAuthenticated ? nextDisplayName : null)
      setRole(isAuthenticated ? nextRole : null)
      setPermissions(isAuthenticated ? nextPermissions : normaliseAdminPagePermissions(null))
      setPages(nextPages)
      setLoading(false)

      if (isAuthenticated && nextUsername) {
        window.localStorage.setItem(
          "bunker_admin_actor",
          JSON.stringify({
            username: nextUsername,
            displayName: nextDisplayName || nextUsername,
            role: nextRole,
            permissions: nextPermissions,
            pages: nextPages,
          })
        )
      } else {
        window.localStorage.removeItem("bunker_admin_actor")
      }
    }

    async function checkSession() {
      try {
        const data = await loadAdminSession()
        applySession(data)
      } catch {
        if (cachedActor) return
        setAuthenticated(false)
        setUsername(null)
        setDisplayName(null)
        setRole(null)
        setPermissions(normaliseAdminPagePermissions(null))
        setPages(ADMIN_PAGE_DEFINITIONS)
        if (typeof window !== "undefined") {
          window.localStorage.removeItem("bunker_admin_actor")
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

export function SimpleAdminAuthProvider({ children }: { children: ReactNode }) {
  const state = useSimpleAdminAuthState()
  return createElement(AdminAuthContext.Provider, { value: state }, children)
}

export function useSimpleAdminAuth(): AuthState {
  const state = useContext(AdminAuthContext)
  if (!state) throw new Error("useSimpleAdminAuth must be used within SimpleAdminAuthProvider.")
  return state
}
