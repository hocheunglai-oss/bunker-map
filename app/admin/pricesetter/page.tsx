"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { priceSetterTabs } from "@/data/priceSetterTabs"
import { chinaReportSections, compactReportSections } from "@/data/reportSections"
import { hasFormulaForAnyFuel, parseSimpleFormula } from "@/lib/portPricing"
import { loadReportSnapshot, saveReportSnapshot, type ReportSnapshotKey } from "@/lib/reportSnapshots"
import { buildChinaReportSections } from "@/lib/chinaReport"
import { buildTaiwanReportRows, formatReportDate, type TaiwanReportRow } from "@/lib/taiwanReport"
import { buildHongKongReportRows, type HongKongReportRow } from "@/lib/hongKongReport"
import { useIsMobile } from "@/lib/useIsMobile"

type SavedPortsState = Record<string, boolean>
type SavingPortsState = Record<string, boolean>
type ActivityLog = {
  id: string
  message: string
  timestamp: string
}

type PortGroupMode = "All" | "Primary Ports" | "Secondary Ports"
type ReportDateOverrides = Record<ReportSnapshotKey, string>
type ReportDates = Record<ReportSnapshotKey, string>

const tertiaryPortNames = new Set(
  [
    "ningbo",
    "jiangyin",
    "nanjing",
    "nantong",
    "taicang",
    "taizhou",
    "zhangjiagang",
    "lanqiao",
    "lanshan",
    "ningde",
    "putian",
    "xiuyu",
    "huanghua",
    "jingtang",
    "huangpu",
    "nansha",
    "machong",
    "shekou",
  ].map((name) => name.toLowerCase())
)

const fuelFieldConfigs = [
  { priceField: "hsfo", formulaField: "hsfo_formula", label: "HSFO" },
  { priceField: "vlsfo", formulaField: "vlsfo_formula", label: "VLSFO" },
  { priceField: "mgo", formulaField: "mgo_formula", label: "MGO" },
] as const

const taiwanBasisFormulaDefaults: Record<string, { vlsfo_formula?: string; mgo_formula?: string }> = {
  keelung: {
    vlsfo_formula: "Taichung + 0",
    mgo_formula: "Taichung + 0",
  },
  suao: {
    vlsfo_formula: "Taichung + 0",
    mgo_formula: "Taichung + 0",
  },
  hualien: {
    vlsfo_formula: "Taichung + 0",
    mgo_formula: "Taichung + 0",
  },
}

const emptyReportDateOverrides: ReportDateOverrides = {
  taiwan: "",
  hongkong: "",
  china: "",
  compact: "",
}

const emptyReportDates: ReportDates = {
  taiwan: "",
  hongkong: "",
  china: "",
  compact: "",
}

const reportDateItems: Array<{ key: ReportSnapshotKey; label: string }> = [
  { key: "china", label: "China" },
  { key: "compact", label: "Compact" },
  { key: "taiwan", label: "Taiwan" },
  { key: "hongkong", label: "Hong Kong" },
]

