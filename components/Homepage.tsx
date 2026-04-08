"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { CircleMarker, MapContainer, Popup, useMap } from "react-leaflet"
import "leaflet/dist/leaflet.css"
import "@maptiler/sdk/dist/maptiler-sdk.css"
import L from "leaflet"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabase"

type Port = {
  id: number
  name: string
  lat: number | null
  lng: number | null
  hsfo: number | null
  vlsfo: number | null
  mgo: number | null
  hsfo_formula?: string | null
  vlsfo_formula?: string | null
  mgo_formula?: string | null
  recorded_at?: string | null
  updated_at?: string | null
  date?: string | null
}

const mapTilerKey = process.env.NEXT_PUBLIC_MAPTILER_KEY
const mapTilerStyle =
  process.env.NEXT_PUBLIC_MAPTILER_STYLE ||
  "https://api.maptiler.com/maps/basic-v2-dark/style.json"

const glassPanelStyle: React.CSSProperties = {
  background:
    "rgba(6, 24, 44, 0.62)",
  border: "1px solid rgba(210, 236, 255, 0.18)",
  backdropFilter: "blur(20px) saturate(145%)",
  WebkitBackdropFilter: "blur(20px) saturate(145%)",
  boxShadow: "0 20px 70px rgba(0, 0, 0, 0.22)",
  color: "#edf7ff",
}

function formatUpdatedDate(value: string | null | undefined) {
  if (!value || value === "-") return "-"

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value

  return new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    timeZone: "Asia/Hong_Kong",
  }).format(parsed)
}

function MapController({ mapRef }: { mapRef: React.MutableRefObject<L.Map | null> }) {
  const map = useMap()
  mapRef.current = map
  return null
}

function BaseMapLayer() {
  const map = useMap()

  useEffect(() => {
    let mounted = true
    let layer: L.Layer | null = null

    async function loadLayer() {
      if (!mapTilerKey) {
        layer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: "© OpenStreetMap",
        })
        layer.addTo(map)
        return
      }

      const { MaptilerLayer } = await import("@maptiler/leaflet-maptilersdk")

      if (!mounted) return

      layer = new MaptilerLayer({
        apiKey: mapTilerKey,
        style: mapTilerStyle,
      })

      layer.addTo(map)
    }

    loadLayer()

    return () => {
      mounted = false
      if (layer) {
        map.removeLayer(layer)
      }
    }
  }, [map])

  return null
}

function ZoomControls() {
  const map = useMap()

  return (
    <div
      style={{
        position: "absolute",
        right: 18,
        bottom: 20,
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      }}
    >
      {[
        { label: "+", action: () => map.zoomIn() },
        { label: "−", action: () => map.zoomOut() },
      ].map((control) => (
        <button
          key={control.label}
          onClick={control.action}
          style={{
            width: "44px",
            height: "44px",
            border: "1px solid rgba(255,255,255,0.14)",
            borderRadius: "14px",
            background: "rgba(7, 23, 41, 0.86)",
            color: "white",
            fontSize: "22px",
            cursor: "pointer",
            boxShadow: "0 12px 24px rgba(0,0,0,0.18)",
          }}
        >
          {control.label}
        </button>
      ))}
    </div>
  )
}

function OilWidget() {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    container.innerHTML = ""

    const widgetHost = document.createElement("div")
    widgetHost.className = "tradingview-widget-container__widget"
    widgetHost.style.height = "210px"
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
      height: 210,
      largeChartUrl: "",
      isTransparent: true,
      showSymbolLogo: false,
      showFloatingTooltip: false,
      plotLineColorGrowing: "rgba(41, 98, 255, 1)",
      plotLineColorFalling: "rgba(41, 98, 255, 1)",
      gridLineColor: "rgba(255, 255, 255, 0.06)",
      scaleFontColor: "rgba(237, 247, 255, 0.8)",
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

  return <div ref={containerRef} style={{ width: "100%", minHeight: "210px" }} />
}

