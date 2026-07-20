"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { CircleMarker, MapContainer, Popup, useMap } from "react-leaflet"
import "leaflet/dist/leaflet.css"
import L from "leaflet"
import { useRouter } from "next/navigation"
import Image from "next/image"
import { useIsMobile } from "@/lib/useIsMobile"
import { resolvePortFuelValue } from "@/lib/portPricing"
import DisclaimerLink from "@/components/DisclaimerLink"
import { buildFallbackKey, type FallbackMap } from "@/lib/reportFallbackKeys"
import type { HomepageMarketData, PublicPort } from "@/lib/publicMarketData"

type Port = PublicPort

type HomepageDataResponse = {
  ports?: Port[]
  fallbacks?: FallbackMap
  message?: string
}

type HomepageInitialData = HomepageMarketData & {
  unavailable?: boolean
}

type HomepageProps = {
  initialData?: HomepageInitialData
  onReady?: () => void
}

const mapTilerKey = process.env.NEXT_PUBLIC_MAPTILER_KEY
const mapTilerStyle =
  process.env.NEXT_PUBLIC_MAPTILER_STYLE ||
  "https://api.maptiler.com/maps/basic-v2-dark/style.json"
const KEY_PORT_NAMES = ["Singapore", "Hong Kong", "Zhoushan", "Busan", "Kaohsiung"]

function getMapTilerRasterUrl() {
  if (!mapTilerKey) return null

  const styleId = mapTilerStyle.match(/\/maps\/([^/]+)\/style\.json(?:\?|$)/)?.[1] || "basic-v2-dark"
  return `https://api.maptiler.com/maps/${encodeURIComponent(styleId)}/{z}/{x}/{y}.png?key=${encodeURIComponent(mapTilerKey)}`
}

const glassPanelStyle: React.CSSProperties = {
  background:
    "radial-gradient(circle at top left, rgba(88, 182, 255, 0.16), transparent 34%), linear-gradient(180deg, rgba(6, 24, 44, 0.8) 0%, rgba(7, 27, 49, 0.72) 100%)",
  border: "1px solid rgba(210, 236, 255, 0.2)",
  backdropFilter: "blur(20px) saturate(145%)",
  WebkitBackdropFilter: "blur(20px) saturate(145%)",
  boxShadow: "0 26px 80px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255,255,255,0.06)",
  color: "#edf7ff",
}

const panelSectionStyle: React.CSSProperties = {
  borderRadius: "18px",
  border: "1px solid rgba(255,255,255,0.1)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.04) 100%)",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
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

function formatFuelDelta(value: number | null, singaporeValue: number | null) {
  if (value == null || singaporeValue == null) return null

  const delta = value - singaporeValue
  if (delta === 0) return "vs SGP 0"

  return `vs SGP ${delta > 0 ? "+" : ""}${delta}`
}

function normaliseHomepageData(payload: HomepageDataResponse | HomepageMarketData | undefined) {
  const data = Array.isArray(payload?.ports) ? payload.ports : []
  const portsByName = new Map(
    data.map((port: Port) => [port.name.toLowerCase(), port] as const)
  )

  return {
    ports: data.map((port: Port) => ({
      ...port,
      hsfo: resolvePortFuelValue(port, portsByName, "hsfo"),
      vlsfo: resolvePortFuelValue(port, portsByName, "vlsfo"),
      mgo: resolvePortFuelValue(port, portsByName, "mgo"),
    })),
    fallbacks: payload?.fallbacks || {},
  }
}

function MapController({ mapRef }: { mapRef: React.MutableRefObject<L.Map | null> }) {
  const map = useMap()
  useEffect(() => {
    mapRef.current = map
    return () => {
      if (mapRef.current === map) mapRef.current = null
    }
  }, [map, mapRef])
  return null
}

function BaseMapLayer() {
  const map = useMap()

  useEffect(() => {
    const mapTilerRasterUrl = getMapTilerRasterUrl()
    const layer = mapTilerRasterUrl
      ? L.tileLayer(mapTilerRasterUrl, {
          tileSize: 512,
          zoomOffset: -1,
          minZoom: 1,
          crossOrigin: true,
          attribution:
            '<a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener">© MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>',
        })
      : L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: "© OpenStreetMap contributors",
        })

    layer.addTo(map)

    return () => {
      map.removeLayer(layer)
    }
  }, [map])

  return null
}

