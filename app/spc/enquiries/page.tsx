"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { useSpcAuth } from "@/lib/useSpcAuth"
import { canAccessSpcPage } from "@/lib/spcPages"
import {
  buildSpcStandardEnquiry,
  cleanSpcEnquiryText,
  formatSpcFuelSegment,
  parseSpcEnquiryText,
  restoreStoredSpcEnquiryFields,
  spcFuelInputValue,
  writeSpcEnquiryNotes,
  type ParsedSpcEnquiry,
  type SpcEnquiryMeta,
} from "@/lib/spcEnquiryText"
import {
  detectAttentionTerms,
  detectSpcCautionTerms,
  detectVlsfoMaxRemarks,
  formatVlsfoMaxRemark,
  formatSpcCautionWarning,
  replaceHsfoWithRmk,
  type VlsfoMaxRemark,
} from "@/lib/enquiryShortener"
import { notifyParserReportCountChanged } from "@/lib/parserReportClient"
import { spcAmendmentSummaryLabels } from "@/lib/spcAmendmentPresentation"

type SpcEnquiry = {
  id: string
  enquiryNumber: string
  title: string
  vesselName: string | null
  port: string | null
  product: string | null
  quantity: string | null
  deliveryDate: string | null
  supplierName: string | null
  status: string
  notes: string | null
  meta: SpcEnquiryMeta
  formattedText: string
  createdByDisplayName: string
  revisionNumber: number
  lastAmendedAt: string | null
  lastAmendedByUsername: string | null
  amendmentChanges: Array<{ field: string; label: string; before: string; after: string }>
  createdAt: string
  updatedAt: string
}

type SupplierTrader = {
  username: string
  displayName: string
}

type EnquiriesResponse = {
  enquiries?: SpcEnquiry[]
  supplierTraders?: SupplierTrader[]
  buyerLostReasons?: string[]
  sessionKey?: string
  message?: string
}

type VesselHistoryResponse = {
  fixed?: Array<{
    id: string
    date: string | null
    supplier: string
    supplierTrader: string
  }>
  lost?: Array<{
    id: string
    date: string
    operator: string
    reason: string
  }>
  visibility?: {
    fixtures: boolean
    lost: boolean
  }
  message?: string
}

type VesselHistoryStatus = "idle" | "loading" | "loaded" | "failed"

type EnquiryOutcome = "stem" | "lost" | "postpone" | "cancel"

type DraftEnquiry = ParsedSpcEnquiry & {
  standardText: string
}

type OutcomeDraft = {
  id: string
  type: Extract<EnquiryOutcome, "stem" | "lost">
  lostReason: string
  supplierTraderUsername: string
}

type ReofferDraft = DraftEnquiry & {
  id: string
  enquiryNumber: string
}

type ParserReportDialog = {
  context: "new-enquiry" | "reoffer"
  rawText: string
  parserOutput: string
  aiOutput?: string
  aiSources?: ParserAiSourceLink[]
  correctedOutput: string
  note: string
}

type ParserAiSourceLink = {
  title: string
  url: string
}

type DraftFieldKey = "vesselName" | "imo" | "eta" | "fuel"

type ParserAiFields = {
  vesselName?: string
  imo?: string
  port?: string
  eta?: string
  hsfo?: string
  vlsfo?: string
  lsmgo?: string
  remarks?: string
}

type ParserAiResponse = {
  success?: boolean
  model?: string
  correctedOutput?: string
  fields?: ParserAiFields
  vlsfoMaxRemarks?: VlsfoMaxRemark[]
  confidence?: number
  warnings?: string[]
  imoSources?: ParserAiSourceLink[]
  message?: string
}

type ParserAiSuggestion = {
  context: ParserReportDialog["context"]
  model: string
  parserOutput: string
  correctedOutput: string
  fields: ParserAiFields
  vlsfoMaxRemarks: VlsfoMaxRemark[]
  confidence: number
  warnings: string[]
  imoSources: ParserAiSourceLink[]
  appliedAt: string
}

const FALLBACK_BUYER_LOST_REASONS = [
  "MINIMUM MARGIN",
  "CREDIT OR PAYMENT TERMS",
  "COVERAGE (SUPPLIER NOT COVERED)",
  "COVERAGE (LIMITED BY CUSTOMER)",
  "NOT TIMELY OFFERED",
  "DOUBLE TRADING",
  "T&C",
  "UNKNOWN",
] as const

const vlsfoRemarkOptions: VlsfoMaxRemark[] = ["80cst min", "120cst max", "180cst max"]

const emptyDraft: DraftEnquiry = {
  rawText: "",
  title: "",
  vesselName: "",
  imo: "",
  port: "SG",
  eta: "",
  hsfo: "",
  vlsfo: "",
  lsmgo: "",
  remarks: "",
  standardText: "",
}

function displayTime(value: string | null) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)
}

function displayDate(value: string | null) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
  }).format(date)
}

function displayHistoryDate(value: string | null) {
  if (!value) return "DATE NOT SET"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date)
}

function statusLabel(status: string) {
  if (status === "quoted") return "STEM"
  if (status === "cancelled") return "LOST"
  if (status === "closed") return "CANCELLED"
  return status || "sent"
}

function enquiryStatusLabel(enquiry: SpcEnquiry) {
  if (enquiry.status === "sent" && enquiry.meta?.postponedAt) return "POSTPONED"
  return statusLabel(enquiry.status)
}

function enquiryStatusClass(enquiry: SpcEnquiry) {
  if (enquiry.status === "sent" && enquiry.meta?.postponedAt) return "postponed"
  return enquiry.status || "sent"
}

function standardTextForDraft(
  draft: Pick<DraftEnquiry, "vesselName" | "imo" | "port" | "eta" | "hsfo" | "vlsfo" | "lsmgo" | "remarks">,
  vlsfoMaxRemarks: VlsfoMaxRemark[] = [],
) {
  return buildSpcStandardEnquiry({ ...draft, vlsfoMaxRemarks })
}

function rmkStandardText(text: string) {
  return replaceHsfoWithRmk(text).replace(/RMK\s+RMG380\s*\(3\.5%\)/i, "RMK")
}

function normaliseDraft(rawText: string, vlsfoMaxRemarks: VlsfoMaxRemark[] = []): DraftEnquiry {
  const parsed = parseSpcEnquiryText(rawText, vlsfoMaxRemarks)
  const draft = {
    ...parsed,
    hsfo: spcFuelInputValue(parsed.hsfo, "hsfo"),
    vlsfo: spcFuelInputValue(parsed.vlsfo, "vlsfo"),
    lsmgo: spcFuelInputValue(parsed.lsmgo, "lsmgo"),
  }
  const standardText = standardTextForDraft(draft, vlsfoMaxRemarks)
  return {
    ...draft,
    rawText,
    standardText: detectSpcCautionTerms(rawText).includes("RMK")
      ? rmkStandardText(standardText)
      : standardText,
  }
}

function cleanAiVlsfoMaxRemarks(value: ParserAiResponse["vlsfoMaxRemarks"]) {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value.filter((item): item is VlsfoMaxRemark =>
        item === "80cst min" || item === "80cst max" || item === "120cst max" || item === "180cst max",
      ),
    ),
  )
}

function draftFromAiResponse(
  rawText: string,
  payload: ParserAiResponse,
  fallbackVlsfoMaxRemarks: VlsfoMaxRemark[],
) {
  const nextVlsfoMaxRemarks = cleanAiVlsfoMaxRemarks(payload.vlsfoMaxRemarks)
  const vlsfoRemarks = nextVlsfoMaxRemarks.length > 0 ? nextVlsfoMaxRemarks : fallbackVlsfoMaxRemarks
  const fields = payload.fields || {}
  const parsed = normaliseDraft(payload.correctedOutput || "", vlsfoRemarks)
  const draft: DraftEnquiry = {
    ...parsed,
    rawText,
    vesselName: fields.vesselName || parsed.vesselName,
    imo: fields.imo || parsed.imo,
    port: fields.port || parsed.port || "SG",
    eta: fields.eta || parsed.eta,
    hsfo: spcFuelInputValue(fields.hsfo || parsed.hsfo, "hsfo"),
    vlsfo: spcFuelInputValue(fields.vlsfo || parsed.vlsfo, "vlsfo"),
    lsmgo: spcFuelInputValue(fields.lsmgo || parsed.lsmgo, "lsmgo"),
    remarks: fields.remarks || parsed.remarks,
  }
  draft.standardText = standardTextForDraft(draft, vlsfoRemarks)
  draft.title = [draft.vesselName || "new enquiry", draft.eta].filter(Boolean).join(" / ")
  return { draft, vlsfoMaxRemarks: vlsfoRemarks }
}

