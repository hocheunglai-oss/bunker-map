"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { useSpcAuth } from "@/lib/useSpcAuth"
import { canAccessSpcPage } from "@/lib/spcPages"
import {
  buildSpcStandardEnquiry,
  cleanSpcEnquiryText,
  formatSpcFuelSegment,
  parseSpcEnquiryText,
  writeSpcEnquiryNotes,
  type ParsedSpcEnquiry,
  type SpcEnquiryMeta,
} from "@/lib/spcEnquiryText"
import { detectVlsfoMaxRemarks, hasVlsfoMaxCaution, type VlsfoMaxRemark } from "@/lib/enquiryShortener"

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
  createdAt: string
  updatedAt: string
}

type SupplierTrader = {
  username: string
  displayName: string
}

type EnquiriesResponse = {
  enquiries?: SpcEnquiry[]
  message?: string
}

type ParserReportsResponse = {
  reports?: unknown[]
}

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
  correctedOutput: string
  note: string
}

type DraftFieldKey = "vesselName" | "imo" | "eta" | "fuel"

const LOST_REASONS = [
  "MINIMUM MARGIN",
  "CREDIT OR PAYMENT TERMS",
  "COVERAGE (SUPPLIER NOT COVERED)",
  "COVERAGE (LIMITED BY CUSTOMER)",
  "NOT TIMELY OFFERED",
  "DOUBLE TRADING",
  "T&C",
  "UNKNOWN",
] as const

const vlsfoRemarkOptions: VlsfoMaxRemark[] = ["120cst max", "180cst max"]

const emptyDraft: DraftEnquiry = {
  rawText: "",
  title: "",
  vesselName: "",
  imo: "",
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
  draft: Pick<DraftEnquiry, "vesselName" | "imo" | "eta" | "hsfo" | "vlsfo" | "lsmgo" | "remarks">,
  vlsfoMaxRemarks: VlsfoMaxRemark[] = [],
) {
  return buildSpcStandardEnquiry({ ...draft, vlsfoMaxRemarks })
}

function cleanFuelEntry(value: string | null | undefined) {
  return String(value || "")
    .replace(/\b(?:120|180)\s*cst\s*max\b/gi, "")
    .replace(/\b(?:120|180)\s*cst\b/gi, "")
    .replace(/\bm\s*t?s?\b/gi, "")
    .replace(/[^\d-]/g, "")
    .replace(/-{2,}/g, "-")
    .trim()
}

function normaliseDraft(rawText: string, vlsfoMaxRemarks: VlsfoMaxRemark[] = []): DraftEnquiry {
  const parsed = parseSpcEnquiryText(rawText, vlsfoMaxRemarks)
  const draft = {
    ...parsed,
    hsfo: cleanFuelEntry(parsed.hsfo),
    vlsfo: cleanFuelEntry(parsed.vlsfo),
    lsmgo: cleanFuelEntry(parsed.lsmgo),
  }
  return {
    ...draft,
    standardText: standardTextForDraft(draft, vlsfoMaxRemarks),
  }
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
    "No supplier"
}

function reportEnquiryError(error: unknown, fallback: string) {
  console.error(error instanceof Error ? error.message : fallback)
}

function draftFromEnquiry(enquiry: SpcEnquiry): ReofferDraft {
  const parsed = normaliseDraft(enquiry.formattedText || enquiry.title || "")
  return {
    ...emptyDraft,
    ...parsed,
    id: enquiry.id,
    enquiryNumber: enquiry.enquiryNumber,
    vesselName: parsed.vesselName || String(enquiry.vesselName || "").toLowerCase(),
    standardText: parsed.standardText || enquiry.formattedText || enquiry.title,
  }
}