function IconButton({
  label,
  title,
  children,
  onClick,
  href,
}: {
  label: string
  title: string
  children: React.ReactNode
  onClick?: () => void
  href?: string
}) {
  const sharedStyle: React.CSSProperties = {
    width: "50px",
    height: "50px",
    borderRadius: "999px",
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(6, 24, 44, 0.72)",
    color: "#edf7ff",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    boxShadow: "0 14px 34px rgba(0,0,0,0.2)",
    backdropFilter: "blur(14px)",
    WebkitBackdropFilter: "blur(14px)",
    textDecoration: "none",
  }

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={label}
        title={title}
        style={sharedStyle}
      >
        {children}
      </a>
    )
  }

  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={title}
      style={sharedStyle}
    >
      {children}
    </button>
  )
}

export default function Homepage() {
  const [ports, setPorts] = useState<Port[]>([])
  const [search, setSearch] = useState("")
  const [results, setResults] = useState<Port[]>([])
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [reportsOpen, setReportsOpen] = useState(false)
  const [hoveredAction, setHoveredAction] = useState<string | null>(null)

  const mapRef = useRef<L.Map | null>(null)
  const markerRefs = useRef<Record<number, L.CircleMarker>>({})
  const router = useRouter()

  useEffect(() => {
    async function loadPorts() {
      const { data } = await supabase.from("ports").select("*")
      if (!data) return

      const processed = data.map((port: Port) => {
        const calc = (formula: string, fuel: "hsfo" | "vlsfo" | "mgo") => {
          const parts = formula.split(" ")
          if (parts.length !== 3) return null

          const refName = parts[0].toLowerCase()
          const operator = parts[1]
          const value = Number(parts[2])
          const ref = data.find((item: Port) => item.name.toLowerCase() === refName)

          if (!ref || ref[fuel] == null) return null
          if (operator === "+") return ref[fuel]! + value
          if (operator === "-") return ref[fuel]! - value

          return null
        }

        return {
          ...port,
          hsfo: port.hsfo ?? (port.hsfo_formula ? calc(port.hsfo_formula, "hsfo") : null),
          vlsfo: port.vlsfo ?? (port.vlsfo_formula ? calc(port.vlsfo_formula, "vlsfo") : null),
          mgo: port.mgo ?? (port.mgo_formula ? calc(port.mgo_formula, "mgo") : null),
        }
      })

      setPorts(processed)
    }

    loadPorts()
  }, [])

  useEffect(() => {
    if (!search) {
      setResults([])
      return
    }

    const filtered = ports.filter((port) =>
      port.name.toLowerCase().includes(search.toLowerCase())
    )

    setResults(filtered.slice(0, 8))
    setSelectedIndex(-1)
  }, [search, ports])

  const keyPortNames = ["Hong Kong", "Singapore", "Zhoushan", "Busan", "Kaohsiung"]
  const keyPorts = useMemo(
    () =>
      keyPortNames
        .map((name) => ports.find((port) => port.name === name))
        .filter((port): port is Port => port != null),
    [ports]
  )

  function zoomToPort(port: Port) {
    if (!mapRef.current || port.lat == null || port.lng == null) return

    mapRef.current.flyTo([port.lat, port.lng], 7, {
      animate: true,
      duration: 1.1,
    })
  }

  function openPortPopup(port: Port) {
    const marker = markerRefs.current[port.id]
    const map = mapRef.current
    if (!marker || !map || port.lat == null || port.lng == null) return
    const target: [number, number] = [port.lat, port.lng]

    window.setTimeout(() => {
      map.panTo(target, {
        animate: false,
      })
      marker.openPopup()
      map.panTo(target, {
        animate: true,
        duration: 0.35,
      })
    }, 700)
  }

  function selectPort(port: Port, options?: { clearSearch?: boolean }) {
    zoomToPort(port)
    openPortPopup(port)
    if (options?.clearSearch) {
      setSearch("")
    } else {
      setSearch(port.name)
    }
    setResults([])
    setReportsOpen(false)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) return

    if (event.key === "ArrowDown") {
      event.preventDefault()
      setSelectedIndex((prev) => (prev < results.length - 1 ? prev + 1 : prev))
    }

    if (event.key === "ArrowUp") {
      event.preventDefault()
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev))
    }

    if (event.key === "Enter") {
      event.preventDefault()

      let port = results[selectedIndex]
      if (!port && results.length === 1) port = results[0]
      if (port) selectPort(port, { clearSearch: true })
    }
  }

  const center: [number, number] = [22.3193, 114.1694]

  return (
    <div style={{ height: "100vh", width: "100%", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, zIndex: 1 }}>
        <MapContainer
          center={center}
          zoom={3}
          zoomControl={false}
          style={{ height: "100%", width: "100%" }}
        >
          <MapController mapRef={mapRef} />

          <BaseMapLayer />

          {ports.map((port) => {
            if (port.lat == null || port.lng == null) return null

            const updatedDate = formatUpdatedDate(
              port.recorded_at || port.updated_at || port.date || "-"
            )

            return (
              <CircleMarker
                key={port.id}
                center={[port.lat, port.lng]}
                ref={(element) => {
                  if (element) {
                    markerRefs.current[port.id] = element
                  }
                }}
                radius={7}
                color="#78d6ff"
                weight={2}
                fillColor="#1e90ff"
                fillOpacity={0.88}
              >
                <Popup minWidth={220} className="glass-popup">
                  <div style={{ minWidth: "210px", color: "#eef7ff" }}>
                    <div style={{ fontSize: "20px", fontWeight: 700, marginBottom: "12px" }}>
                      {port.name}
                    </div>

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                        gap: "8px",
                        marginBottom: "12px",
                      }}
                    >
                      {[
                        { label: "HSFO", value: port.hsfo },
                        { label: "VLSFO", value: port.vlsfo },
                        { label: "LSMGO", value: port.mgo },
                      ].map((item) => (
                        <div
                          key={item.label}
                          style={{
                            padding: "10px 8px",
                            borderRadius: "12px",
                            background: "rgba(255,255,255,0.09)",
                            textAlign: "center",
                          }}
                        >
                          <div style={{ fontSize: "11px", color: "#abd8ff", marginBottom: "4px" }}>
                            {item.label}
                          </div>
                          <div style={{ fontSize: "16px", fontWeight: 700 }}>
                            {item.value ?? "-"}
                          </div>
                        </div>
                      ))}
                    </div>

                    <div style={{ fontSize: "12px", color: "#abd8ff" }}>
                      Updated: <strong style={{ color: "#eef7ff" }}>{updatedDate}</strong>
                    </div>
                  </div>
                </Popup>
              </CircleMarker>
            )
          })}

          <ZoomControls />
        </MapContainer>
      </div>

      <div
        style={{
          position: "absolute",
          right: 18,
          top: 18,
          zIndex: 1000,
          width: "min(330px, calc(100% - 36px))",
          borderRadius: "22px",
          padding: "16px 18px",
          display: "grid",
          gap: "14px",
          ...glassPanelStyle,
        }}
      >
        <div>
          <div
            style={{
              fontSize: "12px",
              textTransform: "uppercase",
              letterSpacing: "0.2em",
              color: "#8fd7ff",
              marginBottom: "10px",
              fontWeight: 800,
            }}
          >
            Oil Market
          </div>
          <div
            style={{
              borderRadius: "16px",
              border: "1px solid rgba(255,255,255,0.1)",
              background: "rgba(255,255,255,0.04)",
              overflow: "hidden",
              minHeight: "210px",
            }}
          >
            <OilWidget />
          </div>
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          top: 18,
          left: 18,
          zIndex: 1000,
          width: "min(360px, calc(100% - 36px))",
          borderRadius: "26px",
          padding: "18px",
          ...glassPanelStyle,
        }}
      >
        <div style={{ display: "flex", justifyContent: "center", marginBottom: "18px" }}>
          <div style={{ width: "100%", display: "flex", justifyContent: "center" }}>
            <img
              src="/logo-trans.png"
              alt="Bunker Map"
              style={{ height: "88px", width: "auto" }}
            />
          </div>
        </div>

        <div style={{ position: "relative", marginBottom: "14px" }}>
          <input
            type="text"
            placeholder="Search by port name"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={handleKeyDown}
            style={{
              width: "100%",
              padding: "14px 16px",
              borderRadius: "18px",
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(255,255,255,0.97)",
              color: "#10243a",
              fontSize: "15px",
              outline: "none",
            }}
          />

          {results.length > 0 && (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 8px)",
                left: 0,
                right: 0,
                background: "rgba(255,255,255,0.98)",
                borderRadius: "18px",
                boxShadow: "0 20px 40px rgba(0,0,0,0.2)",
                overflow: "hidden",
                border: "1px solid rgba(16, 36, 58, 0.08)",
              }}
            >
              {results.map((port, index) => (
                <button
                key={port.id}
                  onClick={() => selectPort(port, { clearSearch: true })}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "12px 14px",
                    background: index === selectedIndex ? "#e9f5ff" : "white",
                    border: "none",
                    borderBottom:
                      index === results.length - 1 ? "none" : "1px solid rgba(16,36,58,0.06)",
                    cursor: "pointer",
                    color: "#10243a",
                    textAlign: "left",
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{port.name}</span>
                  <span style={{ color: "#5c7691", fontSize: "12px" }}>View</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {!search && (
          <div style={{ display: "grid", gap: "8px" }}>
            <div
              style={{
                fontSize: "12px",
                textTransform: "uppercase",
                letterSpacing: "0.2em",
                color: "#8fd7ff",
                marginBottom: "2px",
                fontWeight: 800,
              }}
            >
              Key Port Snapshot
            </div>
            {keyPorts.map((port) => (
              <button
                key={port.id}
                onClick={() => selectPort(port, { clearSearch: true })}
                style={{
                  width: "100%",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: "14px",
                  background: "rgba(255,255,255,0.06)",
                  color: "#edf7ff",
                  padding: "10px 12px",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1.2fr repeat(3, minmax(0, 1fr))",
                    gap: "8px",
                    alignItems: "center",
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: "14px" }}>{port.name}</div>
                  {[
                    { label: "HSFO", value: port.hsfo },
                    { label: "VLSFO", value: port.vlsfo },
                    { label: "MGO", value: port.mgo },
                  ].map((item) => (
                    <div key={item.label} style={{ textAlign: "center" }}>
                      <div style={{ fontSize: "10px", color: "#abd8ff" }}>{item.label}</div>
                      <div style={{ fontSize: "13px", fontWeight: 700 }}>{item.value ?? "-"}</div>
                    </div>
                  ))}
                </div>
              </button>
            ))}
          </div>
        )}

      </div>

      <div
        style={{
          position: "absolute",
          left: 18,
          bottom: 18,
          zIndex: 1000,
          display: "flex",
          gap: "12px",
          pointerEvents: "none",
        }}
      >
        <div style={{ display: "flex", gap: "12px", pointerEvents: "auto" }}>
          {[
            {
              key: "admin",
              label: "Admin Login",
              onClick: () => router.push("/admin"),
              icon: (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M12 12a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5Z"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  />
                  <path
                    d="M5.5 19.25a6.5 6.5 0 0 1 13 0"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              ),
              background: "rgba(6, 24, 44, 0.72)",
              textColor: "#edf7ff",
            },
            {
              key: "reports",
              label: "Market Reports",
              onClick: () => setReportsOpen((prev) => !prev),
              icon: (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M6 4.75C6 4.34 6.34 4 6.75 4h8.9c.2 0 .39.08.53.22l2.6 2.6c.14.14.22.33.22.53v11.9c0 .41-.34.75-.75.75H6.75A.75.75 0 0 1 6 19.25V4.75Z"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  />
                  <path d="M16 4.5V7a1 1 0 0 0 1 1h2.5" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M8.5 11h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  <path d="M8.5 14h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  <path d="M8.5 17h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              ),
              background: "rgba(6, 24, 44, 0.72)",
              textColor: "#edf7ff",
            },
            {
              key: "whatsapp",
              label: "Contact Us",
              href: "https://wa.me/85266885575",
              icon: (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M20 11.54c0 4.47-3.66 8.1-8.17 8.1-1.42 0-2.75-.36-3.9-1l-3.93 1.23 1.28-3.8a8.03 8.03 0 0 1-1.38-4.53c0-4.47 3.66-8.1 8.17-8.1S20 7.07 20 11.54Z"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M9.27 8.72c.16-.37.32-.38.47-.39.12 0 .26-.01.4-.01.13 0 .34.05.52.45.18.4.61 1.39.66 1.49.05.1.09.23.02.37-.07.14-.1.23-.2.35-.1.12-.22.27-.31.36-.1.1-.2.2-.09.4.11.19.48.79 1.03 1.28.71.64 1.31.84 1.5.94.19.1.3.08.42-.05.11-.13.46-.53.59-.72.13-.18.26-.15.44-.09.18.06 1.14.53 1.34.62.2.1.33.15.37.24.05.09.05.54-.13 1.06-.18.51-1.05 1-1.45 1.06-.39.07-.88.1-2.49-.55-1.94-.78-3.2-2.74-3.3-2.87-.1-.13-.79-1.04-.79-1.99 0-.95.5-1.42.67-1.61Z"
                    fill="currentColor"
                  />
                </svg>
              ),
              background: "#25D366",
              textColor: "#ffffff",
            },
          ].map((item) => {
            const expanded = hoveredAction === item.key

            const buttonStyle: React.CSSProperties = {
              width: expanded ? "220px" : "50px",
              height: "50px",
              borderRadius: "999px",
              border: item.key === "whatsapp"
                ? "1px solid rgba(255,255,255,0.18)"
                : "1px solid rgba(255,255,255,0.14)",
              background: item.background,
              color: item.textColor,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: expanded ? "flex-start" : "center",
              gap: expanded ? "10px" : "0",
              cursor: "pointer",
              boxShadow: "0 14px 34px rgba(0,0,0,0.2)",
              backdropFilter: item.key === "whatsapp" ? undefined : "blur(14px)",
              WebkitBackdropFilter: item.key === "whatsapp" ? undefined : "blur(14px)",
              textDecoration: "none",
              overflow: "hidden",
              whiteSpace: "nowrap",
              transition: "width 0.22s ease, background 0.22s ease, transform 0.22s ease",
              padding: expanded ? "0 18px" : "0",
            }

            const content = (
              <>
                <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: "22px" }}>
                  {item.icon}
                </span>
                {expanded && (
                  <span style={{ fontWeight: 700, fontSize: "14px" }}>
                    {item.label}
                  </span>
                )}
              </>
            )

            if (item.href) {
              return (
                <a
                  key={item.key}
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={item.label}
                  title={item.label}
                  style={buttonStyle}
                  onMouseEnter={() => setHoveredAction(item.key)}
                  onMouseLeave={() => setHoveredAction(null)}
                >
                  {content}
                </a>
              )
            }

            return (
              <div key={item.key} style={{ position: "relative" }}>
                <button
                  onClick={item.onClick}
                  aria-label={item.label}
                  title={item.label}
                  style={buttonStyle}
                  onMouseEnter={() => setHoveredAction(item.key)}
                  onMouseLeave={() => setHoveredAction(null)}
                >
                  {content}
                </button>

                {item.key === "reports" && reportsOpen && (
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      bottom: "calc(100% + 10px)",
                      minWidth: "240px",
                      background: "rgba(9, 22, 39, 0.72)",
                      border: "1px solid rgba(210,236,255,0.18)",
                      borderRadius: "18px",
                      overflow: "hidden",
                      backdropFilter: "blur(18px)",
                      WebkitBackdropFilter: "blur(18px)",
                      boxShadow: "0 18px 40px rgba(0,0,0,0.18)",
                    }}
                  >
                    {[
                      { label: "Taiwan Market Report", path: "/reports/taiwan" },
                      { label: "Hong Kong Market Report", path: "/reports/hongkong" },
                      { label: "China Market Report", path: "/reports/china" },
                      { label: "Compact Market Report", path: "/reports/compact" },
                    ].map((report, index) => (
                      <button
                        key={report.path}
                        onClick={() => {
                          setReportsOpen(false)
                          router.push(report.path)
                        }}
                        style={{
                          width: "100%",
                          border: "none",
                          background: "transparent",
                          padding: "12px 14px",
                          textAlign: "left",
                          cursor: "pointer",
                          color: "#edf7ff",
                          fontWeight: 600,
                          borderTop: index > 0 ? "1px solid rgba(255,255,255,0.08)" : "none",
                        }}
                      >
                        {report.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

    </div>
  )
}
