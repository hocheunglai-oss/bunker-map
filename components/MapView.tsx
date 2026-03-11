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
import L from "leaflet"
import { supabase } from "../lib/supabase"



/* -----------------------------
FORMULA ENGINE
----------------------------- */

function calculatePrice(formula: string, ports: any[], fuel: string) {

  if (!formula) return null

  const parts = formula.trim().split(" ")
  if (parts.length !== 3) return null

  const refPortName = parts[0].toLowerCase()
  const operator = parts[1]
  const value = Number(parts[2])

  const refPort = ports.find(
    (p) => p.name?.toLowerCase() === refPortName
  )

  if (!refPort) return null

  const basePrice = Number(refPort[fuel])
  if (isNaN(basePrice)) return null

  if (operator === "+") return basePrice + value
  if (operator === "-") return basePrice - value

  return null
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
ZOOM LISTENER
----------------------------- */

function ZoomHandler({ setZoom }: any) {

  useMapEvents({
    zoomend: (e) => setZoom(e.target.getZoom()),
  })

  return null
}



/* -----------------------------
MAP FLY TO PORT
----------------------------- */

function FlyToPort({ port }: any) {

  const map = useMap()

  useEffect(() => {
    if (port) {
      map.flyTo([Number(port.lat), Number(port.lng)], 7)
    }
  }, [port, map])

  return null
}



/* =============================
MAIN MAP
============================= */

export default function MapView() {

  const [zoom, setZoom] = useState(4)
  const [ports, setPorts] = useState<any[]>([])
  const [selectedPort, setSelectedPort] = useState<any | null>(null)
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

      const { data, error } = await supabase
        .from("ports")
        .select("*")

      if (error) {
        console.error(error)
        return
      }

      let calculatedPorts = [...(data || [])]

      calculatedPorts = calculatedPorts.map((port) => {

        if (!port.vlsfo && port.vlsfo_formula) {
          const result = calculatePrice(port.vlsfo_formula, calculatedPorts, "vlsfo")
          if (result !== null) port.vlsfo = result
        }

        if (!port.hsfo && port.hsfo_formula) {
          const result = calculatePrice(port.hsfo_formula, calculatedPorts, "hsfo")
          if (result !== null) port.hsfo = result
        }

        if (!port.mgo && port.mgo_formula) {
          const result = calculatePrice(port.mgo_formula, calculatedPorts, "mgo")
          if (result !== null) port.mgo = result
        }

        return port
      })

      setPorts(calculatedPorts)

    }

    fetchPorts()

  }, [])



  /* -----------------------------
  SEARCH
  ----------------------------- */

  const suggestions =
    search.length > 0
      ? ports
          .filter((p) =>
            p.name.toLowerCase().includes(search.toLowerCase())
          )
          .slice(0, 5)
      : []

  const selectPort = (port: any) => {
    setSelectedPort(port)
    setSearch("")
  }



  return (
    <div style={{ position: "relative" }}>



      {/* SEARCH BAR */}

      <div
        style={{
          position: "absolute",
          top: "15px",
          left: "70px",
          zIndex: 1500,
        }}
      >

        <input
          placeholder="Search port..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            padding: "10px",
            width: "260px",
            borderRadius: "6px",
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
              width: "260px",
              boxShadow: "0 3px 8px rgba(0,0,0,0.15)",
              marginTop: "6px",
            }}
          >
            {suggestions.map((port) => (
              <div
                key={port.id}
                onClick={() => selectPort(port)}
                style={{
                  padding: "10px",
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
          className="blue-map"
        />

        {ports.map((port: any) => (
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
              </div>
            </Popup>

            <Tooltip direction="top" offset={[0, -10]}>
              {port.name}
            </Tooltip>

          </Marker>
        ))}

      </MapContainer>



      {/* MAP BLUE FILTER */}

      <style jsx global>{`
        .blue-map {
          filter: hue-rotate(360deg) saturate(900%) brightness(85%);
        }
      `}</style>

    </div>
  )
}