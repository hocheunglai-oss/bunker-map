"use client"

import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"

const portsWanted = ["Kaohsiung", "Keelung", "Taichung", "Suao", "Hualien"]

interface Port {
  id: number
  name: string
  hsfo: number | null
  vlsfo: number | null
  mgo: number | null
  hsfo_formula?: string
  vlsfo_formula?: string
  mgo_formula?: string
}

interface Price {
  today: number | null
  last: number | null
  change: number | null
}

interface Row {
  port: string
  hsfo: Price
  vlsfo: Price
  mgo: Price
}

export default function TaiwanReport() {
  const [rows, setRows] = useState<Row[]>([])
  const [remarks, setRemarks] = useState<string>("")
  const [isAdmin, setIsAdmin] = useState<boolean>(false)
  const todayDate = new Date().toLocaleDateString("en-GB")

  /* -----------------------------
     SAFELY CALCULATE FORMULA
  ----------------------------- */
  function calculatePrice(formula: string, ports: Port[] | null, fuel: keyof Port): number | null {
    if (!formula || !ports) return null
    const parts = formula.trim().split(" ")
    if (parts.length !== 3) return null
    const refPortName = parts[0].toLowerCase()
    const operator = parts[1]
    const value = Number(parts[2])

    const ref = ports.find((p) => p.name?.toLowerCase() === refPortName)
    if (!ref) return null
    const basePrice = Number(ref[fuel])
    if (isNaN(basePrice)) return null

    if (operator === "+") return basePrice + value
    if (operator === "-") return basePrice - value
    return null
  }

  /* -----------------------------
     FETCH DATA
  ----------------------------- */
  useEffect(() => {
    const load = async () => {
      const { data: ports, error: portsError } = await supabase
        .from("ports")
        .select("*")
        .in("name", portsWanted)
      if (!ports || portsError) return

      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)

      const { data: history } = await supabase
        .from("price_history")
        .select("*")
        .order("recorded_at", { ascending: false })

      if (!history) return

      function getLast(portId: number) {
        return history.find(h => h.port_id === portId && new Date(h.recorded_at) < todayStart) || null
      }

      const result: Row[] = portsWanted.map((name) => {
        const p = ports.find(port => port.name === name)!
        let hsfo = p.hsfo
        let vlsfo = p.vlsfo
        let mgo = p.mgo

        if (!vlsfo && p.vlsfo_formula) vlsfo = calculatePrice(p.vlsfo_formula, ports, "vlsfo")
        if (!mgo && p.mgo_formula) mgo = calculatePrice(p.mgo_formula, ports, "mgo")
        if (!hsfo && p.hsfo_formula) hsfo = calculatePrice(p.hsfo_formula, ports, "hsfo")

        let historyPort = p
        if (p.vlsfo_formula) {
          const refName = p.vlsfo_formula.split(" ")[0]
          const refPort = ports.find(x => x.name.toLowerCase() === refName.toLowerCase())
          if (refPort) historyPort = refPort
        }

        const last = getLast(historyPort.id)

        const hsfoToday = p.name === "Kaohsiung" ? hsfo : null
        const hsfoLast = p.name === "Kaohsiung" ? last?.hsfo ?? null : null
        const vlsfoLast = last?.vlsfo ?? null
        const mgoLast = last?.mgo ?? null

        return {
          port: p.name,
          hsfo: {
            today: hsfoToday,
            last: hsfoLast,
            change: hsfoToday != null && hsfoLast != null ? hsfoToday - hsfoLast : null
          },
          vlsfo: {
            today: vlsfo,
            last: vlsfoLast,
            change: vlsfo != null && vlsfoLast != null ? vlsfo - vlsfoLast : null
          },
          mgo: {
            today: mgo,
            last: mgoLast,
            change: mgo != null && mgoLast != null ? mgo - mgoLast : null
          }
        }
      })

      setRows(result)

      // Load remarks
      const { data: remarksData } = await supabase.from("remarks").select("content").single()
      setRemarks(remarksData?.content ?? "")

      // Check admin
      const { data: userData } = await supabase.auth.getUser()
      setIsAdmin(userData?.user?.email === "your-admin-email@example.com")
    }

    load()
  }, [])

  /* -----------------------------
     COLOR AND FORMAT
  ----------------------------- */
  function color(c: number | null) {
    if (c == null) return "white"
    if (c > 0) return "#1fa97a"
    if (c < 0) return "#e63946"
    return "white"
  }

  function fmt(c: number | null) {
    if (c == null) return "-"
    if (c > 0) return "+" + c
    return c
  }

  /* -----------------------------
     SAVE REMARKS (ADMIN)
  ----------------------------- */
  const saveRemarks = async () => {
    await supabase.from("remarks").upsert({ id: 1, content: remarks })
  }

  return (
    <div style={{ background: "#032855", color: "white", minHeight: "100vh", padding: 40, fontFamily: "'Arial', sans-serif" }}>
      
      {/* Logo */}
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
        <img src="/logo.png" alt="Logo" style={{ height: 150, objectFit: "contain" }} />
      </div>

      {/* Title */}
      <h1 style={{ textAlign: "center", textTransform: "uppercase", fontSize: 36, fontWeight: 700, marginBottom: 10, fontFamily: "'Helvetica Neue', sans-serif" }}>
        Taiwan Posted Price Change
      </h1>
      <p style={{ textAlign: "center", textTransform: "uppercase", fontSize: 16, letterSpacing: 1, marginBottom: 30, fontFamily: "'Helvetica Neue', sans-serif" }}>
        Date: {todayDate}
      </p>

      {/* Back to Map Button */}
      <div style={{ textAlign: "center", marginBottom: 20 }}>
        <a href="/" style={{
          backgroundColor: "#e63946",
          color: "white",
          textTransform: "uppercase",
          fontWeight: 700,
          fontSize: 16,
          padding: "12px 24px",
          borderRadius: 6,
          textDecoration: "none",
          boxShadow: "0 4px 8px rgba(0,0,0,0.3)",
          transition: "all 0.2s ease-in-out"
        }}>
          Back to Bunker Map
        </a>
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 15, borderRadius: 8, overflow: "hidden", boxShadow: "0 4px 12px rgba(0,0,0,0.3)" }}>
          <thead>
            <tr style={{ background: "#0a355b", color: "white" }}>
              <th rowSpan={2} style={{ padding: 12, fontSize: 18, borderRight: "2px solid #ffffff44" }}>Port</th>
              <th colSpan={3} style={{ padding: 10, fontSize: 14, borderRight: "2px solid #ffffff22" }}>HSFO</th>
              <th colSpan={3} style={{ padding: 10, fontSize: 14, borderRight: "2px solid #ffffff22" }}>VLSFO</th>
              <th colSpan={3} style={{ padding: 10, fontSize: 14 }}>LSMGO</th>
            </tr>
            <tr style={{ background: "#0a355b", color: "white" }}>
              <th style={{ padding: 8, fontSize: 13 }}>Today</th>
              <th style={{ padding: 8, fontSize: 13 }}>Last</th>
              <th style={{ padding: 8, fontSize: 13, borderRight: "2px solid #ffffff44" }}>Change</th>

              <th style={{ padding: 8, fontSize: 13 }}>Today</th>
              <th style={{ padding: 8, fontSize: 13 }}>Last</th>
              <th style={{ padding: 8, fontSize: 13, borderRight: "2px solid #ffffff44" }}>Change</th>

              <th style={{ padding: 8, fontSize: 13 }}>Today</th>
              <th style={{ padding: 8, fontSize: 13 }}>Last</th>
              <th style={{ padding: 8, fontSize: 13 }}>Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}
                style={{
                  textAlign: "center",
                  background: i % 2 === 0 ? "#032e6f" : "#043b8b",
                  transition: "background 0.3s",
                  cursor: "default"
                }}
                onMouseEnter={(e: any) => e.currentTarget.style.background = "#0451a0"}
                onMouseLeave={(e: any) => e.currentTarget.style.background = i % 2 === 0 ? "#032e6f" : "#043b8b"}
              >
                <td style={{ fontWeight: 700, fontSize: 16, padding: 8, borderRight: "2px solid #ffffff44" }}>{r.port}</td>

                <td style={{ fontSize: 14 }}>{r.hsfo.today ?? "-"}</td>
                <td style={{ fontSize: 14 }}>{r.hsfo.last ?? "-"}</td>
                <td style={{ fontSize: 14, color: color(r.hsfo.change), fontWeight: "700" }}>{fmt(r.hsfo.change)}</td>

                <td style={{ fontSize: 14 }}>{r.vlsfo.today ?? "-"}</td>
                <td style={{ fontSize: 14 }}>{r.vlsfo.last ?? "-"}</td>
                <td style={{ fontSize: 14, color: color(r.vlsfo.change), fontWeight: "700" }}>{fmt(r.vlsfo.change)}</td>

                <td style={{ fontSize: 14 }}>{r.mgo.today ?? "-"}</td>
                <td style={{ fontSize: 14 }}>{r.mgo.last ?? "-"}</td>
                <td style={{ fontSize: 14, color: color(r.mgo.change), fontWeight: "700" }}>{fmt(r.mgo.change)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Remarks */}
      <div style={{ marginTop: 40, padding: 20, background: "#043b8b", borderRadius: 8 }}>
        <p style={{ marginBottom: 12, fontWeight: 600 }}>Remarks:</p>
        {isAdmin ? (
          <textarea
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            style={{
              width: "100%",
              minHeight: 100,
              borderRadius: 6,
              padding: 10,
              fontSize: 14,
              resize: "vertical"
            }}
          />
        ) : (
          <p style={{ whiteSpace: "pre-wrap" }}>{remarks}</p>
        )}
        {isAdmin && (
          <button
            onClick={saveRemarks}
            style={{
              marginTop: 10,
              backgroundColor: "#1fa97a",
              color: "white",
              fontWeight: 700,
              padding: "10px 20px",
              borderRadius: 6,
              cursor: "pointer",
              textTransform: "uppercase"
            }}
          >
            Save Remarks
          </button>
        )}
      </div>
    </div>
  )
}