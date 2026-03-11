"use client"

import { useEffect, useState } from "react"
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Tooltip,
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
  lat: number
  lng: number
  hsfo?: number
  vlsfo?: number
  mgo?: number
  hsfo_formula?: string
  vlsfo_formula?: string
  mgo_formula?: string
  supplier?: string
  lead_time?: string
}

const portsOrder = ["Kaohsiung", "Keelung", "Taichung", "Suao", "Hualien"]

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

function calculatePrice(formula: string, ports: Port[], fuel: keyof Port) {
  if (!formula || !ports) return null
  const parts = formula.trim().split(" ")
  if (parts.length !== 3) return null

  const refName = parts[0].toLowerCase()
  const operator = parts[1]
  const value = Number(parts[2])

  const refPort = ports.find((p) => p.name.toLowerCase() === refName)
  if (!refPort) return null

  const base = Number(refPort[fuel])
  if (isNaN(base)) return null

  if (operator === "+") return base + value
  if (operator === "-") return base - value

  return null
}

function ZoomHandler({ setZoom }: { setZoom: (z: number) => void }) {
  useMapEvents({
    zoomend: (e) => setZoom(e.target.getZoom()),
  })
  return null
}

function FlyToPort({ port }: { port: Port | null }) {
  const map = useMap()
  useEffect(() => {
    if (port) {
      map.flyTo([Number(port.lat), Number(port.lng)], 7)
    }
  }, [port, map])
  return null
}

export default function MapView() {
  const [ports, setPorts] = useState<Port[]>([])
  const [selectedPort, setSelectedPort] = useState<Port | null>(null)
  const [zoom, setZoom] = useState(4)

  useEffect(() => {
    const fetchPorts = async () => {
      const { data, error } = await supabase.from("ports").select("*")
      if (error) {
        console.error(error)
        return
      }
      if (!data) return

      // Calculate formula prices
      const calculatedPorts = data.map((p: Port) => {
        if (!p.vlsfo && p.vlsfo_formula) p.vlsfo = calculatePrice(p.vlsfo_formula, data, "vlsfo")
        if (!p.hsfo && p.hsfo_formula) p.hsfo = calculatePrice(p.hsfo_formula, data, "hsfo")
        if (!p.mgo && p.mgo_formula) p.mgo = calculatePrice(p.mgo_formula, data, "mgo")
        return p
      })

      // Sort by portOrder
      const sortedPorts = calculatedPorts.sort(
        (a, b) => portsOrder.indexOf(a.name) - portsOrder.indexOf(b.name)
      )

      setPorts(sortedPorts)
    }

    fetchPorts()
  }, [])

  return (
    <div style={{ position: "relative", height: "100vh" }}>
      <MapContainer center={[20, 120]} zoom={4} zoomControl={false} style={{ height: "100%", width: "100%" }}>
        <ZoomControl position="bottomright" />
        <ZoomHandler setZoom={setZoom} />
        <FlyToPort port={selectedPort} />

        {/* Base map */}
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
        />

        {/* Semi-transparent blue overlay */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            background: "rgba(3, 40, 85, 0.15)",
            pointerEvents: "none",
            zIndex: 10,
          }}
        />

        {/* Markers */}
        {ports.map((port) => (
          <Marker
            key={port.id}
            position={[Number(port.lat), Number(port.lng)]}
            icon={customIcon}
            eventHandlers={{
              click: () => setSelectedPort(port),
            }}
          >
            <Popup>
              <div style={{ width: "200px" }}>
                <b>{port.name}</b>
                <div>HSFO: {port.hsfo ?? "-"}</div>
                <div>VLSFO: {port.vlsfo ?? "-"}</div>
                <div>MGO: {port.mgo ?? "-"}</div>
                {port.supplier && <div>Supplier: {port.supplier}</div>}
                {port.lead_time && <div>Lead time: {port.lead_time}</div>}
              </div>
            </Popup>
            <Tooltip direction="top">{port.name}</Tooltip>
          </Marker>
        ))}
      </MapContainer>
    </div>
  )
}