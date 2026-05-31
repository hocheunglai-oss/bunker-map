"use client"

import { usePathname, useRouter } from "next/navigation"
import { canAccessAdminPage, getAdminPageByPath, isAdminRole } from "@/lib/adminPages"
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
  const page = getAdminPageByPath(pathname)
  const { loading, authenticated, permissions, role } = useSimpleAdminAuth()

  if (!page || pathname === "/admin") return <>{children}</>

  if (loading) return <p style={{ padding: "40px" }}>Loading...</p>

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
          <button type="button" onClick={() => router.push("/admin")} style={buttonStyle}>
            Go To Admin
          </button>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
