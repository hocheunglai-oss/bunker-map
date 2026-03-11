"use client"

import { useEffect, useState } from "react"
import { supabase } from "../../../lib/supabase"

const portsWanted = ["Kaohsiung","Keelung","Taichung","Suao","Hualien"]

export default function TaiwanReport() {
  const [rows, setRows] = useState<any[]>([])
  const [remark, setRemark] = useState("")

  const todayDate = new Date().toLocaleDateString("en-GB")

  useEffect(() => {
    async function load() {
      const { data: ports } = await supabase
        .from("ports")
        .select("*")
        .in("name", portsWanted)

      if (!ports || ports.length === 0) return

      const todayStart = new Date()
      todayStart.setHours(0,0,0,0)

      const { data: history } = await supabase
        .from("price_history")
        .select("*")
        .order("recorded_at", { ascending: false })

      const getLast = (portId: number) =>
        history?.find(h => h.port_id === portId && new Date(h.recorded_at) < todayStart) ?? null

      // Always pass ports array, so TypeScript knows it's not null
      const calc = (formula: string | null, fuel: string, portsNonNull: any[]) => {
        if (!formula) return null
        const parts = formula.trim().split(" ")
        if (parts.length !== 3) return null

        const refName = parts[0].toLowerCase()
        const operator = parts[1]
        const value = Number(parts[2])

        const ref = portsNonNull.find(p => p.name?.toLowerCase() === refName)
        if (!ref) return null

        const base = Number(ref[fuel])
        if (isNaN(base)) return null

        if (operator === "+") return base + value
        if (operator === "-") return base - value
        return null
      }

      const result = ports.map((p: any) => {
        let hsfo = p.hsfo
        let vlsfo = p.vlsfo
        let mgo = p.mgo

        if (!vlsfo && p.vlsfo_formula) vlsfo = calc(p.vlsfo_formula, "vlsfo", ports)
        if (!mgo && p.mgo_formula) mgo = calc(p.mgo_formula, "mgo", ports)
        if (!hsfo && p.hsfo_formula) hsfo = calc(p.hsfo_formula, "hsfo", ports)

        let historyPort = p
        if (p.vlsfo_formula) {
          const ref = p.vlsfo_formula.split(" ")[0]
          const refPort = ports.find(x => x.name?.toLowerCase() === ref.toLowerCase())
          if (refPort) historyPort = refPort
        }

        const last = getLast(historyPort.id)

        const hsfoToday = p.name === "Kaohsiung" ? hsfo : null
        const hsfoLast = p.name === "Kaohsiung" ? last?.hsfo ?? null : null
        const vlsfoLast = last?.vlsfo ?? null
        const mgoLast = last?.mgo ?? null

        return {
          port: p.name,
          hsfo: { today: hsfoToday, last: hsfoLast, change: hsfoToday != null && hsfoLast != null ? hsfoToday - hsfoLast : null },
          vlsfo: { today: vlsfo, last: vlsfoLast, change: vlsfo != null && vlsfoLast != null ? vlsfo - vlsfoLast : null },
          mgo: { today: mgo, last: mgoLast, change: mgo != null && mgoLast != null ? mgo - mgoLast : null }
        }
      })

      const portOrder = ["Kaohsiung","Keelung","Taichung","Suao","Hualien"]
      setRows(result.sort((a,b) => portOrder.indexOf(a.port) - portOrder.indexOf(b.port)))

      const { data: remarkData } = await supabase
        .from("remarks")
        .select("*")
        .limit(1)
        .single()
      if (remarkData) setRemark(remarkData.content)
    }

    load()
  }, [])

  const color = (c: any) => c == null ? "white" : c > 0 ? "#27ae60" : c < 0 ? "#e63946" : "white"
  const fmt = (c: any) => c == null ? "-" : c > 0 ? "+" + c : c
  const arrow = (c: any) => c == null || c === 0 ? "" : c > 0 ? " ▲" : " ▼"

  return (
    <div style={{ background: "#032855", color: "white", minHeight:"100vh", padding:"40px", fontFamily:"Arial" }}>
      {/* Table and rest of your JSX here */}
      {/* ... keep the previous table, remarks, and WhatsApp section */}
    </div>
  )
}