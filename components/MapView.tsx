"use client"

import { useEffect, useState, useRef } from "react"
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from "react-leaflet"
import "leaflet/dist/leaflet.css"
import { supabase } from "@/lib/supabase"
import L from "leaflet"
import { useRouter } from "next/navigation"

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

export default function MapView() {

  const [ports, setPorts] = useState<Port[]>([])
  const [search, setSearch] = useState("")
  const [results, setResults] = useState<Port[]>([])
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [reportsOpen, setReportsOpen] = useState(false)

  const mapRef = useRef<L.Map | null>(null)
  const router = useRouter()

  useEffect(() => {

    async function loadPorts() {

      const { data } = await supabase.from("ports").select("*")

      if (!data) return

      const processed = data.map((p: Port) => {

        const calc = (formula: string, fuel: "hsfo" | "vlsfo" | "mgo") => {

          const parts = formula.split(" ")

          if (parts.length !== 3) return null

          const refName = parts[0].toLowerCase()
          const operator = parts[1]
          const value = Number(parts[2])

          const ref = data.find((x: Port) =>
            x.name.toLowerCase() === refName
          )

          if (!ref || ref[fuel] == null) return null

          if (operator === "+") return ref[fuel]! + value
          if (operator === "-") return ref[fuel]! - value

          return null
        }

        const hsfo = p.hsfo ?? (p.hsfo_formula ? calc(p.hsfo_formula, "hsfo") : null)
        const vlsfo = p.vlsfo ?? (p.vlsfo_formula ? calc(p.vlsfo_formula, "vlsfo") : null)
        const mgo = p.mgo ?? (p.mgo_formula ? calc(p.mgo_formula, "mgo") : null)

        return { ...p, hsfo, vlsfo, mgo }

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

    const filtered = ports.filter((p) =>
      p.name.toLowerCase().includes(search.toLowerCase())
    )

    setResults(filtered.slice(0, 8))
    setSelectedIndex(-1)

  }, [search, ports])

  function zoomToPort(port: Port) {

    if (!mapRef.current || !port.lat || !port.lng) return

    mapRef.current.setView([port.lat, port.lng], 7)

  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {

    if (results.length === 0) return

    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelectedIndex((prev) =>
        prev < results.length - 1 ? prev + 1 : prev
      )
    }

    if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelectedIndex((prev) =>
        prev > 0 ? prev - 1 : prev
      )
    }

    if (e.key === "Enter") {

      e.preventDefault()

      let port = results[selectedIndex]

      if (!port && results.length === 1) port = results[0]

      if (port) {
        zoomToPort(port)
        setSearch(port.name)
        setResults([])
      }

    }

  }

  function MapController() {
    const map = useMap()
    mapRef.current = map
    return null
  }

  function ZoomControls() {

    const map = useMap()

    return (

      <div
        style={{
          position: "absolute",
          bottom: 20,
          right: 20,
          zIndex: 1000,
          display: "flex",
          flexDirection: "column"
        }}
      >

        <button
          onClick={() => map.zoomIn()}
          style={{
            marginBottom: 5,
            padding: "6px 12px",
            background: "#0a3d62",
            color: "white",
            border: "none",
            borderRadius: 4,
            cursor: "pointer"
          }}
        >
          +
        </button>

        <button
          onClick={() => map.zoomOut()}
          style={{
            padding: "6px 12px",
            background: "#0a3d62",
            color: "white",
            border: "none",
            borderRadius: 4,
            cursor: "pointer"
          }}
        >
          −
        </button>

      </div>

    )

  }

  const center: [number, number] = [20, 0]

  return (

    <div style={{ height: "100vh", width: "100%", position: "relative" }}>

      {/* Logo */}

      <img
        src="/logo-trans.png"
        alt="Logo"
        style={{
          position: "absolute",
          top: 20,
          left: 20,
          zIndex: 1000,
          height: 70
        }}
      />

      {/* Search */}

      <div
        style={{
          position: "absolute",
          top: 110,
          left: 20,
          zIndex: 1000,
          width: 260
        }}
      >

        <input
          type="text"
          placeholder="Search port..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{
            width: "100%",
            padding: "10px",
            borderRadius: 6,
            border: "1px solid #ccc",
            background: "white"
          }}
        />

        {results.length > 0 && (

          <div
            style={{
              background: "white",
              border: "1px solid #ccc",
              borderTop: "none"
            }}
          >

            {results.map((p, i) => (

              <div
                key={p.id}
                onClick={() => {
                  zoomToPort(p)
                  setSearch(p.name)
                  setResults([])
                }}
                style={{
                  padding: 8,
                  cursor: "pointer",
                  background: i === selectedIndex ? "#e6f2ff" : "white"
                }}
              >
                {p.name}
              </div>

            ))}

          </div>

        )}

      </div>

      {/* MARKET REPORT BUTTON */}

      <div
        style={{
          position: "absolute",
          bottom: 20,
          left: 20,
          zIndex: 1000
        }}
      >

        {reportsOpen && (

          <div
            style={{
              background: "white",
              borderRadius: 6,
              boxShadow: "0 4px 10px rgba(0,0,0,0.15)",
              marginBottom: 8
            }}
          >

            <div
              onClick={() => router.push("/reports/taiwan")}
              style={{
                padding: "10px 14px",
                cursor: "pointer",
                whiteSpace: "nowrap"
              }}
            >
              Taiwan Posted Price Change
            </div>

          </div>

        )}

        <button
          onClick={() => setReportsOpen(!reportsOpen)}
          style={{
            background: "#0a3d62",
            color: "white",
            border: "none",
            borderRadius: 6,
            padding: "10px 16px",
            cursor: "pointer",
            fontWeight: 500
          }}
        >
          Market Reports
        </button>

      </div>

      <MapContainer
        center={center}
        zoom={3}
        zoomControl={false}
        style={{ height: "100%", width: "100%" }}
      >

        <MapController />

        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="© OpenStreetMap"
        />

        {ports.map((p) => {

          if (!p.lat || !p.lng) return null

          const updatedDate =
            p.recorded_at ||
            p.updated_at ||
            p.date ||
            "-"

          return (

            <CircleMarker
              key={p.id}
              center={[p.lat, p.lng]}
              radius={6}
              color="#1e90ff"
              fillColor="#1e90ff"
              fillOpacity={1}
            >

              <Popup>

                <strong>{p.name}</strong>
                <br />
                HSFO: {p.hsfo ?? "-"}
                <br />
                VLSFO: {p.vlsfo ?? "-"}
                <br />
                LSMGO: {p.mgo ?? "-"}
                <br />
                Updated: {updatedDate}

              </Popup>

            </CircleMarker>

          )

        })}

        <ZoomControls />

      </MapContainer>

    </div>

  )

}