export default function AdminPage() {
  const { loading: adminLoading, authenticated } = useSimpleAdminAuth()
  const isMobile = useIsMobile()

  const [ports, setPorts] = useState<any[]>([])
  const [showCoords, setShowCoords] = useState(false)
  const [savedPorts, setSavedPorts] = useState<SavedPortsState>({})
  const [savingPorts, setSavingPorts] = useState<SavingPortsState>({})
  const [selectedPortGroup, setSelectedPortGroup] = useState<PortGroupMode>("All")
  const [selectedTab, setSelectedTab] = useState("All")
  const [hideTertiary, setHideTertiary] = useState(false)
  const [publishingChina, setPublishingChina] = useState(false)
  const [publishedChina, setPublishedChina] = useState(false)
  const [publishingCompact, setPublishingCompact] = useState(false)
  const [publishedCompact, setPublishedCompact] = useState(false)
  const [publishingTaiwan, setPublishingTaiwan] = useState(false)
  const [publishedTaiwan, setPublishedTaiwan] = useState(false)
  const [publishingHongKong, setPublishingHongKong] = useState(false)
  const [publishedHongKong, setPublishedHongKong] = useState(false)
  const [reportDateOverrides, setReportDateOverrides] = useState<ReportDateOverrides>(emptyReportDateOverrides)
  const [reportDates, setReportDates] = useState<ReportDates>(emptyReportDates)
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false)
  const [showDeleteButtons, setShowDeleteButtons] = useState(false)
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([])
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  const today = new Date().toDateString()

  const th: React.CSSProperties = {
    borderBottom: "1px solid rgba(255,255,255,0.12)",
    padding: "7px 5px",
    fontSize: "10px",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#b9d6ed",
    textAlign: "left",
    whiteSpace: "nowrap",
  }

  const td: React.CSSProperties = {
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    padding: "2px 5px",
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

  useEffect(() => {
    async function loadReportDates() {
      const entries = await Promise.all(
        reportDateItems.map(async (item) => {
          const snapshot = await loadReportSnapshot<{ reportDate?: string }>(item.key)
          return [item.key, snapshot?.reportDate || ""] as const
        })
      )

      setReportDates((prev) => ({
        ...prev,
        ...Object.fromEntries(entries),
      }))
    }

    loadReportDates()
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

  function addActivityLog(message: string) {
    const timestamp = new Date().toLocaleString("en-GB", {
      hour12: false,
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    })
    setActivityLogs((prev) => [
      { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, message, timestamp },
      ...prev,
    ].slice(0, 80))
  }

  async function saveDivider(port: any) {
    await supabase
      .from("ports")
      .update({
        name: port.name,
      })
      .eq("id", port.id)
    addActivityLog(`${port.name || "Divider"} divider updated`)
  }

  async function savePort(port: any) {
    setSavingPorts((prev) => ({ ...prev, [port.id]: true }))
    const taiwanDefaults = taiwanBasisFormulaDefaults[String(port.name).toLowerCase()] ?? {}

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
      vlsfo_formula: port.vlsfo_formula || taiwanDefaults.vlsfo_formula || null,
      mgo_formula: port.mgo_formula || taiwanDefaults.mgo_formula || null,
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
    addActivityLog(
      isFormulaStylePort(port)
        ? `${port.name} formula updated`
        : `${port.name} price saved`
    )
  }

  async function deletePort(id: string, name: string) {
    if (!confirm(`Delete ${name} ?`)) return

    await supabase.from("ports").delete().eq("id", id)
    setPorts((prev) => prev.filter((port) => port.id !== id))
    addActivityLog(`${name} deleted`)
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
      addActivityLog("New port added")
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
      addActivityLog("Section divider added")
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

  function isFormulaStylePort(port: any) {
    const portName = String(port.name).toLowerCase()
    if (portName === "vizag") return false
    if (taiwanBasisFormulaDefaults[portName]) return true
    return hasFormulaForAnyFuel(port) || portName === "zhanjiang"
  }

  function getDisplayTabLabel(label: string) {
    return label
      .replace(/\s*\(([^)]+)\)/g, " $1")
      .replace(/\s+\/\s+/g, " / ")
  }

  function getDisplayGroupLabel(group: PortGroupMode) {
    if (group === "Primary Ports") return "Primary"
    if (group === "Secondary Ports") return "Secondary"
    return "All"
  }

  function focusGridCell(row: number, col: number) {
    const key = `${row}:${col}`
    const element = inputRefs.current[key]
    if (!element) return false
    element.focus()
    element.select()
    return true
  }

  function moveFocus(row: number, col: number, direction: "up" | "down" | "left" | "right") {
    if (direction === "left") {
      for (let nextCol = col - 1; nextCol >= 0; nextCol -= 1) {
        if (focusGridCell(row, nextCol)) return
      }
      return
    }

    if (direction === "right") {
      for (let nextCol = col + 1; nextCol < 12; nextCol += 1) {
        if (focusGridCell(row, nextCol)) return
      }
      return
    }

    const step = direction === "up" ? -1 : 1
    for (let nextRow = row + step; nextRow >= 0 && nextRow < visiblePorts.length; nextRow += step) {
      if (focusGridCell(nextRow, col)) return

      for (let offset = 1; offset < 12; offset += 1) {
        if (focusGridCell(nextRow, col - offset) || focusGridCell(nextRow, col + offset)) return
      }
    }
  }

  function handleGridKeyDown(
    event: React.KeyboardEvent<HTMLInputElement>,
    row: number,
    col: number
  ) {
    if (event.key === "ArrowUp") {
      event.preventDefault()
      moveFocus(row, col, "up")
    } else if (event.key === "ArrowDown") {
      event.preventDefault()
      moveFocus(row, col, "down")
    } else if (event.key === "ArrowLeft" && event.currentTarget.selectionStart === 0) {
      event.preventDefault()
      moveFocus(row, col, "left")
    } else if (
      event.key === "ArrowRight" &&
      event.currentTarget.selectionStart === event.currentTarget.value.length
    ) {
      event.preventDefault()
      moveFocus(row, col, "right")
    } else if (event.key === "Enter") {
      event.preventDefault()
      moveFocus(row, col, "down")
    }
  }

  async function buildSnapshotFromPorts(
    key: "china" | "compact",
    sections: Array<{ title: string; ports: string[] }>
  ) {
    const includedPorts = Array.from(new Set(sections.flatMap((section) => section.ports)))
    const { data: portsData } = await supabase
      .from("ports")
      .select("*")
      .in("name", includedPorts)

    if (!portsData) return null

    const latestUpdated = portsData
      .map((port) => port.updated_at)
      .filter(Boolean)
      .sort()
      .at(-1)

    const automaticReportDate = latestUpdated ? formatReportDate(latestUpdated) : ""
    const snapshot = {
      reportDate: getReportDateForSnapshot(key, automaticReportDate),
      sections: buildChinaReportSections(portsData, sections),
    }

    await saveReportSnapshot(key, snapshot)
    return snapshot
  }

  function formatOverrideDate(value: string) {
    if (!value) return ""
    return formatReportDate(`${value}T12:00:00+08:00`)
  }

  function getReportDateForSnapshot(key: ReportSnapshotKey, automaticReportDate: string) {
    return formatOverrideDate(reportDateOverrides[key]) || automaticReportDate
  }

  function updateReportDateOverride(key: ReportSnapshotKey, value: string) {
    setReportDateOverrides((prev) => ({
      ...prev,
      [key]: value,
    }))
  }

  async function buildTaiwanSnapshot(): Promise<{
    reportDate: string
    rows: TaiwanReportRow[]
    remark: string
  } | null> {
    const portsWanted = ["Kaohsiung", "Keelung", "Taichung", "Suao", "Hualien"]
    const { data: portsData } = await supabase
      .from("ports")
      .select("*")
      .in("name", portsWanted)

    if (!portsData) return null

    const portIds = portsData.map((port) => port.id)
    const { data: historyData } = await supabase
      .from("price_history")
      .select("*")
      .in("port_id", portIds)
      .order("recorded_at", { ascending: false })

    if (!historyData || historyData.length === 0) return null

    const { data: remarkData } = await supabase
      .from("remarks")
      .select("*")
      .eq("id", 1)
      .maybeSingle()

    const automaticReportDate = formatReportDate(historyData[0].recorded_at)

    return {
      reportDate: getReportDateForSnapshot("taiwan", automaticReportDate),
      rows: buildTaiwanReportRows(portsData, historyData, portsWanted),
      remark: remarkData?.content || "",
    }
  }

  async function buildHongKongSnapshot(): Promise<{
    reportDate: string
    rows: HongKongReportRow[]
  } | null> {
    const portsWanted = ["Hong Kong"]
    const { data: portsData } = await supabase
      .from("ports")
      .select("*")
      .in("name", portsWanted)

    if (!portsData) return null

    const portIds = portsData.map((port) => port.id)
    const { data: historyData } = await supabase
      .from("price_history")
      .select("*")
      .in("port_id", portIds)
      .order("recorded_at", { ascending: false })

    if (!historyData || historyData.length === 0) return null

    const automaticReportDate = formatReportDate(historyData[0].recorded_at)

    return {
      reportDate: getReportDateForSnapshot("hongkong", automaticReportDate),
      rows: buildHongKongReportRows(portsData, historyData, portsWanted),
    }
  }

  async function handlePublishChina() {
    setPublishingChina(true)
    const snapshot = await buildSnapshotFromPorts("china", chinaReportSections)
    if (snapshot) setPublishedChina(true)
    if (snapshot) setReportDates((prev) => ({ ...prev, china: snapshot.reportDate }))
    setPublishingChina(false)
    if (snapshot) addActivityLog("China report published")
  }

  async function handlePublishCompact() {
    setPublishingCompact(true)
    const snapshot = await buildSnapshotFromPorts("compact", compactReportSections)
    if (snapshot) setPublishedCompact(true)
    if (snapshot) setReportDates((prev) => ({ ...prev, compact: snapshot.reportDate }))
    setPublishingCompact(false)
    if (snapshot) addActivityLog("Compact report published")
  }

  async function handlePublishTaiwan() {
    setPublishingTaiwan(true)
    const snapshot = await buildTaiwanSnapshot()
    if (snapshot) {
      await saveReportSnapshot("taiwan", snapshot)
      setPublishedTaiwan(true)
      setReportDates((prev) => ({ ...prev, taiwan: snapshot.reportDate }))
      addActivityLog("Taiwan report published")
    }
    setPublishingTaiwan(false)
  }

  async function handlePublishHongKong() {
    setPublishingHongKong(true)
    const snapshot = await buildHongKongSnapshot()
    if (snapshot) {
      await saveReportSnapshot("hongkong", snapshot)
      setPublishedHongKong(true)
      setReportDates((prev) => ({ ...prev, hongkong: snapshot.reportDate }))
      addActivityLog("Hong Kong report published")
    }
    setPublishingHongKong(false)
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
      if (hideTertiary && tertiaryPortNames.has(portName)) return false

      if (selectedPortGroup === "All") return true

      const hasFormula = isFormulaStylePort(port)
      const hasPrice = [port.hsfo, port.vlsfo, port.mgo].some(
        (value) => value !== null && value !== undefined && String(value).trim() !== ""
      )

      if (selectedPortGroup === "Primary Ports") {
        return hasPrice && !hasFormula
      }

      return hasFormula || !hasPrice
    })
  }, [hideTertiary, ports, selectedPortGroup, selectedTab])

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
            position: isMobile ? "static" : "sticky",
            top: isMobile ? undefined : "0",
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

            <div
              style={{
                display: "grid",
                gridTemplateColumns: isMobile
                  ? "1fr"
                  : "200px repeat(4, 188px) 72px",
                gap: "10px",
                alignItems: "center",
              }}
            >
              <a href="/admin" style={{ ...toolbarButtonStyle, textDecoration: "none" }}>
                ← Back To Admin
              </a>
              <button
                onClick={handlePublishChina}
                disabled={publishingChina}
                style={{
                  ...toolbarButtonStyle,
                  background: "linear-gradient(180deg, rgba(72, 170, 255, 0.34) 0%, rgba(20, 112, 196, 0.18) 100%)",
                  border: "1px solid rgba(80, 170, 255, 0.18)",
                  color: "#e2f3ff",
                }}
              >
                {publishingChina ? "Publishing China..." : publishedChina ? "Published China" : "Publish China"}
              </button>
              <a
                href="/reports/china"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  ...toolbarButtonStyle,
                  textDecoration: "none",
                  background: "linear-gradient(180deg, rgba(210, 74, 74, 0.18) 0%, rgba(170, 47, 53, 0.1) 100%)",
                  border: "1px solid rgba(255, 120, 120, 0.16)",
                  color: "#ffd4d8",
                }}
              >
                Check China
              </a>
              <button
                onClick={handlePublishCompact}
                disabled={publishingCompact}
                style={{
                  ...toolbarButtonStyle,
                  background: "linear-gradient(180deg, rgba(72, 170, 255, 0.34) 0%, rgba(20, 112, 196, 0.18) 100%)",
                  border: "1px solid rgba(80, 170, 255, 0.18)",
                  color: "#e2f3ff",
                }}
              >
                {publishingCompact ? "Publishing Compact..." : publishedCompact ? "Published Compact" : "Publish Compact"}
              </button>
              <a
                href="/reports/compact"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  ...toolbarButtonStyle,
                  textDecoration: "none",
                  background: "linear-gradient(180deg, rgba(210, 74, 74, 0.18) 0%, rgba(170, 47, 53, 0.1) 100%)",
                  border: "1px solid rgba(255, 120, 120, 0.16)",
                  color: "#ffd4d8",
                }}
              >
                Check Compact
              </a>
              <div style={{ position: "relative" }}>
                <button onClick={() => setToolsMenuOpen((prev) => !prev)} style={{ ...toolbarButtonStyle, minWidth: "52px", paddingLeft: "12px", paddingRight: "12px" }}>
                  ☰
                </button>
                {toolsMenuOpen && (
                  <div
                    style={{
                      position: "absolute",
                      right: 0,
                      top: "calc(100% + 8px)",
                      minWidth: "210px",
                      padding: "8px",
                      borderRadius: "16px",
                      background: "linear-gradient(180deg, rgba(12, 40, 66, 0.96) 0%, rgba(6, 24, 44, 0.96) 100%)",
                      border: "1px solid rgba(210,236,255,0.14)",
                      boxShadow: "0 22px 40px rgba(0,0,0,0.22)",
                      display: "grid",
                      gap: "6px",
                      zIndex: 30,
                    }}
                  >
                    <button onClick={() => { setToolsMenuOpen(false); void addPort() }} style={{ ...toolbarButtonStyle, justifyContent: "flex-start", textAlign: "left" }}>
                      Add Port
                    </button>
                    <button onClick={() => { setToolsMenuOpen(false); void addDivider() }} style={{ ...toolbarButtonStyle, justifyContent: "flex-start", textAlign: "left" }}>
                      Add Divider
                    </button>
                    <button onClick={() => { setShowCoords((prev) => !prev); setToolsMenuOpen(false) }} style={{ ...toolbarButtonStyle, justifyContent: "flex-start", textAlign: "left" }}>
                      {showCoords ? "Hide Coordinates" : "Show Coordinates"}
                    </button>
                    <button onClick={() => { setShowDeleteButtons((prev) => !prev); setToolsMenuOpen(false) }} style={{ ...toolbarButtonStyle, justifyContent: "flex-start", textAlign: "left" }}>
                      {showDeleteButtons ? "Hide Delete Buttons" : "Show Delete Buttons"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobile
                ? "1fr"
                : "200px repeat(4, 188px) 72px",
              justifyContent: "end",
              gap: "10px",
              marginTop: "-6px",
              marginBottom: "12px",
            }}
          >
            {!isMobile && <div />}
            <div
              style={{
                display: "grid",
                gridColumn: isMobile ? "auto" : "2 / span 4",
                gridTemplateColumns: isMobile ? "1fr" : "repeat(4, 188px)",
                gap: "10px",
              }}
            >
              <button
                onClick={handlePublishTaiwan}
                disabled={publishingTaiwan}
                style={{
                  ...toolbarButtonStyle,
                  background: "linear-gradient(180deg, rgba(72, 170, 255, 0.34) 0%, rgba(20, 112, 196, 0.18) 100%)",
                  border: "1px solid rgba(80, 170, 255, 0.18)",
                  color: "#e2f3ff",
                }}
              >
                {publishingTaiwan ? "Publishing Taiwan..." : publishedTaiwan ? "Published Taiwan" : "Publish Taiwan"}
              </button>
              <a
                href="/reports/taiwan"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  ...toolbarButtonStyle,
                  textDecoration: "none",
                  background: "linear-gradient(180deg, rgba(210, 74, 74, 0.18) 0%, rgba(170, 47, 53, 0.1) 100%)",
                  border: "1px solid rgba(255, 120, 120, 0.16)",
                  color: "#ffd4d8",
                }}
              >
                Check Taiwan
              </a>
              <button
                onClick={handlePublishHongKong}
                disabled={publishingHongKong}
                style={{
                  ...toolbarButtonStyle,
                  background: "linear-gradient(180deg, rgba(72, 170, 255, 0.34) 0%, rgba(20, 112, 196, 0.18) 100%)",
                  border: "1px solid rgba(80, 170, 255, 0.18)",
                  color: "#e2f3ff",
                }}
              >
                {publishingHongKong ? "Publishing HK..." : publishedHongKong ? "Published HK" : "Publish HK"}
              </button>
              <a
                href="/reports/hongkong"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  ...toolbarButtonStyle,
                  textDecoration: "none",
                  background: "linear-gradient(180deg, rgba(210, 74, 74, 0.18) 0%, rgba(170, 47, 53, 0.1) 100%)",
                  border: "1px solid rgba(255, 120, 120, 0.16)",
                  color: "#ffd4d8",
                }}
              >
                Check HK
              </a>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "flex-start",
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
                      selectedPortGroup === group ? "rgba(143,215,255,0.18)" : "rgba(255,255,255,0.04)",
                    borderColor:
                      selectedPortGroup === group ? "rgba(143,215,255,0.38)" : "rgba(255,255,255,0.06)",
                    color: selectedPortGroup === group ? "#edf7ff" : "#b9d6ed",
                  }}
                >
                  {getDisplayGroupLabel(group)}
                </button>
              ))}
              <button
                onClick={() => setHideTertiary((prev) => !prev)}
                style={{
                  ...tabButtonStyle,
                  background: hideTertiary ? "rgba(143,215,255,0.18)" : "rgba(255,255,255,0.04)",
                  borderColor: hideTertiary
                    ? "rgba(143,215,255,0.38)"
                    : "rgba(255,255,255,0.06)",
                  color: hideTertiary ? "#edf7ff" : "#b9d6ed",
                }}
              >
                Hide Tertiary
              </button>
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
                      selectedTab === tab.label ? "rgba(143,215,255,0.18)" : "rgba(255,255,255,0.04)",
                    borderColor:
                      selectedTab === tab.label ? "rgba(143,215,255,0.38)" : "rgba(255,255,255,0.06)",
                    color: selectedTab === tab.label ? "#edf7ff" : "#b9d6ed",
                  }}
                >
                  {getDisplayTabLabel(tab.label)}
                </button>
              ))}
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1fr) 280px",
            gap: "16px",
            alignItems: "start",
          }}
        >
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: showCoords ? "980px" : "860px" }}>
            <thead>
              <tr>
                <th style={th}>⇅</th>
                <th style={th}>Status</th>
                <th style={th}>Port</th>
                {showCoords && <th style={th}>Lat</th>}
                {showCoords && <th style={th}>Lng</th>}
                <th style={th}>HSFO</th>
                <th style={th}>VLSFO</th>
                <th style={th}>MGO</th>
                <th style={th}>Updated</th>
                <th style={th}>Save</th>
                {showDeleteButtons && <th style={th}>Delete</th>}
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
                          ref={(element) => {
                            inputRefs.current[`${index}:0`] = element
                          }}
                          onKeyDown={(event) => handleGridKeyDown(event, index, 0)}
                          style={{
                            ...compactInputStyle,
                            width: "100%",
                            fontWeight: 700,
                            fontSize: "12px",
                          }}
                        />
                      </td>
                      {showDeleteButtons && (
                        <td style={td}>
                          <button onClick={() => deletePort(port.id, port.name)} style={dangerButtonStyle}>
                            Delete
                          </button>
                        </td>
                      )}
                    </tr>
                  )
                }

                const updated = isUpdatedToday(port.updated_at)
                const isSaving = Boolean(savingPorts[port.id])
                const isSaved = Boolean(savedPorts[port.id])
                const isFormulaPort = isFormulaStylePort(port)
                const taiwanDefaults = taiwanBasisFormulaDefaults[String(port.name).toLowerCase()] ?? {}
                const rowTint = isFormulaPort
                  ? "rgba(24, 74, 128, 0.34)"
                  : "rgba(14, 52, 96, 0.34)"

                return (
                  <tr
                    key={port.id}
                    draggable
                    onDragStart={(event) => dragStart(event, index)}
                    onDrop={(event) => dragDrop(event, index)}
                    onDragOver={(event) => event.preventDefault()}
                    style={{ background: rowTint }}
                  >
                    <td style={{ ...td, color: "#8fb7d5", fontSize: "11px" }}>⇅</td>
                    <td style={td}>
                      <span
                        style={{
                          display: "inline-block",
                          width: "11px",
                          height: "11px",
                          borderRadius: "50%",
                          background: updated
                            ? "radial-gradient(circle at 30% 30%, rgba(214,255,238,0.95) 0%, rgba(92,237,177,0.95) 34%, rgba(28,154,110,0.98) 100%)"
                            : "radial-gradient(circle at 30% 30%, rgba(255,225,230,0.95) 0%, rgba(255,126,143,0.95) 34%, rgba(191,56,75,0.98) 100%)",
                          border: updated
                            ? "1px solid rgba(109, 241, 191, 0.45)"
                            : "1px solid rgba(255, 136, 150, 0.42)",
                          boxShadow: updated
                            ? "0 0 0 2px rgba(56, 211, 159, 0.14), 0 0 14px rgba(56, 211, 159, 0.18)"
                            : "0 0 0 2px rgba(224, 90, 90, 0.14), 0 0 14px rgba(224, 90, 90, 0.18)",
                        }}
                      />
                    </td>
                    <td style={td}>
                      <input
                        value={port.name ?? ""}
                        onChange={(event) => updateValue(port.id, "name", event.target.value)}
                        ref={(element) => {
                          inputRefs.current[`${index}:0`] = element
                        }}
                        onKeyDown={(event) => handleGridKeyDown(event, index, 0)}
                        style={{ ...compactInputStyle, width: "114px", fontWeight: 600 }}
                      />
                    </td>

                    {showCoords && (
                      <td style={td}>
                        <input
                          value={port.lat ?? ""}
                          onChange={(event) => updateValue(port.id, "lat", event.target.value)}
                          ref={(element) => {
                            inputRefs.current[`${index}:1`] = element
                          }}
                          onKeyDown={(event) => handleGridKeyDown(event, index, 1)}
                          style={{ ...compactInputStyle, width: "74px" }}
                        />
                      </td>
                    )}

                    {showCoords && (
                      <td style={td}>
                        <input
                          value={port.lng ?? ""}
                          onChange={(event) => updateValue(port.id, "lng", event.target.value)}
                          ref={(element) => {
                            inputRefs.current[`${index}:2`] = element
                          }}
                          onKeyDown={(event) => handleGridKeyDown(event, index, 2)}
                          style={{ ...compactInputStyle, width: "74px" }}
                        />
                      </td>
                    )}

                    {fuelFieldConfigs.map((field, fuelIndex) => (
                      <td key={field.priceField} style={td}>
                        <input
                          placeholder={isFormulaPort ? "formula" : "price"}
                          value={
                            isFormulaPort
                              ? port[field.formulaField] ?? taiwanDefaults[field.formulaField as keyof typeof taiwanDefaults] ?? ""
                              : port[field.priceField] ?? ""
                          }
                          onChange={(event) =>
                            updateValue(
                              port.id,
                              isFormulaPort ? field.formulaField : field.priceField,
                              event.target.value
                            )
                          }
                          ref={(element) => {
                            inputRefs.current[`${index}:${fuelIndex + (showCoords ? 3 : 1)}`] = element
                          }}
                          onKeyDown={(event) =>
                            handleGridKeyDown(event, index, fuelIndex + (showCoords ? 3 : 1))
                          }
                          style={{
                            ...compactInputStyle,
                            width: isFormulaPort ? "124px" : "62px",
                          }}
                        />
                      </td>
                    ))}

                    <td style={{ ...td, fontSize: "12px", whiteSpace: "nowrap", color: "#c4dff2" }}>
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
                          color: isSaved ? "#e5eef7" : "#ddffef",
                          border: isSaved
                            ? "1px solid rgba(196, 212, 231, 0.24)"
                            : "1px solid rgba(73, 219, 165, 0.32)",
                          background: isSaved
                            ? "linear-gradient(180deg, rgba(171, 187, 204, 0.2) 0%, rgba(98, 112, 128, 0.12) 100%)"
                            : "linear-gradient(180deg, rgba(56, 214, 154, 0.34) 0%, rgba(20, 130, 93, 0.16) 100%)",
                          boxShadow: isSaved
                            ? "inset 0 1px 0 rgba(255,255,255,0.1), 0 10px 24px rgba(8,24,44,0.16)"
                            : "inset 0 1px 0 rgba(255,255,255,0.12), 0 10px 24px rgba(20,130,93,0.18), 0 0 0 1px rgba(37,211,102,0.08)",
                        }}
                      >
                        {isSaving ? "Saving..." : isSaved ? "Saved" : "Save"}
                      </button>
                    </td>

                    {showDeleteButtons && (
                      <td style={td}>
                        <button onClick={() => deletePort(port.id, port.name)} style={dangerButtonStyle}>
                          Delete
                        </button>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <aside
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(210,236,255,0.14)",
            borderRadius: "18px",
            padding: "14px",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
            display: "grid",
            gap: "10px",
            position: isMobile ? "static" : "sticky",
            top: isMobile ? undefined : "122px",
          }}
        >
          <div style={{ fontSize: "12px", letterSpacing: "0.14em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700 }}>
            Log
          </div>
          <div style={{ display: "grid", gap: "8px", maxHeight: isMobile ? "none" : "70vh", overflowY: "auto", paddingRight: "4px" }}>
            {activityLogs.length === 0 ? (
              <div style={{ color: "#a7c3d9", fontSize: "12px", lineHeight: 1.5 }}>
                No activity yet. Saves, publishes, new ports, and formula changes will appear here.
              </div>
            ) : (
              activityLogs.map((log) => (
                <div
                  key={log.id}
                  style={{
                    padding: "10px 12px",
                    borderRadius: "14px",
                    background: "linear-gradient(180deg, rgba(20, 60, 96, 0.44) 0%, rgba(8, 28, 44, 0.34) 100%)",
                    border: "1px solid rgba(210,236,255,0.08)",
                  }}
                >
                  <div style={{ color: "#edf7ff", fontSize: "12px", lineHeight: 1.45 }}>{log.message}</div>
                  <div style={{ marginTop: "4px", color: "#8fb7d5", fontSize: "10px", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                    {log.timestamp}
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>
        </div>

        <section
          style={{
            marginTop: "16px",
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(210,236,255,0.14)",
            borderRadius: "18px",
            padding: "14px",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
          }}
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "10px",
              marginBottom: "12px",
            }}
          >
            <div style={{ fontSize: "12px", letterSpacing: "0.14em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700 }}>
              Report Dates
            </div>
            <div style={{ color: "#a7c3d9", fontSize: "12px" }}>
              Leave blank to use the automatic publish date.
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "repeat(4, minmax(0, 1fr))",
              gap: "10px",
            }}
          >
            {reportDateItems.map((item) => (
              <label
                key={item.key}
                style={{
                  display: "grid",
                  gap: "8px",
                  padding: "12px",
                  borderRadius: "14px",
                  background: "linear-gradient(180deg, rgba(20, 60, 96, 0.44) 0%, rgba(8, 28, 44, 0.34) 100%)",
                  border: "1px solid rgba(210,236,255,0.08)",
                }}
              >
                <span style={{ color: "#edf7ff", fontSize: "13px", fontWeight: 800 }}>
                  {item.label}
                </span>
                <span style={{ color: "#a7c3d9", fontSize: "12px" }}>
                  Current: {reportDates[item.key] || "-"}
                </span>
                <input
                  type="date"
                  value={reportDateOverrides[item.key]}
                  onChange={(event) => updateReportDateOverride(item.key, event.target.value)}
                  style={{
                    ...compactInputStyle,
                    width: "100%",
                    minHeight: "34px",
                    colorScheme: "dark",
                  }}
                />
              </label>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

const compactInputStyle: React.CSSProperties = {
  padding: "4px 6px",
  borderRadius: "8px",
  border: "1px solid rgba(173, 216, 255, 0.16)",
  background: "rgba(255,255,255,0.03)",
  color: "#edf7ff",
  fontSize: "12px",
  outline: "none",
  lineHeight: 1.2,
}

const toolbarButtonStyle: React.CSSProperties = {
  alignItems: "center",
  display: "inline-flex",
  justifyContent: "center",
  padding: "7px 14px",
  minHeight: "40px",
  minWidth: "118px",
  border: "1px solid rgba(210,236,255,0.16)",
  borderRadius: "999px",
  background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)",
  color: "#d7e8ff",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: 700,
  lineHeight: 1.1,
  textAlign: "center",
  whiteSpace: "nowrap",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
}

const tabButtonStyle: React.CSSProperties = {
  padding: "7px 11px",
  border: "1px solid rgba(210,236,255,0.14)",
  borderRadius: "999px",
  background: "linear-gradient(180deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.08) 100%)",
  cursor: "pointer",
  fontSize: "11px",
  fontWeight: 700,
  letterSpacing: "0.02em",
  color: "#d7e8ff",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
}

const saveButtonStyle: React.CSSProperties = {
  minWidth: "84px",
  color: "#ddffef",
  padding: "6px 12px",
  border: "1px solid rgba(73, 219, 165, 0.32)",
  borderRadius: "999px",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: 700,
  background: "linear-gradient(180deg, rgba(56, 214, 154, 0.34) 0%, rgba(20, 130, 93, 0.16) 100%)",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.12), 0 10px 24px rgba(20,130,93,0.18), 0 0 0 1px rgba(37,211,102,0.08)",
}

const dangerButtonStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, rgba(230, 57, 70, 0.18) 0%, rgba(230, 57, 70, 0.1) 100%)",
  color: "#ffd4d8",
  padding: "6px 12px",
  border: "1px solid rgba(255, 120, 120, 0.16)",
  borderRadius: "999px",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: 700,
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
}
