"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { primeSpcClientSessionCache, useSpcAuth } from "@/lib/useSpcAuth"
import { SpcShell } from "@/components/SpcShell"

const HOLIDAY_MARKET_CODES = "IT HK MC FR US GR SG"

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

function SpcOilWidget() {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    container.innerHTML = ""

    const timer = window.setTimeout(() => {
      const widgetHost = document.createElement("div")
      widgetHost.className = "tradingview-widget-container__widget"
      widgetHost.style.height = "216px"
      widgetHost.style.width = "100%"

      const script = document.createElement("script")
      script.src = "https://s3.tradingview.com/external-embedding/embed-widget-market-overview.js"
      script.type = "text/javascript"
      script.async = true
      script.innerHTML = JSON.stringify({
        colorTheme: "light",
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
        gridLineColor: "rgba(29, 29, 31, 0.08)",
        scaleFontColor: "rgba(29, 29, 31, 0.72)",
        belowLineFillColorGrowing: "rgba(0, 113, 227, 0.12)",
        belowLineFillColorFalling: "rgba(0, 113, 227, 0.08)",
        belowLineFillColorGrowingBottom: "rgba(0, 113, 227, 0.01)",
        belowLineFillColorFallingBottom: "rgba(0, 113, 227, 0.01)",
        symbolActiveColor: "rgba(0, 113, 227, 0.12)",
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
    }, 0)

    return () => {
      window.clearTimeout(timer)
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

export default function SpcLoginPage() {
  const router = useRouter()
  const { loading, authenticated, displayName, username: sessionUsername } = useSpcAuth()
  const [loginUsername, setLoginUsername] = useState("")
  const [password, setPassword] = useState("")
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
      permissions: data.user?.permissions || {},
      pages: data.pages || [],
    })

    router.replace("/spc")
    router.refresh()
  }

  if (!loading && authenticated) {
    return (
      <SpcShell title="SPC Welcome">
        <section className="fc-admin-welcome-page spc-welcome-page" aria-label="SPC welcome">
          <div className="fc-admin-welcome-content spc-welcome-content">
            <h1>Welcome{displayName || sessionUsername ? `, ${displayName || sessionUsername}` : ""}</h1>

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

              <section className="fc-admin-swatch-card is-crude" aria-label="Current crude market">
                <div className="fc-admin-swatch-heading">
                  <span>Crude Watch</span>
                  <strong>Brent / WTI</strong>
                </div>
                <SpcOilWidget />
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
                value={loginUsername}
                onChange={(event) => setLoginUsername(event.target.value)}
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
