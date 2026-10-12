"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { confirmPriceSetterInventory } from "@/lib/priceSetterInventory"
import { buildPriceSetterFuelChanges, priceSetterFuelEdit, priceSetterFuelInput, type PriceSetterFuelDrafts } from "@/lib/priceSetterFuelInputs"
import { getTaiwanBasisFormula } from "@/lib/taiwanReport"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import { priceSetterTabs } from "@/data/priceSetterTabs"
import { hasFormulaForAnyFuel, resolvePortFuelValue } from "@/lib/portPricing"
import type { ReportSnapshotKey } from "@/lib/reportSnapshots"
import { useReportPublication } from "@/lib/useReportPublication"
import { ReportPublicationStatus } from "@/components/ReportPublicationStatus"
import { confirmPriceSetterCreation, confirmPriceSetterDeletion, confirmPriceSetterSave, priceSetterDeletionFallbacks, priceSetterDeletionSnapshot, priceSetterSnapshot, type PriceSetterSnapshot } from "@/lib/priceSetterMutation"
import { confirmPriceSetterAcknowledgement, confirmPriceSetterCreationState, type OwnedPriceSetterCreation, type PriceSetterCreationState } from "@/lib/priceSetterCreationRecovery"
import { formatMarketDateNumeric, getMarketDateKey } from "@/lib/priceHistoryRecords"
import { useIsMobile } from "@/lib/useIsMobile"
import {
  buildFallbackKey,
  loadReportFallbacks,
  type FallbackMap,
  type FallbackValue,
} from "@/lib/reportFallbacks"
import { confirmPriceSetterDivider, mergeConfirmedFallbackBaseline, parsePriceSetterFallbacks } from "@/lib/priceSetterSettings"
import { confirmPriceSetterOrder, insertVisiblePort, priceSetterOrderSnapshot, type PriceSetterReorder } from "@/lib/priceSetterOrder"

type SavedPortsState = Record<string, boolean>
type SavingPortsState = Record<string, boolean>
type PortDropPreview = {
  movedId: string
  targetId: string
  edge: "before" | "after"
  draft: PriceSetterReorder
  ports: readonly { id: string; display_order?: unknown }[]
  visible: readonly { id: string }[]
}

type PortGroupMode = "All" | "Primary Ports" | "Secondary Ports"
type ReportDateOverrides = Record<ReportSnapshotKey, string>

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