function ZoomControls() {
  const map = useMap()
  const isMobile = useIsMobile()

  return (
    <div
      style={{
        position: "absolute",
        right: 18,
        bottom: isMobile ? 118 : 20,
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
            border: "1px solid rgba(143,215,255,0.34)",
            borderRadius: "999px",
            background: "linear-gradient(180deg, rgba(43, 112, 196, 0.4) 0%, rgba(18, 53, 95, 0.24) 100%)",
            color: "#eef7ff",
            fontSize: "22px",
            fontWeight: 700,
            cursor: "pointer",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.12), 0 12px 30px rgba(8,24,44,0.24), 0 0 0 1px rgba(90,169,255,0.12)",
            backdropFilter: "blur(14px)",
            WebkitBackdropFilter: "blur(14px)",
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
  const [shouldLoad, setShouldLoad] = useState(false)

  useEffect(() => {
    let cancelled = false
    let idleId: number | null = null
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null

    const markReady = () => {
      if (!cancelled) setShouldLoad(true)
    }

    if ("requestIdleCallback" in window) {
      idleId = window.requestIdleCallback(markReady, { timeout: 1600 })
    } else {
      timeoutId = globalThis.setTimeout(markReady, 900)
    }

    return () => {
      cancelled = true
      if (idleId != null && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleId)
      }
      if (timeoutId != null) globalThis.clearTimeout(timeoutId)
    }
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !shouldLoad) return

    container.innerHTML = ""

    const widgetHost = document.createElement("div")
    widgetHost.className = "tradingview-widget-container__widget"
    widgetHost.style.height = "300px"
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
      height: 300,
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
  }, [shouldLoad])

  return (
    <div ref={containerRef} style={{ width: "100%", minHeight: "300px" }}>
      {!shouldLoad && (
        <div
          style={{
            minHeight: "300px",
            display: "grid",
            placeItems: "center",
            color: "rgba(237,247,255,0.72)",
            fontSize: "13px",
            fontWeight: 700,
          }}
        >
          Loading market overview...
        </div>
      )}
    </div>
  )
}

