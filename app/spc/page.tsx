"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { primeSpcClientSessionCache, useSpcAuth } from "@/lib/useSpcAuth"
import { getDefaultSpcLandingPath } from "@/lib/spcPages"

export default function SpcLoginPage() {
  const router = useRouter()
  const { loading, authenticated, permissions } = useSpcAuth()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState("")

  useEffect(() => {
    document.title = "Singapore Purchasing Center"
  }, [])

  useEffect(() => {
    if (!loading && authenticated) {
      router.replace(getDefaultSpcLandingPath(permissions))
    }
  }, [authenticated, loading, permissions, router])

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setMessage("")

    const response = await fetch("/api/spc/login", {
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

    primeSpcClientSessionCache({
      authenticated: true,
      username: data.user?.username || null,
      displayName: data.user?.displayName || data.user?.username || null,
      role: data.user?.role || null,
      permissions: data.user?.permissions || {},
      pages: data.pages || [],
    })

    router.replace(data.redirectTo || getDefaultSpcLandingPath(data.user?.permissions || {}))
    router.refresh()
  }

  return (
    <div className="spc-login-page">
      <section className="spc-login-card" aria-label="Singapore Purchasing Center login">
        <h1 className="sr-only">Singapore Purchasing Center</h1>

        <form onSubmit={handleLogin} className="spc-login-form">
          <label className="spc-login-field">
            <span className="spc-login-hidden-label">Username</span>
            <span className="spc-input-wrap">
              <span className="spc-field-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
                  <path d="M4.5 21c.9-4.6 3.4-7 7.5-7s6.6 2.4 7.5 7" />
                </svg>
              </span>
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                aria-label="Username"
                required
              />
            </span>
          </label>

          <label className="spc-login-field">
            <span className="spc-login-hidden-label">Password</span>
            <span className="spc-password-wrap">
              <span className="spc-field-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M7 10V8a5 5 0 0 1 10 0v2" />
                  <path d="M6 10h12v10H6V10Z" />
                  <path d="M12 14.2v2.6" />
                </svg>
              </span>
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                aria-label="Password"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((current) => !current)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                title={showPassword ? "Hide password" : "Show password"}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3.5 12s3-5 8.5-5 8.5 5 8.5 5-3 5-8.5 5-8.5-5-8.5-5Z" />
                  <circle cx="12" cy="12" r="2.6" />
                </svg>
              </button>
            </span>
          </label>

          <button type="submit" disabled={submitting || loading} className="spc-login-submit">
            {submitting ? "Signing In" : "Log In"}
          </button>

          {message ? <p className="spc-login-message">{message}</p> : null}
        </form>
      </section>
    </div>
  )
}
