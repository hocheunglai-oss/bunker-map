import React, { Component, useState } from "react"
import { createRoot } from "react-dom/client"
import { SimpleAdminAuthProvider, useSimpleAdminAuth } from "../../lib/useSimpleAdminAuth"
import { SpcAuthProvider, useSpcAuth, primeSpcClientSessionCache, clearSpcClientSessionCache } from "../../lib/useSpcAuth"
import { AdminNavigationShell } from "../../components/AdminNavigationShell"
import { SpcNavigationShell } from "../../components/SpcNavigationShell"
import { supabase } from "../../lib/supabase"
import AdminPage from "../../app/admin/page"

class TestBoundary extends Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: "" }
  static getDerivedStateFromError(error: Error) { return { error: error.message } }
  render() { return this.state.error ? <output role="alert">UI error: {this.state.error}</output> : this.props.children }
}

function AdminProbe() {
  const auth = useSimpleAdminAuth()
  const [read, setRead] = useState("")
  return <>
    <output data-testid="auth">{auth.loading ? "loading" : auth.authenticated ? "signed-in" : "signed-out"}</output>
    <button onClick={async () => { const result = await supabase.from("ports").select("id"); setRead(result.error ? "read-failed" : "read-ok") }}>Read prices</button>
    <button onClick={async () => { const result = await supabase.from("ports").update({ name: "synthetic-only" }).eq("id", "synthetic-port"); setRead(result.error ? "edit-blocked" : "edit-sent") }}>Try protected edit</button>
    <output data-testid="read">{read}</output>
  </>
}

function SpcProbe() {
  const auth = useSpcAuth()
  return <>
    <output data-testid="auth">{auth.loading ? "loading" : auth.authenticated ? "signed-in" : "signed-out"}</output>
    <button onClick={() => primeSpcClientSessionCache({ authenticated: true, username: "synthetic-spc", role: "ADMIN", pages: [], permissions: {} })}>Prime signed-in session</button>
    <button onClick={() => clearSpcClientSessionCache()}>Clear signed-in session</button>
  </>
}

const mode = new URLSearchParams(window.location.search).get("mode") || "admin"
const nav = new URLSearchParams(window.location.search).has("nav")
createRoot(document.getElementById("root")!).render(<TestBoundary>
  {mode === "admin-login" ? <SimpleAdminAuthProvider><AdminPage /></SimpleAdminAuthProvider>
    : mode === "spc" ? <SpcAuthProvider>{nav ? <SpcNavigationShell><SpcProbe /></SpcNavigationShell> : <SpcProbe />}</SpcAuthProvider>
    : <SimpleAdminAuthProvider>{nav ? <AdminNavigationShell><AdminProbe /></AdminNavigationShell> : <AdminProbe />}</SimpleAdminAuthProvider>}
</TestBoundary>)
