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
  gridTemplateColumns: "1.05fr 1fr 1fr",
  gap: "18px",
}

const panelStyle: React.CSSProperties = {
  borderRadius: "28px",
  padding: "30px",
  background:
    "radial-gradient(circle at top left, rgba(88, 182, 255, 0.22), transparent 34%), linear-gradient(180deg, rgba(6, 24, 44, 0.9) 0%, rgba(7, 27, 49, 0.82) 100%)",
  border: "1px solid rgba(210, 236, 255, 0.24)",
  backdropFilter: "blur(18px)",
  WebkitBackdropFilter: "blur(18px)",
  boxShadow: "0 30px 96px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 1px rgba(90,169,255,0.06)",
  color: "#edf7ff",
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  border: "1px solid rgba(210,236,255,0.16)",
  borderRadius: "14px",
  fontSize: "15px",
  background: "linear-gradient(180deg, rgba(246,251,255,0.98) 0%, rgba(232,243,252,0.95) 100%)",
  color: "#10243a",
  outline: "none",
  boxShadow: "0 12px 28px rgba(4,16,29,0.12), inset 0 1px 0 rgba(255,255,255,0.7)",
}

const actionButtonStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 16px",
  border: "1px solid rgba(210,236,255,0.18)",
  borderRadius: "999px",
  background: "linear-gradient(180deg, rgba(82, 153, 230, 0.22) 0%, rgba(25, 79, 140, 0.12) 100%)",
  color: "#d9eeff",
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
                  color: "#d7e8ff",
                  cursor: "pointer",
                  fontSize: "14px",
                  fontWeight: 700,
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
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
            background: authenticated
              ? panelStyle.background
              : "linear-gradient(180deg, rgba(28, 38, 50, 0.9) 0%, rgba(20, 28, 38, 0.84) 100%)",
            border: authenticated
              ? panelStyle.border
              : "1px solid rgba(255,255,255,0.12)",
            display: "flex",
            flexDirection: "column",
            boxShadow: authenticated
              ? panelStyle.boxShadow
              : "0 30px 96px rgba(0, 0, 0, 0.26), inset 0 1px 0 rgba(255,255,255,0.04)",
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
              { label: "CHINA AND COMPACT", path: "/admin/pricesetter" },
              { label: "HONG KONG", path: "/admin/hongkongpricehistory" },
              { label: "TAIWAN", path: "/admin/taiwanpricehistory" },
              { label: "TAIWAN REMARKS", path: "/admin/taiwanremarks" },
            ].map((item) => (
              <button
                key={item.label}
                onClick={() => authenticated && router.push(item.path)}
                disabled={!authenticated}
                style={{
                  ...actionButtonStyle,
                  padding: isMobile ? "13px 14px" : actionButtonStyle.padding,
                  background: authenticated
                    ? "linear-gradient(180deg, rgba(82, 153, 230, 0.24) 0%, rgba(25, 79, 140, 0.14) 100%)"
                    : "linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.03) 100%)",
                  color: authenticated ? "#d9eeff" : "transparent",
                  borderColor: authenticated ? "rgba(120, 188, 255, 0.26)" : "rgba(255,255,255,0.08)",
                  cursor: authenticated ? "pointer" : "default",
                  boxShadow: authenticated
                    ? "0 18px 40px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 1px rgba(90,169,255,0.1)"
                    : "none",
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
            background: "linear-gradient(180deg, rgba(58, 64, 72, 0.9) 0%, rgba(35, 39, 46, 0.86) 100%)",
            border: "1px solid rgba(255,255,255,0.12)",
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 30px 96px rgba(0, 0, 0, 0.26), inset 0 1px 0 rgba(255,255,255,0.04)",
          }}
        >
          <div
            style={{
              textAlign: "center",
              fontSize: "12px",
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: "#c0c6cd",
              marginBottom: "10px",
              fontWeight: 700,
            }}
          >
            Trading Tools
          </div>

          <div style={{ display: "grid", gap: "12px" }}>
            {[
              { label: "ENQUIRY WORKFLOW", path: "/admin/enqworkflow" },
              { label: "COUNTRY AND COMPANY INFO", path: "/admin/ccinfo" },
              { label: "PHONEBOOK", path: "/admin/phonebook" },
            ].map((item) => (
              <button
                key={item.label}
                onClick={() => authenticated && router.push(item.path)}
                disabled={!authenticated}
                style={{
                  ...mutedTradingButtonStyle,
                  padding: isMobile ? "13px 14px" : actionButtonStyle.padding,
                  background: authenticated
                    ? mutedTradingButtonStyle.background
                    : "linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.03) 100%)",
                  color: authenticated ? mutedTradingButtonStyle.color : "transparent",
                  borderColor: authenticated ? mutedTradingButtonStyle.borderColor : "rgba(255,255,255,0.08)",
                  cursor: authenticated ? "pointer" : "default",
                  boxShadow: authenticated
                    ? mutedTradingButtonStyle.boxShadow
                    : "none",
                }}
              >
                <span
                  style={{
                    filter: authenticated ? "none" : "blur(7px)",
                  }}
                >
                  {item.label}
                </span>
              </button>
            ))}
          </div>

          <div
            style={{
              marginTop: "12px",
              textAlign: "center",
              color: "#b7bdc4",
              fontSize: "12px",
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              fontWeight: 700,
            }}
          >
            Under Construction
          </div>
        </div>
      </div>
    </div>
  )
}
