"use client"

import Image from "next/image"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useSpcAuth } from "@/lib/useSpcAuth"

export default function SpcLoginPage() {
  const router = useRouter()
  const { loading, authenticated, role } = useSpcAuth()
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
      router.replace(role === "supplier_trader" ? "/spc/supplier" : "/spc/buyer")
    }
  }, [authenticated, loading, role, router])

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

    if (data.user?.username) {
      window.localStorage.setItem(
        "spc_actor",
        JSON.stringify({
          username: data.user.username,
          displayName: data.user.displayName || data.user.username,
          role: data.user.role || null,
        }),
      )
    }

    router.replace(data.user?.role === "supplier_trader" ? "/spc/supplier" : "/spc/buyer")
    router.refresh()
  }

  return (
    <div className="spc-login-page">
      <section className="spc-login-card" aria-label="Singapore Purchasing Center login">
        <div className="spc-skyline" aria-hidden="true">
          <span />
        </div>

        <Image
          src="/logo.png"
          alt="Fratelli Cosulich"
          className="spc-login-logo"
          width={968}
          height={440}
          priority
        />

        <div className="spc-login-title">
          <h1>Singapore</h1>
          <p>Purchasing Center</p>
        </div>

        <form onSubmit={handleLogin} className="spc-login-form">
          <label className="spc-login-field">
            <span>Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              placeholder="Enter your username"
              required
            />
          </label>

          <label className="spc-login-field">
            <span>Password</span>
            <span className="spc-password-wrap">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                placeholder="Enter your password"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((current) => !current)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                title={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? "Hide" : "Show"}
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
