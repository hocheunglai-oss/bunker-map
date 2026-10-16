"use client"

import { createContext, createElement, Fragment, useContext, useEffect, useState } from "react"
import type { ReactNode } from "react"
import { ADMIN_PAGE_DEFINITIONS, normaliseAdminPagePermissions, type AdminPageDefinition, type AdminPagePermissionMap } from "@/lib/adminPages"
import { normaliseAdminPageDefinitions } from "@/lib/adminPageRegistry"
import { removeClientStorage, writeClientStorage } from "@/lib/clientStorage"
import { clearAdminClientCache } from "@/lib/adminClientCache"
import { browserSessionOwnerKey, createBrowserSessionStore, parseBrowserSessionPayload, type BrowserSessionPayload } from "@/lib/clientSessionStore"

type AuthState = {
  loading: boolean
  authenticated: boolean
  actorKey: string | null
  resetRequired: boolean
  username: string | null
  displayName: string | null
  role: string | null
  permissions: AdminPagePermissionMap
  pages: AdminPageDefinition[]
}

const AdminAuthContext = createContext<AuthState | null>(null)
const ADMIN_ACTOR_STORAGE_KEY = "bunker_admin_actor"
const ADMIN_SESSION_CHANGED_EVENT = "fcuno-admin-session-changed"
const adminSessionStore = createBrowserSessionStore("/api/admin/session", 5000)

function persistAdminActor(data: BrowserSessionPayload) {
  if (!data.authenticated || !data.username) {
    removeClientStorage(ADMIN_ACTOR_STORAGE_KEY)
    return
  }
  writeClientStorage(ADMIN_ACTOR_STORAGE_KEY, JSON.stringify({
    actorKey: data.actorKey, username: data.username, displayName: data.displayName || data.username,
    role: data.role, resetRequired: data.resetRequired === true,
    permissions: data.permissions, pages: data.pages,
  }))
}

export function clearAdminClientSessionCache() {
  adminSessionStore.invalidate()
  clearAdminClientCache()
  removeClientStorage(ADMIN_ACTOR_STORAGE_KEY)
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ADMIN_SESSION_CHANGED_EVENT))
}

export function primeAdminClientSessionCache(value: unknown) {
  const data = adminSessionStore.prime(value)
  clearAdminClientCache()
  persistAdminActor(data)
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ADMIN_SESSION_CHANGED_EVENT))
}

function signedOutState(loading = false): AuthState {
  return { loading, authenticated: false, actorKey: null, resetRequired: false, username: null,
    displayName: null, role: null, permissions: normaliseAdminPagePermissions(null), pages: ADMIN_PAGE_DEFINITIONS }
}

function useSimpleAdminAuthState(): AuthState {
  const [state, setState] = useState<AuthState>(() => signedOutState(true))
  useEffect(() => {
    let active = true
    let requestSequence = 0
    let ownerKey = "signed-out"

    function applySession(data: BrowserSessionPayload, persist = true) {
      if (!active) return
      const pages = normaliseAdminPageDefinitions(data.pages)
      const permissions = data.authenticated ? normaliseAdminPagePermissions(data.permissions, "none", pages) : normaliseAdminPagePermissions(null)
      const next = { ...data, pages, permissions }
      const nextOwner = browserSessionOwnerKey(next)
      if (nextOwner !== ownerKey) clearAdminClientCache()
      ownerKey = nextOwner
      if (persist) persistAdminActor(next)
      setState(data.authenticated ? {
        loading: false, authenticated: true, actorKey: data.actorKey, resetRequired: data.resetRequired,
        username: data.username, displayName: data.displayName, role: data.role, permissions, pages,
      } : signedOutState())
    }

    async function checkSession(cacheMs = 5000) {
      const sequence = ++requestSequence
      const version = adminSessionStore.version()
      try {
        const data = await adminSessionStore.load(cacheMs)
        if (active && sequence === requestSequence && version === adminSessionStore.version()) applySession(data)
      } catch {
        if (!active || sequence !== requestSequence || version !== adminSessionStore.version()) return
        // A temporary refresh failure does not undo a previously verified session.
        if (!adminSessionStore.current()) applySession(parseBrowserSessionPayload({ authenticated: false }))
      }
    }

    function refreshActiveSession() { void checkSession(0) }
    function handleVisibilityChange() { if (document.visibilityState === "visible") refreshActiveSession() }
    function handleSessionChanged() {
      requestSequence += 1
      applySession(adminSessionStore.current() || parseBrowserSessionPayload({ authenticated: false }))
    }
    function handleStorage(event: StorageEvent) {
      if (event.key !== null && event.key !== ADMIN_ACTOR_STORAGE_KEY) return
      try {
        if (event.newValue && browserSessionOwnerKey(parseBrowserSessionPayload({ ...JSON.parse(event.newValue), authenticated: true })) === ownerKey) return
      } catch { /* A malformed/replaced actor is not proof of the current session. */ }
      adminSessionStore.invalidate()
      requestSequence += 1
      clearAdminClientCache()
      applySession(parseBrowserSessionPayload({ authenticated: false }), false)
      void checkSession(0)
    }

    window.addEventListener(ADMIN_SESSION_CHANGED_EVENT, handleSessionChanged)
    window.addEventListener("storage", handleStorage)
    window.addEventListener("focus", refreshActiveSession)
    document.addEventListener("visibilitychange", handleVisibilityChange)
    const interval = window.setInterval(refreshActiveSession, 12 * 60 * 60 * 1000)
    // Persisted display metadata is never accepted as a verified sign-in.
    void checkSession()
    return () => {
      active = false
      requestSequence += 1
      window.removeEventListener(ADMIN_SESSION_CHANGED_EVENT, handleSessionChanged)
      window.removeEventListener("storage", handleStorage)
      window.removeEventListener("focus", refreshActiveSession)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.clearInterval(interval)
    }
  }, [])
  return state
}

export function SimpleAdminAuthProvider({ children }: { children: ReactNode }) {
  const state = useSimpleAdminAuthState()
  return createElement(AdminAuthContext.Provider, { value: state },
    createElement(Fragment, { key: browserSessionOwnerKey(state) }, children))
}

export function useSimpleAdminAuth(): AuthState {
  const state = useContext(AdminAuthContext)
  if (!state) throw new Error("useSimpleAdminAuth must be used within SimpleAdminAuthProvider.")
  return state
}
