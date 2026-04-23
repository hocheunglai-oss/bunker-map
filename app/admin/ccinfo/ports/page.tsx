"use client"

import { useEffect, useMemo, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

type PortRow = {
  id: string
  name: string
  country_name: string | null
  notes: string | null
  summary: string | null
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
  padding: "6px 8px",
  borderRadius: "10px",
  border: "1px solid rgba(210,236,255,0.16)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.05) 100%)",
  color: "#edf7ff",
  fontSize: "12px",
  outline: "none",
  boxSizing: "border-box",
}

const buttonStyle: React.CSSProperties = {
  padding: "9px 12px",
  borderRadius: "999px",
  border: "1px solid rgba(210,236,255,0.16)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)",
  color: "#d7e8ff",
  textDecoration: "none",
  fontSize: "12px",
  fontWeight: 700,
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 10px 24px rgba(8,24,44,0.16)",
  cursor: "pointer",
}

export default function PortIndexPage() {
  const { loading: adminLoading, authenticated } = useSimpleAdminAuth()
  const [ports, setPorts] = useState<PortRow[]>([])
  const [loading, setLoading] = useState(true)
  const [savingAll, setSavingAll] = useState(false)
  const [message, setMessage] = useState("")
  const [filter, setFilter] = useState("")

  async function loadPorts() {
    setLoading(true)
    const result = await supabase
      .from("cc_ports")
      .select("id,name,country_name,notes,summary")
      .order("country_name", { ascending: true })
      .order("name", { ascending: true })
    setPorts((result.data as PortRow[]) || [])
    setLoading(false)
  }

  useEffect(() => {
    if (adminLoading || !authenticated) return
    void loadPorts()
  }, [adminLoading, authenticated])

  const filteredPorts = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return ports
    return ports.filter((row) =>
      [row.name, row.country_name || "", row.notes || ""].some((value) => value.toLowerCase().includes(needle)),
    )
  }, [filter, ports])

  async function saveAll() {
    setSavingAll(true)
    setMessage("")
    try {
      const chunks = []
      for (let i = 0; i < ports.length; i += 25) chunks.push(ports.slice(i, i + 25))
      for (const chunk of chunks) {
        const results = await Promise.all(
          chunk.map((row) =>
            supabase
              .from("cc_ports")
              .update({
                name: row.name.trim(),
                country_name: row.country_name?.trim() || null,
                notes: row.notes?.trim() || null,
                summary: null,
              })
              .eq("id", row.id),
          ),
        )
        const failed = results.find((result) => result.error)
        if (failed?.error) throw failed.error
      }
      setMessage("All ports saved.")
    } catch {
      setMessage("Unable to save all ports.")
    }
    setSavingAll(false)
  }

  async function deleteRow(row: PortRow) {
    if (!confirm(`Delete ${row.name}?`)) return
    const { error } = await supabase.from("cc_ports").delete().eq("id", row.id)
    if (error) {
      setMessage("Unable to delete port.")
      return
    }
    setPorts((prev) => prev.filter((item) => item.id !== row.id))
    setMessage(`Deleted ${row.name}.`)
  }

  async function addPort() {
    const { data, error } = await supabase
      .from("cc_ports")
      .insert({
        name: "",
        country_name: "",
        notes: "",
        summary: null,
      })
      .select("id,name,country_name,notes,summary")
      .single()

    if (error || !data) {
      setMessage("Unable to add port.")
      return
    }

    setPorts((prev) => [data as PortRow, ...prev])
    setMessage("New port added.")
  }

  function updateRow(id: string, field: keyof PortRow, value: string) {
    setPorts((prev) => prev.map((row) => (row.id === id ? { ...row, [field]: value } : row)))
  }

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
            <button
              onClick={addPort}
              style={{
                ...buttonStyle,
                background: "linear-gradient(180deg, rgba(76, 164, 255, 0.34) 0%, rgba(31, 82, 143, 0.18) 100%)",
                color: "#e8f4ff",
                border: "1px solid rgba(108, 185, 255, 0.24)",
              }}
            >
              Add Port
            </button>
            <button
              onClick={() => void saveAll()}
              disabled={savingAll}
              style={{ ...buttonStyle, background: "linear-gradient(180deg, rgba(56, 214, 154, 0.34) 0%, rgba(20, 130, 93, 0.16) 100%)", color: "#ddffef", border: "1px solid rgba(73, 219, 165, 0.26)" }}
            >
              <span style={{ display: "inline-block", minWidth: "88px", textAlign: "center" }}>
                {savingAll ? "Saving..." : "Save All"}
              </span>
            </button>
            <a href="/admin/ccinfo" style={{ ...buttonStyle, textDecoration: "none" }}>Back</a>
            <div style={{ color: "#8fd7ff", fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700 }}>Count: {filteredPorts.length}</div>
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
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Port</th>
                  <th style={thStyle}>Country</th>
                  <th style={thStyle}>Information</th>
                  <th style={thStyle}>Delete</th>
                </tr>
              </thead>
              <tbody>
                {filteredPorts.map((row) => (
                  <tr key={row.id}>
                    <td style={{ ...tdStyle, minWidth: "200px", padding: "4px 6px" }}>
                      <input value={row.name} onChange={(event) => updateRow(row.id, "name", event.target.value)} style={inputStyle} />
                    </td>
                    <td style={{ ...tdStyle, minWidth: "140px", padding: "4px 6px" }}>
                      <input value={row.country_name || ""} onChange={(event) => updateRow(row.id, "country_name", event.target.value)} style={inputStyle} />
                    </td>
                    <td style={{ ...tdStyle, minWidth: "760px", padding: "4px 6px" }}>
                      <textarea
                        value={row.notes || ""}
                        onChange={(event) => updateRow(row.id, "notes", event.target.value)}
                        style={{ ...inputStyle, minHeight: "42px", height: "42px", resize: "vertical", lineHeight: 1.3, fontFamily: "Arial, Helvetica, sans-serif", padding: "5px 7px", overflow: "auto" }}
                      />
                    </td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap", minWidth: "84px", padding: "4px 6px" }}>
                      <button
                        onClick={() => void deleteRow(row)}
                        style={{ ...buttonStyle, background: "linear-gradient(180deg, rgba(230, 57, 70, 0.24) 0%, rgba(170, 47, 53, 0.12) 100%)", color: "#ffd6db", border: "1px solid rgba(255, 120, 120, 0.22)", width: "100%" }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {message && (
          <div style={{ color: message.startsWith("Unable") ? "#ffb0b0" : "#8ff0c8", fontWeight: 700 }}>
            {message}
          </div>
        )}
      </div>
    </div>
  )
}
