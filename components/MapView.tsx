"use client"

import { useEffect, useState } from "react"
import {
  MapContainer,
  TileLayer,
  Marker,
  Tooltip,
  Popup,
  ZoomControl,
  useMapEvents,
  useMap,
} from "react-leaflet"
import L, { LatLngExpression } from "leaflet"
import "leaflet/dist/leaflet.css"
import { supabase } from "@/lib/supabase"

interface Port {
  id: number
  name: string
  lat: string
  lng: string
  hsfo?: number
  vlsfo?: number
  mgo?: number
  hsfo_formula?: string
  vlsfo_formula?: string
  mgo_formula?: string
  supplier?: string
  lead_time?: string
}

interface Price {
  today?: number
  last?: number
  change?: number
}

/* -----------------------------
FORMULA ENGINE
----------------------------- */

function calculatePrice(
  formula: string,
  ports: Port[],
  fuel: "hsfo" | "vlsfo" | "mgo"
): number | undefined {
  if (!formula) return undefined

  const parts = formula.trim().split(" ")
  if (parts.length !== 3) return undefined

  const refPortName = parts[0].toLowerCase()
  const operator = parts[1]
  const value = Number(parts[2])

  const refPort = ports.find((p) => p.name?.toLowerCase() === refPortName)
  if (!refPort) return undefined

  const basePrice = Number(refPort[fuel])
  if (isNaN(basePrice)) return undefined

  if (operator === "+") return basePrice + value
  if (operator === "-") return basePrice - value

  return undefined
}

/* -----------------------------
MARKER ICON
----------------------------- */

const customIcon = new L.DivIcon({
  className: "",
  html: `
  <div style="
    width:14px;
    height:14px;
    background:#2563eb;
    border-radius:50%;
    border:2px solid white;
    box-shadow:0 0 6px rgba(0,0,0,0.4);
  "></div>
  `,
})

/* -----------------------------
ZOOM HANDLER
----------------------------- */

function ZoomHandler({ setZoom }: { setZoom: (z: number) => void }) {
  useMapEvents({
    zoomend: (e) => setZoom(e.target.getZoom()),
  })
  return null
}

/* -----------------------------
FLY TO PORT
----------------------------- */

function FlyToPort({ port }: { port: Port | null }) {
  const map = useMap()

  useEffect(() => {
    if (port) {
      map.flyTo([Number(port.lat), Number(port.lng)], 7)
    }
  }, [port, map])

  return null
}

/* =============================
MAIN MAP COMPONENT
============================= */

