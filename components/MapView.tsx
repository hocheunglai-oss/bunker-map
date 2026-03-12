"use client"

import { useEffect, useState } from "react"
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet"
import L, { LatLngExpression } from "leaflet"
import "leaflet/dist/leaflet.css"
import { supabase } from "@/lib/supabase"

interface Port {
  id: number
  name: string
  lat: number
  lng: number
  vlsfo?: number | null
  hsfo?: number | null
  mgo?: number | null
}

export default function MapView() {
  const [ports, setPorts] = useState<Port[]>([])
  const [search, setSearch] = useState("")
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const position: LatLngExpression = [25, 121]

  useEffect(() => {
    fetchPorts()
  }, [])

  async function fetchPorts() {
    const { data, error } = await supabase.from("ports").select("*")

    if (error) {
      console.error(error)
      return
    }

    if (data) {
      setPorts(data)
    }
  }

  const filteredPorts = ports.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase())
  )

  const icon = new L.Icon({
    iconUrl:
      "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
    iconSize: [25, 41],
    iconAnchor: [12, 41],
  })

  return (
    <div style={{ height: "100vh", width: "100%" }}>

      {/* SIDEBAR */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: sidebarOpen ? 0 : -260,
          width: 260,
          height: "100%",
          background: "#032855",
          color: "white",
          transition: "left 0.3s",
          zIndex: 1500,
          padding: 20,
        }}
      >
        <div
          onClick={() => setSidebarOpen(false)}
          style={{
            fontSize: 24,
            cursor: "pointer",
            marginBottom: 30,
          }}
        >
          ✕
        </div>

        <h2 style={{ marginBottom: 20 }}>Market Reports</h2>

        <a
          href="/reports/taiwan"
          style={{
            display: "block",
            padding: "10px 0",
            color: "white",
            textDecoration: "none",
            borderBottom: "1px solid rgba(255,255,255,0.2)",
          }}
        >
          Taiwan Market Report
        </a>
      </div>

      {/* HAMBURGER */}
      <div
        onClick={() => setSidebarOpen(true)}
        style={{
          position: "absolute",
          top: 20,
          left: 20,
          zIndex: 1200,
          fontSize: 26,
          cursor: "pointer",
          background: "white",
          padding: "4px 10px",
          borderRadius: 6,
          boxShadow: "0 2px 6px rgba(0,0,0,0.25)",
        }}
      >
        ☰
      </div>

      {/* LOGO */}
      <div
        style={{
          position: "absolute",
          top: 15,
          left: 70,
          zIndex: 1200,
        }}
      >
        <img
          src="/logo.png"
          style={{
            width: 150,
          }}
        />
      </div>

      {/* SEARCH BAR */}
      <div
        style={{
          position: "absolute",
          top: 70,
          left: 20,
          zIndex: 1200,
        }}
      >
        <input
          type="text"
          placeholder="Search port..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            padding: "10px",
            width: 220,
            borderRadius: 6,
            border: "1px solid #ccc",
            boxShadow: "0 2px 6px rgba(0,0,0,0.2)",
          }}
        />
      </div>

      {/* MAP */}
      <MapContainer
        center={position}
        zoom={5}
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {filteredPorts.map((port) => (
          <Marker
            key={port.id}
            position={[port.lat, port.lng]}
            icon={icon}
          >
            <Popup>
              <strong>{port.name}</strong>
              <br />
              VLSFO: {port.vlsfo ?? "-"}
              <br />
              HSFO: {port.hsfo ?? "-"}
              <br />
              MGO: {port.mgo ?? "-"}
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  )
}