export default function Homepage({ initialData, onReady }: HomepageProps) {
  const isMobile = useIsMobile()
  const initialMarketData = useMemo(() => normaliseHomepageData(initialData), [initialData])
  const [ports, setPorts] = useState<Port[]>(() => initialMarketData.ports)
  const [search, setSearch] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [selectedPortId, setSelectedPortId] = useState<number | null>(null)
  const [reportsOpen, setReportsOpen] = useState(false)
  const [hoveredAction, setHoveredAction] = useState<string | null>(null)
  const [fallbacks, setFallbacks] = useState<FallbackMap>(() => initialMarketData.fallbacks)
  const [marketDataStatus, setMarketDataStatus] = useState<"loading" | "ready" | "error">(
    () => initialData?.unavailable ? "error" : initialMarketData.ports.length > 0 ? "ready" : "loading"
  )

  const mapRef = useRef<L.Map | null>(null)
  const markerRefs = useRef<Record<number, L.CircleMarker>>({})
  const reportsCloseTimeoutRef = useRef<number | null>(null)
  const router = useRouter()

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      onReady?.()
    })

    return () => window.cancelAnimationFrame(frameId)
  }, [onReady])

  function clearReportsCloseTimeout() {
    if (reportsCloseTimeoutRef.current != null) {
      window.clearTimeout(reportsCloseTimeoutRef.current)
      reportsCloseTimeoutRef.current = null
    }
  }

  function scheduleReportsClose() {
    clearReportsCloseTimeout()
    reportsCloseTimeoutRef.current = window.setTimeout(() => {
      setReportsOpen(false)
      reportsCloseTimeoutRef.current = null
    }, 220)
  }

  useEffect(() => {
    let cancelled = false
    let refreshTimer: number | null = null

    async function loadHomepageData(showLoading: boolean) {
      try {
        if (showLoading) setMarketDataStatus("loading")
        const response = await fetch("/api/homepage-data")
        const payload = (await response.json()) as HomepageDataResponse

        if (!response.ok) {
          throw new Error(payload.message || "Unable to load homepage data.")
        }

        const processed = normaliseHomepageData(payload)

        if (cancelled) return
        setPorts(processed.ports)
        setFallbacks(processed.fallbacks)
        setMarketDataStatus("ready")
      } catch (error) {
        console.error("Failed to load homepage data", error)
        if (!cancelled) setMarketDataStatus("error")
      }
    }

    if (initialMarketData.ports.length > 0) {
      refreshTimer = window.setTimeout(() => {
        void loadHomepageData(false)
      }, 60000)
    } else if (!initialData?.unavailable) {
      void loadHomepageData(true)
    }

    return () => {
      cancelled = true
      if (refreshTimer != null) window.clearTimeout(refreshTimer)
    }
  }, [initialData?.unavailable, initialMarketData.ports.length])

  function fuelFallback(portName: string, fuel: "hsfo" | "vlsfo" | "mgo") {
    return fallbacks[buildFallbackKey(portName, fuel)] || "-"
  }

  function formatFuelValue(portName: string, fuel: "hsfo" | "vlsfo" | "mgo", value: number | null) {
    if (value == null) return fuelFallback(portName, fuel)
    return String(value)
  }

  const results = useMemo(() => {
    if (!search) return []
    const normalisedSearch = search.toLowerCase()
    return ports
      .filter((port) => port.type !== "divider" && port.name.toLowerCase().includes(normalisedSearch))
      .slice(0, 8)
  }, [ports, search])

  useEffect(() => {
    return () => clearReportsCloseTimeout()
  }, [])

  useEffect(() => {
    if (!isMobile) return
    window.scrollTo(0, 0)
  }, [isMobile])

  const keyPorts = useMemo(
    () =>
      KEY_PORT_NAMES
        .map((name) => ports.find((port) => port.name === name))
        .filter((port): port is Port => port != null),
    [ports]
  )
  const singaporePort = useMemo(
    () => ports.find((port) => port.name.toLowerCase() === "singapore") ?? null,
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
    setSelectedPortId(port.id)
    if (options?.clearSearch) {
      setSearch("")
    } else {
      setSearch(port.name)
    }
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
  const panelInset = isMobile ? 12 : 18

  return (
    <div style={{ height: "100vh", width: "100%", position: "relative", overflow: "hidden", fontFamily: "Arial, Helvetica, sans-serif" }}>
      <div style={{ position: "absolute", inset: 0, zIndex: 1 }}>
        <MapContainer
          center={center}
          zoom={4}
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
            const isSingapore = port.name.toLowerCase() === "singapore"

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
                <Popup minWidth={260} className="glass-popup">
                  <div style={{ minWidth: "248px", color: "#eef7ff" }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "12px",
                        marginBottom: "10px",
                      }}
                    >
                      <div>
                        <div
                          style={{
                            fontSize: "11px",
                            textTransform: "uppercase",
                            letterSpacing: "0.18em",
                            color: "#8fd7ff",
                            marginBottom: "6px",
                            fontWeight: 800,
                          }}
                        >
                          Port Pricing
                        </div>
                        <div
                          style={{
                            color: "#eef7ff",
                            fontSize: "22px",
                            fontWeight: 800,
                            lineHeight: 1.05,
                          }}
                        >
                          {port.name}
                        </div>
                      </div>
                    </div>

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                        gap: "8px",
                        marginBottom: "8px",
                      }}
                    >
                      {[
                        {
                          label: "HSFO",
                          fuel: "hsfo" as const,
                          value: port.hsfo,
                          singaporeValue: singaporePort?.hsfo ?? null,
                          accent: "#5aa9ff",
                          glow: "rgba(90,169,255,0.2)",
                        },
                        {
                          label: "VLSFO",
                          fuel: "vlsfo" as const,
                          value: port.vlsfo,
                          singaporeValue: singaporePort?.vlsfo ?? null,
                          accent: "#57e3b0",
                          glow: "rgba(87,227,176,0.18)",
                        },
                        {
                          label: "LSMGO",
                          fuel: "mgo" as const,
                          value: port.mgo,
                          singaporeValue: singaporePort?.mgo ?? null,
                          accent: "#ffd166",
                          glow: "rgba(255,209,102,0.18)",
                        },
                      ].map((item) => {
                        const deltaLabel = isSingapore
                          ? null
                          : formatFuelDelta(item.value, item.singaporeValue)

                        return (
                          <div
                            key={item.label}
                            style={{
                              padding: "10px 8px 8px",
                              borderRadius: "14px",
                              border: `1px solid ${item.glow}`,
                              background: `linear-gradient(180deg, ${item.glow} 0%, rgba(255,255,255,0.05) 100%)`,
                              textAlign: "center",
                              boxShadow: `inset 0 1px 0 rgba(255,255,255,0.08), 0 10px 24px ${item.glow}`,
                              position: "relative",
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                right: 0,
                                height: "3px",
                                background: item.accent,
                              }}
                            />
                            <div
                              style={{
                                fontSize: "10px",
                                color: item.accent,
                                marginBottom: "4px",
                                fontWeight: 800,
                                letterSpacing: "0.12em",
                              }}
                            >
                              {item.label}
                            </div>
                            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1.05 }}>
                              {formatFuelValue(port.name, item.fuel, item.value)}
                            </div>
                            {deltaLabel && (
                              <div
                                style={{
                                  marginTop: "4px",
                                  fontSize: "9px",
                                  color: "rgba(237,247,255,0.72)",
                                  fontWeight: 800,
                                  letterSpacing: "0.04em",
                                }}
                              >
                                {deltaLabel}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>

                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "12px",
                        padding: "8px 10px",
                        borderRadius: "12px",
                        background: "linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.05) 100%)",
                        border: "1px solid rgba(143,215,255,0.12)",
                      }}
                    >
                      <div style={{ fontSize: "10px", color: "#8fd7ff", fontWeight: 800, letterSpacing: "0.12em" }}>
                        UPDATED
                      </div>
                      <div style={{ fontSize: "12px", color: "#eef7ff", fontWeight: 700 }}>
                        {updatedDate}
                      </div>
                    </div>
                  </div>
                </Popup>
              </CircleMarker>
            )
          })}

          <ZoomControls />
        </MapContainer>
      </div>

      {!isMobile && (
        <div
          style={{
            position: "absolute",
            right: panelInset,
            top: panelInset,
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
                ...panelSectionStyle,
                border: "1px solid rgba(90,169,255,0.2)",
                background: "linear-gradient(180deg, rgba(90,169,255,0.1) 0%, rgba(255,255,255,0.02) 100%), rgba(6, 24, 44, 0.72)",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 10px 24px rgba(90,169,255,0.12)",
                overflow: "hidden",
                minHeight: "300px",
                position: "relative",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  height: "3px",
                  background: "#5aa9ff",
                  zIndex: 1,
                }}
              />
              <OilWidget />
            </div>
          </div>
        </div>
      )}

      <div
        style={{
          position: "absolute",
          top: panelInset,
          left: isMobile ? 0 : panelInset,
          right: isMobile ? 0 : "auto",
          zIndex: 1000,
          width: isMobile ? "auto" : "min(360px, calc(100% - 36px))",
          borderRadius: isMobile ? "0 0 24px 24px" : "26px",
          padding: isMobile ? "14px" : "18px",
          ...glassPanelStyle,
        }}
      >
        <div style={{ display: "flex", justifyContent: "center", marginBottom: isMobile ? "12px" : "18px" }}>
          <div style={{ width: "100%", display: "flex", justifyContent: "center", flexDirection: "column", alignItems: "center" }}>
            <Image
              src="/uno-transparent.png"
              alt="Bunker Map"
              width={629}
              height={284}
              priority
              style={{ height: isMobile ? "78px" : "108px", width: "auto" }}
            />
          </div>
        </div>

        <div style={{ position: "relative", marginBottom: isMobile ? "10px" : "14px" }}>
          <input
            type="text"
            placeholder="Search by port name"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setSelectedPortId(null)
              setSelectedIndex(-1)
            }}
            onKeyDown={handleKeyDown}
            style={{
              width: "100%",
              padding: isMobile ? "12px 14px" : "14px 16px",
              borderRadius: "18px",
              border: "1px solid rgba(210,236,255,0.16)",
              background: "linear-gradient(180deg, rgba(246,251,255,0.98) 0%, rgba(232,243,252,0.95) 100%)",
              color: "#10243a",
              fontSize: "15px",
              outline: "none",
              boxShadow: "0 12px 28px rgba(4,16,29,0.12), inset 0 1px 0 rgba(255,255,255,0.7)",
            }}
          />

          {results.length > 0 && selectedPortId == null && (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 8px)",
                left: 0,
                right: 0,
                background: "linear-gradient(180deg, rgba(247,251,255,0.99) 0%, rgba(237,245,252,0.98) 100%)",
                borderRadius: "18px",
                boxShadow: "0 22px 44px rgba(0,0,0,0.18)",
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
                    background: index === selectedIndex ? "#8fc9ff" : "transparent",
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

        {marketDataStatus === "error" && (
          <div
            style={{
              ...panelSectionStyle,
              marginBottom: isMobile ? "10px" : "14px",
              padding: "12px",
              color: "#ffd8a8",
              fontSize: "13px",
              fontWeight: 700,
              lineHeight: 1.35,
            }}
          >
            Market data is temporarily unavailable.
          </div>
        )}

        {!isMobile && !search && selectedPortId == null && (
          <div style={{ display: "grid", gap: "8px" }}>
            {keyPorts.map((port) => (
              <button
                key={port.id}
                onClick={() => selectPort(port, { clearSearch: true })}
                style={{
                  width: "100%",
                  ...panelSectionStyle,
                  color: "#edf7ff",
                  padding: "10px 12px",
                  cursor: "pointer",
                  textAlign: "left",
                  backdropFilter: "blur(14px)",
                  WebkitBackdropFilter: "blur(14px)",
                }}
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: isMobile ? "1fr" : "120px 1fr",
                      gap: isMobile ? "6px" : "8px",
                      alignItems: "center",
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: "14px" }}>{port.name}</div>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                        gap: "8px",
                      }}
                    >
                      {[
                        { label: "HSFO", fuel: "hsfo" as const, value: port.hsfo },
                        { label: "VLSFO", fuel: "vlsfo" as const, value: port.vlsfo },
                        { label: "MGO", fuel: "mgo" as const, value: port.mgo },
                      ].map((item) => (
                        <div key={item.label} style={{ textAlign: "center" }}>
                          <div style={{ fontSize: "10px", color: "#abd8ff", marginBottom: "2px" }}>{item.label}</div>
                          <div style={{ fontSize: "13px", fontWeight: 700 }}>{formatFuelValue(port.name, item.fuel, item.value)}</div>
                        </div>
                      ))}
                    </div>
                  </div>
              </button>
            ))}
          </div>
        )}

      </div>

      <div
        style={{
          position: "absolute",
          left: panelInset,
          bottom: isMobile ? 114 : panelInset,
          zIndex: 1000,
          display: "flex",
          gap: "12px",
          pointerEvents: "none",
        }}
      >
        <div style={{ display: "flex", gap: isMobile ? "10px" : "12px", pointerEvents: "auto" }}>
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
              background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)",
              textColor: "#d7e8ff",
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
              background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)",
              textColor: "#d7e8ff",
            },
          ].map((item) => {
            const expanded = hoveredAction === item.key

            const buttonStyle: React.CSSProperties = {
              width: expanded && !isMobile ? "220px" : isMobile ? "46px" : "50px",
              height: isMobile ? "46px" : "50px",
              borderRadius: "999px",
              border: "1px solid rgba(143, 215, 255, 0.46)",
              background: item.background,
              color: item.textColor,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: expanded && !isMobile ? "flex-start" : "center",
              gap: expanded && !isMobile ? "10px" : "0",
              cursor: "pointer",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14), 0 14px 34px rgba(8,24,44,0.28), 0 0 0 1px rgba(90,169,255,0.16)",
              backdropFilter: "blur(14px)",
              WebkitBackdropFilter: "blur(14px)",
              textDecoration: "none",
              overflow: "hidden",
              whiteSpace: "nowrap",
              transition: "width 0.22s ease, background 0.22s ease, transform 0.22s ease, box-shadow 0.22s ease",
              padding: expanded && !isMobile ? "0 18px" : "0",
            }

            const content = (
              <>
                <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: "22px" }}>
                  {item.icon}
                </span>
                {expanded && !isMobile && (
                  <span style={{ fontWeight: 700, fontSize: "14px" }}>
                    {item.label}
                  </span>
                )}
              </>
            )

            return (
              <div
                key={item.key}
                style={{ position: "relative" }}
                onMouseEnter={() => {
                  if (item.key === "reports") clearReportsCloseTimeout()
                }}
                onMouseLeave={() => {
                  setHoveredAction(null)
                  if (item.key === "reports") scheduleReportsClose()
                }}
              >
                <button
                  onClick={item.onClick}
                  aria-label={item.label}
                  title={item.label}
                  style={buttonStyle}
                  onMouseEnter={() => {
                    setHoveredAction(item.key)
                    if (item.key === "reports") clearReportsCloseTimeout()
                  }}
                  onMouseLeave={() => {
                    setHoveredAction(null)
                    if (item.key === "reports") scheduleReportsClose()
                  }}
                >
                  {content}
                </button>

                {item.key === "reports" && reportsOpen && (
                  <div
                    onMouseEnter={clearReportsCloseTimeout}
                    onMouseLeave={scheduleReportsClose}
                    style={{
                      position: "absolute",
                      left: 0,
                      bottom: "calc(100% + 4px)",
                      minWidth: "240px",
                      background: "radial-gradient(circle at top left, rgba(88,182,255,0.16), transparent 34%), linear-gradient(180deg, rgba(9, 22, 39, 0.82) 0%, rgba(7, 20, 35, 0.76) 100%)",
                      border: "1px solid rgba(210,236,255,0.2)",
                      borderRadius: "18px",
                      overflow: "hidden",
                      backdropFilter: "blur(18px)",
                      WebkitBackdropFilter: "blur(18px)",
                      boxShadow: "0 20px 44px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.05)",
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
                          padding: "13px 14px",
                          textAlign: "left",
                          cursor: "pointer",
                          color: "#d7e8ff",
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

      {!isMobile && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            transform: "translateX(-50%)",
            bottom: "20px",
            zIndex: 1000,
            pointerEvents: "auto",
          }}
        >
          <DisclaimerLink subtle centered />
        </div>
      )}

    </div>
  )
}
