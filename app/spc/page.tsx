"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { primeSpcClientSessionCache, useSpcAuth } from "@/lib/useSpcAuth"
import { SpcShell } from "@/components/SpcShell"

const HOLIDAY_MARKET_CODES = "IT HK MC FR US GR SG JP KR VN"

type SpcHoliday = {
  countryCode: string
  countryName: string
  date: string
  name: string
  localName: string | null
  daysUntil: number
}

type SpcDashboardWatchData = {
  holidays: {
    countries: string
    items: SpcHoliday[]
    error: string | null
  }
}

function dateFromKey(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map((part) => Number(part))
  return new Date(Date.UTC(year, month - 1, day))
}

function formatHolidayDate(dateKey: string) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    timeZone: "Asia/Hong_Kong",
  }).format(dateFromKey(dateKey))
}

function formatDaysUntil(daysUntil: number) {
  if (daysUntil === 0) return "Today"
  if (daysUntil === 1) return "Tomorrow"
  return `In ${daysUntil} days`
}

export default function SpcLoginPage() {
  const router = useRouter()
  const {
    loading,
    authenticated,
    displayName,
    username: sessionUsername,
    role,
    office,
    permissions,
    pages,
    mustChangePassword,
  } = useSpcAuth()
  const [loginUsername, setLoginUsername] = useState("")
  const [password, setPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState("")
  const [dashboardData, setDashboardData] = useState<SpcDashboardWatchData | null>(null)
  const [dashboardError, setDashboardError] = useState("")

  useEffect(() => {
    document.title = "Singapore Purchasing Center"
  }, [])

  useEffect(() => {
    if (!authenticated) return

    let cancelled = false
    setDashboardError("")

    fetch("/api/spc/dashboard-watch", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.message || "SPC dashboard watch unavailable.")
        return data as SpcDashboardWatchData
      })
      .then((data) => {
        if (!cancelled) setDashboardData(data)
      })
      .catch((error) => {
        if (!cancelled) {
          setDashboardError(error instanceof Error ? error.message : "SPC dashboard watch unavailable.")
        }
      })

    return () => {
      cancelled = true
    }
  }, [authenticated])

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setMessage("")

    const response = await fetch("/api/spc/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: loginUsername, password }),
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
      office: data.user?.office || null,
      mustChangePassword: data.user?.mustChangePassword === true,
      permissions: data.user?.permissions || {},
      pages: data.pages || [],
    })

    router.replace("/spc")
    router.refresh()
  }

  async function handlePasswordChange(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setMessage("")

    if (newPassword !== confirmPassword) {
      setMessage("Passwords do not match.")
      setSubmitting(false)
      return
    }

    try {
      const response = await fetch("/api/spc/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      })
      const data = (await response.json()) as {
        user?: {
          username?: string
          displayName?: string
          role?: string
          office?: string
          mustChangePassword?: boolean
          permissions?: Record<string, "none" | "view" | "edit">
        }
        message?: string
      }
      if (!response.ok || !data.user) throw new Error(data.message || "Failed to update password.")

      primeSpcClientSessionCache({
        authenticated: true,
        username: data.user.username || sessionUsername,
        displayName: data.user.displayName || displayName || sessionUsername,
        role: data.user.role || role,
        office: data.user.office || office,
        mustChangePassword: false,
        permissions: data.user.permissions || permissions,
        pages,
      })
      setNewPassword("")
      setConfirmPassword("")
      setMessage("")
      router.refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to update password.")
    } finally {
      setSubmitting(false)
    }
  }

  if (!loading && authenticated && mustChangePassword) {
    return (
      <SpcShell title="SPC Password Change">
        <section className="spc-password-change-page" aria-label="Change SPC password">
          <form onSubmit={handlePasswordChange} className="spc-password-change-panel">
            <h1>Change Password</h1>
            <label>
              <span>New Password</span>
              <input
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
            <label>
              <span>Confirm Password</span>
              <input
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
            {message ? <p className="spc-login-message">{message}</p> : null}
            <button type="submit" disabled={submitting}>
              {submitting ? "Saving..." : "Save Password"}
            </button>
          </form>
        </section>
      </SpcShell>
    )
  }

  if (!loading && authenticated) {
    return (
      <SpcShell title="SPC Welcome">
        <section className="fc-admin-welcome-page spc-welcome-page" aria-label="SPC welcome">
          <div className="fc-admin-welcome-content spc-welcome-content">
            <h1>WELCOME{displayName || sessionUsername ? `, ${displayName || sessionUsername}` : ""}</h1>
            <p className="spc-welcome-introduction">
              YOU ARE INVITED TO THE <Link href="/spc/readme">INTRODUCTION</Link>
            </p>

            <div className="fc-admin-dashboard-swatches spc-dashboard-swatches" aria-label="SPC dashboard watch">
              <section className="fc-admin-swatch-card is-holiday" aria-label="Upcoming public holidays">
                <div className="fc-admin-swatch-heading">
                  <div>
                    <span>Public Holidays</span>
                    <small>{dashboardData?.holidays.countries || HOLIDAY_MARKET_CODES}</small>
                  </div>
                </div>

                {dashboardError ? (
                  <p className="fc-admin-swatch-empty">{dashboardError}</p>
                ) : !dashboardData ? (
                  <p className="fc-admin-swatch-empty">Loading holiday watch...</p>
                ) : dashboardData.holidays.error ? (
                  <p className="fc-admin-swatch-empty">{dashboardData.holidays.error}</p>
                ) : dashboardData.holidays.items.length ? (
                  <div className="fc-admin-holiday-list spc-holiday-list">
                    {dashboardData.holidays.items.map((holiday) => (
                      <article
                        key={`${holiday.countryCode}-${holiday.date}-${holiday.name}`}
                        className="fc-admin-holiday-item"
                      >
                        <span className="fc-admin-holiday-code">{holiday.countryCode}</span>
                        <div>
                          <strong>{holiday.countryName}</strong>
                          <span>{holiday.name}</span>
                        </div>
                        <time dateTime={holiday.date}>
                          {formatHolidayDate(holiday.date)}
                          <span>{formatDaysUntil(holiday.daysUntil)}</span>
                        </time>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="fc-admin-swatch-empty">No upcoming public holidays found.</p>
                )}
              </section>

            </div>
          </div>
        </section>
      </SpcShell>
    )
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
                name="username"
                value={loginUsername}
                onChange={(event) => setLoginUsername(event.target.value)}
                autoComplete="username"
                aria-label="Username"
                autoCapitalize="none"
                spellCheck={false}
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
                name="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                aria-label="Password"
                autoCapitalize="none"
                spellCheck={false}
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
