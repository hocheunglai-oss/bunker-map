"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { canAccessAdminPage, getAdminPagesByGroup, isAdminRole } from "@/lib/adminPages"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { useIsMobile } from "@/lib/useIsMobile"

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  padding: "24px",
  background: "var(--fc-admin-page-bg)",
  color: "var(--fc-admin-panel-text)",
  fontFamily: "var(--fc-admin-font)",
}

const shellStyle: React.CSSProperties = {
  width: "min(1380px, 100%)",
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(220px, 1fr))",
  gap: "18px",
}

const panelStyle: React.CSSProperties = {
  borderRadius: "28px",
  padding: "30px",
  background: "var(--fc-admin-panel-bg)",
  border: "1px solid var(--fc-admin-border)",
  boxShadow: "0 18px 42px #00000014",
  color: "var(--fc-admin-panel-text)",
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  border: "1px solid var(--fc-input-border)",
  borderRadius: "14px",
  fontSize: "15px",
  background: "var(--fc-login-input-bg)",
  color: "var(--fc-login-input-text)",
  outline: "none",
  boxShadow: "none",
}

const actionButtonStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 16px",
  border: "1px solid var(--fc-admin-button-border)",
  borderRadius: "999px",
  background: "var(--fc-admin-button-bg)",
  color: "var(--fc-admin-button-text)",
  cursor: "pointer",
  fontSize: "14px",
  fontWeight: 700,
  textAlign: "center",
  transition: "transform 0.16s ease, background 0.16s ease, border-color 0.16s ease",
  boxShadow: "none",
}

const lockedPanelShellStyle: React.CSSProperties = {
  ...panelStyle,
  background: "var(--fc-admin-panel-soft-bg)",
  border: "1px solid var(--fc-admin-border-soft)",
  boxShadow: "0 18px 42px #00000010",
}