function normaliseVesselName(value: string | null | undefined) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function isOutcome(status: string) {
  return status === "quoted" || status === "cancelled" || status === "closed"
}

function sortByLatest(enquiries: SpcEnquiry[]) {
  return [...enquiries].sort((a, b) => {
    const first = a.meta?.postponedAt || a.updatedAt || a.createdAt
    const second = b.meta?.postponedAt || b.updatedAt || b.createdAt
    return second.localeCompare(first)
  })
}

function missingDraftFields(draft: DraftEnquiry): Set<DraftFieldKey> {
  const missing = new Set<DraftFieldKey>()
  if (!draft.vesselName.trim()) missing.add("vesselName")
  if (!draft.imo.trim()) missing.add("imo")
  if (!draft.eta.trim()) missing.add("eta")
  if (!draft.hsfo.trim() && !draft.vlsfo.trim() && !draft.lsmgo.trim()) missing.add("fuel")
  return missing
}

function productTextForDraft(draft: DraftEnquiry, vlsfoMaxRemarks: VlsfoMaxRemark[]) {
  return [
    formatSpcFuelSegment("hsfo", draft.hsfo),
    formatSpcFuelSegment("vlsfo", draft.vlsfo, vlsfoMaxRemarks),
    formatSpcFuelSegment("lsmgo", draft.lsmgo),
  ].filter(Boolean).join(" / ")
}

function googleImoSearchUrl(draft: DraftEnquiry) {
  const firstRawLine = draft.rawText
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) || ""
  const vessel = draft.vesselName || firstRawLine.split(/\s+@\s+/)[0] || ""
  const query = [vessel, "vessel IMO"].filter(Boolean).join(" ").trim()
  return query ? `https://www.google.com/search?q=${encodeURIComponent(query)}` : ""
}

function missingRecordSupplier(match: SpcEnquiry) {
  return match.meta?.stemSupplierTraderDisplayName ||
    match.supplierName ||
    match.meta?.fixtureSupplier ||
    (match.status === "cancelled" ? match.meta?.lostReason : "") ||
    "NO SUPPLIER"
}

function stemRecordSupplier(match: SpcEnquiry) {
  return match.meta?.fixtureSupplier || match.supplierName || ""
}

function recordLine(match: SpcEnquiry) {
  const parts = [
    statusLabel(match.status),
    displayDate(match.meta?.outcomeAt || match.updatedAt),
  ]

  if (match.status === "quoted") {
    parts.push(match.meta?.stemSupplierTraderDisplayName || "NO TRADER")
    parts.push(stemRecordSupplier(match) || "SUPPLIER NOT SET")
  } else {
    parts.push(missingRecordSupplier(match))
  }

  return parts.filter(Boolean).join(" · ")
}

function EnquiryCommandIcon({ kind }: { kind: "ai" | "report" | "send" | "sent" }) {
  if (kind === "ai") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="m14.6 5.1 4.3 4.3L9.1 19.2H4.8v-4.3l9.8-9.8Z" />
        <path d="M6 2.8v4.4M3.8 5h4.4M18.8 14.8v4.4M16.6 17h4.4" />
      </svg>
    )
  }

  if (kind === "report") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M5 21V4.2M5 5h11l-1.8 3L16 11H5" />
      </svg>
    )
  }

  if (kind === "sent") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="m5 12.5 4.2 4.2L19 7" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3.8 11.2 19.1 4.1c.9-.4 1.8.5 1.4 1.4l-7.1 15.3c-.4.9-1.7.7-1.9-.3l-1.4-6.4-6.4-1.4c-1-.2-1.2-1.5-.3-1.9Z" />
      <path d="m10.4 13.7 4.2-4.2" />
    </svg>
  )
}

function VesselHistoryIcon({ kind }: { kind: "fixed" | "lost" | "neutral" }) {
  if (kind === "fixed") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12.2 2.6 2.6 5.6-6" />
      </svg>
    )
  }

  if (kind === "lost") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 3.5 21 20H3L12 3.5Z" />
        <path d="M12 9v5M12 17.2v.2" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="7" />
      <path d="m16.2 16.2 4.1 4.1M8.5 11h5" />
    </svg>
  )
}

function reportEnquiryError(error: unknown, fallback: string) {
  console.error(error instanceof Error ? error.message : fallback)
}

function draftFromEnquiry(enquiry: SpcEnquiry): ReofferDraft {
  const parsed = restoreStoredSpcEnquiryFields(enquiry)
  const structured = {
    ...parsed,
    hsfo: spcFuelInputValue(parsed.hsfo, "hsfo"),
    vlsfo: spcFuelInputValue(parsed.vlsfo, "vlsfo"),
    lsmgo: spcFuelInputValue(parsed.lsmgo, "lsmgo"),
  }
  return {
    ...emptyDraft,
    ...structured,
    id: enquiry.id,
    enquiryNumber: enquiry.enquiryNumber,
    title: [structured.vesselName || "reoffer", structured.eta].filter(Boolean).join(" / "),
    standardText: standardTextForDraft(structured),
  }
}

