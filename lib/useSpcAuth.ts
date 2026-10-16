"use client"

import { createContext, createElement, Fragment, useContext, useEffect, useState } from "react"
import type { ReactNode } from "react"
import type { SpcPageDefinition, SpcPagePermissionMap, SpcRoleId } from "@/lib/spcPages"
import { removeClientStorage, writeClientStorage } from "@/lib/clientStorage"
import { browserSessionOwnerKey, createBrowserSessionStore, parseBrowserSessionPayload, type BrowserSessionPayload } from "@/lib/clientSessionStore"

type SpcAuthState = {
  loading: boolean
  authenticated: boolean
  actorKey: string | null
  username: string | null
  displayName: string | null
  role: SpcRoleId | null
  office: string | null
  mustChangePassword: boolean
  permissions: SpcPagePermissionMap
  pages: SpcPageDefinition[]
}

type SpcSessionPayload = Partial<BrowserSessionPayload>
const SpcAuthContext = createContext<SpcAuthState | null>(null)
const SPC_ACTOR_STORAGE_KEY = "spc_actor"
const SPC_SESSION_CHANGED_EVENT = "spc-session-changed"
const SPC_SESSION_CACHE_MS = 30_000
const SPC_SESSION_BACKGROUND_REFRESH_MS = 12 * 60 * 60 * 1000
const spcSessionStore = createBrowserSessionStore("/api/spc/session", SPC_SESSION_CACHE_MS)
// Document-local UI transition only; never a session or authorization signal.
let documentDeparturePending = false

export function isSpcDocumentDeparturePending() { return documentDeparturePending }

function emitSpcSessionChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SPC_SESSION_CHANGED_EVENT))
}

function writeCachedSpcActor(data: BrowserSessionPayload) {
  if (!data.authenticated || !data.username) { removeClientStorage(SPC_ACTOR_STORAGE_KEY); return }
  writeClientStorage(SPC_ACTOR_STORAGE_KEY, JSON.stringify({
    actorKey: data.actorKey, username: data.username, displayName: data.displayName || data.username,
    role: data.role, office: data.office, mustChangePassword: data.mustChangePassword === true,
    permissions: data.permissions, pages: data.pages,
  }))
}

export function clearSpcClientSessionCache(options: { leavingDocument?: boolean } = {}) {
  documentDeparturePending = options.leavingDocument === true
  spcSessionStore.invalidate()
  removeClientStorage(SPC_ACTOR_STORAGE_KEY)
  emitSpcSessionChanged()
}

export function primeSpcClientSessionCache(value: SpcSessionPayload) {
  const data = spcSessionStore.prime(value)
  documentDeparturePending = false
  writeCachedSpcActor(data)
  emitSpcSessionChanged()
}

function signedOutState(loading = false): SpcAuthState {
  return { loading, authenticated: false, actorKey: null, username: null, displayName: null, role: null,
    office: null, mustChangePassword: false, permissions: {}, pages: [] }
}

function useSpcAuthState(): SpcAuthState {
  const [state, setState] = useState<SpcAuthState>(() => signedOutState(true))
  useEffect(() => {
    let active = true
    let requestSequence = 0
    let ownerKey = "signed-out"

    function applySession(data: BrowserSessionPayload, persist = true) {
      if (!active) return
      ownerKey = browserSessionOwnerKey(data)
      if (persist) writeCachedSpcActor(data)
      setState(data.authenticated ? {
        loading: false, authenticated: true, actorKey: data.actorKey, username: data.username,
        displayName: data.displayName, role: data.role, office: data.office,
        mustChangePassword: data.mustChangePassword,
        permissions: data.permissions, pages: data.pages as SpcPageDefinition[],
      } : signedOutState())
    }

    async function checkSession(cacheMs = SPC_SESSION_CACHE_MS) {
      const sequence = ++requestSequence
      const version = spcSessionStore.version()
      try {
        const data = await spcSessionStore.load(cacheMs)
        if (active && sequence === requestSequence && version === spcSessionStore.version()) applySession(data)
      } catch {
        if (!active || sequence !== requestSequence || version !== spcSessionStore.version()) return
        if (!spcSessionStore.current()) applySession(parseBrowserSessionPayload({ authenticated: false }))
      }
    }

    function refreshActiveSession() { void checkSession(0) }
    function handleVisibilityChange() { if (document.visibilityState === "visible") refreshActiveSession() }
    function handleSessionChanged() {
      requestSequence += 1
      applySession(spcSessionStore.current() || parseBrowserSessionPayload({ authenticated: false }))
    }
    function handleStorage(event: StorageEvent) {
      if (event.key !== null && event.key !== SPC_ACTOR_STORAGE_KEY) return
      try {
        if (event.newValue && browserSessionOwnerKey(parseBrowserSessionPayload({ ...JSON.parse(event.newValue), authenticated: true })) === ownerKey) return
      } catch { /* Cached metadata cannot authenticate a replacement session. */ }
      spcSessionStore.invalidate()
      requestSequence += 1
      applySession(parseBrowserSessionPayload({ authenticated: false }), false)
      void checkSession(0)
    }

    window.addEventListener(SPC_SESSION_CHANGED_EVENT, handleSessionChanged)
    window.addEventListener("storage", handleStorage)
    window.addEventListener("focus", refreshActiveSession)
    document.addEventListener("visibilitychange", handleVisibilityChange)
    const refreshInterval = window.setInterval(refreshActiveSession, SPC_SESSION_BACKGROUND_REFRESH_MS)
    void checkSession()
    return () => {
      active = false
      requestSequence += 1
      window.removeEventListener(SPC_SESSION_CHANGED_EVENT, handleSessionChanged)
      window.removeEventListener("storage", handleStorage)
      window.removeEventListener("focus", refreshActiveSession)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.clearInterval(refreshInterval)
    }
  }, [])
  return state
}

export function SpcAuthProvider({ children }: { children: ReactNode }) {
  const state = useSpcAuthState()
  return createElement(SpcAuthContext.Provider, { value: state },
    createElement(Fragment, { key: browserSessionOwnerKey(state) }, children))
}

export function useSpcAuth(): SpcAuthState {
  const state = useContext(SpcAuthContext)
  if (!state) throw new Error("useSpcAuth must be used within SpcAuthProvider.")
  return state
}
