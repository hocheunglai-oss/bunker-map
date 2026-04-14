"use client"

import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

type PortRow = {
  id: string
  name: string
  country_name: string | null
  notes: string | null
  summary: string | null
  created_at: string
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "linear-gradient(180deg, #0a2c4c 0%, #06213b 32%, #041629 100%)",
  fontFamily: "Arial, Helvetica, sans-serif",
  color: "#edf7ff",
  padding: "18px",
}

const panelStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, rgba(14, 43, 70, 0.88) 0%, rgba(7, 26, 44, 0.86) 100%)",
  border: "1px solid rgba(210, 236, 255, 0.14)",
  borderRadius: "18px",
  boxShadow: "0 20px 44px rgba(0, 0, 0, 0.18), inset 0 1px 0 rgba(255,255,255,0.05)",
}

const tableStyle: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: "12px" }
const thStyle: React.CSSProperties = { textAlign: "left", padding: "10px 12px", borderBottom: "1px solid rgba(210,236,255,0.14)", color: "#8fd7ff", fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase" }
const tdStyle: React.CSSProperties = { verticalAlign: "top", padding: "10px 12px", borderBottom: "1px solid rgba(210,236,255,0.08)", color: "#e8f2fb", lineHeight: 1.45 }

export default function PortIndexPage() {
  const { loading: adminLoading, authenticated } = useSimpleAdminAuth()
  const [ports, setPorts] = useState<PortRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (adminLoading || !authenticated) return
    ;(async () => {
      setLoading(true)
      const result = await supabase.from("cc_ports").select("id,name,country_name,notes,summary,created_at").order("country_name", { ascending: true }).order("name", { ascending: true })
      setPorts((result.data as PortRow[]) || [])
      setLoading(false)
    })()
  }, [adminLoading, authenticated])

  if (!adminLoading && !authenticated) return <p style={{ padding: 40 }}>Access Denied</p>
  if (adminLoading || loading) return <p style={{ padding: 40 }}>Loading...</p>

  return (
    <div style={pageStyle}>
      <div style={{ maxWidth: "1480px", margin: "0 auto", display: "grid", gap: "14px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: "12px", letterSpacing: "0.16em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700 }}>Country And Company Info</div>
            <h1 style={{ margin: "6px 0 0", fontSize: "28px", lineHeight: 1.05 }}>Port</h1>
          </div>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
            <a href="/admin/ccinfo" style={{ padding: "10px 14px", borderRadius: "999px", border: "1px solid rgba(210,236,255,0.16)", background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)", color: "#d7e8ff", textDecoration: "none", fontSize: "13px", fontWeight: 700 }}>Back To Cc Info</a>
            <div style={{ color: "#8fd7ff", fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700 }}>Count: {ports.length}</div>
          </div>
        </div>

        <section style={{ ...panelStyle, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Port</th>
                  <th style={thStyle}>Country</th>
                  <th style={thStyle}>Information</th>
                </tr>
              </thead>
              <tbody>
                {ports.map((row) => (
                  <tr key={row.id}>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap", fontWeight: 700 }}>{row.name}</td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{row.country_name || "-"}</td>
                    <td style={{ ...tdStyle, minWidth: "760px", whiteSpace: "pre-wrap" }}>{row.notes || "No info"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  )
}
