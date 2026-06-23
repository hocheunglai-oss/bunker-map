"use client"

import Image from "next/image"
import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import "leaflet/dist/leaflet.css"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

const HOLIDAY_MARKET_CODES = "HK CN SG KR JP VN US"
const HKO_TROPICAL_CYCLONE_MAP_URL = "https://www.hko.gov.hk/en/wxinfo/currwx/tc_gis.htm"

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

function typhoonStyle(color: string) {
  return { "--tc-grade-color": color } as React.CSSProperties & {
    "--tc-grade-color": string
  }
}

type MappableTrackPoint = AdminTrackPoint & {
  lat: number
  lon: number
}

function getMappableTrackPoints(storm: AdminTyphoonStorm): MappableTrackPoint[] {
  return (storm.trackPoints || []).filter(
    (point): point is MappableTrackPoint =>
      typeof point.lat === "number" && typeof point.lon === "number",
  )
}

function toLatLng(points: MappableTrackPoint[]) {
  return points.map((point) => [point.lat, point.lon] as [number, number])
}

function escapeHtml(value: string | null | undefined) {
  return (value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function AdminTyphoonMap({
  storm,
  gradeColor,
}: {
  storm: AdminTyphoonStorm
  gradeColor: string
}) {
  const mapRef = useRef<HTMLDivElement | null>(null)
  const points = getMappableTrackPoints(storm)
  const pastPoints = points.filter((point) => point.kind === "past" || point.kind === "analysis")
  const forecastPoints = points.filter((point) => point.kind === "forecast")
  const currentPoint =
    [...points].reverse().find((point) => point.kind === "analysis") ||
    [...pastPoints].reverse()[0] ||
    points[0]
  const center: [number, number] = currentPoint ? [currentPoint.lat, currentPoint.lon] : [21.5, 122]

  useEffect(() => {
    const container = mapRef.current
    if (!container || !points.length) return

    let cancelled = false
    let map: import("leaflet").Map | null = null

    async function mountMap() {
      const L = await import("leaflet")
      if (cancelled || !container) return

      if ("_leaflet_id" in container) {
        delete (container as HTMLDivElement & { _leaflet_id?: number })._leaflet_id
      }

      map = L.map(container, {
        attributionControl: true,
        scrollWheelZoom: false,
        zoomControl: true,
      })

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 18,
      }).addTo(map)

      const pointBounds = toLatLng(points)

      if (pointBounds.length > 1) {
        map.fitBounds(L.latLngBounds(pointBounds), {
          animate: false,
          maxZoom: 6,
          padding: [34, 34],
        })
      } else {
        map.setView(center, 5, { animate: false })
      }

      if (pastPoints.length > 1) {
        L.polyline(toLatLng(pastPoints), {
          color: gradeColor,
          opacity: 0.96,
          weight: 5,
        }).addTo(map)
      }

      if (forecastPoints.length > 1) {
        L.polyline(toLatLng(forecastPoints), {
          color: gradeColor,
          dashArray: "8 8",
          opacity: 0.74,
          weight: 4,
        }).addTo(map)
      }

      for (const point of points) {
        L.circleMarker([point.lat, point.lon], {
          color: gradeColor,
          fillColor: point.kind === "forecast" ? "#ffffff" : gradeColor,
          fillOpacity: point.kind === "forecast" ? 0.82 : 0.95,
          opacity: 1,
          radius: point.kind === "analysis" ? 8 : 5,
          weight: point.kind === "analysis" ? 3 : 2,
        })
          .bindPopup(
            `<strong>${escapeHtml(storm.name)}</strong><br>${escapeHtml(
              point.intensity || storm.latest.intensity || "Track point",
            )}<br>${escapeHtml([point.latitude, point.longitude].filter(Boolean).join(", "))}`,
          )
          .addTo(map)
      }

      window.setTimeout(() => map?.invalidateSize(), 0)
    }

    void mountMap()

    return () => {
      cancelled = true
      map?.remove()
    }
  }, [center, forecastPoints, gradeColor, pastPoints, points, storm.latest.intensity, storm.name])

  if (!points.length) {
    return (
      <div className="fc-admin-typhoon-map-fallback">
        <p>Track map unavailable for this storm.</p>
        <Link href={HKO_TROPICAL_CYCLONE_MAP_URL} target="_blank" rel="noreferrer">
          Open HKO GIS map
        </Link>
      </div>
    )
  }

  return <div ref={mapRef} className="fc-admin-typhoon-leaflet-map" />
}

function AdminTyphoonMapModal({
  storm,
  onClose,
}: {
  storm: AdminTyphoonStorm
  onClose: () => void
}) {
  const grade = getTyphoonGrade(storm.latest.intensity)

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
          <AdminTyphoonMap storm={storm} gradeColor={grade.color} />

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

function AdminOilWidget() {
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
                  No public holidays in the upcoming 3 days.
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
