"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
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
  fontFamily: "Arial, Helvetica, sans-serif",
}

const shellStyle: React.CSSProperties = {
  width: "min(1760px, 100%)",
  display: "grid",
  gridTemplateColumns: "1.05fr repeat(4, 1fr)",
  gap: "18px",
}

const panelStyle: React.CSSProperties = {
  borderRadius: "28px",
  padding: "30px",
  background: "var(--fc-admin-panel-bg)",
  border: "1px solid var(--fc-admin-border)",
  backdropFilter: "blur(18px)",
  WebkitBackdropFilter: "blur(18px)",
  boxShadow: "0 30px 96px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 1px rgba(90,169,255,0.06)",
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
  boxShadow: "0 12px 28px rgba(4,16,29,0.12), inset 0 1px 0 rgba(255,255,255,0.7)",
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
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 12px 28px rgba(8,24,44,0.18), 0 0 0 1px rgba(90,169,255,0.08)",
}

const mutedTradingButtonStyle: React.CSSProperties = {
  ...actionButtonStyle,
  background: "linear-gradient(180deg, rgba(134, 141, 151, 0.22) 0%, rgba(72, 78, 88, 0.12) 100%)",
  color: "#bcc5ce",
  borderColor: "rgba(190, 198, 208, 0.18)",
  boxShadow: "0 18px 40px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.05), 0 0 0 1px rgba(180,190,200,0.06)",
}

const lockedPanelShellStyle: React.CSSProperties = {
  ...panelStyle,
  background: "var(--fc-admin-panel-soft-bg)",
  border: "1px solid var(--fc-admin-border-soft)",
  boxShadow: "0 30px 96px rgba(0, 0, 0, 0.26), inset 0 1px 0 rgba(255,255,255,0.04)",
}

export default function AdminPage() {
  const isMobile = useIsMobile()
  const router = useRouter()
  const { loading, authenticated } = useSimpleAdminAuth()
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

    window.location.reload()
  }

  async function handleLogout() {
    await fetch("/api/admin/logout", {
      method: "POST",
    })

    window.location.reload()
  }

  if (loading) return <p style={{ padding: "40px" }}>Loading...</p>

  return (
    <div style={pageStyle}>
      <div
        style={{
          ...shellStyle,
          gridTemplateColumns: isMobile ? "1fr" : shellStyle.gridTemplateColumns,
          gap: isMobile ? "14px" : "18px",
        }}
      >
        <form onSubmit={handleLogin} style={panelStyle}>
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
                  textShadow: "0 10px 24px rgba(4,16,29,0.22)",
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
                  textShadow: "0 10px 24px rgba(4,16,29,0.22)",
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
              {authenticated ? (
                <button
                  type="button"
                  onClick={handleLogout}
                style={{
                  width: "100%",
                  padding: "14px 16px",
                  border: "1px solid rgba(255, 120, 120, 0.28)",
                  borderRadius: "999px",
                  background: "linear-gradient(180deg, rgba(230, 57, 70, 0.24) 0%, rgba(170, 47, 53, 0.12) 100%)",
                  color: "#ffd6db",
                  cursor: "pointer",
                  fontSize: "15px",
                  fontWeight: 800,
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.12), inset 0 0 18px rgba(230,57,70,0.08), 0 16px 34px rgba(0,0,0,0.16)",
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
                  border: "1px solid rgba(73, 219, 165, 0.34)",
                  borderRadius: "999px",
                  background: "linear-gradient(180deg, rgba(56, 214, 154, 0.34) 0%, rgba(20, 130, 93, 0.16) 100%)",
                  color: "#eafff4",
                  cursor: "pointer",
                  fontSize: "15px",
                  fontWeight: 800,
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14), inset 0 0 18px rgba(37,211,102,0.08), 0 18px 38px rgba(0,0,0,0.16)",
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
                  border: "1px solid rgba(210,236,255,0.16)",
                  borderRadius: "999px",
                  background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)",
                  color: "var(--fc-admin-button-text)",
                  cursor: "pointer",
                  fontSize: "14px",
                  fontWeight: 700,
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
                }}
              >
                Back To Bunker Map
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
                {[
                  { label: "CHINA AND COMPACT", path: "/admin/pricesetter" },
                  { label: "HONG KONG", path: "/admin/hongkongpricehistory" },
                  { label: "TAIWAN", path: "/admin/taiwanpricehistory" },
                  { label: "TAIWAN REMARKS", path: "/admin/taiwanremarks" },
                ].map((item) => (
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
                      boxShadow: "0 18px 40px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 1px rgba(90,169,255,0.1)",
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </>
          ) : null}

        </div>

        <div
          style={{
            ...(authenticated ? panelStyle : lockedPanelShellStyle),
            display: "flex",
            flexDirection: "column",
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
                {[{ label: "COUNTRY AND COMPANY INFO", path: "/admin/ccinfo" }].map((item) => (
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
                      boxShadow: "0 18px 40px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 1px rgba(90,169,255,0.1)",
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>

        <div
          style={{
            ...(authenticated ? panelStyle : lockedPanelShellStyle),
            display: "flex",
            flexDirection: "column",
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
                {[
                  { label: "PHONEBOOK", path: "/admin/phonebook" },
                  { label: "OUTLOOK ADDRESS BOOK", path: "/admin/outlookaddressbook" },
                  { label: "EMAIL TEMPLATES", path: "/admin/emailtemplates" },
                ].map((item) => (
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
                      boxShadow: "0 18px 40px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 1px rgba(90,169,255,0.1)",
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>

        <div
          style={{
            ...(authenticated ? panelStyle : lockedPanelShellStyle),
            display: "flex",
            flexDirection: "column",
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
                {[
                  { label: "EVENT CALENDAR", path: "/admin/eventcalendar" },
                  { label: "TASK CALENDAR", path: "/admin/taskcalendar" },
                ].map((item) => (
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
                      boxShadow: "0 18px 40px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 1px rgba(90,169,255,0.1)",
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
