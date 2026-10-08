"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import { priceSetterTabs } from "@/data/priceSetterTabs"
import { chinaReportSections, compactReportSections } from "@/data/reportSections"
import { hasFormulaForAnyFuel, parseSimpleFormula, resolvePortFuelValue } from "@/lib/portPricing"
import { loadReportSnapshots, saveReportSnapshot, type ReportSnapshotKey } from "@/lib/reportSnapshots"
import { buildChinaReportSections } from "@/lib/chinaReport"
import { buildTaiwanReportRows, formatReportDate, type TaiwanReportRow } from "@/lib/taiwanReport"
import { buildHongKongReportRows, type HongKongReportRow } from "@/lib/hongKongReport"
import { savePriceHistoryForMarketDate } from "@/lib/priceHistoryRecords"
import { useIsMobile } from "@/lib/useIsMobile"
import {
  buildFallbackKey,
  loadReportFallbacks,
  saveReportFallbacks,
  type FallbackMap,
  type FallbackValue,
} from "@/lib/reportFallbacks"

type SavedPortsState = Record<string, boolean>
type SavingPortsState = Record<string, boolean>

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
  const { loading: adminLoading, authenticated, role, permissions } = useSimpleAdminAuth()
  const hasEditPermission = isAdminRole(role) || canAccessAdminPage(permissions, "pricesetter", "edit")
  const isMobile = useIsMobile()

  const [ports, setPorts] = useState<any[]>([])
  const [portsLoadStatus, setPortsLoadStatus] = useState<"loading" | "ready" | "error">("loading")
  const [portsLoadAttempt, setPortsLoadAttempt] = useState(0)
  const [portListError, setPortListError] = useState("")
  const [changingPortList, setChangingPortList] = useState(false)
  const portListLock = useRef(false)
  const canEdit = hasEditPermission && portsLoadStatus === "ready" && !changingPortList
  const canChangePortList = canEdit && !portListError
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
  const [publishErrors, setPublishErrors] = useState<Partial<Record<ReportSnapshotKey, string>>>({})
  const publishingAny = publishingChina || publishingCompact || publishingTaiwan || publishingHongKong
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false)

  useEffect(() => {
    document.title = "Price Setter - FC Uno"
  }, [])
  const [showDeleteButtons, setShowDeleteButtons] = useState(false)
  const [reportFallbacks, setReportFallbacks] = useState<FallbackMap>({})
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  const today = new Date().toDateString()

  const th: React.CSSProperties = {
    borderBottom: "1px solid var(--fc-admin-border-soft)",
    padding: "7px 5px",
    fontSize: "10px",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--fc-admin-muted)",
    textAlign: "left",
    whiteSpace: "nowrap",
  }

  const td: React.CSSProperties = {
    borderBottom: "1px solid var(--fc-admin-border-soft)",
    padding: "2px 5px",
    verticalAlign: "middle",
  }

  useEffect(() => {
    if (adminLoading || !authenticated) return
    let cancelled = false
    const timeout = setTimeout(() => {
      cancelled = true
      setPortsLoadStatus("error")
    }, 15_000)
    setPortsLoadStatus("loading")
    async function loadPorts() {
      try {
        const { data, error } = await supabase
          .from("ports")
          .select("id,name,type,lat,lng,hsfo,vlsfo,mgo,hsfo_formula,vlsfo_formula,mgo_formula,updated_at,display_order")
          .order("display_order", { ascending: true })
        if (error || !Array.isArray(data)
          || data.some((port) => !port || typeof port.id !== "string" || typeof port.name !== "string")) {
          throw new Error("Could not load the saved ports")
        }
        if (cancelled) return
        setPorts(data)
        setSavedPorts({})
        setPortListError("")
        setPortsLoadStatus("ready")
      } catch {
        if (!cancelled) setPortsLoadStatus("error")
      } finally {
        clearTimeout(timeout)
      }
    }

    void loadPorts()
    return () => { cancelled = true; clearTimeout(timeout) }
  }, [adminLoading, authenticated, portsLoadAttempt])

  useEffect(() => {
    if (adminLoading || !authenticated) return
    async function loadReportConfig() {
      const [snapshots, fallbacks] = await Promise.all([
        loadReportSnapshots<{ reportDate?: string }>(reportDateItems.map((item) => item.key)),
        loadReportFallbacks(),
      ])

      setReportDates((prev) => ({
        ...prev,
        ...Object.fromEntries(
          reportDateItems.map((item) => [item.key, snapshots[item.key]?.reportDate || ""]),
        ),
      }))
      setReportFallbacks(fallbacks)
    }

    loadReportConfig()
  }, [adminLoading, authenticated])

  function updateValue(id: string, field: string, value: any) {
    if (!canEdit || publishingAny || savingPorts[id]) return
    setPorts((prev) =>
      prev.map((port) => (port.id === id ? { ...port, [field]: value } : port))
    )

    setSavedPorts((prev) => ({
      ...prev,
      [id]: false,
    }))
  }

  async function saveDivider(port: any) {
    if (!canEdit || publishingAny) return
    await supabase
      .from("ports")
      .update({
        name: port.name,
      })
      .eq("id", port.id)
  }

  async function savePort(port: any) {
    if (!canEdit || publishingAny || savingPorts[port.id]) return
    setSavingPorts((prev) => ({ ...prev, [port.id]: true }))
    const taiwanDefaults = taiwanBasisFormulaDefaults[String(port.name).toLowerCase()] ?? {}

    const now = new Date()

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

    try {
      await savePriceHistoryForMarketDate(supabase, {
        portId: port.id,
        recordedAt: now.toISOString(),
        values: {
          hsfo: port.hsfo ? Number(port.hsfo) : null,
          vlsfo: port.vlsfo ? Number(port.vlsfo) : null,
          mgo: port.mgo ? Number(port.mgo) : null,
        },
      })
    } catch (error) {
      console.error(error)
      setSavingPorts((prev) => ({ ...prev, [port.id]: false }))
      return
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
    if (!canChangePortList || portListLock.current || publishingAny || Object.values(savingPorts).some(Boolean)) return
    if (!confirm(`Delete ${name} ?`)) return
    portListLock.current = true
    setChangingPortList(true)
    setPortListError("")
    try {
      const { data, error } = await supabase.from("ports").delete().eq("id", id).select("id")
      if (error || !Array.isArray(data) || data.length !== 1 || data[0]?.id !== id) {
        throw new Error("Deletion was not confirmed")
      }
      setPorts((prev) => prev.filter((port) => port.id !== id))
    } catch {
      setPortListError(`Could not confirm deletion of ${name}. The row is still shown; reload saved ports to check before trying again.`)
    } finally {
      portListLock.current = false
      setChangingPortList(false)
    }
  }

  async function addPortRow(divider: boolean) {
    if (!canChangePortList || portListLock.current || publishingAny || Object.values(savingPorts).some(Boolean)) return
    portListLock.current = true
    setChangingPortList(true)
    setPortListError("")
    try {
      const displayOrder = Math.max(0, ...ports.map((port) => Number(port.display_order) || 0)) + 1
      const { data, error } = await supabase.from("ports").insert({
        name: divider ? "Section" : "New Port",
        ...(divider ? { type: "divider" } : {}),
        display_order: displayOrder,
      }).select()
      if (error || !Array.isArray(data) || data.length !== 1
        || typeof data[0]?.id !== "string" || typeof data[0]?.name !== "string") {
        throw new Error("Addition was not confirmed")
      }
      setPorts((prev) => [...prev, data[0]])
    } catch {
      setPortListError(`Could not confirm the new ${divider ? "divider" : "port"}. Reload saved ports to check before adding another.`)
    } finally {
      portListLock.current = false
      setChangingPortList(false)
    }
  }

  function addPort() { return addPortRow(false) }

  function addDivider() { return addPortRow(true) }

  function reloadSavedPorts() {
    if (portListLock.current || publishingAny || Object.values(savingPorts).some(Boolean)) return
    if (Object.values(savedPorts).some((saved) => saved === false)
      && !window.confirm("Reload saved ports and discard unsaved price or name changes?")) return
    setPortsLoadAttempt((attempt) => attempt + 1)
  }

  function dragStart(event: any, index: number) {
    event.dataTransfer.setData("index", index)
  }

  async function dragDrop(event: any, index: number) {
    if (!canEdit || publishingAny || Object.values(savingPorts).some(Boolean)) return
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
    const { data: portsData, error } = await supabase
      .from("ports")
      .select("*")
      .in("name", includedPorts)

    if (error || !Array.isArray(portsData) || portsData.length === 0) {
      throw new Error("Could not load the report prices.")
    }

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

    await saveReportSnapshotOrThrow(key, snapshot)
    return snapshot
  }

  function formatOverrideDate(value: string) {
    if (!value) return ""
    return formatReportDate(`${value}T12:00:00+08:00`)
  }

  function getReportDateForSnapshot(key: ReportSnapshotKey, automaticReportDate: string) {
    const date = formatOverrideDate(reportDateOverrides[key]) || automaticReportDate
    if (!date || date.includes("NaN") || date.includes("Invalid")) {
      throw new Error("A valid report date is required.")
    }
    return date
  }

  function updateReportDateOverride(key: ReportSnapshotKey, value: string) {
    setReportDateOverrides((prev) => ({
      ...prev,
      [key]: value,
    }))
    if (key === "china") setPublishedChina(false)
    if (key === "compact") setPublishedCompact(false)
    if (key === "taiwan") setPublishedTaiwan(false)
    if (key === "hongkong") setPublishedHongKong(false)
  }

  async function saveReportSnapshotOrThrow<T>(key: ReportSnapshotKey, snapshot: T) {
    const { data, error } = await saveReportSnapshot(key, snapshot)
    if (error || !data) throw error || new Error("Report publication was not confirmed.")
  }

  async function buildTaiwanSnapshot(): Promise<{
    reportDate: string
    rows: TaiwanReportRow[]
    remark: string
    specialNotice: string
  }> {
    const portsWanted = ["Kaohsiung", "Keelung", "Taichung", "Suao", "Hualien"]
    const { data: portsData, error: portsError } = await supabase
      .from("ports")
      .select("*")
      .in("name", portsWanted)

    if (portsError || !Array.isArray(portsData)
      || portsWanted.some((name) => !portsData.some((port) => port.name === name))) {
      throw new Error("Could not load all Taiwan report prices.")
    }

    const portIds = portsData.map((port) => port.id)
    const { data: historyData, error: historyError } = await supabase
      .from("price_history")
      .select("*")
      .in("port_id", portIds)
      .order("recorded_at", { ascending: false })
      .order("id", { ascending: false })

    if (historyError || !Array.isArray(historyData) || historyData.length === 0) {
      throw new Error("Could not load Taiwan price history.")
    }

    const { data: remarksData, error: remarksError } = await supabase
      .from("remarks")
      .select("*")
      .in("id", [1, 2])

    // An unavailable read is not an empty notice. Never overwrite the published
    // report with blank remarks when the source could not be read.
    if (remarksError || !Array.isArray(remarksData)) {
      throw new Error("Could not load Taiwan remarks and notices.")
    }

    const remarkData = remarksData?.find((item) => item.id === 1)
    const noticeData = remarksData?.find((item) => item.id === 2)

    const automaticReportDate = formatReportDate(historyData[0].recorded_at)

    return {
      reportDate: getReportDateForSnapshot("taiwan", automaticReportDate),
      rows: buildTaiwanReportRows(portsData, historyData, portsWanted),
      remark: remarkData?.content || "",
      specialNotice: noticeData?.content || "",
    }
  }

  async function buildHongKongSnapshot(): Promise<{
    reportDate: string
    rows: HongKongReportRow[]
  }> {
    const portsWanted = ["Hong Kong"]
    const { data: portsData, error: portsError } = await supabase
      .from("ports")
      .select("*")
      .in("name", portsWanted)

    if (portsError || !Array.isArray(portsData) || portsData.length !== 1) {
      throw new Error("Could not load Hong Kong report prices.")
    }

    const portIds = portsData.map((port) => port.id)
    const { data: historyData, error: historyError } = await supabase
      .from("price_history")
      .select("*")
      .in("port_id", portIds)
      .order("recorded_at", { ascending: false })
      .order("id", { ascending: false })

    if (historyError || !Array.isArray(historyData) || historyData.length === 0) {
      throw new Error("Could not load Hong Kong price history.")
    }

    const automaticReportDate = formatReportDate(historyData[0].recorded_at)

    return {
      reportDate: getReportDateForSnapshot("hongkong", automaticReportDate),
      rows: buildHongKongReportRows(portsData, historyData, portsWanted),
    }
  }

  async function handlePublishChina() {
    if (!canPublish("china")) return
    setPublishingChina(true)
    setPublishedChina(false)
    try {
      const snapshot = await buildSnapshotFromPorts("china", chinaReportSections)
      if (snapshot) setPublishedChina(true)
      if (snapshot) setReportDates((prev) => ({ ...prev, china: snapshot.reportDate }))
    } catch (error) {
      console.error(error)
      setPublishedChina(false)
      setPublishErrors((prev) => ({ ...prev, china: "China report could not be published. Please try again." }))
    } finally {
      setPublishingChina(false)
    }
  }

  async function handlePublishCompact() {
    if (!canPublish("compact")) return
    setPublishingCompact(true)
    setPublishedCompact(false)
    try {
      const snapshot = await buildSnapshotFromPorts("compact", compactReportSections)
      if (snapshot) setPublishedCompact(true)
      if (snapshot) setReportDates((prev) => ({ ...prev, compact: snapshot.reportDate }))
    } catch (error) {
      console.error(error)
      setPublishedCompact(false)
      setPublishErrors((prev) => ({ ...prev, compact: "Compact report could not be published. Please try again." }))
    } finally {
      setPublishingCompact(false)
    }
  }

  async function handlePublishTaiwan() {
    if (!canPublish("taiwan")) return
    setPublishingTaiwan(true)
    setPublishedTaiwan(false)
    try {
      const snapshot = await buildTaiwanSnapshot()
      if (snapshot) {
        await saveReportSnapshotOrThrow("taiwan", snapshot)
        setPublishedTaiwan(true)
        setReportDates((prev) => ({ ...prev, taiwan: snapshot.reportDate }))
      }
    } catch (error) {
      console.error(error)
      setPublishedTaiwan(false)
      setPublishErrors((prev) => ({ ...prev, taiwan: "Taiwan report could not be published. Please try again." }))
    } finally {
      setPublishingTaiwan(false)
    }
  }

  async function handlePublishHongKong() {
    if (!canPublish("hongkong")) return
    setPublishingHongKong(true)
    setPublishedHongKong(false)
    try {
      const snapshot = await buildHongKongSnapshot()
      if (snapshot) {
        await saveReportSnapshotOrThrow("hongkong", snapshot)
        setPublishedHongKong(true)
        setReportDates((prev) => ({ ...prev, hongkong: snapshot.reportDate }))
      }
    } catch (error) {
      console.error(error)
      setPublishedHongKong(false)
      setPublishErrors((prev) => ({ ...prev, hongkong: "Hong Kong report could not be published. Please try again." }))
    } finally {
      setPublishingHongKong(false)
    }
  }

  function canPublish(key: ReportSnapshotKey) {
    if (!canEdit || portListLock.current || publishingAny) return false
    if (portListError) {
      setPublishErrors((prev) => ({ ...prev, [key]: "Reload saved ports before publishing a report." }))
      return false
    }
    if (ports.some((port) => port.type !== "divider" && savedPorts[port.id] === false)
      || Object.values(savingPorts).some(Boolean)) {
      setPublishErrors((prev) => ({ ...prev, [key]: "Save changed prices before publishing a report." }))
      return false
    }
    setPublishErrors((prev) => ({ ...prev, [key]: undefined }))
    return true
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

  const missingFuelMatrix = useMemo(() => {
    const portsByName = new Map(
      ports.map((item) => [String(item.name).toLowerCase(), item] as const)
    )
    const rows: Array<{
      group: string
      port: string
      missing: Partial<Record<"hsfo" | "vlsfo" | "mgo", true>>
    }> = []
    let currentGroup = "Other"

    for (const port of ports) {
      if (port.type === "divider") {
        currentGroup = String(port.name || "Other")
        continue
      }
      const missing: Partial<Record<"hsfo" | "vlsfo" | "mgo", true>> = {}
      for (const fuel of ["hsfo", "vlsfo", "mgo"] as const) {
        const resolved = resolvePortFuelValue(port, portsByName, fuel)
        if (resolved == null) {
          missing[fuel] = true
        }
      }
      if (Object.keys(missing).length > 0) rows.push({ group: currentGroup, port: port.name, missing })
    }

    return rows
  }, [ports])

  async function setFallback(port: string, fuel: "hsfo" | "vlsfo" | "mgo", value: FallbackValue) {
    if (!canEdit || publishingAny) return
    const key = buildFallbackKey(port, fuel)
    const next = {
      ...reportFallbacks,
      [key]: value,
    }
    setReportFallbacks(next)
    await saveReportFallbacks(next)
  }

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
          "var(--fc-admin-page-bg)",
        padding: "24px",
        fontFamily: "var(--fc-admin-font)",
        color: "var(--fc-admin-panel-text)",
      }}
    >
      <div
        style={{
          maxWidth: "1480px",
          margin: "0 auto",
          background: "var(--fc-admin-panel-bg)",
          border: "1px solid var(--fc-admin-border)",
          borderRadius: "24px",
          padding: "22px",
          boxShadow: "0 18px 42px #00000012",
        }}
      >
        <div
          style={{
            position: isMobile ? "static" : "sticky",
            top: isMobile ? undefined : "0",
            zIndex: 20,
            margin: "-22px -22px 16px",
            padding: "18px 22px 14px",
            background: "var(--fc-admin-panel-bg)",
            borderBottom: "1px solid var(--fc-admin-border-soft)",
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
            <div
              style={{
                display: "grid",
                gridTemplateColumns: isMobile
                  ? "1fr"
                  : "repeat(4, 188px) 72px",
                gap: "10px",
                alignItems: "center",
              }}
            >
              <button
                onClick={handlePublishChina}
                disabled={!canEdit || publishingAny}
                style={{
                  ...toolbarButtonStyle,
                  background: "var(--fc-admin-primary-button-bg)",
                  border: "1px solid var(--fc-admin-selected-border)",
                  color: "var(--fc-admin-primary-button-text)",
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
                  background: "var(--fc-admin-danger-bg)",
                  border: "1px solid var(--fc-admin-danger-border)",
                  color: "var(--fc-admin-danger-text)",
                }}
              >
                Check China
              </a>
              <button
                onClick={handlePublishCompact}
                disabled={!canEdit || publishingAny}
                style={{
                  ...toolbarButtonStyle,
                  background: "var(--fc-admin-primary-button-bg)",
                  border: "1px solid var(--fc-admin-selected-border)",
                  color: "var(--fc-admin-primary-button-text)",
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
                  background: "var(--fc-admin-danger-bg)",
                  border: "1px solid var(--fc-admin-danger-border)",
                  color: "var(--fc-admin-danger-text)",
                }}
              >
                Check Compact
              </a>
              <div style={{ position: "relative" }}>
                <button onClick={() => setToolsMenuOpen((prev) => !prev)} className="fc-admin-menu-button" style={{ ...toolbarButtonStyle, minWidth: "52px", paddingLeft: "12px", paddingRight: "12px" }}>
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
                      background: "var(--fc-admin-panel-soft-bg)",
                      border: "1px solid var(--fc-admin-border-soft)",
                      boxShadow: "0 16px 36px #00000018",
                      display: "grid",
                      gap: "6px",
                      zIndex: 30,
                    }}
                  >
                    <button disabled={!canChangePortList || publishingAny || Object.values(savingPorts).some(Boolean)} onClick={() => { setToolsMenuOpen(false); void addPort() }} style={{ ...toolbarButtonStyle, justifyContent: "flex-start", textAlign: "left" }}>
                      Add Port
                    </button>
                    <button disabled={!canChangePortList || publishingAny || Object.values(savingPorts).some(Boolean)} onClick={() => { setToolsMenuOpen(false); void addDivider() }} style={{ ...toolbarButtonStyle, justifyContent: "flex-start", textAlign: "left" }}>
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
                disabled={!canEdit || publishingAny}
                style={{
                  ...toolbarButtonStyle,
                  background: "var(--fc-admin-primary-button-bg)",
                  border: "1px solid var(--fc-admin-selected-border)",
                  color: "var(--fc-admin-primary-button-text)",
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
                  background: "var(--fc-admin-danger-bg)",
                  border: "1px solid var(--fc-admin-danger-border)",
                  color: "var(--fc-admin-danger-text)",
                }}
              >
                Check Taiwan
              </a>
              <button
                onClick={handlePublishHongKong}
                disabled={!canEdit || publishingAny}
                style={{
                  ...toolbarButtonStyle,
                  background: "var(--fc-admin-primary-button-bg)",
                  border: "1px solid var(--fc-admin-selected-border)",
                  color: "var(--fc-admin-primary-button-text)",
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
                  background: "var(--fc-admin-danger-bg)",
                  border: "1px solid var(--fc-admin-danger-border)",
                  color: "var(--fc-admin-danger-text)",
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
                  type="button"
                  aria-pressed={selectedPortGroup === group}
                  onClick={() => switchPortGroup(group)}
                  style={{
                    ...tabButtonStyle,
                    background:
                      selectedPortGroup === group ? "var(--fc-admin-selected-bg)" : "var(--fc-admin-button-bg)",
                    borderColor:
                      selectedPortGroup === group ? "var(--fc-admin-selected-border)" : "var(--fc-admin-button-border)",
                    color: selectedPortGroup === group ? "var(--fc-admin-panel-text)" : "var(--fc-admin-muted)",
                  }}
                >
                  {getDisplayGroupLabel(group)}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={hideTertiary}
                onClick={() => setHideTertiary((prev) => !prev)}
                style={{
                  ...tabButtonStyle,
                  background: hideTertiary ? "var(--fc-admin-selected-bg)" : "var(--fc-admin-button-bg)",
                  borderColor: hideTertiary
                    ? "var(--fc-admin-selected-border)"
                    : "var(--fc-admin-button-border)",
                  color: hideTertiary ? "var(--fc-admin-panel-text)" : "var(--fc-admin-muted)",
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
                  type="button"
                  aria-pressed={selectedTab === tab.label}
                  onClick={() => setSelectedTab(tab.label)}
                  style={{
                    ...tabButtonStyle,
                    background:
                      selectedTab === tab.label ? "var(--fc-admin-selected-bg)" : "var(--fc-admin-button-bg)",
                    borderColor:
                      selectedTab === tab.label ? "var(--fc-admin-selected-border)" : "var(--fc-admin-button-border)",
                    color: selectedTab === tab.label ? "var(--fc-admin-panel-text)" : "var(--fc-admin-muted)",
                  }}
                >
                  {getDisplayTabLabel(tab.label)}
                </button>
              ))}
          </div>
        </div>

        {reportDateItems.map((item) => publishErrors[item.key] ? (
          <p key={item.key} role="alert" style={{ color: "var(--fc-admin-danger-text)" }}>{publishErrors[item.key]}</p>
        ) : null)}

        {portsLoadStatus === "loading" && <p role="status">Loading saved ports...</p>}
        {portsLoadStatus === "error" && <div role="alert">
          <p>Could not load saved ports. Editing and publishing are paused until they can be loaded.</p>
          <button onClick={reloadSavedPorts} style={toolbarButtonStyle}>Try loading again</button>
        </div>}
        {portListError && <div role="alert">
          <p>{portListError}</p>
          <button onClick={reloadSavedPorts} disabled={changingPortList || publishingAny || Object.values(savingPorts).some(Boolean)} style={toolbarButtonStyle}>Reload saved ports</button>
        </div>}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr",
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
                      draggable={canEdit && !publishingAny}
                      onDragStart={(event) => dragStart(event, index)}
                      onDrop={(event) => dragDrop(event, index)}
                      onDragOver={(event) => event.preventDefault()}
                    >
                      <td style={td}>↕</td>
                      <td style={{ ...td, paddingTop: "8px", paddingBottom: "8px" }} colSpan={showCoords ? 9 : 7}>
                        <input
                          value={port.name}
                          disabled={!canEdit || publishingAny}
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
                          <button disabled={!canChangePortList || publishingAny || Object.values(savingPorts).some(Boolean)} onClick={() => deletePort(port.id, port.name)} style={dangerButtonStyle}>
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
                  ? "#eef6ff"
                  : "#ffffff"

                return (
                  <tr
                    key={port.id}
                    draggable={canEdit && !publishingAny && !isSaving}
                    onDragStart={(event) => dragStart(event, index)}
                    onDrop={(event) => dragDrop(event, index)}
                    onDragOver={(event) => event.preventDefault()}
                    style={{ background: rowTint }}
                  >
                    <td style={{ ...td, color: "var(--fc-admin-muted)", fontSize: "11px" }}>⇅</td>
                    <td style={td}>
                      <span
                        style={{
                          display: "inline-block",
                          width: "11px",
                          height: "11px",
                          borderRadius: "50%",
                          background: updated
                            ? "var(--fc-admin-success-bg)"
                            : "var(--fc-admin-danger-bg)",
                          border: updated
                            ? "1px solid var(--fc-admin-success-border)"
                            : "1px solid var(--fc-admin-danger-border)",
                          boxShadow: "none",
                        }}
                      />
                    </td>
                    <td style={td}>
                      <input
                        value={port.name ?? ""}
                        disabled={!canEdit || publishingAny || isSaving}
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
                          disabled={!canEdit || publishingAny || isSaving}
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
                          disabled={!canEdit || publishingAny || isSaving}
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
                          disabled={!canEdit || publishingAny || isSaving}
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

                    <td style={{ ...td, fontSize: "12px", whiteSpace: "nowrap", color: "var(--fc-admin-muted)" }}>
                      {port.updated_at
                        ? new Date(port.updated_at).toLocaleDateString("en-GB")
                        : "-"}
                    </td>

                    <td style={td}>
                      <button
                        onClick={() => savePort(port)}
                        disabled={!canEdit || publishingAny || isSaving}
                        style={{
                          ...saveButtonStyle,
                          color: isSaved ? "var(--fc-admin-muted)" : "var(--fc-admin-success-text)",
                          border: isSaved
                            ? "1px solid var(--fc-admin-border)"
                            : "1px solid var(--fc-admin-success-border)",
                          background: isSaved
                            ? "var(--fc-admin-button-bg)"
                            : "var(--fc-admin-success-bg)",
                          boxShadow: "none",
                        }}
                      >
                        {isSaving ? "Saving..." : isSaved ? "Saved" : "Save"}
                      </button>
                    </td>

                    {showDeleteButtons && (
                      <td style={td}>
                        <button disabled={!canChangePortList || publishingAny || Object.values(savingPorts).some(Boolean)} onClick={() => deletePort(port.id, port.name)} style={dangerButtonStyle}>
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
        </div>

        <section
          style={{
            marginTop: "16px",
            background: "var(--fc-admin-panel-soft-bg)",
            border: "1px solid var(--fc-admin-border-soft)",
            borderRadius: "18px",
            padding: "14px",
            boxShadow: "none",
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
            <div style={{ fontSize: "12px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--fc-admin-link)", fontWeight: 700 }}>
              Report Dates
            </div>
            <div style={{ color: "var(--fc-admin-muted)", fontSize: "12px" }}>
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
                  background: "var(--fc-admin-panel-bg)",
                  border: "1px solid var(--fc-admin-border-soft)",
                }}
              >
                <span style={{ color: "var(--fc-admin-panel-text)", fontSize: "13px", fontWeight: 800 }}>
                  {item.label}
                </span>
                <span style={{ color: "var(--fc-admin-muted)", fontSize: "12px" }}>
                  Current: {reportDates[item.key] || "-"}
                </span>
                <input
                  type="date"
                  value={reportDateOverrides[item.key]}
                  disabled={!canEdit || (item.key === "china" ? publishingChina : item.key === "compact" ? publishingCompact : item.key === "taiwan" ? publishingTaiwan : publishingHongKong)}
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

        <section
          style={{
            marginTop: "16px",
            background: "var(--fc-admin-panel-soft-bg)",
            border: "1px solid var(--fc-admin-border-soft)",
            borderRadius: "18px",
            padding: "14px",
            boxShadow: "none",
          }}
        >
          <div style={{ fontSize: "12px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--fc-admin-link)", fontWeight: 700, marginBottom: "10px" }}>
            Missing Value Overrides
          </div>

          {missingFuelMatrix.length === 0 ? (
            <div style={{ color: "var(--fc-admin-muted)", fontSize: "12px" }}>No missing price/formula fields right now.</div>
          ) : (
            <div
              style={{
                display: "grid",
                gap: "6px",
              }}
            >
              {missingFuelMatrix.map((item, index) => {
                const showGroupHeader = index === 0 || missingFuelMatrix[index - 1].group !== item.group
                return (
                  <div key={item.port}>
                    {showGroupHeader && (
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: isMobile ? "minmax(0, 1fr) repeat(3, 82px)" : "minmax(0, 1fr) repeat(3, 90px)",
                          gap: "8px",
                          marginTop: index === 0 ? "2px" : "8px",
                          marginBottom: "5px",
                          padding: "2px 2px",
                        }}
                      >
                        <div style={{ fontSize: "11px", fontWeight: 800, color: "var(--fc-admin-link)", letterSpacing: "0.1em", textTransform: "uppercase" }}>{item.group}</div>
                        <div style={{ color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", textAlign: "center" }}>HSFO</div>
                        <div style={{ color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", textAlign: "center" }}>VLSFO</div>
                        <div style={{ color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", textAlign: "center" }}>MGO</div>
                      </div>
                    )}
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: isMobile ? "minmax(0, 1fr) repeat(3, 82px)" : "minmax(0, 1fr) repeat(3, 90px)",
                        alignItems: "center",
                        gap: "8px",
                        padding: "8px 10px",
                        borderRadius: "12px",
                        border: "1px solid var(--fc-admin-border-soft)",
                        background: "var(--fc-admin-panel-bg)",
                      }}
                    >
                      <div style={{ color: "var(--fc-admin-panel-text)", fontSize: "12px", fontWeight: 700 }}>{item.port}</div>
                      {(["hsfo", "vlsfo", "mgo"] as const).map((fuel) => {
                        if (!item.missing[fuel]) {
                          return <div key={fuel} style={{ textAlign: "center", color: "var(--fc-admin-muted)", fontSize: "12px" }}>-</div>
                        }
                        const mapKey = buildFallbackKey(item.port, fuel)
                        const current = reportFallbacks[mapKey] ?? "-"
                        const selectColor =
                          current === "NA" ? "var(--fc-admin-danger-text)" : current === "SE" ? "var(--fc-admin-warning-text)" : "var(--fc-admin-panel-text)"
                        return (
                          <select
                            key={fuel}
                            disabled={!canEdit || publishingAny}
                            value={current}
                            onChange={(event) => {
                              void setFallback(item.port, fuel, event.target.value as FallbackValue)
                            }}
                            style={{
                              ...compactInputStyle,
                              minHeight: "30px",
                              width: "100%",
                              padding: "4px 6px",
                              textTransform: "uppercase",
                              textAlign: "center",
                              color: selectColor,
                            }}
                          >
                            <option value="-">-</option>
                            <option value="NA">NA</option>
                            <option value="SE">SE</option>
                          </select>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

const compactInputStyle: React.CSSProperties = {
  padding: "4px 6px",
  borderRadius: "8px",
  border: "1px solid var(--fc-admin-border)",
  background: "var(--fc-tool-input-bg)",
  color: "var(--fc-admin-panel-text)",
  fontSize: "12px",
  outline: "none",
  lineHeight: 1.2,
}

const toolbarButtonStyle: React.CSSProperties = {
  alignItems: "center",
  display: "inline-flex",
  justifyContent: "center",
  padding: "6px 12px",
  minWidth: "118px",
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "999px",
  background: "var(--fc-admin-button-bg)",
  color: "var(--fc-admin-button-text)",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: 700,
  lineHeight: 1.1,
  textAlign: "center",
  whiteSpace: "nowrap",
  boxShadow: "none",
}

const tabButtonStyle: React.CSSProperties = {
  padding: "7px 11px",
  border: "1px solid var(--fc-admin-border-soft)",
  borderRadius: "999px",
  background: "var(--fc-admin-button-bg)",
  cursor: "pointer",
  fontSize: "11px",
  fontWeight: 700,
  letterSpacing: "0.02em",
  color: "var(--fc-admin-button-text)",
  boxShadow: "none",
}

const saveButtonStyle: React.CSSProperties = {
  minWidth: "84px",
  color: "var(--fc-admin-success-text)",
  padding: "6px 12px",
  border: "1px solid var(--fc-admin-success-border)",
  borderRadius: "999px",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: 700,
  background: "var(--fc-admin-success-bg)",
  boxShadow: "none",
}

const dangerButtonStyle: React.CSSProperties = {
  background: "var(--fc-admin-danger-bg)",
  color: "var(--fc-admin-danger-text)",
  padding: "6px 12px",
  border: "1px solid var(--fc-admin-danger-border)",
  borderRadius: "999px",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: 700,
  boxShadow: "none",
}
