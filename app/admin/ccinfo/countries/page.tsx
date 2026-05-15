"use client"

import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

type CountryRow = {
  id: string
  name: string
  notes: string | null
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
const navLinkStyle: React.CSSProperties = { padding: "8px 12px", borderRadius: "999px", border: "1px solid rgba(210,236,255,0.16)", background: "linear-gradient(180deg, rgba(255,255,255,0.13) 0%, rgba(255,255,255,0.06) 100%)", color: "#d7e8ff", textDecoration: "none", fontSize: "12px", fontWeight: 800 }
const activeNavLinkStyle: React.CSSProperties = { ...navLinkStyle, background: "linear-gradient(180deg, rgba(143,215,255,0.28) 0%, rgba(54,123,184,0.16) 100%)", color: "#ffffff", border: "1px solid rgba(143,215,255,0.32)" }

export default function CountryIndexPage() {
  const { loading: adminLoading, authenticated } = useSimpleAdminAuth()
  const [countries, setCountries] = useState<CountryRow[]>([])
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
        .from("cc_countries")
        .select("id,name,notes,created_at", { count: "exact" })
        .order("name", { ascending: true })
      if (needle) query = query.or(`name.ilike.%${needle}%,notes.ilike.%${needle}%`)
      const result = await query.range(from, from + pageSize - 1)
      setCountries((result.data as CountryRow[]) || [])
      setTotalCount(result.count || 0)
      setLoading(false)
    })()
  }, [adminLoading, authenticated, page, filter])

  useEffect(() => {
    setPage(1)
  }, [filter])

  async function deleteCountry(row: CountryRow) {
    if (!confirm(`Delete country ${row.name}?`)) return
    const { error } = await supabase.from("cc_countries").delete().eq("id", row.id)
    if (error) return alert("Unable to delete country.")
    setCountries((prev) => prev.filter((item) => item.id !== row.id))
    setTotalCount((prev) => Math.max(0, prev - 1))
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  if (!adminLoading && !authenticated) return <p style={{ padding: 40 }}>Access Denied</p>
  if (adminLoading) return <p style={{ padding: 40 }}>Loading...</p>

  return (
    <div style={pageStyle}>
      <div style={{ maxWidth: "1480px", margin: "0 auto", display: "grid", gap: "14px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: "12px", letterSpacing: "0.16em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700 }}>Country And Company Info</div>
            <h1 style={{ margin: "6px 0 0", fontSize: "28px", lineHeight: 1.05 }}>Country Index</h1>
          </div>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
            <a href="/admin/ccinfo" style={{ padding: "10px 14px", borderRadius: "999px", border: "1px solid rgba(210,236,255,0.16)", background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)", color: "#d7e8ff", textDecoration: "none", fontSize: "13px", fontWeight: 700 }}>Back</a>
            <div style={{ color: "#8fd7ff", fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700 }}>Count: {totalCount}</div>
          </div>
        </div>

        <nav style={{ ...panelStyle, padding: "10px 12px", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          <a href="/admin/ccinfo/countries" style={activeNavLinkStyle}>Country Index</a>
          <a href="/admin/ccinfo/ports" style={navLinkStyle}>Port Index</a>
          <a href="/admin/ccinfo/companies" style={navLinkStyle}>Company Index</a>
        </nav>

        <section style={{ ...panelStyle, padding: "12px 14px" }}>
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search countries..."
            style={{ width: "100%", padding: "9px 11px", borderRadius: "12px", border: "1px solid rgba(210,236,255,0.16)", background: "linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.05) 100%)", color: "#edf7ff", fontSize: "12px", outline: "none", boxSizing: "border-box" }}
          />
        </section>

        <section style={{ ...panelStyle, overflow: "hidden" }}>
          {loading && <div style={{ padding: "10px 12px", color: "#8fd7ff", fontSize: "12px", fontWeight: 700 }}>Loading results...</div>}
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Country</th>
                  <th style={thStyle}>Information</th>
                  <th style={thStyle}>Action</th>
                </tr>
              </thead>
              <tbody>
                {countries.map((row) => (
                  <tr key={row.id}>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap", fontWeight: 700 }}>
                      <a
                        href={`/admin/ccinfo?kind=country&id=${row.id}`}
                        style={{ color: "#bfe6ff", textDecoration: "none" }}
                      >
                        {row.name}
                      </a>
                    </td>
                    <td style={{ ...tdStyle, minWidth: "760px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "0" }}>{(row.notes || "No info").replace(/\s+/g, " ")}</td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                      <button onClick={() => void deleteCountry(row)} style={{ padding: "6px 10px", borderRadius: "999px", border: "1px solid rgba(255,120,120,0.24)", background: "linear-gradient(180deg, rgba(230,57,70,0.24) 0%, rgba(170,47,53,0.12) 100%)", color: "#ffd6db", fontSize: "11px", fontWeight: 700 }}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <div style={{ display: "flex", justifyContent: "center", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={() => setPage((prev) => Math.max(1, prev - 1))} disabled={page <= 1} style={{ padding: "10px 14px", borderRadius: "999px", border: "1px solid rgba(210,236,255,0.16)", background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)", color: "#d7e8ff", fontSize: "13px", fontWeight: 700, opacity: page <= 1 ? 0.5 : 1 }}>Previous</button>
          <div style={{ color: "#8fd7ff", fontSize: "12px", fontWeight: 800, letterSpacing: "0.08em" }}>Page {page} / {totalPages}</div>
          <button onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))} disabled={page >= totalPages} style={{ padding: "10px 14px", borderRadius: "999px", border: "1px solid rgba(210,236,255,0.16)", background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)", color: "#d7e8ff", fontSize: "13px", fontWeight: 700, opacity: page >= totalPages ? 0.5 : 1 }}>Next</button>
        </div>
      </div>
    </div>
  )
}