export default function SpcEnquiriesPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions } = useSpcAuth()
  const [draft, setDraft] = useState<DraftEnquiry>(emptyDraft)
  const [enquiries, setEnquiries] = useState<SpcEnquiry[]>([])
  const [supplierTraders, setSupplierTraders] = useState<SupplierTrader[]>([])
  const [outcomeDraft, setOutcomeDraft] = useState<OutcomeDraft | null>(null)
  const [reofferDraft, setReofferDraft] = useState<ReofferDraft | null>(null)
  const [vlsfoMaxRemarks, setVlsfoMaxRemarks] = useState<VlsfoMaxRemark[]>([])
  const [validationAttempted, setValidationAttempted] = useState(false)
  const [dismissedDraftMissingFields, setDismissedDraftMissingFields] = useState<Set<DraftFieldKey>>(() => new Set())
  const [reofferValidationAttempted, setReofferValidationAttempted] = useState(false)
  const [dismissedReofferMissingFields, setDismissedReofferMissingFields] = useState<Set<DraftFieldKey>>(() => new Set())
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [updatingId, setUpdatingId] = useState("")
  const [parserReportDialog, setParserReportDialog] = useState<ParserReportDialog | null>(null)
  const [parserReportStatus, setParserReportStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle")
  const [parserReportCount, setParserReportCount] = useState(0)

  const canView = authenticated && canAccessSpcPage(permissions, "spc-buyer-enquiries", "view")
  const canEdit = authenticated && canAccessSpcPage(permissions, "spc-buyer-enquiries", "edit")
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
  const draftPreviousMatches = useMemo(() => matchesForVesselName(draft.vesselName), [draft.vesselName, outcomeMatchesByVessel])
  const imoSearchUrl = useMemo(() => googleImoSearchUrl(draft), [draft])
  const viscosityCautionDetected = hasVlsfoMaxCaution(draft.rawText)

  function shouldShowDraftMissing(field: DraftFieldKey) {
    return validationAttempted && draftMissingFields.has(field) && !dismissedDraftMissingFields.has(field)
  }

  function shouldShowReofferMissing(field: DraftFieldKey) {
    return reofferValidationAttempted && reofferMissingFields.has(field) && !dismissedReofferMissingFields.has(field)
  }

  const loadEnquiries = useCallback(async () => {
    if (!canView) return
    setLoading(true)
    try {
      const response = await fetch("/api/spc/enquiries?limit=200", { cache: "no-store" })
      const data = (await response.json()) as EnquiriesResponse
      if (!response.ok) throw new Error(data.message || "Failed to load enquiries.")
      setEnquiries(data.enquiries || [])
    } catch (error) {
      reportEnquiryError(error, "Failed to load enquiries.")
    } finally {
      setLoading(false)
    }
  }, [canView])

  const loadSupplierTraders = useCallback(async () => {
    if (!canEdit) return
    try {
      const response = await fetch("/api/spc/supplier-traders", { cache: "no-store" })
      const data = (await response.json()) as { supplierTraders?: SupplierTrader[]; message?: string }
      if (!response.ok) throw new Error(data.message || "Failed to load supplier traders.")
      setSupplierTraders(data.supplierTraders || [])
    } catch (error) {
      reportEnquiryError(error, "Failed to load supplier traders.")
    }
  }, [canEdit])

  const loadParserReportCount = useCallback(async () => {
    if (!canView) {
      setParserReportCount(0)
      return
    }

    try {
      const response = await fetch("/api/parser-reports?source=spc", { cache: "no-store" })
      const payload = (await response.json().catch(() => ({}))) as ParserReportsResponse
      if (!response.ok) throw new Error("Unable to load parser reports.")
      setParserReportCount(Array.isArray(payload.reports) ? payload.reports.length : 0)
    } catch (error) {
      reportEnquiryError(error, "Failed to load parser report count.")
      setParserReportCount(0)
    }
  }, [canView])

  useEffect(() => {
    document.title = "SPC Enquiries"
  }, [])

  useEffect(() => {
    if (!authLoading && !canView) router.replace("/spc")
  }, [authLoading, canView, router])

  useEffect(() => {
    void loadEnquiries()
  }, [loadEnquiries])

  useEffect(() => {
    void loadSupplierTraders()
  }, [loadSupplierTraders])

  useEffect(() => {
    void loadParserReportCount()
  }, [loadParserReportCount])

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
      setVlsfoMaxRemarks([])
      setDraft(normaliseDraft(value, []))
      return
    }

    setDraft((current) => {
      const next = {
        ...current,
        [key]: key === "hsfo" || key === "vlsfo" || key === "lsmgo" ? cleanFuelEntry(value) : value,
      }
      if (key !== "standardText") {
        next.standardText = standardTextForDraft(next, vlsfoMaxRemarks)
        next.title = [next.vesselName || "new enquiry", next.eta]
          .filter(Boolean)
          .join(" / ")
      }
      return next
    })
  }

  function updateReofferDraft(key: keyof DraftEnquiry, value: string) {
    if (key === "vesselName") dismissReofferMissingField("vesselName")
    if (key === "imo") dismissReofferMissingField("imo")
    if (key === "eta") dismissReofferMissingField("eta")
    if (key === "hsfo" || key === "vlsfo" || key === "lsmgo") dismissReofferMissingField("fuel")

    if (key === "rawText") {
      setReofferDraft((current) =>
        current ? { ...current, ...normaliseDraft(value, []), id: current.id, enquiryNumber: current.enquiryNumber } : current,
      )
      return
    }

    setReofferDraft((current) => {
      if (!current) return current
      const next = {
        ...current,
        [key]: key === "hsfo" || key === "vlsfo" || key === "lsmgo" ? cleanFuelEntry(value) : value,
      }
      if (key !== "standardText") {
        next.standardText = standardTextForDraft(next, [])
        next.title = [next.vesselName || "reoffer", next.eta].filter(Boolean).join(" / ")
      }
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
        standardText: standardTextForDraft(draftCurrent, next),
      }))
      return next
    })
  }

  function clearDraft() {
    setDraft(emptyDraft)
    setVlsfoMaxRemarks([])
    setValidationAttempted(false)
    setDismissedDraftMissingFields(new Set())
  }

  function openDraftParserReport() {
    setParserReportDialog({
      context: "new-enquiry",
      rawText: draft.rawText,
      parserOutput: standardTextForDraft(draft, vlsfoMaxRemarks),
      correctedOutput: draft.standardText || standardTextForDraft(draft, vlsfoMaxRemarks),
      note: "",
    })
    setParserReportStatus("idle")
  }

  function openReofferParserReport() {
    if (!reofferDraft) return
    setParserReportDialog({
      context: "reoffer",
      rawText: reofferDraft.rawText || reofferDraft.standardText,
      parserOutput: standardTextForDraft(reofferDraft, []),
      correctedOutput: reofferDraft.standardText || standardTextForDraft(reofferDraft, []),
      note: "",
    })
    setParserReportStatus("idle")
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
          },
        }),
      })
      const data = (await response.json().catch(() => ({}))) as { message?: string }
      if (!response.ok) throw new Error(data.message || "Failed to save report.")

      applyCorrectedParserReport(parserReportDialog, correctedOutput)
      await loadParserReportCount()
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
      product: productTextForDraft(draft, finalVlsfoMaxRemarks),
      notes: writeSpcEnquiryNotes(standardText, {
        imo: draft.imo,
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
    } catch (error) {
      reportEnquiryError(error, "Failed to send enquiry.")
    } finally {
      setSaving(false)
    }
  }

  function openOutcome(enquiry: SpcEnquiry, type: Extract<EnquiryOutcome, "stem" | "lost">) {
    setOutcomeDraft({
      id: enquiry.id,
      type,
      lostReason: LOST_REASONS[0],
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
    } catch (error) {
      reportEnquiryError(error, "Failed to update enquiry.")
    } finally {
      setUpdatingId("")
    }
  }

  function openReoffer(enquiry: SpcEnquiry) {
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
          mode: "reoffer",
          title: reofferDraft.title || reofferDraft.vesselName || standardText.slice(0, 80),
          vesselName: reofferDraft.vesselName,
          product: productTextForDraft(reofferDraft, finalVlsfoMaxRemarks),
          notes: writeSpcEnquiryNotes(standardText, {
            imo: reofferDraft.imo,
            eta: reofferDraft.eta,
            hsfo: reofferDraft.hsfo,
            vlsfo: reofferDraft.vlsfo,
            lsmgo: reofferDraft.lsmgo,
          }),
        }),
      })
      const data = (await response.json()) as { enquiry?: SpcEnquiry; message?: string }
      if (!response.ok || !data.enquiry) throw new Error(data.message || "Failed to reoffer enquiry.")

      setEnquiries((current) => [
        data.enquiry!,
        ...current.filter((enquiry) => enquiry.id !== reofferDraft.id && enquiry.id !== data.enquiry!.id),
      ])
      setReofferDraft(null)
    } catch (error) {
      reportEnquiryError(error, "Failed to reoffer enquiry.")
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
    <SpcShell title="SPC Enquiries">
      <div className="spc-enquiries-layout">
        <div className="spc-enquiry-left-column">
          <section className="spc-panel spc-enquiry-entry-panel">
            <div className="spc-panel-header">
              <h2>New Enquiry</h2>
              <button type="button" onClick={clearDraft} disabled={!canEdit || saving}>
                Clear
              </button>
            </div>
            <form onSubmit={sendEnquiry} className="spc-enquiry-entry-form" noValidate>
              <label className="spc-enquiry-raw">
                <span>AUTO FORMAT (DOUBLE CHECK BEFORE SENDING)</span>
                <textarea
                  value={draft.rawText}
                  onChange={(event) => updateDraft("rawText", event.target.value)}
                  placeholder="PASTE YOUR ENQUIRY HERE"
                  rows={4}
                  disabled={!canEdit}
                />
              </label>
              {viscosityCautionDetected ? (
                <div className="spc-enquiry-warning">
                  WARNING: 180 / 120 spotted. Confirm whether VLSFO 180CST MAX or 120CST MAX applies.
                </div>
              ) : null}
              <div className="spc-enquiry-fields">
                <label className={shouldShowDraftMissing("vesselName") ? "is-missing" : ""}>
                  <span>Vessel</span>
                  <input value={draft.vesselName} onChange={(event) => updateDraft("vesselName", event.target.value)} disabled={!canEdit} />
                </label>
                <div className={`spc-field-block${shouldShowDraftMissing("imo") ? " is-missing" : ""}`}>
                  <div className="spc-field-label-row">
                    <label htmlFor="spc-enquiry-imo">IMO</label>
                    {!draft.imo.trim() && imoSearchUrl ? (
                      <a className="spc-imo-lookup" href={imoSearchUrl} target="_blank" rel="noreferrer">
                        Google search
                      </a>
                    ) : null}
                  </div>
                  <input id="spc-enquiry-imo" value={draft.imo} onChange={(event) => updateDraft("imo", event.target.value)} disabled={!canEdit} inputMode="numeric" maxLength={7} />
                </div>
                <label className={shouldShowDraftMissing("eta") ? "is-missing" : ""}>
                  <span>ETA</span>
                  <input value={draft.eta} onChange={(event) => updateDraft("eta", event.target.value)} disabled={!canEdit} />
                </label>
                <label className={shouldShowDraftMissing("fuel") ? "is-missing" : ""}>
                  <span>HSFO</span>
                  <input value={draft.hsfo} onChange={(event) => updateDraft("hsfo", event.target.value)} disabled={!canEdit} inputMode="numeric" pattern="[0-9-]*" />
                </label>
                <label className={shouldShowDraftMissing("fuel") ? "is-missing" : ""}>
                  <span>VLSFO</span>
                  <input value={draft.vlsfo} onChange={(event) => updateDraft("vlsfo", event.target.value)} disabled={!canEdit} inputMode="numeric" pattern="[0-9-]*" />
                </label>
                <label className={shouldShowDraftMissing("fuel") ? "is-missing" : ""}>
                  <span>LSMGO</span>
                  <input value={draft.lsmgo} onChange={(event) => updateDraft("lsmgo", event.target.value)} disabled={!canEdit} inputMode="numeric" pattern="[0-9-]*" />
                </label>
                <label className="spc-enquiry-remarks">
                  <span>Remarks</span>
                  <input value={draft.remarks} onChange={(event) => updateDraft("remarks", event.target.value)} disabled={!canEdit} />
                </label>
              </div>
              <div className="spc-vlsfo-remark-row" aria-label="VLSFO max viscosity controls">
                {vlsfoRemarkOptions.map((remark) => {
                  const active = vlsfoMaxRemarks.includes(remark)
                  return (
                    <button
                      key={remark}
                      type="button"
                      className={active ? "is-active" : ""}
                      aria-pressed={active}
                      onClick={() => toggleVlsfoMaxRemark(remark)}
                      disabled={!canEdit}
                    >
                      Add {remark === "120cst max" ? "120CST MAX" : "180CST MAX"}
                    </button>
                  )
                })}
              </div>
              {draftPreviousMatches.length > 0 ? (
                <div className="spc-enquiry-match is-new-panel">
                  <strong>RECORD</strong>
                  {draftPreviousMatches.slice(0, 3).map((match) => (
                    <span key={match.id}>
                      {statusLabel(match.status)} · {displayDate(match.meta?.outcomeAt || match.updatedAt)} ·{" "}
                      {missingRecordSupplier(match)}
                    </span>
                  ))}
                </div>
              ) : null}
              <label className="spc-enquiry-preview-field">
                <span className="spc-preview-label-row">
                  <span>Standard Format Preview</span>
                  <button
                    type="button"
                    onClick={openDraftParserReport}
                    disabled={!canEdit || !draft.rawText.trim()}
                  >
                    Report ({parserReportCount})
                  </button>
                </span>
                <textarea
                  value={draft.standardText}
                  onChange={(event) => updateDraft("standardText", event.target.value)}
                  placeholder="Standard enquiry preview"
                  rows={2}
                  disabled={!canEdit}
                />
              </label>
              <div className="spc-form-actions">
                <button type="submit" disabled={saving || !canEdit}>
                  {saving ? "Sending..." : "Send Enquiry"}
                </button>
              </div>
            </form>
          </section>

          {postponedEnquiries.length > 0 ? (
            <section className="spc-postponed-enquiries-panel">
              <div className="spc-postponed-enquiries-list">
                {postponedEnquiries.map((enquiry) => (
                  <article key={enquiry.id} className="spc-postponed-enquiry-card">
                    <p>{enquiry.formattedText || enquiry.title}</p>
                    <span>Postponed {displayDate(enquiry.meta?.postponedAt || enquiry.updatedAt)}</span>
                    <button
                      type="button"
                      onClick={() => openReoffer(enquiry)}
                      disabled={!canEdit || updatingId === enquiry.id}
                    >
                      Reoffer
                    </button>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        <section className="spc-panel spc-sent-enquiries-panel">
          <div className="spc-panel-header">
            <h2>Sent Enquiries</h2>
          </div>
          <div className="spc-sent-enquiries-list">
            {activeEnquiries.map((enquiry) => {
              const matches = matchesFor(enquiry)
              return (
                <article key={enquiry.id} className="spc-sent-enquiry-card">
                  <div className="spc-sent-enquiry-summary">
                    <p>{enquiry.formattedText || enquiry.title}</p>
                    <span className={`spc-status-pill is-${enquiryStatusClass(enquiry)}`}>
                      {enquiryStatusLabel(enquiry)}
                    </span>
                  </div>
                  {enquiry.status === "quoted" && enquiry.meta?.stemSupplierTraderDisplayName ? (
                    <div className="spc-outcome-note">Stemmed to {enquiry.meta.stemSupplierTraderDisplayName}</div>
                  ) : null}
                  {enquiry.status === "cancelled" && enquiry.meta?.lostReason ? (
                    <div className="spc-outcome-note is-lost">Lost: {enquiry.meta.lostReason}</div>
                  ) : null}
                  {matches.length > 0 ? (
                    <div className="spc-enquiry-match">
                      <strong>RECORD</strong>
                      {matches.slice(0, 3).map((match) => (
                        <span key={match.id}>
                          {statusLabel(match.status)} · {displayDate(match.meta?.outcomeAt || match.updatedAt)} ·{" "}
                          {missingRecordSupplier(match)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="spc-sent-enquiry-meta">
                    <span>{displayTime(enquiry.createdAt)}</span>
                  </div>
                  {enquiry.status === "sent" ? (
                    <div className="spc-sent-enquiry-actions">
                      <button
                        type="button"
                        onClick={() => openOutcome(enquiry, "stem")}
                        disabled={!canEdit || updatingId === enquiry.id}
                      >
                        STEM
                      </button>
                      <button
                        type="button"
                        className="is-lost"
                        onClick={() => openOutcome(enquiry, "lost")}
                        disabled={!canEdit || updatingId === enquiry.id}
                      >
                        LOST
                      </button>
                      <button
                        type="button"
                        className="is-postpone"
                        onClick={() => void quickOutcome(enquiry, "postpone")}
                        disabled={!canEdit || updatingId === enquiry.id}
                      >
                        POSTPONE
                      </button>
                      <button
                        type="button"
                        className="is-cancel"
                        onClick={() => void quickOutcome(enquiry, "cancel")}
                        disabled={!canEdit || updatingId === enquiry.id}
                      >
                        CANCEL
                      </button>
                    </div>
                  ) : null}
                </article>
              )
            })}
            {!loading && activeEnquiries.length === 0 ? (
              <div className="spc-empty">No enquiries yet.</div>
            ) : null}
          </div>
        </section>
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
                  {LOST_REASONS.map((reason) => (
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
          <section className="spc-dialog spc-reoffer-dialog" role="dialog" aria-modal="true" aria-label="Reoffer enquiry">
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
              <div className="spc-enquiry-fields">
                <label className={shouldShowReofferMissing("vesselName") ? "is-missing" : ""}>
                  <span>Vessel</span>
                  <input value={reofferDraft.vesselName} onChange={(event) => updateReofferDraft("vesselName", event.target.value)} disabled={saving} />
                </label>
                <label className={shouldShowReofferMissing("imo") ? "is-missing" : ""}>
                  <span>IMO</span>
                  <input value={reofferDraft.imo} onChange={(event) => updateReofferDraft("imo", event.target.value)} disabled={saving} inputMode="numeric" maxLength={7} />
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
                    onClick={openReofferParserReport}
                    disabled={saving || !reofferDraft.standardText.trim()}
                  >
                    Report ({parserReportCount})
                  </button>
                </span>
                <textarea value={reofferDraft.standardText} onChange={(event) => updateReofferDraft("standardText", event.target.value)} rows={3} disabled={saving} />
              </label>
              <div className="spc-dialog-actions">
                <button type="button" onClick={() => setReofferDraft(null)} disabled={saving}>Cancel</button>
                <button type="submit" className="is-primary" disabled={saving || updatingId === reofferDraft.id}>
                  {saving ? "Sending..." : "Send Reoffer"}
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
