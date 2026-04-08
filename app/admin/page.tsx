"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { useIsMobile } from "@/lib/useIsMobile"

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  padding: "24px",
  background:
    "radial-gradient(circle at top, #114a80 0%, #0a2c4c 34%, #041629 100%)",
  fontFamily: "Arial, Helvetica, sans-serif",
}

const shellStyle: React.CSSProperties = {
  width: "min(1320px, 100%)",
  display: "grid",
  gridTemplateColumns: "1.05fr 1fr 0.9fr",
  gap: "18px",
}

const panelStyle: React.CSSProperties = {
  borderRadius: "28px",
  padding: "30px",
  background: "rgba(6, 24, 44, 0.68)",
  border: "1px solid rgba(210, 236, 255, 0.16)",
  backdropFilter: "blur(18px)",
  WebkitBackdropFilter: "blur(18px)",
  boxShadow: "0 24px 80px rgba(0, 0, 0, 0.24)",
  color: "#edf7ff",
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  border: "1px solid rgba(173, 216, 255, 0.2)",
  borderRadius: "14px",
  fontSize: "15px",
  background: "rgba(255,255,255,0.92)",
  color: "#10243a",
  outline: "none",
}

const actionButtonStyle: React.CSSProperties = {
  width: "100%",
  padding: "15px 16px",
  border: "1px solid rgba(173, 216, 255, 0.18)",
  borderRadius: "18px",
  background: "rgba(255,255,255,0.08)",
  color: "#edf7ff",
  cursor: "pointer",
  fontSize: "15px",
  fontWeight: 700,
  textAlign: "left",
  transition: "transform 0.16s ease, background 0.16s ease, border-color 0.16s ease",
}

export default function AdminPage() {
  const isMobile = useIsMobile()
  const router = useRouter()
  const { loading, authenticated } = useSimpleAdminAuth()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState("")

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
              <img
                src="/logo-trans.png"
                alt="Bunker Map"
                style={{ height: isMobile ? "68px" : "86px", width: "auto" }}
              />
            </div>

            <div
              style={{
                textAlign: "center",
                fontSize: "12px",
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                color: "#8fd7ff",
                marginBottom: "10px",
                fontWeight: 700,
              }}
            >
              Admin Access
            </div>

            <h1
              style={{
                margin: "0 0 24px",
                textAlign: "center",
                fontSize: isMobile ? "26px" : "32px",
                lineHeight: 1,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
              }}
            >
              Login
            </h1>

            <label style={{ display: "block", marginBottom: 16 }}>
              <div style={{ marginBottom: 8, fontWeight: 700, color: "#d8edff" }}>Username</div>
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                style={inputStyle}
              />
            </label>

            <label style={{ display: "block", marginBottom: 20 }}>
              <div style={{ marginBottom: 8, fontWeight: 700, color: "#d8edff" }}>Password</div>
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
                    border: "none",
                    borderRadius: "16px",
                    background: "linear-gradient(135deg, #1f7acb 0%, #0a4f87 100%)",
                    color: "white",
                    cursor: "pointer",
                    fontSize: "15px",
                    fontWeight: 800,
                    boxShadow: "0 14px 34px rgba(16, 97, 166, 0.28)",
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
                    border: "none",
                    borderRadius: "16px",
                    background: "linear-gradient(135deg, #1f7acb 0%, #0a4f87 100%)",
                    color: "white",
                    cursor: "pointer",
                    fontSize: "15px",
                    fontWeight: 800,
                    boxShadow: "0 14px 34px rgba(16, 97, 166, 0.28)",
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
                  padding: "13px 16px",
                  border: "1px solid rgba(255,255,255,0.14)",
                  borderRadius: "16px",
                  background: "rgba(255,255,255,0.08)",
                  color: "#edf7ff",
                  cursor: "pointer",
                  fontSize: "15px",
                  fontWeight: 700,
                }}
              >
                Back To Bunker Map
              </button>

              {message && (
                <p style={{ marginBottom: 0, marginTop: 16, color: "#ff8e8e", fontWeight: 700 }}>
                  {message}
                </p>
              )}
            </div>
          </div>
        </form>

        <div
          style={{
            ...panelStyle,
            background: authenticated ? panelStyle.background : "rgba(34, 40, 48, 0.78)",
            border: authenticated
              ? panelStyle.border
              : "1px solid rgba(255,255,255,0.08)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              textAlign: "center",
              fontSize: "12px",
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: authenticated ? "#8fd7ff" : "#8f98a2",
              marginBottom: "10px",
              fontWeight: 700,
            }}
          >
            Report Tools
          </div>

          <div style={{ display: "grid", gap: "12px" }}>
            {[
              { label: "Price Setter", path: "/admin/pricesetter" },
              { label: "Taiwan Price History", path: "/admin/taiwanpricehistory" },
              { label: "Hong Kong Price History", path: "/admin/hongkongpricehistory" },
              { label: "Taiwan Market Report Remarks", path: "/admin/taiwanremarks" },
            ].map((item) => (
              <button
                key={item.label}
                onClick={() => authenticated && router.push(item.path)}
                disabled={!authenticated}
                style={{
                  ...actionButtonStyle,
                  padding: isMobile ? "13px 14px" : actionButtonStyle.padding,
                  background: authenticated ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)",
                  color: authenticated ? "#edf7ff" : "transparent",
                  borderColor: authenticated ? "rgba(173, 216, 255, 0.18)" : "rgba(255,255,255,0.06)",
                  cursor: authenticated ? "pointer" : "default",
                  boxShadow: authenticated ? "0 10px 24px rgba(0,0,0,0.14)" : "none",
                }}
              >
                <span style={{ filter: authenticated ? "none" : "blur(7px)" }}>
                  {item.label}
                </span>
              </button>
            ))}
          </div>

        </div>

        <div
          style={{
            ...panelStyle,
            background: authenticated ? panelStyle.background : "rgba(34, 40, 48, 0.78)",
            border: authenticated
              ? panelStyle.border
              : "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <div
            style={{
              textAlign: "center",
              fontSize: "12px",
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: authenticated ? "#8fd7ff" : "#8f98a2",
              marginBottom: "10px",
              fontWeight: 700,
            }}
          >
            Market Reports
          </div>

          <div style={{ display: "grid", gap: "12px" }}>
            {[
              { label: "Taiwan Market Report", path: "/reports/taiwan?preview=1" },
              { label: "Hong Kong Market Report", path: "/reports/hongkong?preview=1" },
              { label: "China Market Report", path: "/reports/china?preview=1" },
              { label: "Compact Market Report", path: "/reports/compact?preview=1" },
            ].map((item) => (
              <button
                key={item.label}
                onClick={() => authenticated && router.push(item.path)}
                disabled={!authenticated}
                style={{
                  ...actionButtonStyle,
                  padding: isMobile ? "13px 14px" : actionButtonStyle.padding,
                  background: authenticated ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)",
                  color: authenticated ? "#edf7ff" : "transparent",
                  borderColor: authenticated ? "rgba(173, 216, 255, 0.18)" : "rgba(255,255,255,0.06)",
                  cursor: authenticated ? "pointer" : "default",
                  boxShadow: authenticated ? "0 10px 24px rgba(0,0,0,0.14)" : "none",
                }}
              >
                <span style={{ filter: authenticated ? "none" : "blur(7px)" }}>
                  {item.label}
                </span>
              </button>
            ))}
          </div>

        </div>
      </div>
    </div>
  )
}