export default function MapView() {
  const [zoom, setZoom] = useState(4)
  const [ports, setPorts] = useState<Port[]>([])
  const [selectedPort, setSelectedPort] = useState<Port | null>(null)
  const [search, setSearch] = useState("")
  const [user, setUser] = useState<any>(null)

  /* -----------------------------
  LOGIN CHECK
  ----------------------------- */

  useEffect(() => {
    const getUser = async () => {
      const { data } = await supabase.auth.getUser()
      setUser(data.user)
    }
    getUser()
  }, [])

  /* -----------------------------
  FETCH PORT DATA
  ----------------------------- */

  useEffect(() => {
    const fetchPorts = async () => {
      const { data, error } = await supabase.from("ports").select("*")
      if (error) return console.error(error)
      if (!data) return

      const calculatedPorts: Port[] = data.map((p) => {
        if (!p.vlsfo && p.vlsfo_formula)
          p.vlsfo = calculatePrice(p.vlsfo_formula, data, "vlsfo")
        if (!p.hsfo && p.hsfo_formula)
          p.hsfo = calculatePrice(p.hsfo_formula, data, "hsfo")
        if (!p.mgo && p.mgo_formula)
          p.mgo = calculatePrice(p.mgo_formula, data, "mgo")
        return p
      })

      setPorts(calculatedPorts)
    }
    fetchPorts()
  }, [])

  /* -----------------------------
  SEARCH SUGGESTIONS
  ----------------------------- */

  const suggestions = search.length
    ? ports
        .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
        .slice(0, 5)
    : []

  const selectPort = (port: Port) => {
    setSelectedPort(port)
    setSearch("")
  }

  /* -----------------------------
  UTILITY FUNCTIONS
  ----------------------------- */

  const color = (c?: number) => {
    if (c == null) return "white"
    if (c > 0) return "#27ae60"
    if (c < 0) return "#e63946"
    return "white"
  }

  const fmt = (c?: number) => {
    if (c == null) return "-"
    if (c > 0) return "+" + c
    return c
  }

  const arrow = (c?: number) => {
    if (c == null || c === 0) return ""
    return c > 0 ? " ▲" : " ▼"
  }

  return (
    <div style={{ position: "relative" }}>
      {/* SEARCH BAR */}
      <div
        style={{
          position: "absolute",
          top: 15,
          left: 70,
          zIndex: 1200,
        }}
      >
        <input
          placeholder="Search port..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            padding: 10,
            width: 260,
            borderRadius: 6,
            border: "1px solid #ccc",
            background: "white",
            boxShadow: "0 2px 6px rgba(0,0,0,0.2)",
            color: "#111",
          }}
        />
        {suggestions.length > 0 && (
          <div
            style={{
              background: "white",
              border: "1px solid #ddd",
              width: 260,
              boxShadow: "0 3px 8px rgba(0,0,0,0.15)",
              marginTop: 6,
            }}
          >
            {suggestions.map((port) => (
              <div
                key={port.id}
                onClick={() => selectPort(port)}
                style={{
                  padding: 10,
                  cursor: "pointer",
                  borderBottom: "1px solid #eee",
                  color: "#111",
                  fontWeight: 500,
                }}
              >
                {port.name}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* MAP */}
      <MapContainer
        center={[20, 100]}
        zoom={4}
        zoomControl={false}
        className="h-screen w-full"
      >
        <ZoomControl position="bottomright" />
        <ZoomHandler setZoom={setZoom} />
        <FlyToPort port={selectedPort} />

        <TileLayer
          attribution="&copy; OpenStreetMap contributors"
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
        />

        {/* BLUE OVERLAY */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            backgroundColor: "rgba(0,100,255,0.15)",
            pointerEvents: "none",
            zIndex: 500,
          }}
        />

        {ports.map((port) => (
          <Marker
            key={port.id}
            position={[Number(port.lat), Number(port.lng)]}
            icon={customIcon}
            eventHandlers={{ click: () => setSelectedPort(port) }}
          >
            <Popup>
              <div style={{ width: 200 }}>
                <b>{port.name}</b>
                <div>HSFO: {port.hsfo ?? "-"}</div>
                <div>VLSFO: {port.vlsfo ?? "-"}</div>
                <div>MGO: {port.mgo ?? "-"}</div>
              </div>
            </Popup>
            <Tooltip direction="top" offset={[0, -10]}>
              {port.name}
            </Tooltip>
          </Marker>
        ))}
      </MapContainer>

      {/* FLOATING PORT CARD */}
      {selectedPort && (
        <div
          style={{
            position: "absolute",
            top: 80,
            left: 70,
            width: 320,
            background: "white",
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
            overflow: "hidden",
            zIndex: 1100,
          }}
        >
          <img
            src="https://career.cosulich.com/storage/loghi_preview_corporate/fratelli_cosulich_bunkers_hk.jpg"
            style={{
              width: "100%",
              height: 140,
              objectFit: "contain",
              padding: 10,
              background: "white",
            }}
          />
          <div style={{ padding: 16 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <h3 style={{ fontSize: 20, fontWeight: "bold", color: "#111" }}>
                {selectedPort.name}
              </h3>
              <button
                onClick={() => setSelectedPort(null)}
                style={{
                  border: "none",
                  background: "none",
                  fontSize: 18,
                  cursor: "pointer",
                }}
              >
                ✕
              </button>
            </div>
            <div style={{ marginTop: 10, color: "#111" }}>
              <p>HSFO: {selectedPort.hsfo ?? "-"}</p>
              <p>VLSFO: {selectedPort.vlsfo ?? "-"}</p>
              <p>MGO: {selectedPort.mgo ?? "-"}</p>
            </div>
            {user && (
              <div style={{ marginTop: 10, color: "#444" }}>
                <p>Supplier: {selectedPort.supplier ?? "-"}</p>
                <p>Lead time: {selectedPort.lead_time ?? "-"}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}