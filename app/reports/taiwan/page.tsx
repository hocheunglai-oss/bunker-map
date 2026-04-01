"use client"

import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"

type PriceRow = {
  port: string
  hsfo: { today: number | null; last: number | null; change: number | null }
  vlsfo: { today: number | null; last: number | null; change: number | null }
  mgo: { today: number | null; last: number | null; change: number | null }
}

const portsWanted = ["Kaohsiung", "Keelung", "Taichung", "Suao", "Hualien"]

export default function TaiwanReport() {
  const [rows, setRows] = useState<PriceRow[]>([])
  const [remark, setRemark] = useState("")
  const [reportDate, setReportDate] = useState("")

  useEffect(() => {
  async function load() {

    // fetch ports
    const { data: portsData } = await supabase
      .from("ports")
      .select("*")
      .in("name", portsWanted)

    if (!portsData) return
    const ports = portsData

    // fetch history
    const { data: historyData } = await supabase
      .from("price_history")
      .select("*")
      .order("recorded_at", { ascending: false })

    if (!historyData || historyData.length === 0) return
    const history = historyData

    // REPORT DATE = latest save
    const latest = history[0]
    const reportTime = new Date(latest.recorded_at)

    const formatted =
      String(reportTime.getDate()).padStart(2, "0") +
      " " +
      reportTime.toLocaleString("en-GB", { month: "short" }) +
      " " +
      reportTime.getFullYear()

    setReportDate(formatted)

    // helper
function getToday(portId: number) {
  const portHistory = history.filter((h: any) => h.port_id === portId)
  return portHistory[0] ?? null
}

function getLast(portId: number) {
  const portHistory = history.filter((h: any) => h.port_id === portId)
  return portHistory[1] ?? null
}

    function calc(formula: string, fuel: "hsfo" | "vlsfo" | "mgo") {
      const parts = formula.split(" ")
      if (parts.length !== 3) return null

      const refName = parts[0].toLowerCase()
      const operator = parts[1]
      const value = Number(parts[2])

      const ref = ports.find((p: any) => p.name.toLowerCase() === refName)
      if (!ref) return null

      const base = Number(ref[fuel])
      if (isNaN(base)) return null

      if (operator === "+") return base + value
      if (operator === "-") return base - value

      return null
    }

    const result: PriceRow[] = ports.map((p: any) => {

      const today = getToday(p.id)
      const last = getLast(p.id)

      let hsfo = p.hsfo
      let vlsfo = p.vlsfo
      let mgo = p.mgo

      if (!vlsfo && p.vlsfo_formula) vlsfo = calc(p.vlsfo_formula, "vlsfo")
      if (!mgo && p.mgo_formula) mgo = calc(p.mgo_formula, "mgo")
      if (!hsfo && p.hsfo_formula) hsfo = calc(p.hsfo_formula, "hsfo")

      const hsfoToday = p.name === "Kaohsiung" ? today?.hsfo ?? hsfo : null
      const hsfoLast = p.name === "Kaohsiung" ? last?.hsfo ?? null : null

let vlsfoToday = today?.vlsfo ?? vlsfo
let vlsfoLast = last?.vlsfo ?? null

let mgoToday = today?.mgo ?? mgo
let mgoLast = last?.mgo ?? null

// calculate LAST using formula if needed
if (p.vlsfo_formula && vlsfoLast == null) {
  const parts = p.vlsfo_formula.split(" ")
  const ref = ports.find((x:any)=>x.name.toLowerCase()===parts[0].toLowerCase())
  if(ref){
    const refLast = getLast(ref.id)
    const base = refLast?.vlsfo
    const value = Number(parts[2])
    if(base!=null){
      vlsfoLast = parts[1]==="+" ? base+value : base-value
    }
  }
}

if (p.mgo_formula && mgoLast == null) {
  const parts = p.mgo_formula.split(" ")
  const ref = ports.find((x:any)=>x.name.toLowerCase()===parts[0].toLowerCase())
  if(ref){
    const refLast = getLast(ref.id)
    const base = refLast?.mgo
    const value = Number(parts[2])
    if(base!=null){
      mgoLast = parts[1]==="+" ? base+value : base-value
    }
  }
}

      return {
        port: p.name,

        hsfo: {
          today: hsfoToday,
          last: hsfoLast,
          change:
            hsfoToday != null && hsfoLast != null
              ? hsfoToday - hsfoLast
              : null,
        },

        vlsfo: {
          today: vlsfoToday,
          last: vlsfoLast,
          change:
            vlsfoToday != null && vlsfoLast != null
              ? vlsfoToday - vlsfoLast
              : null,
        },

        mgo: {
          today: mgoToday,
          last: mgoLast,
          change:
            mgoToday != null && mgoLast != null
              ? mgoToday - mgoLast
              : null,
        },
      }
    })

    const portOrder = ["Kaohsiung", "Keelung", "Taichung", "Suao", "Hualien"]

    setRows(
      result.sort(
        (a, b) => portOrder.indexOf(a.port) - portOrder.indexOf(b.port)
      )
    )

    // load remarks
    const { data: remarkData } = await supabase
      .from("remarks")
      .select("*")
      .limit(1)
      .single()

    if (remarkData) setRemark(remarkData.content)
  }

  load()
}, [])

  function color(c: number | null) {
    if (c == null) return "white"
    if (c > 0) return "#27ae60"
    if (c < 0) return "#e63946"
    return "white"
  }

  function fmt(c: number | null) {
    if (c == null) return "-"
    if (c > 0) return "+" + c
    return c
  }

  function arrow(c: number | null) {
    if (c == null || c === 0) return ""
    return c > 0 ? " ▲" : " ▼"
  }

  return (
    <div
      style={{
        background: "#032855",
        color: "white",
        minHeight: "100vh",
        padding: "40px",
        fontFamily: "Arial",
      }}
    >
      {/* LOGO */}
      <div style={{ display: "flex", justifyContent: "center", marginBottom: "20px" }}>
        <img src="/logo.png" style={{ height: "140px" }} />
      </div>

      {/* TITLE */}
      <h1
        style={{
          textAlign: "center",
          textTransform: "uppercase",
          fontSize: "36px",
          fontWeight: "700",
          marginBottom: "10px",
        }}
      >
        Taiwan Posted Price Change
      </h1>

      {/* DATE */}
      <p
        style={{
          textAlign: "center",
          textTransform: "uppercase",
          fontSize: "16px",
          marginBottom: "30px",
        }}
      >
Date: {reportDate}
      </p>

      {/* BACK BUTTON */}
      <div style={{ textAlign: "center", marginBottom: "25px" }}>
        <a
          href="/"
          style={{
            background: "#e63946",
            color: "white",
            padding: "12px 26px",
            borderRadius: "6px",
            textDecoration: "none",
            fontWeight: "700",
            textTransform: "uppercase",
            letterSpacing: "1px",
          }}
        >
          Back To Bunker Map
        </a>
      </div>

      {/* TABLE */}
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "15px",
            boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
          }}
        >
          <thead>
            <tr style={{ background: "#0a355b" }}>
              <th
                rowSpan={2}
                style={{ padding: "12px", fontSize: "18px", borderRight: "2px solid #ffffff44" }}
              >
                Port
              </th>
              <th colSpan={3} style={{ borderRight: "2px solid #ffffff44" }}>
                HSFO
              </th>
              <th colSpan={3} style={{ borderRight: "2px solid #ffffff44" }}>
                VLSFO
              </th>
              <th colSpan={3}>LSMGO</th>
            </tr>
            <tr style={{ background: "#0a355b" }}>
              <th>Today</th>
              <th>Last</th>
              <th style={{ borderRight: "2px solid #ffffff44" }}>Change</th>
              <th>Today</th>
              <th>Last</th>
              <th style={{ borderRight: "2px solid #ffffff44" }}>Change</th>
              <th>Today</th>
              <th>Last</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={i}
                style={{
                  textAlign: "center",
                  background: i % 2 === 0 ? "#032e6f" : "#043b8b",
                  transition: "background 0.2s",
                }}
                onMouseEnter={(e: any) => {
                  e.currentTarget.style.background = "#0451a0"
                }}
                onMouseLeave={(e: any) => {
                  e.currentTarget.style.background = i % 2 === 0 ? "#032e6f" : "#043b8b"
                }}
              >
                <td
                  style={{
                    fontWeight: "700",
                    fontSize: "16px",
                    borderRight: "2px solid #ffffff44",
                  }}
                >
                  {r.port}
                </td>
                <td>{r.hsfo.today ?? "-"}</td>
                <td>{r.hsfo.last ?? "-"}</td>
                <td
                  style={{
                    fontWeight: "700",
                    color: color(r.hsfo.change),
                    borderRight: "2px solid #ffffff44",
                  }}
                >
                  {fmt(r.hsfo.change)}
                  {arrow(r.hsfo.change)}
                </td>

                <td>{r.vlsfo.today ?? "-"}</td>
                <td>{r.vlsfo.last ?? "-"}</td>
                <td
                  style={{
                    fontWeight: "700",
                    color: color(r.vlsfo.change),
                    borderRight: "2px solid #ffffff44",
                  }}
                >
                  {fmt(r.vlsfo.change)}
                  {arrow(r.vlsfo.change)}
                </td>

                <td>{r.mgo.today ?? "-"}</td>
                <td>{r.mgo.last ?? "-"}</td>
                <td
                  style={{
                    fontWeight: "700",
                    color: color(r.mgo.change),
                  }}
                >
                  {fmt(r.mgo.change)}
                  {arrow(r.mgo.change)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* REMARKS */}
      {remark && (
        <div
          style={{
            marginTop: "40px",
            padding: "20px",
            background: "#043b8b",
            borderRadius: "8px",
            fontSize: "14px",
            whiteSpace: "pre-line",
          }}
        >
          <strong>Remarks:</strong>
          <div style={{ marginTop: "8px" }}>{remark}</div>
        </div>
      )}

      {/* WHATSAPP */}
      <div
        style={{
          marginTop: "40px",
          padding: "20px",
          background: "#043b8b",
          borderRadius: "8px",
          textAlign: "center",
        }}
      >
        <p style={{ marginBottom: "12px" }}>
          If you need further information please contact us on WhatsApp
        </p>
        <a
          href="https://wa.me/85266885575"
          target="_blank"
          style={{
            background: "#25D366",
            color: "white",
            padding: "12px 24px",
            borderRadius: "6px",
            textDecoration: "none",
            fontWeight: "600",
            textTransform: "uppercase",
          }}
        >
          Contact Us On WhatsApp
        </a>
      </div>
    </div>
  )
}
