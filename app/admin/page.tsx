"use client"

import Image from "next/image"
import Link from "next/link"
import { useEffect, useState } from "react"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

export default function AdminPage() {
  const { loading, authenticated, displayName } = useSimpleAdminAuth()
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
          pages: data.user.pages || [],
        }),
      )
    }

    window.location.reload()
  }

  if (loading) {
    return (
      <div className="fc-admin-login-page">
        <div className="fc-admin-loading">Loading...</div>
      </div>
    )
  }

  if (authenticated) {
    return (
      <section className="fc-admin-welcome-page">
        <div className="fc-admin-welcome-content">
          <h1>Welcome{displayName ? `, ${displayName}` : ""}</h1>
          <p className="fc-admin-welcome-message">
            What would you like to work on?
          </p>
        </div>
      </section>
    )
  }

  return (
    <div className="fc-admin-login-page">
      <section className="fc-admin-login-panel" aria-label="Sign in">
        <Link href="/" className="fc-admin-logo-link">
          <Image
            src="/uno-logo.png"
            alt="UNO"
            className="fc-admin-login-logo"
            width={636}
            height={636}
            priority
          />
        </Link>

        <form onSubmit={handleLogin} className="fc-admin-login-form">
          <label className="fc-admin-auth-field">
            <span>Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              className="fc-admin-auth-input"
              required
            />
          </label>

          <label className="fc-admin-auth-field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              className="fc-admin-auth-input"
              required
            />
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="fc-admin-auth-button fc-admin-auth-button-primary"
          >
            {submitting ? "Signing in..." : "Login"}
          </button>

          {message ? <p className="fc-admin-auth-message">{message}</p> : null}
        </form>

        <Link href="/" className="fc-admin-login-back">
          Back to map
        </Link>
      </section>
    </div>
  )
}
