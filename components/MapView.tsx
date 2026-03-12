"use client"

import { useEffect, useState } from "react"
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet"
import L from "leaflet"
import "leaflet/dist/leaflet.css"
import { supabase } from "@/lib/supabase"

interface Port {
  id: number
  name: string
  lat: number | null
  lng: number | null
  vlsfo?: number | null
  hsfo?: number | null
  mgo?: number | null
}

export default function MapView() {

  const [ports, setPorts] = useState<Port[]>([])
  const [search, setSearch] = useState("")
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const center: [number, number] = [25, 121]

  useEffect(() => {
    loadPorts()
  }, [])

  async function loadPorts() {

    const { data, error } = await supabase
      .from("ports")
      .select("*")

    if (error) {
      console.error("Supabase error:", error)
      return
    }

    if (!data) {
      setPorts([])
      return
    }

    // Filter ports with valid coordinates
    const safePorts = data.filter(
      (p: Port) => p.lat !== null && p.lng !== null
    )

    setPorts(safePorts)
  }

  const filteredPorts = ports.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase())
  )

  const markerIcon = new L.Icon({
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
          zIndex: 2000,
          padding: 20,
        }}
      >
        <div
          style={{ fontSize: 24, cursor: "pointer", marginBottom: 30 }}
          onClick={() => setSidebarOpen(false)}
        >
          ✕
        </div>

        <h2>Market Reports</h2>

        <a
          href="/reports/taiwan"
          style={{
            display: "block",
            marginTop: 20,
            color: "white",
            textDecoration: "none",
            fontSize: 16,
          }}
        >
          Taiwan Market Report
        </a>
      </div>

      {/* HAMBURGER MENU */}
      <div
        onClick={() => setSidebarOpen(true)}
        style={{
          position: "absolute",
          top: 20,
          left: 20,
          zIndex: 1500,
          fontSize: 26,
          cursor: "pointer",
          background: "white",
          padding: "6px 12px",
          borderRadius: 6,
          boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
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
          zIndex: 1500,
        }}
      >
        <img
          src="/logo.png"
          style={{ width: 150 }}
        />
      </div>

      {/* SEARCH BAR */}
      <div
        style={{
          position: "absolute",
          top: 70,
          left: 20,
          zIndex: 1500,
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
        center={center}
        zoom={5}
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer
          attribution='© OpenStreetMap'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {filteredPorts.map((port) => (
          <Marker
            key={port.id}
            position={[port.lat as number, port.lng as number]}
            icon={markerIcon}
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