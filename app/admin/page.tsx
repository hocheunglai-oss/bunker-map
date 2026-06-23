"use client"

import Image from "next/image"
import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import {
  ADMIN_FOLDER_THEME_EVENT,
  ADMIN_FOLDER_THEME_KEY,
  ADMIN_FOLDER_THEME_OPTIONS,
  normaliseAdminFolderThemeId,
  type AdminFolderThemeId,
} from "@/lib/adminFolderTones"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

const HOLIDAY_MARKET_CODES = "HK CN SG KR JP VN US"
const HKO_TROPICAL_CYCLONE_MAP_URL = "https://www.hko.gov.hk/en/wxinfo/currwx/tc_gis.htm"
const TYPHOON_MAP_BOUNDS = {
  minLat: 7,
  maxLat: 36,
  minLon: 100,
  maxLon: 140,
}

type AdminHoliday = {
  countryCode: string
  countryName: string
  date: string
  name: string
  localName: string | null
  daysUntil: number
}

type AdminTrackPoint = {
  kind: "past" | "analysis" | "forecast"
  intensity: string | null
  maximumWind: string | null
  time: string | null
  latitude: string | null
  longitude: string | null
  lat: number | null
  lon: number | null
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
  trackPoints: AdminTrackPoint[]
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

function getTyphoonGrade(intensity: string | null) {
  const normalized = (intensity || "").toLowerCase()

  if (normalized.includes("super typhoon")) {
    return { label: "Super Typhoon", color: "#8b1a79", className: "is-super-typhoon" }
  }
  if (normalized.includes("severe typhoon")) {
    return { label: "Severe Typhoon", color: "#f48ac8", className: "is-severe-typhoon" }
  }
  if (normalized === "typhoon" || normalized.includes(" typhoon")) {
    return { label: "Typhoon", color: "#ff1f2d", className: "is-typhoon" }
  }
  if (normalized.includes("severe tropical storm")) {
    return { label: "Severe Tropical Storm", color: "#174cff", className: "is-severe-storm" }
  }
  if (normalized.includes("tropical storm")) {
    return { label: "Tropical Storm", color: "#00a640", className: "is-tropical-storm" }
  }
  if (normalized.includes("tropical depression")) {
    return { label: "Tropical Depression", color: "#111111", className: "is-depression" }
  }

  return { label: intensity || "Track active", color: "#8a8f98", className: "is-low" }
}

function projectTyphoonPoint(point: AdminTrackPoint) {
  if (typeof point.lat !== "number" || typeof point.lon !== "number") return null

  const x =
    ((point.lon - TYPHOON_MAP_BOUNDS.minLon) /
      (TYPHOON_MAP_BOUNDS.maxLon - TYPHOON_MAP_BOUNDS.minLon)) *
    100
  const y =
    ((TYPHOON_MAP_BOUNDS.maxLat - point.lat) /
      (TYPHOON_MAP_BOUNDS.maxLat - TYPHOON_MAP_BOUNDS.minLat)) *
    70

  return {
    ...point,
    x: Math.max(0, Math.min(100, x)),
    y: Math.max(0, Math.min(70, y)),
  }
}

function toPolyline(points: Array<ReturnType<typeof projectTyphoonPoint>>) {
  return points
    .filter((point): point is NonNullable<typeof point> => Boolean(point))
    .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ")
}

function typhoonStyle(color: string) {
  return { "--tc-grade-color": color } as React.CSSProperties & {
    "--tc-grade-color": string
  }
}

function AdminTyphoonMapModal({
  storm,
  onClose,
}: {
  storm: AdminTyphoonStorm
  onClose: () => void
}) {
  const grade = getTyphoonGrade(storm.latest.intensity)
  const projectedPoints = (storm.trackPoints || [])
    .map(projectTyphoonPoint)
    .filter((point): point is NonNullable<typeof point> => Boolean(point))
  const pastPoints = projectedPoints.filter(
    (point) => point.kind === "past" || point.kind === "analysis",
  )
  const forecastPoints = projectedPoints.filter((point) => point.kind === "forecast")
  const currentPoint =
    [...projectedPoints].reverse().find((point) => point.kind === "analysis") ||
    [...pastPoints].reverse()[0] ||
    projectedPoints[0]

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }

    document.addEventListener("keydown", closeOnEscape)
    return () => document.removeEventListener("keydown", closeOnEscape)
  }, [onClose])

  return (
    <div className="fc-admin-typhoon-map-backdrop" onClick={onClose}>
      <section
        className="fc-admin-typhoon-map-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${storm.name} typhoon map`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="fc-admin-typhoon-map-header">
          <div>
            <span>Asia Typhoon Watch</span>
            <h2>{storm.name}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close typhoon map">
            x
          </button>
        </div>

        <div className="fc-admin-typhoon-map-body" style={typhoonStyle(grade.color)}>
          <svg viewBox="0 0 100 70" role="img" aria-label={`${storm.name} track map`}>
            <defs>
              <linearGradient id="typhoonSea" x1="0" x2="1" y1="0" y2="1">
                <stop offset="0%" stopColor="#dcecf4" />
                <stop offset="100%" stopColor="#9fb9c8" />
              </linearGradient>
            </defs>
            <rect width="100" height="70" rx="4" fill="url(#typhoonSea)" />
            <path
              d="M0 2 C14 4 17 13 27 15 C33 16 35 21 31 27 C27 35 34 42 42 43 C53 45 55 54 50 70 L0 70 Z"
              className="fc-admin-typhoon-map-land"
            />
            <path
              d="M58 2 C63 8 66 17 64 25 C61 37 67 47 76 54 C82 59 84 65 83 70 L100 70 L100 0 Z"
              className="fc-admin-typhoon-map-land is-east"
            />
            <path d="M47 28 C50 32 50 39 47 44 C44 39 44 33 47 28 Z" className="fc-admin-typhoon-map-island" />
            {[20, 40, 60, 80].map((x) => (
              <line key={`x-${x}`} x1={x} x2={x} y1="0" y2="70" className="fc-admin-typhoon-map-grid" />
            ))}
            {[14, 28, 42, 56].map((y) => (
              <line key={`y-${y}`} x1="0" x2="100" y1={y} y2={y} className="fc-admin-typhoon-map-grid" />
            ))}
            <text x="8" y="17">CHINA</text>
            <text x="38" y="38">TAIWAN</text>
            <text x="63" y="61">PHILIPPINES</text>
            <text x="7" y="57">VIETNAM</text>

            {pastPoints.length > 1 ? (
              <polyline points={toPolyline(pastPoints)} className="fc-admin-typhoon-map-track is-past" />
            ) : null}
            {forecastPoints.length > 1 ? (
              <polyline points={toPolyline(forecastPoints)} className="fc-admin-typhoon-map-track is-forecast" />
            ) : null}
            {projectedPoints.map((point, index) =>
              point ? (
                <circle
                  key={`${point.kind}-${index}`}
                  cx={point.x}
                  cy={point.y}
                  r={point.kind === "analysis" ? 1.7 : 1.05}
                  className={`fc-admin-typhoon-map-dot is-${point.kind}`}
                />
              ) : null,
            )}
            {currentPoint ? (
              <circle
                cx={currentPoint.x}
                cy={currentPoint.y}
                r="3.2"
                className="fc-admin-typhoon-map-current"
              />
            ) : null}
          </svg>

          <div className="fc-admin-typhoon-map-meta">
            <span className={`fc-admin-typhoon-grade-pill ${grade.className}`}>{grade.label}</span>
            <dl>
              <div>
                <dt>Wind</dt>
                <dd>{storm.latest.maximumWind || "--"}</dd>
              </div>
              <div>
                <dt>Position</dt>
                <dd>
                  {[storm.latest.latitude, storm.latest.longitude].filter(Boolean).join(", ") ||
                    "--"}
                </dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{formatShortDateTime(storm.bulletinTime || storm.latest.time) || "--"}</dd>
              </div>
            </dl>
            <Link href={HKO_TROPICAL_CYCLONE_MAP_URL} target="_blank" rel="noreferrer">
              Open HKO GIS map
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}

