"use client"

import { useEffect, useMemo, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

type PortRow = {
  id: string
  name: string
  country_name: string | null
  notes: string | null
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

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 11px",
  borderRadius: "12px",
  border: "1px solid rgba(210,236,255,0.16)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.05) 100%)",
  color: "#edf7ff",
  fontSize: "12px",
  outline: "none",
  boxSizing: "border-box",
}

const buttonStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: "999px",
  border: "1px solid rgba(210,236,255,0.16)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)",
  color: "#d7e8ff",
  textDecoration: "none",
  fontSize: "13px",
  fontWeight: 700,
}

export default function PortIndexPage() {
  const { loading: adminLoading, authenticated } = useSimpleAdminAuth()
  const [ports, setPorts] = useState<PortRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState("")
  const [page, setPage] = useState(1)
  const [totalCount, setTotalCount] = useState(0)
  const pageSize = 200

  useEffect(() => {
    if (adminLoading || !authenticated) return
    ;(async () => {
      setLoading(true)
      const from = (page - 1) * pageSize
      const needle = filter.trim()
      let query = supabase
        .from("cc_ports")
        .select("id,name,country_name,notes", { count: "exact" })
        .order("country_name", { ascending: true })
        .order("name", { ascending: true })
      if (needle) query = query.or(`name.ilike.%${needle}%,country_name.ilike.%${needle}%,notes.ilike.%${needle}%`)
      const result = await query.range(from, from + pageSize - 1)
      setPorts((result.data as PortRow[]) || [])
      setTotalCount(result.count || 0)
      setLoading(false)
    })()
  }, [adminLoading, authenticated, filter, page])

  useEffect(() => {
    setPage(1)
  }, [filter])

  const filteredPorts = useMemo(() => {
    return ports
  }, [ports])

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  async function deletePort(row: PortRow) {
    if (!confirm(`Delete port ${row.name}?`)) return
    const { error } = await supabase.from("cc_ports").delete().eq("id", row.id)
    if (error) return alert("Unable to delete port.")
    setPorts((prev) => prev.filter((item) => item.id !== row.id))
    setTotalCount((prev) => Math.max(0, prev - 1))
  }

  if (!adminLoading && !authenticated) return <p style={{ padding: 40 }}>Access Denied</p>
  if (adminLoading) return <p style={{ padding: 40 }}>Loading...</p>

  return (
    <div style={pageStyle}>
      <div style={{ maxWidth: "1480px", margin: "0 auto", display: "grid", gap: "14px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: "12px", letterSpacing: "0.16em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700 }}>Country And Company Info</div>
            <h1 style={{ margin: "6px 0 0", fontSize: "28px", lineHeight: 1.05 }}>Port Index</h1>
          </div>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
            <a href="/admin/ccinfo" style={buttonStyle}>Back</a>
            <div style={{ color: "#8fd7ff", fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700 }}>Count: {totalCount}</div>
          </div>
        </div>

        <div style={{ ...panelStyle, padding: "12px 14px" }}>
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter ports..."
            style={inputStyle}
          />
        </div>

        <section style={{ ...panelStyle, overflow: "hidden" }}>
          {loading && <div style={{ padding: "10px 12px", color: "#8fd7ff", fontSize: "12px", fontWeight: 700 }}>Loading results...</div>}
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Port</th>
                  <th style={thStyle}>Country</th>
                  <th style={thStyle}>Information</th>
                  <th style={thStyle}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredPorts.map((row) => (
                  <tr key={row.id}>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap", fontWeight: 700 }}>
                      <a
                        href={`/admin/ccinfo?kind=port&id=${row.id}`}
                        style={{ color: "#bfe6ff", textDecoration: "none" }}
                      >
                        {row.name}
                      </a>
                    </td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap", color: "#bfe6ff" }}>{row.country_name || ""}</td>
                    <td style={{ ...tdStyle, minWidth: "760px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "0" }}>{(row.notes || "No info").replace(/\s+/g, " ")}</td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                      <button onClick={() => void deletePort(row)} style={{ ...buttonStyle, padding: "6px 10px", fontSize: "11px", background: "linear-gradient(180deg, rgba(230,57,70,0.24) 0%, rgba(170,47,53,0.12) 100%)", color: "#ffd6db", border: "1px solid rgba(255,120,120,0.24)" }}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <div style={{ display: "flex", justifyContent: "center", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={() => setPage((prev) => Math.max(1, prev - 1))} disabled={page <= 1} style={{ ...buttonStyle, opacity: page <= 1 ? 0.5 : 1 }}>Previous</button>
          <div style={{ color: "#8fd7ff", fontSize: "12px", fontWeight: 800, letterSpacing: "0.08em" }}>Page {page} / {totalPages}</div>
          <button onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))} disabled={page >= totalPages} style={{ ...buttonStyle, opacity: page >= totalPages ? 0.5 : 1 }}>Next</button>
        </div>
      </div>
    </div>
  )
}