export default function AdminPage() {
  const isMobile = useIsMobile()
  const router = useRouter()
  const { loading, authenticated, displayName, permissions, role } = useSimpleAdminAuth()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState("")

  useEffect(() => {
    document.title = "Admin - FC Uno"
  }, [])

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setMessage("")

    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password }),
    })

    const data = await response.json()

    if (!response.ok) {
      setMessage(data.message || "Login failed.")
      setSubmitting(false)
      return
    }

    if (data.user?.username) {
      window.localStorage.setItem(
        "bunker_admin_actor",
        JSON.stringify({
          username: data.user.username,
          displayName: data.user.displayName || data.user.username,
          role: data.user.role || null,
          permissions: data.user.permissions || {},
        })
      )
    }

    window.location.reload()
  }

  async function handleLogout() {
    await fetch("/api/admin/logout", {
      method: "POST",
    })

    window.localStorage.removeItem("bunker_admin_actor")
    window.location.reload()
  }

  if (loading) return <p style={{ padding: "40px" }}>Loading...</p>

  function visiblePages(group: "reports" | "trading" | "contacts" | "office" | "management") {
    return getAdminPagesByGroup(group).filter(
      (page) => isAdminRole(role) || canAccessAdminPage(permissions, page.id, "view")
    )
  }

  function renderToolButtons(group: "reports" | "trading" | "contacts" | "office" | "management") {
    const pages = visiblePages(group)

    if (pages.length === 0) {
      return (
        <p style={{ margin: 0, color: "var(--fc-admin-muted)", fontSize: "13px", textAlign: "center" }}>
          No tools assigned.
        </p>
      )
    }

    return pages.map((item) => (
      <button
        key={item.label}
        onClick={() => router.push(item.path)}
        style={{
          ...actionButtonStyle,
          padding: isMobile ? "13px 14px" : actionButtonStyle.padding,
          background: "var(--fc-admin-button-bg)",
          color: "var(--fc-admin-button-text)",
          borderColor: "var(--fc-admin-button-border)",
          cursor: "pointer",
          boxShadow: "none",
        }}
      >
        {item.label}
      </button>
    ))
  }

  return (
    <div style={pageStyle}>
      <div
        style={{
          ...shellStyle,
          gridTemplateColumns: isMobile ? "1fr" : shellStyle.gridTemplateColumns,
          gap: isMobile ? "14px" : "18px",
        }}
      >
        <form
          onSubmit={handleLogin}
          style={{
            ...panelStyle,
            ...(isMobile ? {} : { gridColumn: "1", gridRow: "1" }),
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              minHeight: "100%",
            }}
          >
            <div style={{ display: "flex", justifyContent: "center", marginBottom: "18px" }}>
              <a href="/" style={{ display: "inline-flex" }}>
                <img
                  src="/uno-transparent.png"
                  alt="Bunker Map"
                  style={{ height: isMobile ? "123px" : "156px", width: "auto" }}
                />
              </a>
            </div>

            <label style={{ display: "block", marginBottom: 16 }}>
              <div
                style={{
                  marginBottom: 8,
                  fontSize: "12px",
                  letterSpacing: "0.16em",
                  textTransform: "uppercase",
                  color: "var(--fc-admin-heading)",
                  fontWeight: 700,
                }}
              >
                Username
              </div>
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                style={inputStyle}
              />
            </label>

            <label style={{ display: "block", marginBottom: 20 }}>
              <div
                style={{
                  marginBottom: 8,
                  fontSize: "12px",
                  letterSpacing: "0.16em",
                  textTransform: "uppercase",
                  color: "var(--fc-admin-heading)",
                  fontWeight: 700,
                }}
              >
                Password
              </div>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                style={inputStyle}
              />
            </label>

            <div style={{ marginTop: "auto" }}>
              {authenticated && displayName ? (
                <p
                  style={{
                    margin: "0 0 12px",
                    color: "var(--fc-admin-muted)",
                    fontSize: "13px",
                    fontWeight: 700,
                    textAlign: "center",
                  }}
                >
                  Signed in as {displayName}
                </p>
              ) : null}

              {authenticated ? (
                <button
                  type="button"
                  onClick={handleLogout}
                style={{
                  width: "100%",
                  padding: "14px 16px",
                  border: "1px solid var(--fc-admin-danger-border)",
                  borderRadius: "999px",
                  background: "var(--fc-admin-danger-bg)",
                  color: "var(--fc-admin-danger-text)",
                  cursor: "pointer",
                  fontSize: "15px",
                  fontWeight: 800,
                  boxShadow: "none",
                  marginBottom: "12px",
                }}
                >
                  Logout
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={submitting}
                style={{
                  width: "100%",
                  padding: "14px 16px",
                  border: "1px solid var(--fc-admin-success-border)",
                  borderRadius: "999px",
                  background: "var(--fc-admin-success-bg)",
                  color: "var(--fc-admin-success-text)",
                  cursor: "pointer",
                  fontSize: "15px",
                  fontWeight: 800,
                  boxShadow: "none",
                  marginBottom: "12px",
                }}
                >
                  {submitting ? "Signing In..." : "Login"}
                </button>
              )}

              <button
                type="button"
                onClick={() => router.push("/")}
                style={{
                  width: "100%",
                  padding: "12px 16px",
                  border: "1px solid var(--fc-admin-border)",
                  borderRadius: "999px",
                  background: "var(--fc-admin-button-bg)",
                  color: "var(--fc-admin-button-text)",
                  cursor: "pointer",
                  fontSize: "14px",
                  fontWeight: 700,
                  boxShadow: "none",
                }}
              >
                Back
              </button>

              {message && (
                <p style={{ marginBottom: 0, marginTop: 16, color: "var(--fc-error)", fontWeight: 700 }}>
                  {message}
                </p>
              )}
            </div>
          </div>
        </form>

        <div
          style={{
            ...(authenticated ? panelStyle : lockedPanelShellStyle),
            display: "flex",
            flexDirection: "column",
            ...(isMobile ? {} : { gridColumn: "1", gridRow: "2" }),
          }}
        >
          {authenticated ? (
            <>
              <div
                style={{
                  textAlign: "center",
                  fontSize: "12px",
                  letterSpacing: "0.16em",
                  textTransform: "uppercase",
                  color: "var(--fc-admin-heading)",
                  marginBottom: "10px",
                  fontWeight: 700,
                }}
              >
                Report Tools
              </div>

              <div style={{ display: "grid", gap: "12px" }}>
                {renderToolButtons("reports")}
              </div>
            </>
          ) : null}

        </div>

        <div
          style={{
            ...(authenticated ? panelStyle : lockedPanelShellStyle),
            display: "flex",
            flexDirection: "column",
            ...(isMobile ? {} : { gridColumn: "2", gridRow: "1" }),
          }}
        >
          {authenticated ? (
            <>
              <div
                style={{
                  textAlign: "center",
                  fontSize: "12px",
                  letterSpacing: "0.16em",
                  textTransform: "uppercase",
                  color: "var(--fc-admin-heading)",
                  marginBottom: "10px",
                  fontWeight: 700,
                }}
              >
                Trading Tools
              </div>

              <div style={{ display: "grid", gap: "12px" }}>
                {renderToolButtons("trading")}
              </div>
            </>
          ) : null}
        </div>

        <div
          style={{
            ...(authenticated ? panelStyle : lockedPanelShellStyle),
            display: "flex",
            flexDirection: "column",
            ...(isMobile ? {} : { gridColumn: "4", gridRow: "1" }),
          }}
        >
          {authenticated ? (
            <>
              <div
                style={{
                  textAlign: "center",
                  fontSize: "12px",
                  letterSpacing: "0.16em",
                  textTransform: "uppercase",
                  color: "var(--fc-admin-heading)",
                  marginBottom: "10px",
                  fontWeight: 700,
                }}
              >
                Contact Tools
              </div>

              <div style={{ display: "grid", gap: "12px" }}>
                {renderToolButtons("contacts")}
              </div>
            </>
          ) : null}
        </div>

        <div
          style={{
            ...(authenticated ? panelStyle : lockedPanelShellStyle),
            display: "flex",
            flexDirection: "column",
            ...(isMobile ? {} : { gridColumn: "3", gridRow: "1" }),
          }}
        >
          {authenticated ? (
            <>
              <div
                style={{
                  textAlign: "center",
                  fontSize: "12px",
                  letterSpacing: "0.16em",
                  textTransform: "uppercase",
                  color: "var(--fc-admin-heading)",
                  marginBottom: "10px",
                  fontWeight: 700,
                }}
              >
                Office Tools
              </div>

              <div style={{ display: "grid", gap: "12px" }}>
                {renderToolButtons("office")}
              </div>
            </>
          ) : null}
        </div>

        <div
          style={{
            ...(authenticated ? panelStyle : lockedPanelShellStyle),
            display: "flex",
            flexDirection: "column",
            ...(isMobile ? {} : { gridColumn: "2", gridRow: "2" }),
          }}
        >
          {authenticated ? (
            <>
              <div
                style={{
                  textAlign: "center",
                  fontSize: "12px",
                  letterSpacing: "0.16em",
                  textTransform: "uppercase",
                  color: "var(--fc-admin-heading)",
                  marginBottom: "10px",
                  fontWeight: 700,
                }}
              >
                Management Tools
              </div>

              <div style={{ display: "grid", gap: "12px" }}>
                {renderToolButtons("management")}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
