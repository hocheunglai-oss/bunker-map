"use client"

import Image from "next/image"
import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

type AdminHoliday = {
  countryCode: string
  countryName: string
  date: string
  name: string
  localName: string | null
  daysUntil: number
}

type AdminTyphoonStorm = {
  id: string
  name: string
  chineseName: string | null
  bulletinTime: string | null
  trackUrl: string | null
  latest: {
    intensity: string | null
    maximumWind: string | null
    time: string | null
    latitude: string | null
    longitude: string | null
  }
}

type AdminDashboardData = {
  holidays: {
    fromDate: string
    toDate: string
    windowDays: number
    items: AdminHoliday[]
    error: string | null
  }
  typhoon: {
    activeCount: number
    warning: {
      name: string
      code: string
      actionCode: string | null
      issueTime: string | null
      updateTime: string | null
    } | null
    storms: AdminTyphoonStorm[]
    sourceRegion: string
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

function formatShortDateTime(value: string | null) {
  if (!value) return null

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Hong_Kong",
  }).format(new Date(value))
}

function formatDaysUntil(daysUntil: number) {
  if (daysUntil === 0) return "Today"
  if (daysUntil === 1) return "Tomorrow"
  return `In ${daysUntil} days`
}

function AdminOilWidget() {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    container.innerHTML = ""

    const widgetHost = document.createElement("div")
    widgetHost.className = "tradingview-widget-container__widget"
    widgetHost.style.height = "216px"
    widgetHost.style.width = "100%"

    const script = document.createElement("script")
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-market-overview.js"
    script.type = "text/javascript"
    script.async = true
    script.innerHTML = JSON.stringify({
      colorTheme: "dark",
      dateRange: "1D",
      showChart: true,
      locale: "en",
      width: "100%",
      height: 216,
      largeChartUrl: "",
      isTransparent: true,
      showSymbolLogo: false,
      showFloatingTooltip: false,
      plotLineColorGrowing: "rgba(41, 98, 255, 1)",
      plotLineColorFalling: "rgba(41, 98, 255, 1)",
      gridLineColor: "rgba(255, 255, 255, 0.08)",
      scaleFontColor: "rgba(237, 247, 255, 0.78)",
      belowLineFillColorGrowing: "rgba(30, 144, 255, 0.18)",
      belowLineFillColorFalling: "rgba(30, 144, 255, 0.12)",
      belowLineFillColorGrowingBottom: "rgba(30, 144, 255, 0.01)",
      belowLineFillColorFallingBottom: "rgba(30, 144, 255, 0.01)",
      symbolActiveColor: "rgba(143, 215, 255, 0.18)",
      tabs: [
        {
          title: "Energy",
          symbols: [
            { s: "TVC:UKOIL", d: "Brent" },
            { s: "TVC:USOIL", d: "WTI / Nymex" },
          ],
        },
      ],
    })

    container.appendChild(widgetHost)
    container.appendChild(script)

    return () => {
      container.innerHTML = ""
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className="fc-admin-crude-widget tradingview-widget-container"
      aria-label="Current crude market overview"
    />
  )
}

export default function AdminPage() {
  const { loading, authenticated, displayName } = useSimpleAdminAuth()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState("")
  const [dashboardData, setDashboardData] = useState<AdminDashboardData | null>(null)
  const [dashboardError, setDashboardError] = useState("")

  useEffect(() => {
    document.title = "Admin - FC Uno"
  }, [])

  useEffect(() => {
    if (!authenticated) return

    let cancelled = false

    setDashboardError("")

    fetch("/api/admin/dashboard-swatches", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json()

        if (!response.ok) {
          throw new Error(data.message || "Dashboard data unavailable.")
        }

        return data as AdminDashboardData
      })
      .then((data) => {
        if (!cancelled) setDashboardData(data)
      })
      .catch((error) => {
        if (!cancelled) {
          setDashboardError(error instanceof Error ? error.message : "Dashboard data unavailable.")
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

          <div className="fc-admin-dashboard-swatches" aria-label="Admin dashboard watch">
            <section className="fc-admin-swatch-card is-holiday" aria-label="Upcoming holidays">
              <div className="fc-admin-swatch-heading">
                <span>Public Holidays</span>
                <strong>Next 3 days</strong>
              </div>

              {dashboardError ? (
                <p className="fc-admin-swatch-empty">{dashboardError}</p>
              ) : !dashboardData ? (
                <p className="fc-admin-swatch-empty">Loading holiday watch...</p>
              ) : dashboardData.holidays.error ? (
                <p className="fc-admin-swatch-empty">{dashboardData.holidays.error}</p>
              ) : dashboardData.holidays.items.length ? (
                <div className="fc-admin-holiday-list">
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
                <p className="fc-admin-swatch-empty">
                  No public holidays in the selected markets over the next 3 days.
                </p>
              )}
            </section>

            <section className="fc-admin-swatch-card is-typhoon" aria-label="Asia typhoon watch">
              <div className="fc-admin-swatch-heading">
                <span>Asia Typhoon Watch</span>
                <strong>
                  {dashboardData ? `${dashboardData.typhoon.activeCount} active` : "Loading"}
                </strong>
              </div>

              {dashboardError ? (
                <p className="fc-admin-swatch-empty">{dashboardError}</p>
              ) : !dashboardData ? (
                <p className="fc-admin-swatch-empty">Loading HKO live track...</p>
              ) : dashboardData.typhoon.error ? (
                <p className="fc-admin-swatch-empty">{dashboardData.typhoon.error}</p>
              ) : (
                <>
                  {dashboardData.typhoon.warning ? (
                    <div className="fc-admin-typhoon-warning">
                      {dashboardData.typhoon.warning.name}
                    </div>
                  ) : null}

                  {dashboardData.typhoon.storms.length ? (
                    <div className="fc-admin-typhoon-list">
                      {dashboardData.typhoon.storms.map((storm) => (
                        <article key={storm.id || storm.name} className="fc-admin-typhoon-item">
                          <div>
                            <strong>{storm.name}</strong>
                            <span>{storm.latest.intensity || "Track active"}</span>
                          </div>
                          <dl>
                            <div>
                              <dt>Wind</dt>
                              <dd>{storm.latest.maximumWind || "--"}</dd>
                            </div>
                            <div>
                              <dt>Position</dt>
                              <dd>
                                {[storm.latest.latitude, storm.latest.longitude]
                                  .filter(Boolean)
                                  .join(", ") || "--"}
                              </dd>
                            </div>
                            <div>
                              <dt>Updated</dt>
                              <dd>
                                {formatShortDateTime(storm.bulletinTime || storm.latest.time) ||
                                  "--"}
                              </dd>
                            </div>
                          </dl>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="fc-admin-swatch-empty">
                      No HKO-listed tropical cyclones in the Western North Pacific or South China Sea.
                    </p>
                  )}
                </>
              )}
            </section>

            <section className="fc-admin-swatch-card is-crude" aria-label="Current crude market">
              <div className="fc-admin-swatch-heading">
                <span>Crude Watch</span>
                <strong>Brent / WTI</strong>
              </div>
              <AdminOilWidget />
            </section>
          </div>
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
          Back
        </Link>
      </section>
    </div>
  )
}
