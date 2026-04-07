"use client"

import { useEffect, useMemo, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { priceSetterTabs } from "@/data/priceSetterTabs"

type SavedPortsState = Record<string, boolean>
type SavingPortsState = Record<string, boolean>

type ViewMode = "price" | "formula"
type PortGroupMode = "All" | "Primary Ports" | "Secondary Ports"

function parseSimpleFormula(formula: string | null | undefined) {
  if (!formula) return null

  const parts = formula.trim().split(/\s+/)
  if (parts.length !== 3) return null

  const refName = parts[0].toLowerCase()
  const operator = parts[1]
  const amount = Number(parts[2])

  if ((operator !== "+" && operator !== "-") || Number.isNaN(amount)) {
    return null
  }

  return { refName, operator, amount }
}

export default function AdminPage() {
  const { loading: adminLoading, authenticated } = useSimpleAdminAuth()

  const [ports, setPorts] = useState<any[]>([])
  const [showCoords, setShowCoords] = useState(false)
  const [savedPorts, setSavedPorts] = useState<SavedPortsState>({})
  const [savingPorts, setSavingPorts] = useState<SavingPortsState>({})
  const [viewMode, setViewMode] = useState<ViewMode>("price")
  const [selectedPortGroup, setSelectedPortGroup] = useState<PortGroupMode>("All")
  const [selectedTab, setSelectedTab] = useState("All")

  const today = new Date().toDateString()

  const th: React.CSSProperties = {
    borderBottom: "1px solid rgba(255,255,255,0.12)",
    padding: "8px 6px",
    fontSize: "11px",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#b9d6ed",
    textAlign: "left",
    whiteSpace: "nowrap",
  }

  const td: React.CSSProperties = {
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    padding: "4px 6px",
    verticalAlign: "middle",
  }

  useEffect(() => {
    async function loadPorts() {
      const { data, error } = await supabase
        .from("ports")
        .select("*")
        .order("display_order", { ascending: true })

      if (error) {
        console.error(error)
        return
      }

      setPorts(data || [])
    }

    loadPorts()
  }, [])

  function updateValue(id: string, field: string, value: any) {
    setPorts((prev) =>
      prev.map((port) => (port.id === id ? { ...port, [field]: value } : port))
    )

    setSavedPorts((prev) => ({
      ...prev,
      [id]: false,
    }))
  }

  async function saveDivider(port: any) {
    await supabase
      .from("ports")
      .update({
        name: port.name,
      })
      .eq("id", port.id)
  }

  async function savePort(port: any) {
    setSavingPorts((prev) => ({ ...prev, [port.id]: true }))

    const now = new Date()
    const dayStart = new Date(now)
    dayStart.setHours(0, 0, 0, 0)
    const dayEnd = new Date(now)
    dayEnd.setHours(23, 59, 59, 999)

    const updatePayload = {
      name: port.name,
      lat: port.lat ? Number(port.lat) : null,
      lng: port.lng ? Number(port.lng) : null,
      hsfo: port.hsfo ? Number(port.hsfo) : null,
      vlsfo: port.vlsfo ? Number(port.vlsfo) : null,
      mgo: port.mgo ? Number(port.mgo) : null,
      hsfo_formula: port.hsfo_formula || null,
      vlsfo_formula: port.vlsfo_formula || null,
      mgo_formula: port.mgo_formula || null,
      updated_at: now,
    }

    const { error: updateError } = await supabase
      .from("ports")
      .update(updatePayload)
      .eq("id", port.id)

    if (updateError) {
      console.error(updateError)
      setSavingPorts((prev) => ({ ...prev, [port.id]: false }))
      return
    }

    const historyPayload = {
      port_id: port.id,
      hsfo: port.hsfo ? Number(port.hsfo) : null,
      vlsfo: port.vlsfo ? Number(port.vlsfo) : null,
      mgo: port.mgo ? Number(port.mgo) : null,
      recorded_at: now.toISOString(),
    }

    const { data: existingHistory } = await supabase
      .from("price_history")
      .select("id")
      .eq("port_id", port.id)
      .gte("recorded_at", dayStart.toISOString())
      .lte("recorded_at", dayEnd.toISOString())
      .order("recorded_at", { ascending: false })
      .limit(1)

    if (existingHistory && existingHistory.length > 0) {
      await supabase
        .from("price_history")
        .update(historyPayload)
        .eq("id", existingHistory[0].id)
    } else {
      await supabase.from("price_history").insert(historyPayload)
    }

    const portsByName = new Map(
      ports.map((item) => [String(item.name).toLowerCase(), item] as const)
    )

    const dependentIds = new Set<string>()
    const queue = [String(port.name).toLowerCase()]

    while (queue.length > 0) {
      const currentName = queue.shift()
      if (!currentName) continue

      for (const candidate of ports) {
        if (candidate.id === port.id || candidate.type === "divider") continue

        const formulas = [
          candidate.hsfo_formula,
          candidate.vlsfo_formula,
          candidate.mgo_formula,
        ]

        const referencesCurrent = formulas.some((formula: string | null | undefined) => {
          const parsed = parseSimpleFormula(formula)
          return parsed?.refName === currentName
        })

        if (!referencesCurrent || dependentIds.has(candidate.id)) continue

        dependentIds.add(candidate.id)
        queue.push(String(candidate.name).toLowerCase())
      }
    }

    if (dependentIds.size > 0) {
      const dependentIdList = Array.from(dependentIds)
      await supabase
        .from("ports")
        .update({ updated_at: now.toISOString() })
        .in("id", dependentIdList)
    }

    setPorts((prev) =>
      prev.map((item) => {
        if (item.id === port.id || dependentIds.has(item.id)) {
          return { ...item, updated_at: now.toISOString() }
        }
        return item
      })
    )

    setSavedPorts((prev) => ({
      ...prev,
      [port.id]: true,
    }))
    setSavingPorts((prev) => ({ ...prev, [port.id]: false }))
  }

  async function deletePort(id: string, name: string) {
    if (!confirm(`Delete ${name} ?`)) return

    await supabase.from("ports").delete().eq("id", id)
    setPorts((prev) => prev.filter((port) => port.id !== id))
  }

  async function addPort() {
    const { data } = await supabase
      .from("ports")
      .insert({
        name: "New Port",
        display_order: ports.length + 1,
      })
      .select()

    if (data) {
      setPorts([...ports, ...data])
    }
  }

  async function addDivider() {
    const { data } = await supabase
      .from("ports")
      .insert({
        name: "Section",
        type: "divider",
        display_order: ports.length + 1,
      })
      .select()

    if (data) {
      setPorts([...ports, ...data])
    }
  }

  function dragStart(event: any, index: number) {
    event.dataTransfer.setData("index", index)
  }

  async function dragDrop(event: any, index: number) {
    const from = Number(event.dataTransfer.getData("index"))
    const newPorts = [...ports]
    const item = newPorts.splice(from, 1)[0]
    newPorts.splice(index, 0, item)
    setPorts(newPorts)

    for (let i = 0; i < newPorts.length; i += 1) {
      await supabase
        .from("ports")
        .update({ display_order: i + 1 })
        .eq("id", newPorts[i].id)
    }
  }

  function isUpdatedToday(date: any) {
    if (!date) return false
    return new Date(date).toDateString() === today
  }

  const visiblePorts = useMemo(() => {
    const activeTab = priceSetterTabs.find((tab) => tab.label === selectedTab)
    const allowedPorts =
      selectedTab === "All" || !activeTab
        ? null
        : new Set(activeTab.ports.map((port) => port.toLowerCase()))

    return ports.filter((port) => {
      if (port.type === "divider") {
        return selectedTab === "All"
      }

      const portName = String(port.name).toLowerCase()
      const inTab = !allowedPorts || allowedPorts.has(portName)
      if (!inTab) return false

      if (selectedPortGroup === "All") return true

      const hasPrice = [port.hsfo, port.vlsfo, port.mgo].some(
        (value) => value !== null && value !== undefined && String(value).trim() !== ""
      )

      return selectedPortGroup === "Primary Ports" ? hasPrice : !hasPrice
    })
  }, [ports, selectedPortGroup, selectedTab])

  function switchPortGroup(nextGroup: PortGroupMode) {
    if (nextGroup === selectedPortGroup) return

    setSelectedPortGroup(nextGroup)
  }

  if (!adminLoading && !authenticated) return <p style={{ padding: "40px" }}>Access Denied</p>
  if (adminLoading) return <p style={{ padding: "40px" }}>Loading...</p>

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at top, #114a80 0%, #0a2c4c 34%, #041629 100%)",
        padding: "24px",
        fontFamily: "Arial, Helvetica, sans-serif",
        color: "#edf7ff",
      }}
    >
      <div
        style={{
          maxWidth: "1480px",
          margin: "0 auto",
          background: "rgba(6, 24, 44, 0.68)",
          border: "1px solid rgba(210, 236, 255, 0.16)",
          borderRadius: "24px",
          padding: "22px",
          backdropFilter: "blur(18px)",
          WebkitBackdropFilter: "blur(18px)",
          boxShadow: "0 24px 80px rgba(0, 0, 0, 0.24)",
        }}
      >
        <div
          style={{
            position: "sticky",
            top: "0",
            zIndex: 20,
            margin: "-22px -22px 16px",
            padding: "18px 22px 14px",
            background: "rgba(6, 24, 44, 0.92)",
            backdropFilter: "blur(18px)",
            WebkitBackdropFilter: "blur(18px)",
            borderBottom: "1px solid rgba(210, 236, 255, 0.14)",
            borderTopLeftRadius: "24px",
            borderTopRightRadius: "24px",
          }}
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "16px",
              marginBottom: "14px",
            }}
          >
            <div>
              <h1
                style={{
                  fontSize: "30px",
                  margin: 0,
                  lineHeight: 1,
                  textTransform: "uppercase",
                }}
              >
                Price Setter
              </h1>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
              <a href="/admin" style={{ ...toolbarButtonStyle, textDecoration: "none" }}>
                Back To Admin Home
              </a>
              <button onClick={addPort} style={toolbarButtonStyle}>
                Add Port
              </button>
              <button onClick={addDivider} style={toolbarButtonStyle}>
                Add Section Divider
              </button>
              <button onClick={() => setShowCoords(!showCoords)} style={toolbarButtonStyle}>
                {showCoords ? "Hide Coordinates" : "Show Coordinates"}
              </button>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "12px",
            }}
          >
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
              {(["All", "Primary Ports", "Secondary Ports"] as PortGroupMode[]).map((group) => (
                <button
                  key={group}
                  onClick={() => switchPortGroup(group)}
                  style={{
                    ...tabButtonStyle,
                    background:
                      selectedPortGroup === group ? "rgba(143,215,255,0.18)" : "rgba(255,255,255,0.06)",
                    borderColor:
                      selectedPortGroup === group ? "rgba(143,215,255,0.38)" : "rgba(255,255,255,0.08)",
                    color: selectedPortGroup === group ? "#edf7ff" : "#b9d6ed",
                  }}
                >
                  {group}
                </button>
              ))}
            </div>

            <div style={{ display: "flex", gap: "8px" }}>
              {(["price", "formula"] as ViewMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  style={{
                    ...tabButtonStyle,
                    background:
                      viewMode === mode ? "rgba(143,215,255,0.18)" : "rgba(255,255,255,0.06)",
                    borderColor:
                      viewMode === mode ? "rgba(143,215,255,0.38)" : "rgba(255,255,255,0.08)",
                    color: viewMode === mode ? "#edf7ff" : "#b9d6ed",
                    textTransform: "uppercase",
                  }}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "8px",
              marginTop: "14px",
            }}
          >
            {priceSetterTabs.map((tab) => (
              <button
                key={tab.label}
                onClick={() => setSelectedTab(tab.label)}
                style={{
                  ...tabButtonStyle,
                  background:
                    selectedTab === tab.label ? "rgba(143,215,255,0.18)" : "rgba(255,255,255,0.06)",
                  borderColor:
                    selectedTab === tab.label ? "rgba(143,215,255,0.38)" : "rgba(255,255,255,0.08)",
                  color: selectedTab === tab.label ? "#edf7ff" : "#b9d6ed",
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: showCoords ? "980px" : "860px" }}>
            <thead>
              <tr>
                <th style={th}>↕</th>
                <th style={th}>Status</th>
                <th style={th}>Port</th>
                {showCoords && <th style={th}>Lat</th>}
                {showCoords && <th style={th}>Lng</th>}
                <th style={th}>HSFO</th>
                <th style={th}>VLSFO</th>
                <th style={th}>MGO</th>
                <th style={th}>Updated</th>
                <th style={th}>Save</th>
                <th style={th}>Delete</th>
              </tr>
            </thead>

            <tbody>
              {visiblePorts.map((port, index) => {
                if (port.type === "divider") {
                  return (
                    <tr
                      key={port.id}
                      draggable
                      onDragStart={(event) => dragStart(event, index)}
                      onDrop={(event) => dragDrop(event, index)}
                      onDragOver={(event) => event.preventDefault()}
                    >
                      <td style={td}>↕</td>
                      <td style={{ ...td, paddingTop: "8px", paddingBottom: "8px" }} colSpan={showCoords ? 9 : 7}>
                        <input
                          value={port.name}
                          onChange={(event) => updateValue(port.id, "name", event.target.value)}
                          onBlur={() => saveDivider(port)}
                          style={{
                            ...compactInputStyle,
                            width: "100%",
                            fontWeight: 700,
                            fontSize: "13px",
                          }}
                        />
                      </td>
                      <td style={td}>
                        <button onClick={() => deletePort(port.id, port.name)} style={dangerButtonStyle}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  )
                }

                const updated = isUpdatedToday(port.updated_at)
                const isSaving = Boolean(savingPorts[port.id])
                const isSaved = Boolean(savedPorts[port.id])

                return (
                  <tr
                    key={port.id}
                    draggable
                    onDragStart={(event) => dragStart(event, index)}
                    onDrop={(event) => dragDrop(event, index)}
                    onDragOver={(event) => event.preventDefault()}
                  >
                    <td style={td}>↕</td>
                    <td style={{ ...td, fontSize: "13px" }}>{updated ? "🟢" : "🔴"}</td>
                    <td style={td}>
                      <input
                        value={port.name ?? ""}
                        onChange={(event) => updateValue(port.id, "name", event.target.value)}
                        style={{ ...compactInputStyle, width: "116px" }}
                      />
                    </td>

                    {showCoords && (
                      <td style={td}>
                        <input
                          value={port.lat ?? ""}
                          onChange={(event) => updateValue(port.id, "lat", event.target.value)}
                          style={{ ...compactInputStyle, width: "74px" }}
                        />
                      </td>
                    )}

                    {showCoords && (
                      <td style={td}>
                        <input
                          value={port.lng ?? ""}
                          onChange={(event) => updateValue(port.id, "lng", event.target.value)}
                          style={{ ...compactInputStyle, width: "74px" }}
                        />
                      </td>
                    )}

                    {[
                      { priceField: "hsfo", formulaField: "hsfo_formula" },
                      { priceField: "vlsfo", formulaField: "vlsfo_formula" },
                      { priceField: "mgo", formulaField: "mgo_formula" },
                    ].map((field) => (
                      <td key={field.priceField} style={td}>
                        <input
                          placeholder={viewMode}
                          value={port[viewMode === "price" ? field.priceField : field.formulaField] ?? ""}
                          onChange={(event) =>
                            updateValue(
                              port.id,
                              viewMode === "price" ? field.priceField : field.formulaField,
                              event.target.value
                            )
                          }
                          style={{
                            ...compactInputStyle,
                            width: viewMode === "price" ? "64px" : "130px",
                          }}
                        />
                      </td>
                    ))}

                    <td style={{ ...td, fontSize: "13px", whiteSpace: "nowrap" }}>
                      {port.updated_at
                        ? new Date(port.updated_at).toLocaleDateString("en-GB")
                        : "-"}
                    </td>

                    <td style={td}>
                      <button
                        onClick={() => savePort(port)}
                        disabled={isSaving}
                        style={{
                          ...saveButtonStyle,
                          background: isSaved ? "#6c757d" : "#1fa97a",
                        }}
                      >
                        {isSaving ? "Saving..." : isSaved ? "Saved" : "Save"}
                      </button>
                    </td>

                    <td style={td}>
                      <button onClick={() => deletePort(port.id, port.name)} style={dangerButtonStyle}>
                        Delete
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

const compactInputStyle: React.CSSProperties = {
  padding: "5px 7px",
  borderRadius: "10px",
  border: "1px solid rgba(173, 216, 255, 0.2)",
  background: "rgba(255,255,255,0.06)",
  color: "#edf7ff",
  fontSize: "12px",
  outline: "none",
}

const toolbarButtonStyle: React.CSSProperties = {
  padding: "10px 14px",
  border: "1px solid rgba(255,255,255,0.14)",
  borderRadius: "14px",
  background: "rgba(255,255,255,0.08)",
  color: "#edf7ff",
  cursor: "pointer",
  fontSize: "14px",
  fontWeight: 700,
}

const tabButtonStyle: React.CSSProperties = {
  padding: "9px 12px",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: "999px",
  background: "rgba(255,255,255,0.06)",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: 700,
}

const saveButtonStyle: React.CSSProperties = {
  color: "white",
  padding: "8px 12px",
  border: "none",
  borderRadius: "10px",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: 700,
}

const dangerButtonStyle: React.CSSProperties = {
  background: "#e63946",
  color: "white",
  padding: "8px 12px",
  border: "none",
  borderRadius: "10px",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: 700,
}