function AdminFolderThemeChooser() {
  const [selectedTheme, setSelectedTheme] = useState<AdminFolderThemeId>(
    normaliseAdminFolderThemeId(null),
  )

  useEffect(() => {
    setSelectedTheme(normaliseAdminFolderThemeId(window.localStorage.getItem(ADMIN_FOLDER_THEME_KEY)))
  }, [])

  function selectTheme(theme: AdminFolderThemeId) {
    setSelectedTheme(theme)
    window.localStorage.setItem(ADMIN_FOLDER_THEME_KEY, theme)
    window.dispatchEvent(new CustomEvent(ADMIN_FOLDER_THEME_EVENT, { detail: theme }))
  }

  return (
    <section className="fc-admin-folder-theme-chooser" aria-label="Left panel folder options">
      <div className="fc-admin-folder-theme-heading">
        <span>Left Panel Folders</span>
        <strong>6 options</strong>
      </div>
      <div className="fc-admin-folder-theme-grid">
        {ADMIN_FOLDER_THEME_OPTIONS.map((option, index) => (
          <button
            key={option.id}
            type="button"
            className="fc-admin-folder-theme-option"
            data-theme-option={option.id}
            aria-pressed={selectedTheme === option.id}
            aria-label={`${option.label} folder style`}
            onClick={() => selectTheme(option.id)}
          >
            <span className="fc-admin-folder-theme-preview" aria-hidden="true">
              <span className="fc-admin-folder-theme-tab" />
              <span className="fc-admin-folder-theme-body">
                <span />
                <span />
                <span />
              </span>
            </span>
            <span>{index + 1}. {option.label}</span>
          </button>
        ))}
      </div>
    </section>
  )
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
  const [selectedTyphoonStorm, setSelectedTyphoonStorm] =
    useState<AdminTyphoonStorm | null>(null)

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
                <div>
                  <span>Public Holidays</span>
                  <small>{HOLIDAY_MARKET_CODES}</small>
                </div>
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
                  No public holidays in the selected markets right now.
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
                      {dashboardData.typhoon.storms.map((storm) => {
                        const grade = getTyphoonGrade(storm.latest.intensity)

                        return (
                          <button
                            key={storm.id || storm.name}
                            type="button"
                            className="fc-admin-typhoon-item"
                            style={typhoonStyle(grade.color)}
                            onClick={() => setSelectedTyphoonStorm(storm)}
                            aria-label={`Open ${storm.name} typhoon map`}
                          >
                            <div>
                              <strong>{storm.name}</strong>
                              <span>{storm.latest.intensity || "Track active"}</span>
                            </div>
                            <span className={`fc-admin-typhoon-grade-pill ${grade.className}`}>
                              {grade.label}
                            </span>
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
                          </button>
                        )
                      })}
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

          <AdminFolderThemeChooser />
        </div>
        {selectedTyphoonStorm ? (
          <AdminTyphoonMapModal
            storm={selectedTyphoonStorm}
            onClose={() => setSelectedTyphoonStorm(null)}
          />
        ) : null}
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