export default function SpcEnquiriesPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, username, permissions } = useSpcAuth()
  const [draft, setDraft] = useState<DraftEnquiry>(emptyDraft)
  const [enquiries, setEnquiries] = useState<SpcEnquiry[]>([])
  const [supplierTraders, setSupplierTraders] = useState<SupplierTrader[]>([])
  const [buyerLostReasons, setBuyerLostReasons] = useState<string[]>([...FALLBACK_BUYER_LOST_REASONS])
  const [outcomeDraft, setOutcomeDraft] = useState<OutcomeDraft | null>(null)
  const [reofferDraft, setReofferDraft] = useState<ReofferDraft | null>(null)
  const [enquiryEditorMode, setEnquiryEditorMode] = useState<"reoffer" | "amend">("reoffer")
  const [vlsfoMaxRemarks, setVlsfoMaxRemarks] = useState<VlsfoMaxRemark[]>([])
  const [validationAttempted, setValidationAttempted] = useState(false)
  const [dismissedDraftMissingFields, setDismissedDraftMissingFields] = useState<Set<DraftFieldKey>>(() => new Set())
  const [reofferValidationAttempted, setReofferValidationAttempted] = useState(false)
  const [dismissedReofferMissingFields, setDismissedReofferMissingFields] = useState<Set<DraftFieldKey>>(() => new Set())
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sendError, setSendError] = useState("")
  const [rmkMode, setRmkMode] = useState(false)
  const [updatingId, setUpdatingId] = useState("")
  const [parserReportDialog, setParserReportDialog] = useState<ParserReportDialog | null>(null)
  const [parserReportStatus, setParserReportStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle")
  const [reportButtonState, setReportButtonState] = useState<"" | "new-enquiry" | "reoffer">("")
  const [parserAiStatus, setParserAiStatus] = useState<"idle" | "loading" | "applied" | "failed">("idle")
  const [parserAiTarget, setParserAiTarget] = useState<ParserReportDialog["context"] | "">("")
  const [parserAiMessage, setParserAiMessage] = useState("")
  const [parserAiSuggestion, setParserAiSuggestion] = useState<ParserAiSuggestion | null>(null)
  const [vesselHistory, setVesselHistory] = useState<VesselHistoryResponse>({ fixed: [], lost: [] })
  const [vesselHistoryStatus, setVesselHistoryStatus] = useState<VesselHistoryStatus>("idle")
  const [vesselHistoryLookupKey, setVesselHistoryLookupKey] = useState("")
  const enquiryLoadSequence = useRef(0)
  const vesselHistoryLoadSequence = useRef(0)

  const canView = authenticated && canAccessSpcPage(permissions, "spc-buyer-enquiries", "view")
  const canEdit = authenticated && canAccessSpcPage(permissions, "spc-buyer-enquiries", "edit")
  const currentVesselHistoryLookupKey = `${draft.imo.replace(/\D/g, "")}|${normaliseVesselName(draft.vesselName)}`
  const visibleVesselHistoryStatus =
    vesselHistoryLookupKey === currentVesselHistoryLookupKey ? vesselHistoryStatus : "idle"
  const showVesselHistorySummary =
    visibleVesselHistoryStatus !== "idle" &&
    !(
      visibleVesselHistoryStatus === "loaded" &&
      !vesselHistory.visibility?.fixtures &&
      !vesselHistory.visibility?.lost
    )
  const activeEnquiries = useMemo(
    () => sortByLatest(enquiries.filter((enquiry) => enquiry.status === "sent" && !enquiry.meta?.postponedAt)),
    [enquiries],
  )
  const postponedEnquiries = useMemo(
    () => sortByLatest(enquiries.filter((enquiry) => enquiry.status === "sent" && enquiry.meta?.postponedAt)),
    [enquiries],
  )
  const outcomeMatchesByVessel = useMemo(() => {
    const matches = new Map<string, SpcEnquiry[]>()
    enquiries.forEach((enquiry) => {
      if (!isOutcome(enquiry.status)) return
      const key = normaliseVesselName(enquiry.vesselName || enquiry.title)
      if (!key) return
      const current = matches.get(key) || []
      current.push(enquiry)
      matches.set(key, current)
    })
    return matches
  }, [enquiries])
  const draftMissingFields = useMemo(() => missingDraftFields(draft), [draft])
  const reofferMissingFields = useMemo(
    () => (reofferDraft ? missingDraftFields(reofferDraft) : new Set<DraftFieldKey>()),
    [reofferDraft],
  )
  const imoSearchUrl = useMemo(() => googleImoSearchUrl(draft), [draft])
  const cautionTerms = detectSpcCautionTerms(draft.rawText)
  const attentionTerms = detectAttentionTerms(draft.rawText).filter((term) => term !== "RMK")
  const reofferAttentionTerms = detectAttentionTerms(reofferDraft?.rawText || reofferDraft?.standardText || "")
  const hasDraftContent = [
    draft.rawText,
    draft.vesselName,
    draft.imo,
    draft.eta,
    draft.hsfo,
    draft.vlsfo,
    draft.lsmgo,
    draft.remarks,
    draft.standardText,
  ].some((value) => value.trim().length > 0)

  function shouldShowDraftMissing(field: DraftFieldKey) {
    return validationAttempted && draftMissingFields.has(field) && !dismissedDraftMissingFields.has(field)
  }

  function shouldShowReofferMissing(field: DraftFieldKey) {
    return reofferValidationAttempted && reofferMissingFields.has(field) && !dismissedReofferMissingFields.has(field)
  }

  const loadEnquiries = useCallback(async () => {
    if (!canView || !username) return
    const sequence = ++enquiryLoadSequence.current
    setLoading(true)
    try {
      const response = await fetch("/api/spc/enquiries?limit=200&bootstrap=1", { cache: "no-store" })
      const data = (await response.json()) as EnquiriesResponse
      if (!response.ok) throw new Error(data.message || "Failed to load enquiries.")
      if (sequence !== enquiryLoadSequence.current) return
      if (data.sessionKey?.toLowerCase() !== username.toLowerCase()) {
        throw new Error("The enquiry response does not match the authenticated SPC user.")
      }
      setEnquiries(data.enquiries || [])
      if (Array.isArray(data.supplierTraders)) setSupplierTraders(data.supplierTraders)
      if (Array.isArray(data.buyerLostReasons) && data.buyerLostReasons.length > 0) {
        setBuyerLostReasons(data.buyerLostReasons)
      }
    } catch (error) {
      reportEnquiryError(error, "Failed to load enquiries.")
    } finally {
      if (sequence === enquiryLoadSequence.current) setLoading(false)
    }
  }, [canView, username])

  useEffect(() => {
    document.title = "SPC NEW ENQUIRY"
  }, [])

  useEffect(() => {
    if (!authLoading && !canView) router.replace("/spc")
  }, [authLoading, canView, router])

  useEffect(() => {
    enquiryLoadSequence.current += 1
    setEnquiries([])
    setSupplierTraders([])
    setBuyerLostReasons([...FALLBACK_BUYER_LOST_REASONS])
  }, [username])

  useEffect(() => {
    void loadEnquiries()
  }, [loadEnquiries])

  useEffect(() => {
    const vesselName = draft.vesselName.trim()
    const imo = draft.imo.replace(/\D/g, "")
    const lookupKey = `${imo}|${normaliseVesselName(vesselName)}`
    const canLookup = imo.length === 7 || normaliseVesselName(vesselName).length >= 3
    const sequence = ++vesselHistoryLoadSequence.current
    const resetTimer = window.setTimeout(() => {
      if (sequence !== vesselHistoryLoadSequence.current) return
      setVesselHistoryLookupKey(lookupKey)
      setVesselHistory({ fixed: [], lost: [] })
      setVesselHistoryStatus(canView && canLookup ? "loading" : "idle")
    }, 0)

    if (!canView || !canLookup) {
      return () => window.clearTimeout(resetTimer)
    }

    const controller = new AbortController()

    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ vesselName, imo })
        const response = await fetch(`/api/spc/enquiry-history?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        })
        const data = (await response.json()) as VesselHistoryResponse
        if (!response.ok) throw new Error(data.message || "Failed to load vessel history.")
        if (sequence !== vesselHistoryLoadSequence.current) return
        setVesselHistoryLookupKey(lookupKey)
        setVesselHistory(data)
        setVesselHistoryStatus("loaded")
      } catch (error) {
        if (controller.signal.aborted || sequence !== vesselHistoryLoadSequence.current) return
        reportEnquiryError(error, "Failed to load vessel history.")
        setVesselHistoryLookupKey(lookupKey)
        setVesselHistory({ fixed: [], lost: [] })
        setVesselHistoryStatus("failed")
      }
    }, 300)

    return () => {
      window.clearTimeout(resetTimer)
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [canView, draft.imo, draft.vesselName])

  function dismissDraftMissingField(field: DraftFieldKey) {
    setDismissedDraftMissingFields((current) => new Set(current).add(field))
  }

  function dismissReofferMissingField(field: DraftFieldKey) {
    setDismissedReofferMissingFields((current) => new Set(current).add(field))
  }

  function updateDraft(key: keyof DraftEnquiry, value: string) {
    if (key === "vesselName") dismissDraftMissingField("vesselName")
    if (key === "imo") dismissDraftMissingField("imo")
    if (key === "eta") dismissDraftMissingField("eta")
    if (key === "hsfo" || key === "vlsfo" || key === "lsmgo") dismissDraftMissingField("fuel")

    if (key === "rawText") {
      setRmkMode(detectSpcCautionTerms(value).includes("RMK"))
      setVlsfoMaxRemarks([])
      setParserAiStatus("idle")
      setParserAiTarget("")
      setParserAiMessage("")
      setParserAiSuggestion(null)
      setDraft(normaliseDraft(value, []))
      return
    }

    if (key === "standardText") {
      setDraft((current) => {
        const parsed = normaliseDraft(value, vlsfoMaxRemarks)
        return {
          ...current,
          ...parsed,
          rawText: current.rawText,
          standardText: value,
          title: [parsed.vesselName || "new enquiry", parsed.eta].filter(Boolean).join(" / "),
        }
      })
      return
    }

    setDraft((current) => {
      const next = {
        ...current,
        [key]: key === "hsfo" || key === "vlsfo" || key === "lsmgo" ? spcFuelInputValue(value, key) : value,
      }
      next.standardText = standardTextForDraft(next, vlsfoMaxRemarks)
      if (rmkMode) next.standardText = rmkStandardText(next.standardText)
      next.title = [next.vesselName || "new enquiry", next.eta]
        .filter(Boolean)
        .join(" / ")
      return next
    })
  }

  function updateReofferDraft(key: keyof DraftEnquiry, value: string) {
    if (key === "vesselName") dismissReofferMissingField("vesselName")
    if (key === "imo") dismissReofferMissingField("imo")
    if (key === "eta") dismissReofferMissingField("eta")
    if (key === "hsfo" || key === "vlsfo" || key === "lsmgo") dismissReofferMissingField("fuel")

    if (key === "rawText") {
      setParserAiStatus("idle")
      setParserAiTarget("")
      setParserAiMessage("")
      setParserAiSuggestion(null)
      setReofferDraft((current) =>
        current ? { ...current, ...normaliseDraft(value, []), id: current.id, enquiryNumber: current.enquiryNumber } : current,
      )
      return
    }

    if (key === "standardText") {
      setReofferDraft((current) => {
        if (!current) return current
        const parsed = normaliseDraft(value, [])
        return {
          ...current,
          ...parsed,
          id: current.id,
          enquiryNumber: current.enquiryNumber,
          rawText: current.rawText,
          standardText: value,
          title: [parsed.vesselName || "reoffer", parsed.eta].filter(Boolean).join(" / "),
        }
      })
      return
    }

    setReofferDraft((current) => {
      if (!current) return current
      const next = {
        ...current,
        [key]: key === "hsfo" || key === "vlsfo" || key === "lsmgo" ? spcFuelInputValue(value, key) : value,
      }
      next.standardText = standardTextForDraft(next, [])
      next.title = [next.vesselName || "reoffer", next.eta].filter(Boolean).join(" / ")
      return next
    })
  }

  function toggleVlsfoMaxRemark(remark: VlsfoMaxRemark) {
    setVlsfoMaxRemarks((current) => {
      const next = current.includes(remark)
        ? current.filter((item) => item !== remark)
        : [...current, remark]

      setDraft((draftCurrent) => ({
        ...draftCurrent,
        standardText: rmkMode
          ? rmkStandardText(standardTextForDraft(draftCurrent, next))
          : standardTextForDraft(draftCurrent, next),
      }))
      return next
    })
  }

  function toggleDraftRemark(remark: "COQ REQUIRED" | "30D QUALITY TIME BAR") {
    setDraft((current) => {
      const values = current.remarks
        .split(/\s*\/\s*/)
        .map((item) => item.trim())
        .filter(Boolean)
      const active = values.some((item) => item.toUpperCase() === remark)
      const nextRemarks = active
        ? values.filter((item) => item.toUpperCase() !== remark).join(" / ")
        : [...values, remark].join(" / ")
      const next = { ...current, remarks: nextRemarks }
      next.standardText = rmkMode
        ? rmkStandardText(standardTextForDraft(next, vlsfoMaxRemarks))
        : standardTextForDraft(next, vlsfoMaxRemarks)
      return next
    })
  }

  function clearDraft() {
    setDraft(emptyDraft)
    setRmkMode(false)
    setVlsfoMaxRemarks([])
    setValidationAttempted(false)
    setDismissedDraftMissingFields(new Set())
    setParserAiStatus("idle")
    setParserAiTarget("")
    setParserAiMessage("")
    setParserAiSuggestion(null)
  }

  async function queueParserReport(context: ParserReportDialog["context"]) {
    const targetDraft = context === "reoffer" ? reofferDraft : draft
    if (!targetDraft || reportButtonState) return
    const rawText = (targetDraft.rawText || targetDraft.standardText).trim()
    const parserOutput = targetDraft.standardText.trim() || standardTextForDraft(
      targetDraft,
      context === "reoffer" ? [] : vlsfoMaxRemarks,
    )
    if (!rawText || !parserOutput) return

    setReportButtonState(context)
    try {
      const response = await fetch("/api/parser-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "spc",
          context,
          rawText,
          parserOutput,
          correctedOutput: parserOutput,
          pageUrl: window.location.href,
          metadata: {
            draft: targetDraft,
            manualVlsfoMaxRemarks: context === "reoffer" ? [] : vlsfoMaxRemarks,
            pendingReview: true,
          },
        }),
      })
      const data = (await response.json().catch(() => ({}))) as { message?: string }
      if (!response.ok) throw new Error(data.message || "Failed to send report.")
      notifyParserReportCountChanged("spc")
      window.setTimeout(() => setReportButtonState(""), 5_000)
    } catch (error) {
      setReportButtonState("")
      reportEnquiryError(error, "Failed to send parser report.")
    }
  }

  function openDraftParserReport() {
    void queueParserReport("new-enquiry")
  }

  function openReofferParserReport() {
    void queueParserReport("reoffer")
  }

  function applyCorrectedParserReport(dialog: ParserReportDialog, correctedOutput: string) {
    const correctedVlsfoMaxRemarks = dialog.context === "reoffer" ? [] : detectVlsfoMaxRemarks(correctedOutput)
    const correctedDraft = normaliseDraft(correctedOutput, correctedVlsfoMaxRemarks)

    if (dialog.context === "reoffer") {
      setReofferDraft((current) =>
        current
          ? {
              ...current,
              ...correctedDraft,
              id: current.id,
              enquiryNumber: current.enquiryNumber,
              rawText: current.rawText,
              standardText: correctedOutput,
            }
          : current,
      )
      return
    }

    setVlsfoMaxRemarks(correctedVlsfoMaxRemarks)
    setDraft((current) => ({
      ...current,
      ...correctedDraft,
      rawText: current.rawText,
      standardText: correctedOutput,
    }))
  }

  async function runParserAi(context: ParserReportDialog["context"]) {
    const targetDraft = context === "reoffer" ? reofferDraft : draft
    if (!targetDraft || parserAiStatus === "loading") return
    const rawText = (targetDraft.rawText || targetDraft.standardText).trim()
    if (!rawText) return

    const manualVlsfoMaxRemarks = context === "reoffer" ? [] : vlsfoMaxRemarks
    const deterministicOutput = standardTextForDraft(targetDraft, manualVlsfoMaxRemarks)
    setParserAiStatus("loading")
    setParserAiTarget(context)
    setParserAiMessage("")

    try {
      const response = await fetch("/api/parser-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "spc",
          context,
          rawText,
          parserOutput: deterministicOutput,
          currentOutput: targetDraft.standardText,
          fields: {
            vesselName: targetDraft.vesselName,
            imo: targetDraft.imo,
            port: targetDraft.port,
            eta: targetDraft.eta,
            hsfo: targetDraft.hsfo,
            vlsfo: targetDraft.vlsfo,
            lsmgo: targetDraft.lsmgo,
            remarks: targetDraft.remarks,
          },
          manualVlsfoMaxRemarks,
        }),
      })
      const payload = (await response.json().catch(() => ({}))) as ParserAiResponse
      if (!response.ok || !payload.correctedOutput) {
        throw new Error(payload.message || "AI parser failed.")
      }

      const next = draftFromAiResponse(rawText, payload, manualVlsfoMaxRemarks)
      if (context === "reoffer") {
        setReofferDraft((current) =>
          current
            ? {
                ...next.draft,
                id: current.id,
                enquiryNumber: current.enquiryNumber,
                rawText: current.rawText || rawText,
              }
            : current,
        )
      } else {
        setVlsfoMaxRemarks(next.vlsfoMaxRemarks)
        setDraft((current) => ({
          ...current,
          ...next.draft,
          rawText: current.rawText || rawText,
        }))
      }

      setParserAiSuggestion({
        context,
        model: payload.model || "gpt-5.4-mini",
        parserOutput: deterministicOutput,
        correctedOutput: next.draft.standardText,
        fields: payload.fields || {},
        vlsfoMaxRemarks: next.vlsfoMaxRemarks,
        confidence: typeof payload.confidence === "number" ? payload.confidence : 0,
        warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
        imoSources: Array.isArray(payload.imoSources) ? payload.imoSources.filter((source) => source?.url) : [],
        appliedAt: new Date().toISOString(),
      })
      setParserAiStatus("applied")
      setParserAiMessage("AI correction applied. Double check before sending.")
      setDismissedDraftMissingFields(new Set())
      setDismissedReofferMissingFields(new Set())
    } catch (error) {
      setParserAiStatus("failed")
      setParserAiMessage(error instanceof Error ? error.message : "AI parser failed.")
    }
  }

  async function submitParserReport() {
    if (!parserReportDialog || parserReportStatus === "saving") return
    const rawText = parserReportDialog.rawText.trim()
    const parserOutput = parserReportDialog.parserOutput.trim()
    const correctedOutput = parserReportDialog.correctedOutput.trim()
    if (!rawText || !correctedOutput) return

    setParserReportStatus("saving")
    try {
      const response = await fetch("/api/parser-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "spc",
          context: parserReportDialog.context,
          rawText,
          parserOutput,
          correctedOutput,
          note: parserReportDialog.note,
          pageUrl: window.location.href,
          metadata: {
            draft: parserReportDialog.context === "reoffer" ? reofferDraft : draft,
            manualVlsfoMaxRemarks: parserReportDialog.context === "reoffer" ? [] : vlsfoMaxRemarks,
            aiSuggestion: parserAiSuggestion?.context === parserReportDialog.context ? parserAiSuggestion : null,
            aiFixOutput: parserReportDialog.aiOutput || "",
            aiSources: parserReportDialog.aiSources || [],
          },
        }),
      })
      const data = (await response.json().catch(() => ({}))) as { message?: string }
      if (!response.ok) throw new Error(data.message || "Failed to save report.")

      applyCorrectedParserReport(parserReportDialog, correctedOutput)
      notifyParserReportCountChanged("spc")
      setParserReportStatus("saved")
      window.setTimeout(() => {
        setParserReportDialog(null)
        setParserReportStatus("idle")
      }, 900)
    } catch (error) {
      reportEnquiryError(error, "Failed to save parser report.")
      setParserReportStatus("failed")
    }
  }

  async function sendEnquiry(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canEdit || saving) return
    setSendError("")
    setValidationAttempted(true)
    setDismissedDraftMissingFields(new Set())
    setSaving(true)

    if (draftMissingFields.size > 0) {
      setSaving(false)
      return
    }

    const standardText = cleanSpcEnquiryText(draft.standardText || standardTextForDraft(draft, vlsfoMaxRemarks))
    const finalVlsfoMaxRemarks = vlsfoMaxRemarks

    const payload = {
      title: draft.title || draft.vesselName || standardText.slice(0, 80),
      vesselName: draft.vesselName,
      port: draft.port,
      product: productTextForDraft(draft, finalVlsfoMaxRemarks),
      notes: writeSpcEnquiryNotes(standardText, {
        imo: draft.imo,
        port: draft.port,
        eta: draft.eta,
        hsfo: draft.hsfo,
        vlsfo: draft.vlsfo,
        lsmgo: draft.lsmgo,
      }),
    }

    try {
      const response = await fetch("/api/spc/enquiries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const data = (await response.json()) as { enquiry?: SpcEnquiry; message?: string }
      if (!response.ok || !data.enquiry) {
        throw new Error(data.message || "Failed to send enquiry.")
      }
      clearDraft()
      setEnquiries((current) => {
        const withoutDuplicate = current.filter((enquiry) => enquiry.id !== data.enquiry!.id)
        return [data.enquiry!, ...withoutDuplicate]
      })
      setRmkMode(false)
    } catch (error) {
      reportEnquiryError(error, "Failed to send enquiry.")
      setSendError(error instanceof Error ? error.message : "Failed to send enquiry.")
    } finally {
      setSaving(false)
    }
  }

  function openOutcome(enquiry: SpcEnquiry, type: Extract<EnquiryOutcome, "stem" | "lost">) {
    setOutcomeDraft({
      id: enquiry.id,
      type,
      lostReason: buyerLostReasons[0] || "UNKNOWN",
      supplierTraderUsername: supplierTraders[0]?.username || "",
    })
  }

  async function patchOutcome(payload: {
    id: string
    outcome: EnquiryOutcome
    lostReason?: string
    supplierTraderUsername?: string
    supplierTraderDisplayName?: string
  }) {
    const response = await fetch("/api/spc/enquiries", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    const data = (await response.json()) as { enquiry?: SpcEnquiry; message?: string }
    if (!response.ok || !data.enquiry) {
      throw new Error(data.message || "Failed to update enquiry.")
    }
    setEnquiries((current) =>
      current.map((enquiry) => (enquiry.id === payload.id ? data.enquiry! : enquiry)),
    )
    return data.enquiry
  }

  async function confirmOutcome() {
    if (!canEdit || !outcomeDraft) return
    const supplierTrader = supplierTraders.find(
      (user) => user.username === outcomeDraft.supplierTraderUsername,
    )
    setUpdatingId(outcomeDraft.id)
    try {
      await patchOutcome({
        id: outcomeDraft.id,
        outcome: outcomeDraft.type,
        lostReason: outcomeDraft.type === "lost" ? outcomeDraft.lostReason : "",
        supplierTraderUsername:
          outcomeDraft.type === "stem" ? outcomeDraft.supplierTraderUsername : "",
        supplierTraderDisplayName: outcomeDraft.type === "stem" ? supplierTrader?.displayName || "" : "",
      })
      setOutcomeDraft(null)
    } catch (error) {
      reportEnquiryError(error, "Failed to update enquiry.")
    } finally {
      setUpdatingId("")
    }
  }

  async function quickOutcome(enquiry: SpcEnquiry, outcome: Extract<EnquiryOutcome, "postpone" | "cancel">) {
    if (!canEdit) return
    setUpdatingId(enquiry.id)
    try {
      await patchOutcome({ id: enquiry.id, outcome })
      if (outcome === "cancel") {
        setEnquiries((current) => current.filter((row) => row.id !== enquiry.id))
      }
    } catch (error) {
      reportEnquiryError(error, "Failed to update enquiry.")
    } finally {
      setUpdatingId("")
    }
  }

  function openReoffer(enquiry: SpcEnquiry) {
    setEnquiryEditorMode("reoffer")
    setReofferValidationAttempted(false)
    setDismissedReofferMissingFields(new Set())
    setReofferDraft(draftFromEnquiry(enquiry))
  }

  function openAmend(enquiry: SpcEnquiry) {
    setEnquiryEditorMode("amend")
    setReofferValidationAttempted(false)
    setDismissedReofferMissingFields(new Set())
    setReofferDraft(draftFromEnquiry(enquiry))
  }

  async function confirmReoffer() {
    if (!canEdit || !reofferDraft || saving) return
    setReofferValidationAttempted(true)
    setDismissedReofferMissingFields(new Set())
    const missing = missingDraftFields(reofferDraft)
    if (missing.size > 0) {
      return
    }

    setSaving(true)
    setUpdatingId(reofferDraft.id)
    const standardText = cleanSpcEnquiryText(reofferDraft.standardText || standardTextForDraft(reofferDraft))
    const finalVlsfoMaxRemarks: VlsfoMaxRemark[] = []

    try {
      const response = await fetch("/api/spc/enquiries", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: reofferDraft.id,
          mode: enquiryEditorMode,
          title: reofferDraft.title || reofferDraft.vesselName || standardText.slice(0, 80),
          vesselName: reofferDraft.vesselName,
          port: reofferDraft.port,
          product: productTextForDraft(reofferDraft, finalVlsfoMaxRemarks),
          notes: writeSpcEnquiryNotes(standardText, {
            imo: reofferDraft.imo,
            port: reofferDraft.port,
            eta: reofferDraft.eta,
            hsfo: reofferDraft.hsfo,
            vlsfo: reofferDraft.vlsfo,
            lsmgo: reofferDraft.lsmgo,
          }),
        }),
      })
      const data = (await response.json()) as { enquiry?: SpcEnquiry; message?: string }
      if (!response.ok || !data.enquiry) {
        throw new Error(data.message || `Failed to ${enquiryEditorMode === "amend" ? "amend" : "reoffer"} enquiry.`)
      }

      setEnquiries((current) => enquiryEditorMode === "amend"
        ? current.map((enquiry) => enquiry.id === data.enquiry!.id ? data.enquiry! : enquiry)
        : [
            data.enquiry!,
            ...current.filter((enquiry) => enquiry.id !== reofferDraft.id && enquiry.id !== data.enquiry!.id),
          ])
      setReofferDraft(null)
    } catch (error) {
      reportEnquiryError(error, `Failed to ${enquiryEditorMode === "amend" ? "amend" : "reoffer"} enquiry.`)
    } finally {
      setSaving(false)
      setUpdatingId("")
    }
  }

  function matchesForVesselName(vesselName: string | null | undefined) {
    const key = normaliseVesselName(vesselName)
    if (!key) return []
    return outcomeMatchesByVessel.get(key) || []
  }

  function matchesFor(enquiry: SpcEnquiry) {
    return matchesForVesselName(enquiry.vesselName || enquiry.title).filter((match) => match.id !== enquiry.id)
  }

  if (authLoading || !canView) {
    return <div className="spc-loading">Loading...</div>
  }

  return (
    <SpcShell title="SPC NEW ENQUIRY">
      <div className="spc-enquiries-layout">
        <section className="spc-panel spc-enquiry-entry-panel">
            <div className="spc-panel-header spc-enquiry-entry-header">
              <div className="spc-enquiry-heading-copy">
                <span>ENQUIRY WORKSPACE</span>
                <h2>New Enquiry</h2>
              </div>
              {showVesselHistorySummary ? (
                <div className="spc-vessel-history-summary" role="status" aria-live="polite">
                  {visibleVesselHistoryStatus === "loading" ? (
                    <div className="spc-vessel-history-card is-neutral">
                      <div className="spc-vessel-history-label"><VesselHistoryIcon kind="neutral" /><strong>CHECKING VESSEL HISTORY</strong></div>
                    </div>
                  ) : null}
                  {visibleVesselHistoryStatus === "failed" ? (
                    <div className="spc-vessel-history-card is-unavailable">
                      <div className="spc-vessel-history-label"><VesselHistoryIcon kind="lost" /><strong>HISTORY CHECK UNAVAILABLE</strong></div>
                    </div>
                  ) : null}
                  {visibleVesselHistoryStatus === "loaded" && (vesselHistory.fixed?.length || 0) > 0 ? (
                    <div className="spc-vessel-history-card is-fixed">
                      <div className="spc-vessel-history-label"><VesselHistoryIcon kind="fixed" /><strong>PREVIOUSLY FIXED</strong></div>
                      <div className="spc-vessel-history-records">
                        {vesselHistory.fixed?.slice(0, 3).map((record) => (
                          <span key={record.id}>{[displayHistoryDate(record.date), record.supplier, record.supplierTrader].filter(Boolean).join(" · ")}</span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {visibleVesselHistoryStatus === "loaded" && (vesselHistory.lost?.length || 0) > 0 ? (
                    <div className="spc-vessel-history-card is-lost">
                      <div className="spc-vessel-history-label"><VesselHistoryIcon kind="lost" /><strong>PREVIOUSLY LOST</strong></div>
                      <div className="spc-vessel-history-records">
                        {vesselHistory.lost?.slice(0, 3).map((record) => (
                          <span key={record.id}>{displayHistoryDate(record.date)} · {record.operator} · {record.reason}</span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {visibleVesselHistoryStatus === "loaded" &&
                  (vesselHistory.fixed?.length || 0) === 0 &&
                  (vesselHistory.lost?.length || 0) === 0 &&
                  (vesselHistory.visibility?.fixtures || vesselHistory.visibility?.lost) ? (
                    <div className="spc-vessel-history-card is-neutral">
                      <div className="spc-vessel-history-label">
                        <VesselHistoryIcon kind="neutral" />
                        <strong>
                          {vesselHistory.visibility?.fixtures && vesselHistory.visibility?.lost
                            ? "NO PREVIOUS FIXED / LOST RECORD"
                            : vesselHistory.visibility?.fixtures
                              ? "NO PREVIOUS FIXED RECORD"
                              : "NO PREVIOUS LOST RECORD"}
                        </strong>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <form onSubmit={sendEnquiry} className="spc-enquiry-entry-form" noValidate>
              <div className="spc-enquiry-parser-pane">
                <div className="spc-enquiry-raw">
                  <label htmlFor="spc-enquiry-parser">Parser</label>
                  <div className="spc-enquiry-raw-control">
                    <textarea
                      id="spc-enquiry-parser"
                      value={draft.rawText}
                      onChange={(event) => updateDraft("rawText", event.target.value)}
                      placeholder="PASTE YOUR ENQUIRY HERE"
                      rows={12}
                      disabled={!canEdit}
                    />
                    <button
                      type="button"
                      className={`spc-enquiry-clear-button${hasDraftContent ? " is-active" : ""}`}
                      onClick={clearDraft}
                      disabled={!canEdit || saving || !hasDraftContent}
                    >
                      CLEAR
                    </button>
                  </div>
                </div>
                {cautionTerms.length > 0 ? (
                  <div className="spc-enquiry-warning">
                    {formatSpcCautionWarning(cautionTerms)}
                  </div>
                ) : null}
                {attentionTerms.length > 0 ? (
                  <div className="spc-enquiry-warning">
                    WARNING: {attentionTerms.join(" / ")} spotted. Check remarks and quantity unit before sending.
                  </div>
                ) : null}
                <label className="spc-enquiry-preview-field">
                  <span>Standard Format</span>
                  <textarea
                    value={draft.standardText}
                    onChange={(event) => updateDraft("standardText", event.target.value)}
                    placeholder="Standard enquiry preview"
                    rows={3}
                    disabled={!canEdit}
                  />
                </label>
                <div className="spc-vlsfo-remark-row" aria-label="Fuel and enquiry requirement controls">
                  <button
                    type="button"
                    className={rmkMode ? "is-active" : ""}
                    aria-pressed={rmkMode}
                    onClick={() => {
                      const next = !rmkMode
                      setRmkMode(next)
                      setDraft((draftCurrent) => ({
                        ...draftCurrent,
                        standardText: next
                          ? rmkStandardText(standardTextForDraft(draftCurrent, vlsfoMaxRemarks))
                          : standardTextForDraft(draftCurrent, vlsfoMaxRemarks),
                      }))
                    }}
                    disabled={!canEdit || !draft.hsfo}
                  >
                    RMK
                  </button>
                  {vlsfoRemarkOptions.map((remark) => {
                    const active = vlsfoMaxRemarks.includes(remark)
                    return (
                      <button key={remark} type="button" className={active ? "is-active" : ""} aria-pressed={active} onClick={() => toggleVlsfoMaxRemark(remark)} disabled={!canEdit || !draft.vlsfo}>
                        {formatVlsfoMaxRemark(remark)}
                      </button>
                    )
                  })}
                  {(["COQ REQUIRED", "30D QUALITY TIME BAR"] as const).map((remark) => {
                    const active = draft.remarks.toUpperCase().split(/\s*\/\s*/).includes(remark)
                    return (
                      <button key={remark} type="button" className={active ? "is-active" : ""} aria-pressed={active} onClick={() => toggleDraftRemark(remark)} disabled={!canEdit}>
                        {remark}
                      </button>
                    )
                  })}
                </div>
                <div className="spc-enquiry-command-row">
                  <button type="button" className="spc-blue-action spc-enquiry-command-button is-ai" onClick={() => void runParserAi("new-enquiry")} disabled={!canEdit || !draft.rawText.trim() || parserAiStatus === "loading"}>
                    <EnquiryCommandIcon kind="ai" />
                    <span>AI FIX</span>
                  </button>
                  <button
                    type="button"
                    className={`spc-blue-action spc-enquiry-command-button is-report${reportButtonState === "new-enquiry" ? " is-sent" : ""}`}
                    onClick={openDraftParserReport}
                    disabled={!canEdit || !draft.rawText.trim() || Boolean(reportButtonState)}
                  >
                    <EnquiryCommandIcon kind={reportButtonState === "new-enquiry" ? "sent" : "report"} />
                    <span>{reportButtonState === "new-enquiry" ? "SENT" : "REPORT"}</span>
                  </button>
                  <button type="submit" className="spc-send-enquiry-button spc-enquiry-command-button is-send" disabled={saving || !canEdit}>
                    <EnquiryCommandIcon kind="send" />
                    <span>{saving ? "Sending..." : "SEND"}</span>
                  </button>
                </div>
                {sendError ? <p className="spc-parser-report-error" role="alert">{sendError}</p> : null}
                {parserAiMessage && parserAiTarget === "new-enquiry" ? <p className={parserAiStatus === "failed" ? "spc-parser-report-error" : "spc-parser-report-status"}>{parserAiMessage}</p> : null}
                {parserAiSuggestion?.context === "new-enquiry" && parserAiSuggestion.warnings.length > 0 ? <p className="spc-parser-report-error">AI warning: {parserAiSuggestion.warnings.join(" / ")}</p> : null}
                {parserAiSuggestion?.context === "new-enquiry" && parserAiSuggestion.imoSources.length > 0 ? <p className="spc-parser-report-status">IMO source: <a href={parserAiSuggestion.imoSources[0].url} target="_blank" rel="noreferrer">{parserAiSuggestion.imoSources[0].title || parserAiSuggestion.imoSources[0].url}</a></p> : null}
              </div>

              <div className="spc-enquiry-details-pane">
                <div className="spc-enquiry-fields">
                  <label className={shouldShowDraftMissing("vesselName") ? "is-missing" : ""}><span>Vessel</span><input value={draft.vesselName} onChange={(event) => updateDraft("vesselName", event.target.value)} disabled={!canEdit} /></label>
                  <div className={`spc-field-block${shouldShowDraftMissing("imo") ? " is-missing" : ""}`}><div className="spc-field-label-row"><label htmlFor="spc-enquiry-imo">IMO</label>{!draft.imo.trim() && imoSearchUrl ? <a className="spc-imo-lookup" href={imoSearchUrl} target="_blank" rel="noreferrer">Google search</a> : null}</div><input id="spc-enquiry-imo" value={draft.imo} onChange={(event) => updateDraft("imo", event.target.value)} disabled={!canEdit} inputMode="numeric" maxLength={7} /></div>
                  <label><span>Port</span><input value={draft.port} onChange={(event) => updateDraft("port", event.target.value)} disabled={!canEdit} /></label>
                  <label className={shouldShowDraftMissing("eta") ? "is-missing" : ""}><span>ETA</span><input value={draft.eta} onChange={(event) => updateDraft("eta", event.target.value)} disabled={!canEdit} /></label>
                  <label className={shouldShowDraftMissing("fuel") ? "is-missing" : ""}><span>HSFO</span><input value={draft.hsfo} onChange={(event) => updateDraft("hsfo", event.target.value)} disabled={!canEdit} inputMode="numeric" pattern="[0-9-]*" /></label>
                  <label className={shouldShowDraftMissing("fuel") ? "is-missing" : ""}><span>VLSFO</span><input value={draft.vlsfo} onChange={(event) => updateDraft("vlsfo", event.target.value)} disabled={!canEdit} inputMode="numeric" pattern="[0-9-]*" /></label>
                  <label className={shouldShowDraftMissing("fuel") ? "is-missing" : ""}><span>LSMGO</span><input value={draft.lsmgo} onChange={(event) => updateDraft("lsmgo", event.target.value)} disabled={!canEdit} inputMode="numeric" pattern="[0-9-]*" /></label>
                  <label className="spc-enquiry-remarks"><span>Remarks</span><input value={draft.remarks} onChange={(event) => updateDraft("remarks", event.target.value)} disabled={!canEdit} /></label>
                </div>
              </div>
            </form>
          </section>

        <div className="spc-enquiry-activity-column">
          <section className="spc-panel spc-sent-enquiries-panel">
            <div className="spc-panel-header">
              <div className="spc-enquiry-heading-copy"><span>LIVE BOARD</span><h2>Sent Enquiries</h2></div>
              <strong className="spc-enquiry-count">{activeEnquiries.length}</strong>
            </div>
            <div className="spc-sent-enquiries-list">
              {activeEnquiries.map((enquiry) => {
                const matches = matchesFor(enquiry)
                const amendmentLabels = spcAmendmentSummaryLabels(enquiry.amendmentChanges)
                return (
                  <article key={enquiry.id} className={`spc-sent-enquiry-card${enquiry.lastAmendedAt ? " is-amended" : ""}`}>
                    <div className="spc-sent-enquiry-summary"><p>{enquiry.formattedText || enquiry.title}</p><span className={`spc-status-pill is-${enquiryStatusClass(enquiry)}`}>{enquiryStatusLabel(enquiry)}</span></div>
                    {enquiry.lastAmendedAt && amendmentLabels.length > 0 ? (
                      <div className="spc-enquiry-amendment">
                        {amendmentLabels.map((label) => (
                          <span key={label}>{label}</span>
                        ))}
                      </div>
                    ) : null}
                    {enquiry.status === "quoted" && enquiry.meta?.stemSupplierTraderDisplayName ? <div className="spc-outcome-note">Stemmed to {enquiry.meta.stemSupplierTraderDisplayName}</div> : null}
                    {enquiry.status === "cancelled" && enquiry.meta?.lostReason ? <div className="spc-outcome-note is-lost">Lost: {enquiry.meta.lostReason}</div> : null}
                    {matches.length > 0 ? <div className="spc-enquiry-match"><strong>RECORD</strong>{matches.slice(0, 3).map((match) => <span key={match.id}>{recordLine(match)}</span>)}</div> : null}
                    <div className="spc-sent-enquiry-meta"><span>{displayTime(enquiry.createdAt)}</span></div>
                    {enquiry.status === "sent" ? <div className="spc-sent-enquiry-actions"><button type="button" className="is-amend" onClick={() => openAmend(enquiry)} disabled={!canEdit || updatingId === enquiry.id}>AMEND</button><button type="button" onClick={() => openOutcome(enquiry, "stem")} disabled={!canEdit || updatingId === enquiry.id}>STEM</button><button type="button" className="is-lost" onClick={() => openOutcome(enquiry, "lost")} disabled={!canEdit || updatingId === enquiry.id}>LOST</button><button type="button" className="is-postpone" onClick={() => void quickOutcome(enquiry, "postpone")} disabled={!canEdit || updatingId === enquiry.id}>POSTPONE</button><button type="button" className="is-cancel" onClick={() => void quickOutcome(enquiry, "cancel")} disabled={!canEdit || updatingId === enquiry.id}>CANCEL</button></div> : null}
                  </article>
                )
              })}
              {!loading && activeEnquiries.length === 0 ? <div className="spc-empty">No enquiries yet.</div> : null}
            </div>
          </section>
          {postponedEnquiries.length > 0 ? (
            <section className="spc-postponed-enquiries-panel">
              <div className="spc-postponed-enquiries-header">
                <h2>POSTPONED ENQUIRY</h2>
              </div>
              <div className="spc-postponed-enquiries-list">
                {postponedEnquiries.map((enquiry) => (
                  <article key={enquiry.id} className="spc-postponed-enquiry-card">
                    <p>{enquiry.formattedText || enquiry.title}</p>
                    <span>Postponed {displayDate(enquiry.meta?.postponedAt || enquiry.updatedAt)}</span>
                    <div className="spc-postponed-enquiry-actions">
                      <button
                        type="button"
                        className="is-cancel"
                        onClick={() => void quickOutcome(enquiry, "cancel")}
                        disabled={!canEdit || updatingId === enquiry.id}
                      >
                        CANCEL
                      </button>
                      <button
                        type="button"
                        onClick={() => openReoffer(enquiry)}
                        disabled={!canEdit || updatingId === enquiry.id}
                      >
                        REOFFER
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>

      {outcomeDraft ? (
        <div className="spc-dialog-backdrop" role="presentation">
          <section className="spc-dialog" role="dialog" aria-modal="true" aria-label="Update enquiry outcome">
            <div className="spc-dialog-header">
              <h2>{outcomeDraft.type === "lost" ? "Lost Reason" : "Supplier Trader"}</h2>
              <button type="button" onClick={() => setOutcomeDraft(null)}>×</button>
            </div>
            {outcomeDraft.type === "lost" ? (
              <label className="spc-dialog-field">
                <span>Reason</span>
                <select
                  value={outcomeDraft.lostReason}
                  onChange={(event) =>
                    setOutcomeDraft((current) =>
                      current ? { ...current, lostReason: event.target.value } : current,
                    )
                  }
                >
                  {buyerLostReasons.map((reason) => (
                    <option key={reason} value={reason}>{reason}</option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="spc-dialog-field">
                <span>Supplier Trader</span>
                <select
                  value={outcomeDraft.supplierTraderUsername}
                  onChange={(event) =>
                    setOutcomeDraft((current) =>
                      current ? { ...current, supplierTraderUsername: event.target.value } : current,
                    )
                  }
                >
                  <option value="">Select supplier trader</option>
                  {supplierTraders.map((user) => (
                    <option key={user.username} value={user.username}>{user.displayName}</option>
                  ))}
                </select>
              </label>
            )}
            <div className="spc-dialog-actions">
              <button type="button" onClick={() => setOutcomeDraft(null)}>Cancel</button>
              <button
                type="button"
                className="is-primary"
                onClick={() => void confirmOutcome()}
                disabled={
                  updatingId === outcomeDraft.id ||
                  (outcomeDraft.type === "stem" && !outcomeDraft.supplierTraderUsername)
                }
              >
                Confirm
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {reofferDraft ? (
        <div className="spc-dialog-backdrop" role="presentation">
          <section className="spc-dialog spc-reoffer-dialog" role="dialog" aria-modal="true" aria-label={enquiryEditorMode === "amend" ? "Amend enquiry" : "Reoffer enquiry"}>
            <div className="spc-dialog-header">
              <h2 className="spc-reoffer-warning-title">PLEASE DOUBLE CHECK ENQUIRY DETAILS</h2>
              <button type="button" onClick={() => setReofferDraft(null)}>×</button>
            </div>
            <form
              className="spc-reoffer-form"
              onSubmit={(event) => {
                event.preventDefault()
                void confirmReoffer()
              }}
              noValidate
            >
              {reofferAttentionTerms.length > 0 ? (
                <div className="spc-enquiry-warning">
                  WARNING: {reofferAttentionTerms.join(" / ")} spotted. Check remarks and quantity unit before sending.
                </div>
              ) : null}
              <div className="spc-enquiry-fields">
                <label className={shouldShowReofferMissing("vesselName") ? "is-missing" : ""}>
                  <span>Vessel</span>
                  <input value={reofferDraft.vesselName} onChange={(event) => updateReofferDraft("vesselName", event.target.value)} disabled={saving} />
                </label>
                <label className={shouldShowReofferMissing("imo") ? "is-missing" : ""}>
                  <span>IMO</span>
                  <input value={reofferDraft.imo} onChange={(event) => updateReofferDraft("imo", event.target.value)} disabled={saving} inputMode="numeric" maxLength={7} />
                </label>
                <label>
                  <span>Port</span>
                  <input value={reofferDraft.port} onChange={(event) => updateReofferDraft("port", event.target.value)} disabled={saving} />
                </label>
                <label className={shouldShowReofferMissing("eta") ? "is-missing" : ""}>
                  <span>ETA</span>
                  <input value={reofferDraft.eta} onChange={(event) => updateReofferDraft("eta", event.target.value)} disabled={saving} />
                </label>
                <label className={shouldShowReofferMissing("fuel") ? "is-missing" : ""}>
                  <span>HSFO</span>
                  <input value={reofferDraft.hsfo} onChange={(event) => updateReofferDraft("hsfo", event.target.value)} disabled={saving} inputMode="numeric" pattern="[0-9-]*" />
                </label>
                <label className={shouldShowReofferMissing("fuel") ? "is-missing" : ""}>
                  <span>VLSFO</span>
                  <input value={reofferDraft.vlsfo} onChange={(event) => updateReofferDraft("vlsfo", event.target.value)} disabled={saving} inputMode="numeric" pattern="[0-9-]*" />
                </label>
                <label className={shouldShowReofferMissing("fuel") ? "is-missing" : ""}>
                  <span>LSMGO</span>
                  <input value={reofferDraft.lsmgo} onChange={(event) => updateReofferDraft("lsmgo", event.target.value)} disabled={saving} inputMode="numeric" pattern="[0-9-]*" />
                </label>
              </div>
              <label className="spc-enquiry-preview-field">
                <span className="spc-preview-label-row">
                  <span>Standard Format Preview</span>
                  <button
                    type="button"
                    className="spc-ai-parser-button spc-blue-action"
                    onClick={() => void runParserAi("reoffer")}
                    disabled={saving || !reofferDraft.standardText.trim() || parserAiStatus === "loading"}
                  >
                    AI FIX
                  </button>
                  <button
                    type="button"
                    className="spc-blue-action"
                    onClick={openReofferParserReport}
                    disabled={saving || !reofferDraft.standardText.trim() || Boolean(reportButtonState)}
                  >
                    {reportButtonState === "reoffer" ? "SENT" : "REPORT"}
                  </button>
                </span>
                <textarea value={reofferDraft.standardText} onChange={(event) => updateReofferDraft("standardText", event.target.value)} rows={3} disabled={saving} />
              </label>
              {parserAiMessage && parserAiTarget === "reoffer" ? (
                <p className={parserAiStatus === "failed" ? "spc-parser-report-error" : "spc-parser-report-status"}>
                  {parserAiMessage}
                </p>
              ) : null}
              {parserAiSuggestion?.context === "reoffer" && parserAiSuggestion.warnings.length > 0 ? (
                <p className="spc-parser-report-error">
                  AI warning: {parserAiSuggestion.warnings.join(" / ")}
                </p>
              ) : null}
              {parserAiSuggestion?.context === "reoffer" && parserAiSuggestion.imoSources.length > 0 ? (
                <p className="spc-parser-report-status">
                  IMO source:{" "}
                  <a href={parserAiSuggestion.imoSources[0].url} target="_blank" rel="noreferrer">
                    {parserAiSuggestion.imoSources[0].title || parserAiSuggestion.imoSources[0].url}
                  </a>
                </p>
              ) : null}
              <div className="spc-dialog-actions">
                <button type="button" onClick={() => setReofferDraft(null)} disabled={saving}>Cancel</button>
                <button type="submit" className="is-primary" disabled={saving || updatingId === reofferDraft.id}>
                  {saving ? "Sending..." : enquiryEditorMode === "amend" ? "Send Amendment" : "Send Reoffer"}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {parserReportDialog ? (
        <div className="spc-dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="spc-parser-report-title">
          <div className="spc-dialog spc-parser-report-dialog">
            <div className="spc-dialog-header">
              <h2 id="spc-parser-report-title">Report Parser Output</h2>
              <button type="button" onClick={() => setParserReportDialog(null)} disabled={parserReportStatus === "saving"} aria-label="Close report dialog">
                ×
              </button>
            </div>
            <div className="spc-parser-report-body">
              <label>
                <span>Raw Enquiry</span>
                <textarea value={parserReportDialog.rawText} readOnly />
              </label>
              <label>
                <span>Parser Output</span>
                <textarea value={parserReportDialog.parserOutput} readOnly />
              </label>
              {parserReportDialog.aiOutput ? (
                <label>
                  <span>AI Fix</span>
                  <textarea value={parserReportDialog.aiOutput} readOnly />
                </label>
              ) : null}
              {parserReportDialog.aiSources?.length ? (
                <p className="spc-parser-report-status">
                  IMO source:{" "}
                  <a href={parserReportDialog.aiSources[0].url} target="_blank" rel="noreferrer">
                    {parserReportDialog.aiSources[0].title || parserReportDialog.aiSources[0].url}
                  </a>
                </p>
              ) : null}
              <label>
                <span>Correct Version</span>
                <textarea
                  value={parserReportDialog.correctedOutput}
                  onChange={(event) =>
                    setParserReportDialog((current) =>
                      current ? { ...current, correctedOutput: event.target.value } : current,
                    )
                  }
                />
              </label>
              <label>
                <span>Note</span>
                <input
                  value={parserReportDialog.note}
                  onChange={(event) =>
                    setParserReportDialog((current) =>
                      current ? { ...current, note: event.target.value } : current,
                    )
                  }
                  placeholder="Optional"
                />
              </label>
              {parserReportStatus === "saved" ? <p className="spc-parser-report-status">Report saved.</p> : null}
              {parserReportStatus === "failed" ? <p className="spc-parser-report-error">Report failed. Please try again.</p> : null}
            </div>
            <div className="spc-dialog-actions">
              <button type="button" onClick={() => setParserReportDialog(null)} disabled={parserReportStatus === "saving"}>Cancel</button>
              <button type="button" className="is-primary" onClick={submitParserReport} disabled={!parserReportDialog.correctedOutput.trim() || parserReportStatus === "saving"}>
                {parserReportStatus === "saving" ? "Saving..." : "Submit Report"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </SpcShell>
  )
}
