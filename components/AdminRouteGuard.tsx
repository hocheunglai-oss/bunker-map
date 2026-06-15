"use client"

import { useEffect, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import { getAdminPageByPathFromPages } from "@/lib/adminPageRegistry"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  background: "var(--fc-admin-page-bg)",
  color: "var(--fc-admin-panel-text)",
  fontFamily: "var(--fc-admin-font)",
}

const panelStyle: React.CSSProperties = {
  width: "min(420px, 100%)",
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "18px",
  background: "var(--fc-admin-panel-bg)",
  boxShadow: "0 12px 28px #00000010",
  padding: "24px",
  textAlign: "center",
}

const buttonStyle: React.CSSProperties = {
  minHeight: "36px",
  border: "1px solid var(--fc-admin-button-border)",
  borderRadius: "999px",
  background: "var(--fc-admin-button-bg)",
  color: "var(--fc-admin-button-text)",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: 800,
  padding: "8px 14px",
  boxShadow: "none",
}

export function AdminRouteGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const { loading, authenticated, permissions, role, pages } = useSimpleAdminAuth()
  const page = getAdminPageByPathFromPages(pathname, pages)
  const [guardedRequestKey, setGuardedRequestKey] = useState("")
  const requestGuardKey =
    page && authenticated && !isAdminRole(role)
      ? `${page.id}:${permissions[page.id] || "none"}`
      : ""

  useEffect(() => {
    if (loading || !authenticated || !page || isAdminRole(role)) return

    const originalFetch = window.fetch.bind(window)
    const canEdit = canAccessAdminPage(permissions, page.id, "edit")

    const guardedFetch: typeof window.fetch = (input, init) => {
      const method =
        init?.method?.toUpperCase() ||
        (input instanceof Request ? input.method.toUpperCase() : "GET")

      if (!canEdit && !["GET", "HEAD", "OPTIONS"].includes(method)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              message: "You have view-only access to this admin page.",
            }),
            {
              status: 403,
              headers: {
                "Content-Type": "application/json",
              },
            }
          )
        )
      }

      return originalFetch(input, init)
    }
    window.fetch = guardedFetch
    setGuardedRequestKey(requestGuardKey)

    return () => {
      if (window.fetch === guardedFetch) {
        window.fetch = originalFetch
      }
    }
  }, [authenticated, loading, page, permissions, requestGuardKey, role])

  if (!page || pathname === "/admin") return <>{children}</>

  if (loading) return <p style={{ padding: "40px" }}>Loading...</p>

  if (requestGuardKey && guardedRequestKey !== requestGuardKey) {
    return <p style={{ padding: "40px" }}>Loading...</p>
  }

  const hasAccess =
    authenticated && (isAdminRole(role) || canAccessAdminPage(permissions, page.id, "view"))

  if (!hasAccess) {
    return (
      <div style={pageStyle}>
        <div style={panelStyle}>
          <h1 style={{ margin: "0 0 8px", fontSize: "20px" }}>Access Denied</h1>
          <p style={{ margin: "0 0 18px", color: "var(--fc-admin-muted)", fontSize: "13px" }}>
            Your account does not have access to this admin page.
          </p>
          <button type="button" onClick={() => router.push("/admin")} className="fc-admin-nav-button" style={buttonStyle}>
            Go To Admin
          </button>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
