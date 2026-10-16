import React, { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { SimpleAdminAuthProvider, useSimpleAdminAuth, primeAdminClientSessionCache, clearAdminClientSessionCache } from "../../lib/useSimpleAdminAuth"
import { SpcAuthProvider, useSpcAuth, primeSpcClientSessionCache, clearSpcClientSessionCache } from "../../lib/useSpcAuth"
import { AdminNavigationShell } from "../../components/AdminNavigationShell"
import { AdminRouteGuard } from "../../components/AdminRouteGuard"
import { SpcNavigationShell } from "../../components/SpcNavigationShell"
import { SpcShell } from "../../components/SpcShell"
import { canAccessAdminPage } from "../../lib/adminPages"
import { canAccessSpcPage } from "../../lib/spcPages"
import EventCalendar from "../../app/admin/eventcalendar/page"
import AdminPage from "../../app/admin/page"
import SpcLoginPage from "../../app/spc/page"

declare global {
  interface Window {
    __sessionOwnership: { changes: number; authenticated: boolean; loading: boolean; actorKey: string | null; username: string | null; permission: string }
    __primeOwnershipSession: (value: unknown) => Promise<void>
    __clearOwnershipSession: () => void
    __sessionOwnershipRoutes: string[]
    __silentSessionSetupThrows: number
    __ownershipDocumentId: string
  }
}
const mode = new URL(location.href).searchParams.get("mode") === "spc" || location.pathname.startsWith("/spc") ? "spc" : "admin"
const calendar = new URL(location.href).searchParams.has("calendar")
const login = new URL(location.href).searchParams.has("login") || ["/admin", "/spc"].includes(location.pathname)
window.__sessionOwnership = { changes: 0, authenticated: false, loading: true, actorKey: null, username: null, permission: "none" }
window.__sessionOwnershipRoutes = []
window.__silentSessionSetupThrows = 0
window.__ownershipDocumentId = crypto.randomUUID()
window.__primeOwnershipSession = async value => {
  const previousCommit = window.__sessionOwnership.changes
  if (mode === "admin") primeAdminClientSessionCache(value)
  else primeSpcClientSessionCache(value as Parameters<typeof primeSpcClientSessionCache>[0])
  const expected = value as { actorKey?: string | null; authenticated?: boolean }
  // Await the actual provider's keyed subtree commit, not merely an old input
  // that is still attached during a same-username actor replacement.
  for (let attempt = 0; attempt < 200; attempt++) {
    if (window.__sessionOwnership.changes > previousCommit && window.__sessionOwnership.actorKey === (expected.actorKey ?? null) && window.__sessionOwnership.authenticated === expected.authenticated) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error("The replacement session owner did not commit.")
}
window.__clearOwnershipSession = () => mode === "admin" ? clearAdminClientSessionCache() : clearSpcClientSessionCache()

// Deliberately ignore transport abort for session requests: stale completion
// safety must come from the real session store/owner, not a cooperative network.
const nativeFetch = window.fetch.bind(window)
window.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin)
  if (url.pathname === "/api/spc/fcuno-login" && new URL(location.href).searchParams.has("syncThrow")) {
    window.__silentSessionSetupThrows += 1
    throw new TypeError("Synthetic synchronous fetch setup failure")
  }
  if (url.pathname === "/api/spc/fcuno-login") {
    // An owned synthetic journal survives this same-origin hard navigation, so
    // the old document's attempted dispatches are visible after logout too.
    const documents = JSON.parse(sessionStorage.getItem("synthetic-silent-documents") || "[]") as string[]
    documents.push(window.__ownershipDocumentId)
    sessionStorage.setItem("synthetic-silent-documents", JSON.stringify(documents))
  }
  if (["/api/admin/session", "/api/spc/session"].includes(url.pathname)) {
    const options = { ...init }
    delete options.signal
    return nativeFetch(input, options)
  }
  return nativeFetch(input, init)
}

function Draft({ permission }: { permission: string }) {
  const [draft, setDraft] = useState("")
  return <section style={{ padding: 20, maxWidth: 680, margin: "0 auto", background: "var(--fc-admin-panel-bg)", color: "var(--fc-admin-panel-text)", border: "1px solid var(--fc-admin-border)", borderRadius: 16 }}>
    <h1 style={{ fontSize: 22 }}>Session-owned draft</h1>
    <p>Local synthetic draft used to verify the real sign-in provider and page boundary.</p>
    <label style={{ display: "grid", gap: 8 }}>Draft text<input aria-label="Session-owned draft" value={draft} onChange={event => setDraft(event.target.value)} readOnly={permission !== "edit"} style={{ width: "100%", minWidth: 0, padding: 12, color: "var(--fc-admin-panel-text)", background: "var(--fc-admin-panel-bg)", border: "1px solid var(--fc-admin-border)", borderRadius: 8 }} /></label>
    <button type="button" disabled={permission !== "edit"} style={{ marginTop: 14, padding: "10px 16px", borderRadius: 24, background: "var(--fc-admin-primary-button-bg)", color: "var(--fc-admin-primary-button-text)", border: 0 }}>Save synthetic draft</button>
    <p data-testid="draft-permission">{permission}</p>
  </section>
}
function useObserve(auth: { authenticated: boolean; loading: boolean; actorKey: string | null; username: string | null }, permission: string) {
  useEffect(() => {
    window.__sessionOwnership = { changes: window.__sessionOwnership.changes + 1, authenticated: auth.authenticated, loading: auth.loading, actorKey: auth.actorKey, username: auth.username, permission }
  }, [auth, permission])
}
function AdminContent() {
  const auth = useSimpleAdminAuth()
  const permission = canAccessAdminPage(auth.permissions, "event-calendar", "edit") ? "edit" : canAccessAdminPage(auth.permissions, "event-calendar", "view") ? "view" : "none"
  useObserve(auth, permission)
  return <AdminNavigationShell><AdminRouteGuard>{login && !auth.authenticated ? <AdminPage /> : calendar ? <EventCalendar /> : <Draft permission={permission} />}</AdminRouteGuard></AdminNavigationShell>
}
function SpcContent() {
  const auth = useSpcAuth()
  const permission = canAccessSpcPage(auth.permissions, "spc-buyer-enquiries", "edit") ? "edit" : canAccessSpcPage(auth.permissions, "spc-buyer-enquiries", "view") ? "view" : "none"
  useObserve(auth, permission)
  if (login && !auth.authenticated) return <SpcNavigationShell><SpcLoginPage /></SpcNavigationShell>
  // SPC has page-level permission checks, not a generic route-guard component.
  return <SpcNavigationShell><SpcShell title="Synthetic session ownership">
    {auth.loading ? <p>Checking sign-in…</p> : !auth.authenticated || permission === "none" ? <section style={{ padding: 24, color: "var(--fc-admin-panel-text)" }}><h1>Access Denied</h1><p>Sign in with access to this page.</p></section> : <Draft permission={permission} />}
  </SpcShell></SpcNavigationShell>
}
createRoot(document.getElementById("root")!).render(<div className={`fc-admin-scope${mode === "spc" ? " spc-scope" : ""}`}>
  {mode === "spc" ? <SpcAuthProvider><SpcContent /></SpcAuthProvider> : <SimpleAdminAuthProvider><AdminContent /></SimpleAdminAuthProvider>}
</div>)