const emptyReportDateOverrides: ReportDateOverrides = {
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
  // Server receipts survive refresh/reopen. Keep an unconfirmed local attempt
  // too: a failed request may still be waiting to commit on the server.
  const pendingCreation = useRef<OwnedPriceSetterCreation | null>(null)
  const [pendingAttempt, setPendingAttempt] = useState<OwnedPriceSetterCreation | null>(null)
  const creationState = useRef<PriceSetterCreationState | null>(null)
  const creationGeneration = useRef(0)
  const [creationLoadStatus, setCreationLoadStatus] = useState<"loading" | "ready" | "error">("loading")
  const [creationLoadAttempt, setCreationLoadAttempt] = useState(0)
  const [creationError, setCreationError] = useState("")
  const [orderDraft, setOrderDraft] = useState<PriceSetterReorder | null>(null)
  const [orderError, setOrderError] = useState("")
  const [savingOrder, setSavingOrder] = useState(false)
  const [orderSaved, setOrderSaved] = useState(false)
  const draggedPortId = useRef<string | null>(null)
  const portDropPreview = useRef<PortDropPreview | null>(null)
  const [dropIndicator, setDropIndicator] = useState<PortDropPreview | null>(null)
  const savedPortSnapshots = useRef<Record<string, PriceSetterSnapshot>>({})
  const dirtyPortIds = useRef(new Set<string>())
  const priceSaveLocks = useRef(new Set<string>())
  const [priceSaveErrors, setPriceSaveErrors] = useState<Record<string, string>>({})
  const [fuelDrafts, setFuelDrafts] = useState<Record<string, PriceSetterFuelDrafts>>({})
  const canEdit = hasEditPermission && portsLoadStatus === "ready" && !changingPortList
  const canChangePortList = canEdit && !portListError && !orderDraft
  const canAddRow = canChangePortList && creationLoadStatus === "ready"
  const [showCoords, setShowCoords] = useState(false)
  const [savedPorts, setSavedPorts] = useState<SavedPortsState>({})
  const [savingPorts, setSavingPorts] = useState<SavingPortsState>({})
  const [selectedPortGroup, setSelectedPortGroup] = useState<PortGroupMode>("All")
  const [selectedTab, setSelectedTab] = useState("All")
  const [hideTertiary, setHideTertiary] = useState(false)
  const publicationEnabled = !adminLoading && authenticated
  const chinaPublication = useReportPublication("china", "pricesetter", publicationEnabled, hasEditPermission)
  const compactPublication = useReportPublication("compact", "pricesetter", publicationEnabled, hasEditPermission)
  const taiwanPublication = useReportPublication("taiwan", "pricesetter", publicationEnabled, hasEditPermission)
  const hongKongPublication = useReportPublication("hongkong", "pricesetter", publicationEnabled, hasEditPermission)
  const publications = { china: chinaPublication, compact: compactPublication, taiwan: taiwanPublication, hongkong: hongKongPublication }
  const { publishing: publishingChina, published: publishedChina } = chinaPublication
  const { publishing: publishingCompact, published: publishedCompact } = compactPublication
  const { publishing: publishingTaiwan, published: publishedTaiwan } = taiwanPublication
  const { publishing: publishingHongKong, published: publishedHongKong } = hongKongPublication
  const [reportDateOverrides, setReportDateOverrides] = useState<ReportDateOverrides>(emptyReportDateOverrides)
  const [publishErrors, setPublishErrors] = useState<Partial<Record<ReportSnapshotKey, string>>>({})
  const publishingAny = publishingChina || publishingCompact || publishingTaiwan || publishingHongKong
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false)

  useEffect(() => {
    document.title = "Price Setter - FC Uno"
  }, [])
  const [showDeleteButtons, setShowDeleteButtons] = useState(false)
  const [reportFallbacks, setReportFallbacks] = useState<FallbackMap>({})
  const savedFallbacks = useRef<FallbackMap>({})
  const [configLoadStatus, setConfigLoadStatus] = useState<"loading" | "ready" | "error">("loading")
  const [configLoadAttempt, setConfigLoadAttempt] = useState(0)
  const [fallbackDrafts, setFallbackDrafts] = useState<FallbackMap>({})
  const [fallbackError, setFallbackError] = useState("")
  const [savingFallback, setSavingFallback] = useState(false)
  const fallbackSaveLock = useRef(false)
  const canDeletePort = canChangePortList && !publishingAny && !Object.values(savingPorts).some(Boolean)
    && configLoadStatus === "ready" && !savingFallback && !Object.keys(fallbackDrafts).length
  const canPublishReports = canEdit && !orderDraft && configLoadStatus === "ready" && !savingFallback && !Object.keys(fallbackDrafts).length
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  const today = getMarketDateKey(new Date().toISOString())

  function invalidatePublications() {
    for (const publication of Object.values(publications)) publication.invalidate()
  }

  async function refreshPublicationSources() {
    // Saving prices can refresh the source, but cannot adopt someone else's
    // publication. That requires the explicit report reload/review control.
    await Promise.all(Object.values(publications).map((publication) => publication.reload(true)))
  }

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
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      cancelled = true
      controller.abort()
      setPortsLoadStatus("error")
    }, 15_000)
    setPortsLoadStatus("loading")
    async function loadPorts() {
      try {
        const response = await fetch("/api/admin/prices", { credentials: "include", cache: "no-store", signal: controller.signal })
        if (!response.ok) throw new Error("Could not load the saved ports")
        const { ports: data } = confirmPriceSetterInventory(await response.json())
        if (cancelled) return
        const snapshots = Object.fromEntries(data.map((port) => [port.id, priceSetterSnapshot(port)]))
        savedPortSnapshots.current = snapshots
        dirtyPortIds.current.clear()
        setPorts(data)
        setFuelDrafts({})
        setSavedPorts({})
        setPriceSaveErrors({})
        setPortListError("")
        setOrderDraft(null)
        setOrderError("")
        setOrderSaved(false)
        setPortsLoadStatus("ready")
      } catch {
        if (!cancelled) setPortsLoadStatus("error")
      } finally {
        clearTimeout(timeout)
      }
    }

    void loadPorts()
    return () => { cancelled = true; controller.abort(); clearTimeout(timeout) }
  }, [adminLoading, authenticated, portsLoadAttempt])

  const setCreationAttempt = useCallback((attempt: OwnedPriceSetterCreation | null) => {
    pendingCreation.current = attempt
    setPendingAttempt(attempt)
  }, [])

  const fetchCreationState = useCallback(async (signal: AbortSignal) => {
    const response = await fetch("/api/admin/prices/creation", { credentials: "same-origin", cache: "no-store", signal })
    if (!response.ok) throw Error("Could not check earlier additions")
    return confirmPriceSetterCreationState(await response.json())
  }, [])

  const applyCreationState = useCallback((state: PriceSetterCreationState) => {
    const prior = pendingCreation.current
    setCreationAttempt(state.pending
      ? { operation: "create", ...state.pending, actorId: state.actorId, expectedVersion: state.version }
      : prior?.actorId === state.actorId ? prior : null)
    creationState.current = state
    setCreationLoadStatus("ready")
    setCreationError("")
  }, [setCreationAttempt])

  useEffect(() => {
    const generation = ++creationGeneration.current
    creationState.current = null
    if (adminLoading || !authenticated || !hasEditPermission) return
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    setCreationLoadStatus("loading")
    void fetchCreationState(controller.signal).then(state => {
      if (generation === creationGeneration.current) applyCreationState(state)
    }).catch(() => {
      if (generation === creationGeneration.current) {
        setCreationLoadStatus("error")
        setCreationError("Could not check earlier additions. Adding rows is paused; your existing prices and drafts have not changed.")
      }
    }).finally(() => clearTimeout(timeout))
    return () => { creationGeneration.current = generation + 1; controller.abort(); clearTimeout(timeout) }
  }, [adminLoading, authenticated, hasEditPermission, creationLoadAttempt, fetchCreationState, applyCreationState])

  useEffect(() => {
    if (adminLoading || !authenticated) return
    let cancelled = false
    setConfigLoadStatus("loading")
    const timeout = setTimeout(() => { cancelled = true; setConfigLoadStatus("error") }, 15_000)
    async function loadReportConfig() {
      try {
        // Publication metadata is loaded by each versioned report endpoint.
        // Do not let one damaged old snapshot block every report's repair.
        const fallbacks = await loadReportFallbacks()
        if (cancelled) return
        savedFallbacks.current = fallbacks
        setReportFallbacks(fallbacks)
        setFallbackDrafts({})
        setFallbackError("")
        setConfigLoadStatus("ready")
      } catch { if (!cancelled) setConfigLoadStatus("error") }
      finally { clearTimeout(timeout) }
    }
    void loadReportConfig()
    return () => { cancelled = true; clearTimeout(timeout) }
  }, [adminLoading, authenticated, configLoadAttempt])

  function updateValue(id: string, field: string, value: any) {
    updateValues(id, { [field]: value })
  }

  function updateValues(id: string, values: Record<string, unknown>) {
    if (!canEdit || portListLock.current || publishingAny || priceSaveLocks.current.has(id)) return
    dirtyPortIds.current.add(id)
    for (const publication of Object.values(publications)) publication.resetPublished()
    setPriceSaveErrors((prev) => ({ ...prev, [id]: "" }))
    setPorts((prev) =>
      prev.map((port) => (port.id === id ? { ...port, ...values } : port))
    )

    setSavedPorts((prev) => ({
      ...prev,
      [id]: false,
    }))
    return true
  }

  async function saveDivider(port: any) {
    if (!canEdit || publishingAny || portListLock.current || priceSaveLocks.current.has(port.id) || !dirtyPortIds.current.has(port.id)) return
    priceSaveLocks.current.add(port.id)
    setSavingPorts((prev) => ({ ...prev, [port.id]: true }))
    setPriceSaveErrors((prev) => ({ ...prev, [port.id]: "" }))
    try {
      const expected = savedPortSnapshots.current[port.id]
      if (!expected || !String(port.name).trim()) throw new Error("Enter a divider name before saving.")
      const response = await fetch("/api/admin/prices", { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "divider", portId: port.id, expectedName: expected.name, name: port.name }), signal: AbortSignal.timeout(20_000) })
      const result = await response.json().catch(() => { throw new Error("The save could not be confirmed. Your draft is still here.") })
      if (!response.ok) throw new Error(typeof result?.message === "string" ? result.message : "The save could not be confirmed. Your draft is still here.")
      const { port: confirmedPort, snapshot } = confirmPriceSetterDivider(result, port.id, String(port.name).trim())
      savedPortSnapshots.current[port.id] = snapshot
      dirtyPortIds.current.delete(port.id)
      setPorts((prev) => prev.map((row) => row.id === port.id ? { ...row, ...confirmedPort } : row))
      setSavedPorts((prev) => ({ ...prev, [port.id]: true }))
    } catch (error) {
      setPriceSaveErrors((prev) => ({ ...prev, [port.id]: error instanceof Error && !["TypeError", "AbortError", "TimeoutError"].includes(error.name) ? error.message : "The save could not be confirmed. Your draft is still here; reload saved ports to check before retrying." }))
      setSavedPorts((prev) => ({ ...prev, [port.id]: false }))
    } finally { priceSaveLocks.current.delete(port.id); setSavingPorts((prev) => ({ ...prev, [port.id]: false })) }
  }

  async function savePort(port: any) {
    if (!canEdit || portListLock.current || publishingAny || priceSaveLocks.current.has(port.id)) return
    priceSaveLocks.current.add(port.id)
    setSavingPorts((prev) => ({ ...prev, [port.id]: true }))
    setPriceSaveErrors((prev) => ({ ...prev, [port.id]: "" }))
    let renaming = false
    try {
      const expected = savedPortSnapshots.current[port.id]
      if (!expected) throw new Error("Reload saved ports before saving this price.")
      const changes = buildPriceSetterFuelChanges(port, fuelDrafts[port.id])
      if (changes.name !== expected.name) {
        if (fallbackSaveLock.current || configLoadStatus !== "ready" || Object.keys(fallbackDrafts).length || priceSaveLocks.current.size > 1) {
          throw new Error("Finish or reload unsaved report settings and wait for other price saves before renaming this port. Your draft is still here.")
        }
        // A rename also moves name-keyed report settings. Keep all competing
        // UI mutations paused until the response and a fresh config read.
        renaming = true
        portListLock.current = true
        setChangingPortList(true)
        setConfigLoadStatus("loading")
      }
      invalidatePublications()
      const response = await fetch("/api/admin/prices", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ portId: port.id, expected, changes }),
        signal: AbortSignal.timeout(20_000),
      })
      const result = await response.json().catch(() => {
        throw new Error("The save could not be confirmed. Reload saved ports to check; your draft is still here.")
      })
      if (!response.ok) throw new Error(typeof result?.message === "string" ? result.message : "The save could not be confirmed. Your draft is still here.")
      const confirmed = new Map<string, Record<string, unknown>>()
      const validatedRows = confirmPriceSetterSave(result, port.id, changes)
      for (const { row, snapshot } of validatedRows) {
        // A basis-port save may update linked ports. Never overwrite a different
        // row's draft or advance its conflict baseline behind the user's back.
        if (row.id === port.id || !dirtyPortIds.current.has(row.id) && !priceSaveLocks.current.has(row.id)) {
          savedPortSnapshots.current[row.id] = snapshot
          confirmed.set(row.id, row)
        }
      }
      dirtyPortIds.current.delete(port.id)
      setPorts((prev) => prev.map((item) => confirmed.has(item.id) ? { ...item, ...confirmed.get(item.id) } : item))
      setFuelDrafts((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !confirmed.has(id))))
      setSavedPorts((prev) => ({ ...prev, [port.id]: true }))
      await refreshPublicationSources()
    } catch (error) {
      setPriceSaveErrors((prev) => ({ ...prev, [port.id]: error instanceof Error && error.message && !["TypeError", "AbortError", "TimeoutError"].includes(error.name)
        ? error.message : "The save could not be confirmed. Your draft is still here; reload saved ports to check before retrying." }))
      setSavedPorts((prev) => ({ ...prev, [port.id]: false }))
    } finally {
      if (renaming) {
        // Also reload after an unknown outcome: the transaction may have
        // committed even when its HTTP response was lost. Price drafts stay.
        setConfigLoadAttempt((attempt) => attempt + 1)
        portListLock.current = false
        setChangingPortList(false)
      }
      priceSaveLocks.current.delete(port.id)
      setSavingPorts((prev) => ({ ...prev, [port.id]: false }))
    }
  }

  async function deletePort(id: string, name: string) {
    if (!canChangePortList || portListLock.current || publishingAny || priceSaveLocks.current.size
      || configLoadStatus !== "ready" || fallbackSaveLock.current || Object.keys(fallbackDrafts).length) return
    if (!confirm(`Delete ${name}? Any unsaved changes in this row will be discarded. Ports required by reports, other prices or saved history cannot be deleted.`)) return
    portListLock.current = true
    setChangingPortList(true)
    setPortListError("")
    const affectsReports = ports.find((port) => port.id === id)?.type !== "divider"
    if (affectsReports) invalidatePublications()
    try {
      const port = ports.find(port => port.id === id), baseline = savedPortSnapshots.current[id]
      if (!port || !baseline) throw new Error("Reload saved ports before deleting.")
      const expected = priceSetterDeletionSnapshot({ ...port, ...baseline })
      const expectedFallbacks = expected.type === "divider" ? {} : priceSetterDeletionFallbacks(expected.name, savedFallbacks.current)
      const response = await fetch("/api/admin/prices", { method: "DELETE", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ portId: id, expected, expectedFallbacks }), signal: AbortSignal.timeout(20_000) })
      const result = await response.json().catch(() => { throw new Error("Could not confirm deletion. Reload saved ports to check before trying again.") })
      if (!response.ok) throw new Error(typeof result?.message === "string" ? result.message : "Could not confirm deletion. Reload saved ports to check before trying again.")
      confirmPriceSetterDeletion(result, id)
      setPorts((prev) => prev.filter((port) => port.id !== id))
      delete savedPortSnapshots.current[id]
      dirtyPortIds.current.delete(id)
      if (affectsReports) await refreshPublicationSources()
    } catch (error) {
      setPortListError(error instanceof Error && !["TypeError", "AbortError", "TimeoutError"].includes(error.name) ? error.message : `Could not confirm deletion of ${name}. The row is still shown; reload saved ports to check before trying again.`)
    } finally {
      // Target overrides may have been cleaned up even if the reply was lost.
      // No setting drafts exist at entry; report publishing waits for this read.
      setConfigLoadStatus("loading")
      setConfigLoadAttempt(attempt => attempt + 1)
      portListLock.current = false
      setChangingPortList(false)
    }
  }

  async function addPortRow(divider: boolean, recover = false) {
    if (!(recover ? canEdit && !orderDraft && !!pendingCreation.current : canAddRow)
      || creationLoadStatus !== "ready" || !creationState.current || portListLock.current
      || publishingAny || priceSaveLocks.current.size || Object.values(savingPorts).some(Boolean)) return
    const kind = divider ? "divider" : "port"
    if (pendingCreation.current && pendingCreation.current.kind !== kind) {
      setPortListError(`Retry Add ${pendingCreation.current.kind === "divider" ? "Divider" : "Port"} first to check the earlier addition. Reload saved ports before retrying.`)
      return
    }
    const attempt = pendingCreation.current || { operation: "create" as const, requestId: crypto.randomUUID(), kind,
      actorId: creationState.current.actorId, expectedVersion: creationState.current.version }
    setCreationAttempt(attempt)
    const generation = creationGeneration.current
    portListLock.current = true
    setChangingPortList(true)
    setPortListError("")
    if (!divider) invalidatePublications()
    try {
      const response = await fetch("/api/admin/prices", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(attempt),
        credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(20_000),
      })
      const result = await response.json()
      if (generation !== creationGeneration.current) return
      if (!response.ok) {
        if (["CREATION_PENDING", "CREATION_VERSION_CHANGED", "CREATION_OWNER_MISMATCH", "CREATION_ACCOUNT_CHANGED"].includes(result?.code)) {
          // These SQL/account checks prove this request did not allocate. Do
          // not silently turn the conflict into a fresh creation intention.
          setCreationAttempt(null)
          creationState.current = null
          setCreationLoadStatus("error")
          setCreationError(typeof result?.message === "string" ? result.message : "Reload previous additions before continuing.")
        }
        throw Error(typeof result?.message === "string" ? result.message : "Addition was not confirmed")
      }
      const confirmed = confirmPriceSetterCreation(result, attempt)
      if (confirmed.port && confirmed.snapshot) {
        // A reload may have found this row already. Preserve its later local
        // edits and baseline; only append a row that is genuinely absent.
        if (!Object.hasOwn(savedPortSnapshots.current, confirmed.portId)) savedPortSnapshots.current[confirmed.portId] = confirmed.snapshot
        setPorts((prev) => prev.some(port => port.id === confirmed.portId) ? prev : [...prev, confirmed.port])
        // A new row has no market or price group yet. Reveal a proven addition
        // (including a confirmed retry) without discarding existing drafts.
        setSelectedTab("All")
        setSelectedPortGroup("All")
      }
      const acknowledgement = { actorId: attempt.actorId, requestId: attempt.requestId }
      const ackResponse = await fetch("/api/admin/prices/creation", { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(acknowledgement), signal: AbortSignal.timeout(20_000) })
      const ackResult = await ackResponse.json()
      if (generation !== creationGeneration.current) return
      if (!ackResponse.ok) throw Error(typeof ackResult?.message === "string" ? ackResult.message : "Could not finish checking the earlier addition. Please retry.")
      confirmPriceSetterAcknowledgement(ackResult, acknowledgement)
      setCreationAttempt(null)
      // Acknowledgement does not invent a next revision. Read current state,
      // which may now contain a different tab's pending request.
      creationState.current = null
      setCreationLoadStatus("loading")
      const state = await fetchCreationState(AbortSignal.timeout(15_000))
      if (generation !== creationGeneration.current) return
      applyCreationState(state)
      if (!confirmed.port) {
        setPortListError("The earlier addition was already removed. No row was recreated. Reload saved ports before making a new addition.")
        return
      }
      if (!divider) await refreshPublicationSources()
    } catch (error) {
      if (generation !== creationGeneration.current) return
      if (!creationState.current) {
        setCreationLoadStatus("error")
        setCreationError("Reload previous additions before adding another row. Your existing prices and drafts are still here.")
      }
      setPortListError(error instanceof Error && !["TypeError", "AbortError", "TimeoutError", "SyntaxError"].includes(error.name)
        ? error.message : `Could not confirm the new ${kind}. Reload saved ports, then retry Add ${divider ? "Divider" : "Port"}; the same request will be checked without creating a duplicate.`)
    } finally {
      portListLock.current = false
      setChangingPortList(false)
    }
  }

  function addPort() { return addPortRow(false) }

  function addDivider() { return addPortRow(true) }

  function reloadSavedPorts() {
    if (portListLock.current || publishingAny || Object.values(savingPorts).some(Boolean)) return
    if ((orderDraft || Object.values(savedPorts).some((saved) => saved === false))
      && !window.confirm("Reload saved ports and discard unsaved price, name or order changes?")) return
    setPortsLoadAttempt((attempt) => attempt + 1)
    setCreationLoadAttempt((attempt) => attempt + 1)
  }

  function reloadPreviousAdditions() {
    if (portListLock.current || publishingAny || priceSaveLocks.current.size) return
    setCreationLoadAttempt(attempt => attempt + 1)
  }

  function dragStart(event: React.DragEvent, id: string) {
    clearPortDrag()
    if (!canChangePortList || publishingAny || portListLock.current || priceSaveLocks.current.size) { event.preventDefault(); return }
    if (event.target instanceof Element && event.target.closest("input, textarea, select, button, a")) { event.preventDefault(); return }
    event.dataTransfer.setData("application/x-fcuno-port-id", id)
    event.dataTransfer.effectAllowed = "move"
    draggedPortId.current = id
  }

  function clearPortDrop() {
    portDropPreview.current = null
    setDropIndicator(null)
  }

  function clearPortDrag() {
    draggedPortId.current = null
    clearPortDrop()
  }

  function dragOver(event: React.DragEvent<HTMLTableRowElement>, targetId: string) {
    const movedId = draggedPortId.current
    if (!movedId || !canChangePortList || publishingAny || portListLock.current || priceSaveLocks.current.size
      || !event.dataTransfer.types.includes("application/x-fcuno-port-id")) { clearPortDrop(); return }
    const bounds = event.currentTarget.getBoundingClientRect()
    const edge = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after"
    const prior = portDropPreview.current
    if (prior?.movedId === movedId && prior.targetId === targetId && prior.edge === edge && prior.ports === ports && prior.visible === visiblePorts) {
      event.preventDefault()
      event.dataTransfer.dropEffect = "move"
      return
    }
    try {
      const fullIds = ports.map(port => port.id)
      const order = insertVisiblePort(fullIds, visiblePorts.map(port => port.id), movedId, targetId, edge)
      if (order.every((id, index) => id === fullIds[index])) { clearPortDrop(); return }
      const preview: PortDropPreview = {
        movedId, targetId, edge, ports, visible: visiblePorts,
        draft: { operation: "reorder", expected: priceSetterOrderSnapshot(ports), order },
      }
      portDropPreview.current = preview
      setDropIndicator(preview)
      event.preventDefault()
      event.dataTransfer.dropEffect = "move"
    } catch { clearPortDrop() }
  }

  function dragLeave(event: React.DragEvent<HTMLElement>) {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) clearPortDrop()
  }

  async function savePortOrder(draft: PriceSetterReorder) {
    if (!canEdit || publishingAny || portListLock.current || priceSaveLocks.current.size) return
    portListLock.current = true
    setChangingPortList(true)
    setSavingOrder(true)
    setOrderDraft(draft)
    setOrderError("")
    setOrderSaved(false)
    try {
      const response = await fetch("/api/admin/prices", { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft), signal: AbortSignal.timeout(20_000) })
      const result = await response.json().catch(() => { throw new Error("The new order could not be confirmed. Retry or reload saved ports.") })
      if (!response.ok) throw new Error(typeof result?.message === "string" ? result.message : "The new order could not be confirmed. Retry or reload saved ports.")
      const confirmed = confirmPriceSetterOrder(result, draft.order)
      // Only the order changes. Existing price/name drafts and baselines survive.
      setPorts(prev => {
        const byId = new Map(prev.map(port => [port.id, port]))
        return confirmed.map(([id, display_order]) => ({ ...byId.get(id), display_order }))
      })
      setOrderDraft(null)
      setOrderSaved(true)
    } catch (error) {
      setOrderError(error instanceof Error && !["TypeError", "AbortError", "TimeoutError"].includes(error.name) ? error.message : "The new order could not be confirmed. Retry or reload saved ports.")
    } finally {
      portListLock.current = false
      setChangingPortList(false)
      setSavingOrder(false)
    }
  }

  async function dragDrop(event: React.DragEvent, targetId: string) {
    event.preventDefault()
    const preview = portDropPreview.current
    const movedId = event.dataTransfer.getData("application/x-fcuno-port-id")
    const activeId = draggedPortId.current
    clearPortDrag()
    if (!canChangePortList || publishingAny || portListLock.current || priceSaveLocks.current.size) return
    // A drop is allowed only where this page displayed a valid insertion line.
    // An external drag, changed filter/list, or stale target cannot choose an
    // unreviewed position or reuse a previous gesture's destination.
    if (!preview || movedId !== activeId || preview.movedId !== movedId || preview.targetId !== targetId
      || preview.ports !== ports || preview.visible !== visiblePorts
      || !(event.currentTarget instanceof HTMLElement) || event.currentTarget.dataset.dropPosition !== preview.edge) return
    await savePortOrder(preview.draft)
  }

  function isUpdatedToday(date: any) {
    if (!date) return false
    return getMarketDateKey(String(date)) === today
  }

  function isFormulaStylePort(port: any) {
    const portName = String(port.name).toLowerCase()
    if (portName === "vizag") return false
    if (getTaiwanBasisFormula(portName, "vlsfo")) return true
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

  function updateReportDateOverride(key: ReportSnapshotKey, value: string) {
    if (!canEdit || portListLock.current || publishingAny) return
    setReportDateOverrides((prev) => ({ ...prev, [key]: value }))
    publications[key].resetPublished()
  }

  async function handlePublish(key: ReportSnapshotKey) {
    if (!canPublish(key) || !publications[key].ready) return
    // Shared immediate lock closes the same-tick gap between different report
    // buttons and price/list changes, before React renders the busy state.
    portListLock.current = true
    try {
      await publications[key].publish(reportDateOverrides[key])
    } finally { portListLock.current = false }
  }

  function handlePublishChina() { return handlePublish("china") }
  function handlePublishCompact() { return handlePublish("compact") }
  function handlePublishTaiwan() { return handlePublish("taiwan") }
  function handlePublishHongKong() { return handlePublish("hongkong") }

  function canPublish(key: ReportSnapshotKey) {
    if (!canEdit || orderDraft || portListLock.current || priceSaveLocks.current.size > 0 || publishingAny) return false
    if (configLoadStatus !== "ready" || fallbackSaveLock.current || Object.keys(fallbackDrafts).length) {
      setPublishErrors((prev) => ({ ...prev, [key]: "Load and save report settings before publishing." }))
      return false
    }
    if (portListError) {
      setPublishErrors((prev) => ({ ...prev, [key]: "Reload saved ports before publishing a report." }))
      return false
    }
    if (dirtyPortIds.current.size > 0 || ports.some((port) => savedPorts[port.id] === false)
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

      // Draft text must not remove its own row before it can be saved. Use
      // the confirmed baseline for membership, but render drafts in full-list
      // order so filtered drag insertion still preserves every hidden slot.
      const filterPort = savedPortSnapshots.current[port.id] ?? port
      const portName = String(filterPort.name).toLowerCase()
      const inTab = !allowedPorts || allowedPorts.has(portName)
      if (!inTab) return false
      if (hideTertiary && tertiaryPortNames.has(portName)) return false

      if (selectedPortGroup === "All") return true

      const hasFormula = isFormulaStylePort(filterPort)
      const hasPrice = [filterPort.hsfo, filterPort.vlsfo, filterPort.mgo].some(
        (value) => value !== null && value !== undefined && String(value).trim() !== ""
      )

      if (selectedPortGroup === "Primary Ports") {
        return hasPrice && !hasFormula
      }

      return hasFormula || !hasPrice
    })
  }, [hideTertiary, ports, selectedPortGroup, selectedTab])

  useLayoutEffect(() => {
    if (!canChangePortList || publishingAny || Object.values(savingPorts).some(Boolean)
      || portDropPreview.current && (portDropPreview.current.ports !== ports || portDropPreview.current.visible !== visiblePorts)) {
      draggedPortId.current = null
      portDropPreview.current = null
      setDropIndicator(null)
    }
  }, [canChangePortList, publishingAny, savingPorts, ports, visiblePorts])

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
    if (!canEdit || portListLock.current || publishingAny || configLoadStatus !== "ready" || fallbackSaveLock.current) return
    if (ports.some((item) => item.name === port && savedPortSnapshots.current[item.id]?.name !== port)) {
      setFallbackError("Save or reload the port name before changing its report settings.")
      return
    }
    const key = buildFallbackKey(port, fuel)
    fallbackSaveLock.current = true
    setSavingFallback(true)
    setFallbackDrafts((prev) => ({ ...prev, [key]: value }))
    setFallbackError("")
    try {
      const response = await fetch("/api/admin/prices", { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "fallback", key, expectedValue: savedFallbacks.current[key] ?? null, value }), signal: AbortSignal.timeout(20_000) })
      const result = await response.json().catch(() => { throw new Error("The override save could not be confirmed. Your draft is still here.") })
      if (!response.ok) throw new Error(typeof result?.message === "string" ? result.message : "The override save could not be confirmed. Your draft is still here.")
      const confirmed = parsePriceSetterFallbacks(JSON.stringify(result?.fallbacks))
      if (result?.key !== key || confirmed[key] !== value) throw new Error("The override save could not be confirmed. Your draft is still here.")
      savedFallbacks.current = mergeConfirmedFallbackBaseline(confirmed, savedFallbacks.current, Object.keys(fallbackDrafts), key)
      setReportFallbacks(confirmed)
      setFallbackDrafts((prev) => { const next = { ...prev }; delete next[key]; return next })
    } catch (error) {
      setFallbackError(error instanceof Error && !["TypeError", "AbortError", "TimeoutError"].includes(error.name) ? error.message : "The override save could not be confirmed. Your draft is still here; reload saved settings to check before retrying.")
    } finally { fallbackSaveLock.current = false; setSavingFallback(false) }
  }

  function reloadReportSettings() {
    if (fallbackSaveLock.current || portListLock.current || publishingAny) return
    if (Object.keys(fallbackDrafts).length && !window.confirm("Reload saved report settings and discard unsaved override changes? Unsaved prices will stay here.")) return
    setConfigLoadAttempt((attempt) => attempt + 1)
  }

  function retryFallback() {
    const entry = Object.entries(fallbackDrafts)[0]
    if (entry) {
      const separator = entry[0].lastIndexOf("::")
      void setFallback(entry[0].slice(0, separator), entry[0].slice(separator + 2) as "hsfo" | "vlsfo" | "mgo", entry[1])
    }
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
                disabled={!canPublishReports || publishingAny || !chinaPublication.ready}
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
                disabled={!canPublishReports || publishingAny || !compactPublication.ready}
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
                    <button disabled={!canAddRow || publishingAny || Object.values(savingPorts).some(Boolean)} onClick={() => { setToolsMenuOpen(false); void addPort() }} style={{ ...toolbarButtonStyle, justifyContent: "flex-start", textAlign: "left" }}>
                      Add Port
                    </button>
                    <button disabled={!canAddRow || publishingAny || Object.values(savingPorts).some(Boolean)} onClick={() => { setToolsMenuOpen(false); void addDivider() }} style={{ ...toolbarButtonStyle, justifyContent: "flex-start", textAlign: "left" }}>
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
                disabled={!canPublishReports || publishingAny || !taiwanPublication.ready}
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
                disabled={!canPublishReports || publishingAny || !hongKongPublication.ready}
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
        {hasEditPermission && creationLoadStatus === "loading" && <p role="status">Checking earlier additions…</p>}
        {hasEditPermission && (creationError || pendingAttempt) && <div role={creationError ? "alert" : "status"}>
          <p>{creationError || `An earlier ${pendingAttempt?.kind === "divider" ? "divider" : "port"} addition needs to be checked. No new row will be added while it is pending.`}</p>
          {pendingAttempt && <button onClick={() => void addPortRow(pendingAttempt.kind === "divider", true)}
            disabled={!canEdit || !!orderDraft || creationLoadStatus !== "ready" || publishingAny || Object.values(savingPorts).some(Boolean)} style={toolbarButtonStyle}>Check earlier addition</button>}
          <button onClick={reloadPreviousAdditions} disabled={changingPortList || publishingAny || Object.values(savingPorts).some(Boolean)} style={toolbarButtonStyle}>Reload previous additions</button>
        </div>}
        {configLoadStatus === "loading" && <p role="status">Loading report settings… Publishing and override changes are paused.</p>}
        {savingOrder && <p role="status">Saving port order…</p>}
        {orderSaved && <p role="status">Port order saved.</p>}
        {orderError && <div role="alert">
          <p>{orderError}</p>
          {orderDraft && <button onClick={() => void savePortOrder(orderDraft)} disabled={savingOrder || !canEdit} style={toolbarButtonStyle}>Retry order save</button>}
          <button onClick={reloadSavedPorts} disabled={changingPortList || publishingAny || Object.values(savingPorts).some(Boolean)} style={toolbarButtonStyle}>Reload saved ports</button>
        </div>}
        {configLoadStatus === "error" && <div role="alert">
          <p>Could not load saved report settings. Publishing and override changes are paused; saved settings have not been replaced.</p>
          <button onClick={reloadReportSettings} style={toolbarButtonStyle}>Try loading report settings again</button>
        </div>}
        {(fallbackError || !savingFallback && Object.keys(fallbackDrafts).length > 0) && <div role="alert">
          <p>{fallbackError || "An override change is still unsaved. Retry it or reload the saved report settings."}</p>
          <button onClick={retryFallback} disabled={savingFallback || configLoadStatus !== "ready"} style={toolbarButtonStyle}>Retry override save</button>
          <button onClick={reloadReportSettings} disabled={savingFallback || publishingAny} style={toolbarButtonStyle}>Reload saved report settings</button>
        </div>}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr",
            gap: "16px",
            alignItems: "start",
          }}
        >
        <div style={{ overflowX: "auto" }} onDragLeave={dragLeave} onDragEnd={clearPortDrag}>
          <style>{`
            table[data-fcuno-port-order] > tbody > tr[data-drop-position="before"] > td { box-shadow: inset 0 3px 0 #006fee; }
            table[data-fcuno-port-order] > tbody > tr[data-drop-position="after"] > td { box-shadow: inset 0 -3px 0 #006fee; }
          `}</style>
          {dropIndicator && <div role="status" aria-live="polite" style={{ position: "fixed", bottom: "18px", left: "50%", transform: "translateX(-50%)", zIndex: 50, pointerEvents: "none", padding: "9px 14px", borderRadius: "8px", background: "#0057bc", color: "#fff", fontWeight: 700, fontSize: "13px" }}>
            Drop {dropIndicator.edge} {ports.find(port => port.id === dropIndicator.targetId)?.name || "this row"}
          </div>}
          <table data-fcuno-port-order style={{ width: "100%", borderCollapse: "collapse", minWidth: showCoords ? "980px" : "860px" }}>
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
                      draggable={canChangePortList && !publishingAny && !Object.values(savingPorts).some(Boolean)}
                      onDragStart={(event) => dragStart(event, port.id)}
                      onDrop={(event) => dragDrop(event, port.id)}
                      onDragOver={(event) => dragOver(event, port.id)}
                      onDragLeave={dragLeave}
                      data-drop-position={dropIndicator && dropIndicator.targetId === port.id ? dropIndicator.edge : undefined}
                    >
                      <td style={td}>↕</td>
                      <td style={{ ...td, paddingTop: "8px", paddingBottom: "8px" }} colSpan={showCoords ? 9 : 7}>
                        <input
                          value={port.name}
                          aria-label="Divider title"
                          disabled={!canEdit || publishingAny || Boolean(savingPorts[port.id])}
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
                        {savingPorts[port.id] && <span role="status">Saving divider…</span>}
                        {savedPorts[port.id] && <span role="status">Saved</span>}
                        {priceSaveErrors[port.id] && <div role="alert">
                          <p>{priceSaveErrors[port.id]}</p>
                          <button onClick={() => void saveDivider(port)} disabled={Boolean(savingPorts[port.id]) || !canEdit} style={toolbarButtonStyle}>Retry divider save</button>
                          <button onClick={reloadSavedPorts} disabled={Object.values(savingPorts).some(Boolean)} style={toolbarButtonStyle}>Reload saved ports</button>
                        </div>}
                      </td>
                      {showDeleteButtons && (
                        <td style={td}>
                          <button disabled={!canDeletePort} onClick={() => deletePort(port.id, port.name)} style={dangerButtonStyle}>
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
                const rowTint = isFormulaStylePort(port)
                  ? "#eef6ff"
                  : "#ffffff"

                return (
                  <tr
                    key={port.id}
                    draggable={canChangePortList && !publishingAny && !Object.values(savingPorts).some(Boolean)}
                    onDragStart={(event) => dragStart(event, port.id)}
                    onDrop={(event) => dragDrop(event, port.id)}
                    onDragOver={(event) => dragOver(event, port.id)}
                    onDragLeave={dragLeave}
                    data-drop-position={dropIndicator && dropIndicator.targetId === port.id ? dropIndicator.edge : undefined}
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

                    {fuelFieldConfigs.map((field, fuelIndex) => {
                      // Preserve the existing primary/direct vs formula-capable
                      // workflow, but display each fuel independently. Pin that
                      // capability to the saved row while editing a draft.
                      const allowsFormula = isFormulaStylePort(port) || hasFormulaForAnyFuel(port)
                        || hasFormulaForAnyFuel(savedPortSnapshots.current[port.id] ?? port)
                      const input = priceSetterFuelInput(port, field.priceField, fuelDrafts[port.id]?.[field.priceField], allowsFormula)
                      return (
                      <td key={field.priceField} style={td}>
                        <input
                          placeholder={input.isFormula ? "formula" : "price"}
                          aria-label={`${port.name} ${field.label} price or formula`}
                          title={allowsFormula ? "Enter a price or a formula, e.g. Taichung + 0" : "Enter a price, or leave empty if unavailable"}
                          maxLength={200}
                          disabled={!canEdit || publishingAny || isSaving}
                          value={input.value}
                          onChange={(event) => {
                            const value = event.target.value
                            if (updateValues(port.id, priceSetterFuelEdit(field.priceField, value, allowsFormula))) {
                              setFuelDrafts((prev) => ({ ...prev, [port.id]: { ...prev[port.id], [field.priceField]: value } }))
                            }
                          }}
                          ref={(element) => {
                            inputRefs.current[`${index}:${fuelIndex + (showCoords ? 3 : 1)}`] = element
                          }}
                          onKeyDown={(event) =>
                            handleGridKeyDown(event, index, fuelIndex + (showCoords ? 3 : 1))
                          }
                          style={{
                            ...compactInputStyle,
                            width: input.isFormula ? "124px" : "62px",
                          }}
                        />
                      </td>
                    )})}

                    <td style={{ ...td, fontSize: "12px", whiteSpace: "nowrap", color: "var(--fc-admin-muted)" }}>
                      {port.updated_at
                        ? formatMarketDateNumeric(port.updated_at)
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
                      {priceSaveErrors[port.id] && <div role="alert" style={{ maxWidth: "260px", fontSize: "12px", marginTop: "6px", color: "var(--fc-admin-danger-text)" }}>
                        <p style={{ margin: "0 0 6px" }}>{priceSaveErrors[port.id]}</p>
                        <button onClick={reloadSavedPorts} disabled={changingPortList || publishingAny || Object.values(savingPorts).some(Boolean)} style={toolbarButtonStyle}>Reload saved ports</button>
                      </div>}
                    </td>

                    {showDeleteButtons && (
                      <td style={td}>
                        <button disabled={!canDeletePort} onClick={() => deletePort(port.id, port.name)} style={dangerButtonStyle}>
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
                  Current: {publications[item.key].baseline?.publishedReportDate || "-"}
                </span>
                <input
                  type="date"
                  value={reportDateOverrides[item.key]}
                  disabled={!canEdit || configLoadStatus !== "ready" || publishingAny}
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
          {reportDateItems.map((item) => <ReportPublicationStatus key={item.key} title={item.label} publication={publications[item.key]}
            busy={publishingAny || changingPortList || Object.values(savingPorts).some(Boolean) || savingOrder || savingFallback} />)}
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
                        const current = fallbackDrafts[mapKey] ?? reportFallbacks[mapKey] ?? "-"
                        const selectColor =
                          current === "NA" ? "var(--fc-admin-danger-text)" : current === "SE" ? "var(--fc-admin-warning-text)" : "var(--fc-admin-panel-text)"
                        return (
                          <select
                            key={fuel}
                            aria-label={`${item.port} ${fuel.toUpperCase()} override`}
                            disabled={!canEdit || publishingAny || configLoadStatus !== "ready" || savingFallback}
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
