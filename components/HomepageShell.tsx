import type { HomepageMarketData, PublicPort } from "@/lib/publicMarketData"
import { buildFallbackKey, type FallbackMap } from "@/lib/reportFallbackKeys"
import { resolvePortFuelValue } from "@/lib/portPricing"

type HomepageShellProps = {
  initialData: HomepageMarketData
}

type ShellPort = PublicPort

const keyPortNames = ["Singapore", "Hong Kong", "Zhoushan", "Busan", "Kaohsiung"]

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

function resolvePorts(ports: PublicPort[]) {
  const portsByName = new Map(ports.map((port) => [port.name.toLowerCase(), port] as const))

  return ports.map((port) => ({
    ...port,
    hsfo: resolvePortFuelValue(port, portsByName, "hsfo"),
    vlsfo: resolvePortFuelValue(port, portsByName, "vlsfo"),
    mgo: resolvePortFuelValue(port, portsByName, "mgo"),
  }))
}

function fuelFallback(fallbacks: FallbackMap, portName: string, fuel: "hsfo" | "vlsfo" | "mgo") {
  return fallbacks[buildFallbackKey(portName, fuel)] || "-"
}

function formatFuelValue(
  fallbacks: FallbackMap,
  portName: string,
  fuel: "hsfo" | "vlsfo" | "mgo",
  value: number | null,
) {
  if (value == null) return fuelFallback(fallbacks, portName, fuel)
  return String(value)
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

export default function HomepageShell({ initialData }: HomepageShellProps) {
  const ports = resolvePorts(initialData.ports || [])
  const fallbacks = initialData.fallbacks || {}
  const keyPorts = keyPortNames
    .map((name) => ports.find((port) => port.name === name))
    .filter((port): port is ShellPort => port != null)
  const latestUpdate = ports
    .map((port) => port.recorded_at || port.updated_at || port.date)
    .filter(Boolean)
    .sort()
    .at(-1)

  return (
    <div
      aria-label="Homepage loading preview"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 1,
        overflow: "hidden",
        background:
          "linear-gradient(135deg, #07121f 0%, #0b2035 45%, #10243a 100%)",
        fontFamily: "Arial, Helvetica, sans-serif",
      }}
    >
      <style>{`
        @media (max-width: 760px) {
          [data-homepage-shell-left] {
            left: 12px !important;
            right: 12px !important;
            width: auto !important;
            padding: 14px !important;
            border-radius: 0 0 24px 24px !important;
          }

          [data-homepage-shell-left] img {
            height: 78px !important;
          }

          [data-homepage-shell-right] {
            display: none !important;
          }

          [data-homepage-shell-port-row] {
            grid-template-columns: 1fr !important;
          }

          [data-homepage-shell-actions] {
            left: 12px !important;
            bottom: 84px !important;
          }

          [data-homepage-shell-actions] a {
            min-width: 46px !important;
            width: 46px !important;
            padding: 0 !important;
            overflow: hidden !important;
            color: transparent !important;
          }

          [data-homepage-shell-updated] {
            left: 12px !important;
            right: 12px !important;
            bottom: 24px !important;
            text-align: center !important;
          }
        }
      `}</style>
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.4,
          backgroundImage:
            "linear-gradient(rgba(143,215,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(143,215,255,0.08) 1px, transparent 1px)",
          backgroundSize: "64px 64px",
        }}
      />

      <div
        data-homepage-shell-left
        style={{
          position: "absolute",
          top: 18,
          left: 18,
          width: "min(360px, calc(100% - 36px))",
          borderRadius: "26px",
          padding: "18px",
          ...glassPanelStyle,
        }}
      >
        <div style={{ display: "flex", justifyContent: "center", marginBottom: "18px" }}>
          <img src="/uno-transparent.png" alt="Bunker Map" style={{ height: "108px", width: "auto" }} />
        </div>

        <div
          style={{
            width: "100%",
            padding: "14px 16px",
            borderRadius: "18px",
            border: "1px solid rgba(210,236,255,0.16)",
            background: "linear-gradient(180deg, rgba(246,251,255,0.98) 0%, rgba(232,243,252,0.95) 100%)",
            color: "#60768f",
            fontSize: "15px",
            boxShadow: "0 12px 28px rgba(4,16,29,0.12), inset 0 1px 0 rgba(255,255,255,0.7)",
          }}
        >
          Search by port name
        </div>

        <div style={{ display: "grid", gap: "8px", marginTop: "14px" }}>
          {keyPorts.length > 0 ? (
            keyPorts.map((port) => (
              <div key={port.id} style={{ width: "100%", ...panelSectionStyle, color: "#edf7ff", padding: "10px 12px" }}>
                <div
                  data-homepage-shell-port-row
                  style={{
                    display: "grid",
                    gridTemplateColumns: "120px 1fr",
                    gap: "8px",
                    alignItems: "center",
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: "14px" }}>{port.name}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "8px" }}>
                    {[
                      { label: "HSFO", fuel: "hsfo" as const, value: port.hsfo },
                      { label: "VLSFO", fuel: "vlsfo" as const, value: port.vlsfo },
                      { label: "MGO", fuel: "mgo" as const, value: port.mgo },
                    ].map((item) => (
                      <div key={item.label} style={{ textAlign: "center" }}>
                        <div style={{ fontSize: "10px", color: "#abd8ff", marginBottom: "2px" }}>{item.label}</div>
                        <div style={{ fontSize: "13px", fontWeight: 700 }}>
                          {formatFuelValue(fallbacks, port.name, item.fuel, item.value)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div style={{ ...panelSectionStyle, padding: "12px", color: "#abd8ff", fontSize: "13px", fontWeight: 700 }}>
              Market data is loading.
            </div>
          )}
        </div>
      </div>

      <div
        data-homepage-shell-right
        style={{
          position: "absolute",
          right: 18,
          top: 18,
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
              minHeight: "150px",
              display: "grid",
              alignContent: "center",
              gap: "8px",
              padding: "16px",
            }}
          >
            <div style={{ fontSize: "13px", color: "#abd8ff", fontWeight: 800, letterSpacing: "0.12em" }}>
              MARKET OVERVIEW
            </div>
            <div style={{ color: "#edf7ff", fontSize: "22px", fontWeight: 800 }}>
              Brent / WTI
            </div>
            <div style={{ color: "rgba(237,247,255,0.72)", fontSize: "13px", fontWeight: 700 }}>
              Live chart loads after the first paint.
            </div>
          </div>
        </div>
      </div>

      <div
        data-homepage-shell-actions
        style={{
          position: "absolute",
          left: 18,
          bottom: 18,
          zIndex: 2,
          display: "flex",
          gap: "12px",
        }}
      >
        <a href="/admin" style={shellActionStyle}>Admin Login</a>
        <a href="/reports/compact" style={shellActionStyle}>Market Reports</a>
      </div>

      <div
        data-homepage-shell-updated
        style={{
          position: "absolute",
          right: 18,
          bottom: 18,
          color: "rgba(237,247,255,0.72)",
          fontSize: "12px",
          fontWeight: 700,
        }}
      >
        Updated {formatUpdatedDate(latestUpdate)}
      </div>
    </div>
  )
}

const shellActionStyle: React.CSSProperties = {
  height: "50px",
  minWidth: "140px",
  borderRadius: "999px",
  border: "1px solid rgba(143, 215, 255, 0.46)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)",
  color: "#d7e8ff",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0 18px",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14), 0 14px 34px rgba(8,24,44,0.28), 0 0 0 1px rgba(90,169,255,0.16)",
  textDecoration: "none",
  fontSize: "14px",
  fontWeight: 700,
}
