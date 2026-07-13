"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  buildShortenedEnquiry,
  detectAttentionTerms,
  detectVlsfoMaxRemarks,
  type VlsfoMaxRemark,
} from "@/lib/enquiryShortener"
import {
  parseEnquiryWorksheetGuess,
  type EnquiryWorksheetGuess,
} from "@/lib/enquiryWorksheetParser"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import styles from "./enquiryWorksheet.module.css"

type WorkflowAction = "register" | "draft" | "approval" | "send"
type WorkflowKey = "bumain" | "nom" | "con" | "bno"

type WorkflowRow = {
  register: boolean
  draft: boolean
  approval: boolean
  send: boolean
  registerText: string
  draftText: string
  approvalText: string
  sendText: string
  note: string
}

type Worksheet = {
  vesselName: string
  imo: string
  date: string
  initials: string
  buyer: string
  credit: string
  workingNotes: string
  unofficialCompensation: string
  workflow: Record<WorkflowKey, WorkflowRow>
}

type EnquiryWorksheetCache = {
  enquiryText: string
  cleanedEnquiryText: string
  vlsfoMaxRemarks: VlsfoMaxRemark[]
  guesses: EnquiryWorksheetGuess
  worksheet: Worksheet
}

type EnquiryWorksheetPortsResponse = {
  ports?: string[]
}

type ParserReportsResponse = {
  reports?: unknown[]
  unresolvedReports?: number
  totalReports?: number
  resolvedReports?: number
}

type ParserReportDraft = {
  open: boolean
  parserOutput: string
  aiOutput: string
  aiSources: ParserAiSourceLink[]
  correctedOutput: string
  note: string
}

type ParserAiSourceLink = {
  title: string
  url: string
}

type ParserAiFields = {
  vesselName?: string
  imo?: string
  port?: string
  buyer?: string
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

const workflowLabels: Array<[WorkflowKey, string]> = [
  ["bumain", "BUMAIN"],
  ["nom", "NOM"],
  ["con", "CON"],
  ["bno", "BNO"],
]

const workflowActions: Array<[WorkflowAction, string]> = [
  ["register", "REGISTER"],
  ["draft", "DRAFT"],
  ["approval", "APPROVAL"],
  ["send", "SEND"],
]

const workflowCells: Record<WorkflowKey, Partial<Record<WorkflowAction, { suffix?: string }>>> = {
  bumain: { register: {} },
  nom: { draft: {}, approval: {}, send: {} },
  con: { draft: { suffix: "BOX" }, approval: {}, send: {} },
  bno: { send: {} },
}

const ENQUIRY_WORKSHEET_CACHE_KEY = "fc-admin-enquiry-worksheet-draft-v1"
const WHATSAPP_EXTENSION_REQUEST_TYPE = "fcuno-wa-enquiry-send"
const WHATSAPP_EXTENSION_RESPONSE_TYPE = "fcuno-wa-enquiry-send-result"
const vlsfoRemarkOptions: VlsfoMaxRemark[] = ["180cst max", "120cst max"]
const worksheetBuyerSectionPattern =
  /^\s*(?:\d+\s*[\).:-]\s*)?(?:buyer|client|for\s+account(?:\s+of)?|account(?:\s+name)?|for\s+a\/?c(?:\s+of)?|a\/?c|acct|for\s+acct(?:\s+of)?)\b\s*(?:[:#\-\t]|\s{2,}|$)/i

function toCaps(value: string) {
  return value.toUpperCase()
}

function normalizeEnquiryText(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, "")
    .replace(/\u00ad/g, "")
    .replace(/[\u00a0\u1680\u180e\u2000-\u200a\u202f\u205f\u3000]/g, " ")
}

function cleanEnquiryLine(value: string) {
  return value.replace(/[^\S\n]+/g, " ").trim()
}

function isLabelOnlyLine(value: string) {
  return /^[A-Za-z][A-Za-z0-9\s/&().,-]{0,48}:\s*$/.test(value)
}

function isLabelLine(value: string) {
  return /^[A-Za-z][A-Za-z0-9\s/&().,-]{0,48}:/.test(value)
}

function cleanEnquiryForReading(value: string) {
  const lines = normalizeEnquiryText(value)
    .split("\n")
    .map(cleanEnquiryLine)
    .filter(Boolean)

  const cleaned: string[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const nextLine = lines[index + 1] || ""

    if (isLabelOnlyLine(line) && nextLine && !isLabelLine(nextLine)) {
      cleaned.push(`${line} ${nextLine}`)
      index += 1
      continue
    }

    cleaned.push(line)
  }

  return cleaned.join("\n")
}

function formatWorksheetWorkingNotes(value: string) {
  const formattedLines: string[] = []

  for (const line of value.replace(/\r\n?/g, "\n").split("\n")) {
    const previousLine = formattedLines[formattedLines.length - 1] || ""
    const shouldAddBuyerSpacer =
      Boolean(line.trim()) &&
      formattedLines.length > 0 &&
      Boolean(previousLine.trim()) &&
      worksheetBuyerSectionPattern.test(line)

    if (shouldAddBuyerSpacer) formattedLines.push("")
    formattedLines.push(line)
  }

  return formattedLines.join("\n")
}

function todayShort() {
  const date = new Date()
  const day = date.getDate()
  const month = date.getMonth() + 1
  const year = String(date.getFullYear()).slice(-2)
  return `${day}/${month}/${year}`
}

function emptyRow(note = ""): WorkflowRow {
  return {
    register: false,
    draft: false,
    approval: false,
    send: false,
    registerText: "",
    draftText: "",
    approvalText: "",
    sendText: "",
    note,
  }
}

function blankWorksheet(initials = ""): Worksheet {
  return {
    vesselName: "",
    imo: "",
    date: todayShort(),
    initials,
    buyer: "",
    credit: "",
    workingNotes: "",
    unofficialCompensation: "",
    workflow: {
      bumain: emptyRow(),
      nom: emptyRow(),
      con: emptyRow("SPECIAL TERM"),
      bno: emptyRow(),
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "string" ? value : ""
}

function readBoolean(record: Record<string, unknown>, key: string) {
  return record[key] === true
}

function restoreWorkflowRow(value: unknown, fallback: WorkflowRow): WorkflowRow {
  if (!isRecord(value)) return fallback

  return {
    register: readBoolean(value, "register"),
    draft: readBoolean(value, "draft"),
    approval: readBoolean(value, "approval"),
    send: readBoolean(value, "send"),
    registerText: readString(value, "registerText"),
    draftText: readString(value, "draftText"),
    approvalText: readString(value, "approvalText"),
    sendText: readString(value, "sendText"),
    note: typeof value.note === "string" ? value.note : fallback.note,
  }
}

function restoreWorksheet(value: unknown): Worksheet | null {
  if (!isRecord(value)) return null

  const fallback = blankWorksheet()
  const workflow = isRecord(value.workflow) ? value.workflow : {}

  return {
    vesselName: readString(value, "vesselName"),
    imo: readString(value, "imo"),
    date: readString(value, "date") || fallback.date,
    initials: readString(value, "initials"),
    buyer: readString(value, "buyer"),
    credit: readString(value, "credit"),
    workingNotes: readString(value, "workingNotes"),
    unofficialCompensation: readString(value, "unofficialCompensation"),
    workflow: {
      bumain: restoreWorkflowRow(workflow.bumain, fallback.workflow.bumain),
      nom: restoreWorkflowRow(workflow.nom, fallback.workflow.nom),
      con: restoreWorkflowRow(workflow.con, fallback.workflow.con),
      bno: restoreWorkflowRow(workflow.bno, fallback.workflow.bno),
    },
  }
}

function restoreGuess(value: unknown): EnquiryWorksheetGuess | null {
  if (!isRecord(value)) return null

  const confidence = value.confidence
  return {
    vesselName: readString(value, "vesselName"),
    imo: readString(value, "imo"),
    port: readString(value, "port"),
    buyer: readString(value, "buyer"),
    confidence:
      confidence === "high" || confidence === "medium" || confidence === "low"
        ? confidence
        : "low",
    warnings: Array.isArray(value.warnings)
      ? value.warnings.filter((warning): warning is string => typeof warning === "string")
      : [],
  }
}

function restoreCache(value: unknown): EnquiryWorksheetCache | null {
  if (!isRecord(value)) return null

  const enquiryText = readString(value, "enquiryText")
  const cleanedEnquiryText = readString(value, "cleanedEnquiryText")
  const sourceText = cleanedEnquiryText || (enquiryText ? cleanEnquiryForReading(enquiryText) : "")
  const guesses = restoreGuess(value.guesses) || (sourceText.trim() ? parseEnquiryWorksheetGuess(sourceText) : emptyGuess())
  const worksheet = restoreWorksheet(value.worksheet) || blankWorksheet()

  return {
    enquiryText,
    cleanedEnquiryText: sourceText,
    vlsfoMaxRemarks: [],
    guesses,
    worksheet,
  }
}

function deriveNickname(displayName: string | null, username: string | null) {
  const source = (displayName || username || "").trim()
  if (!source) return ""

  const words = source.split(/\s+/).filter(Boolean)
  if (words.length >= 2) {
    return words
      .map((word) => word[0])
      .join("")
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 3)
      .toUpperCase()
  }

  return source.replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase()
}

function emptyGuess(): EnquiryWorksheetGuess {
  return {
    vesselName: "",
    imo: "",
    port: "",
    buyer: "",
    confidence: "low",
    warnings: [],
  }
}

function getWorksheetHeader(worksheet: Worksheet) {
  if (worksheet.vesselName && worksheet.imo) return `${worksheet.vesselName} - ${worksheet.imo}`
  return worksheet.vesselName || worksheet.imo
}

function googleImoSearchUrl(vesselName: string, sourceText: string) {
  const firstLine = sourceText
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) || ""
  const vessel = vesselName.trim() || firstLine.split(/\s+@\s+|\s+eta\b|[,，]/i)[0]?.trim() || ""
  const query = [vessel, "vessel IMO"].filter(Boolean).join(" ").trim()
  return query ? `https://www.google.com/search?q=${encodeURIComponent(query)}` : ""
}

function hasViscosityCaution(value: string) {
  return /(^|\D)(?:180|120)(?!\d)/.test(value)
}

export default function EnquiryWorksheetPage() {
  const { authenticated, displayName, username } = useSimpleAdminAuth()
  const userNickname = useMemo(() => deriveNickname(displayName, username), [displayName, username])
  const [worksheet, setWorksheet] = useState<Worksheet>(() => blankWorksheet())
  const [enquiryText, setEnquiryText] = useState("")
  const [cleanedEnquiryText, setCleanedEnquiryText] = useState("")
  const [vlsfoMaxRemarks, setVlsfoMaxRemarks] = useState<VlsfoMaxRemark[]>([])
  const [guesses, setGuesses] = useState<EnquiryWorksheetGuess>(() => emptyGuess())
  const [portIndex, setPortIndex] = useState<string[]>([])
  const [shortenedDraft, setShortenedDraft] = useState("")
  const [cacheReady, setCacheReady] = useState(false)
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle")
  const [whatsappStatus, setWhatsappStatus] = useState<"idle" | "sending" | "sent" | "failed">("idle")
  const [parserReportDraft, setParserReportDraft] = useState<ParserReportDraft>({
    open: false,
    parserOutput: "",
    aiOutput: "",
    aiSources: [],
    correctedOutput: "",
    note: "",
  })
  const [parserReportStatus, setParserReportStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle")
  const [parserReportCount, setParserReportCount] = useState(0)
  const [parserAiStatus, setParserAiStatus] = useState<"idle" | "loading" | "applied" | "failed">("idle")
  const [parserAiMessage, setParserAiMessage] = useState("")
  const [parserAiSuggestion, setParserAiSuggestion] = useState<ParserAiSuggestion | null>(null)
  const preservedShortenedDraftRef = useRef("")
  const whatsappRequestIdRef = useRef("")
  const whatsappTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    document.title = "Enquiry Worksheet - FC Uno"
  }, [])

  const loadParserReportCount = useCallback(async () => {
    if (!authenticated) {
      setParserReportCount(0)
      return
    }

    try {
      const response = await fetch("/api/parser-reports?source=enquiryworksheet&summary=1", { cache: "no-store" })
      const payload = (await response.json().catch(() => ({}))) as ParserReportsResponse
      if (!response.ok) throw new Error("Unable to load parser reports.")
      setParserReportCount(
        typeof payload.unresolvedReports === "number"
          ? payload.unresolvedReports
          : Array.isArray(payload.reports)
            ? payload.reports.length
            : 0,
      )
    } catch {
      setParserReportCount(0)
    }
  }, [authenticated])

  useEffect(() => {
    void loadParserReportCount()
  }, [loadParserReportCount])

  useEffect(() => {
    if (!authenticated) return

    let cancelled = false
    fetch("/api/admin/enquiryworksheet/ports", { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as EnquiryWorksheetPortsResponse
        if (!response.ok) throw new Error("Unable to load port index.")
        return Array.isArray(payload.ports)
          ? payload.ports.filter((port): port is string => typeof port === "string" && Boolean(port.trim()))
          : []
      })
      .then((ports) => {
        if (!cancelled) setPortIndex(ports)
      })
      .catch(() => {
        if (!cancelled) setPortIndex([])
      })

    return () => {
      cancelled = true
    }
  }, [authenticated])

  useEffect(() => {
    try {
      const cached = window.localStorage.getItem(ENQUIRY_WORKSHEET_CACHE_KEY)
      if (!cached) return

      const parsed: unknown = JSON.parse(cached)
      if (!isRecord(parsed)) return

      const restored = restoreCache(parsed)
      if (!restored) return

      setEnquiryText(restored.enquiryText)
      setCleanedEnquiryText(restored.cleanedEnquiryText)
      setVlsfoMaxRemarks(restored.vlsfoMaxRemarks)
      setGuesses(restored.guesses)
      setWorksheet(restored.worksheet)
    } catch {
      window.localStorage.removeItem(ENQUIRY_WORKSHEET_CACHE_KEY)
    } finally {
      setCacheReady(true)
    }
  }, [])

  useEffect(() => {
    if (!cacheReady) return

    try {
      window.localStorage.setItem(
        ENQUIRY_WORKSHEET_CACHE_KEY,
        JSON.stringify({
          enquiryText,
          cleanedEnquiryText,
          guesses,
          worksheet,
        }),
      )
    } catch {
      // If browser storage is blocked/full, keep the worksheet usable without persistence.
    }
  }, [cacheReady, cleanedEnquiryText, enquiryText, guesses, worksheet])

  useEffect(() => {
    if (!userNickname) return
    setWorksheet((current) => {
      if (current.initials === userNickname) return current
      return { ...current, initials: userNickname }
    })
  }, [userNickname])

  function updateField<K extends keyof Worksheet>(key: K, value: Worksheet[K]) {
    setWorksheet((current) => ({ ...current, [key]: value }))
  }

  function updateCapsField<K extends keyof Worksheet>(key: K, value: string) {
    updateField(key, toCaps(value) as Worksheet[K])
  }

  function updateWorkflow(key: WorkflowKey, field: keyof WorkflowRow, value: string | boolean) {
    setWorksheet((current) => ({
      ...current,
      workflow: {
        ...current.workflow,
        [key]: {
          ...current.workflow[key],
          [field]: typeof value === "string" ? toCaps(value) : value,
        },
      },
    }))
  }

  function updateWorksheetHeader(value: string) {
    const next = toCaps(value)
    const imoMatch = next.match(/(?:^|\s+-\s+|\s+)(\d{7})\s*$/)
    const nextImo = imoMatch?.[1] || ""
    const imoIndex = imoMatch?.index ?? next.length
    const nextVessel = nextImo
      ? next.slice(0, imoIndex).replace(/\s*-\s*$/, "").trim()
      : next.trim()

    setWorksheet((current) => ({
      ...current,
      vesselName: nextVessel,
      imo: nextImo,
    }))
  }

  function handleEnquiryTextChange(value: string) {
    setEnquiryText(value)
    setVlsfoMaxRemarks([])
    setParserAiStatus("idle")
    setParserAiMessage("")
    setParserAiSuggestion(null)
    const nextCleaned = cleanEnquiryForReading(value)
    setCleanedEnquiryText(nextCleaned)
    setGuesses(nextCleaned.trim() ? parseEnquiryWorksheetGuess(nextCleaned, { portNames: portIndex }) : emptyGuess())
  }

  function getParserSourceText() {
    return cleanedEnquiryText.trim() ? cleanedEnquiryText : enquiryText
  }

  const shortenedEnquiry = useMemo(
    () =>
      buildShortenedEnquiry(
        getParserSourceText(),
        guesses.vesselName,
        guesses.imo,
        vlsfoMaxRemarks,
        { autoDetectVlsfoRemarks: false, includePort: true, port: guesses.port, portNames: portIndex },
      ),
    [cleanedEnquiryText, enquiryText, guesses.imo, guesses.port, guesses.vesselName, portIndex, vlsfoMaxRemarks],
  )
  const viscosityCautionDetected = hasViscosityCaution(`${enquiryText}\n${cleanedEnquiryText}`)
  const attentionTerms = detectAttentionTerms(`${enquiryText}\n${cleanedEnquiryText}`)
  const imoSearchUrl = useMemo(
    () => googleImoSearchUrl(guesses.vesselName || worksheet.vesselName, getParserSourceText()),
    [cleanedEnquiryText, enquiryText, guesses.vesselName, worksheet.vesselName],
  )

  useEffect(() => {
    if (portIndex.length === 0) return
    const sourceText = getParserSourceText()
    if (!sourceText.trim()) return

    const parsed = parseEnquiryWorksheetGuess(sourceText, { portNames: portIndex })
    if (!parsed.port) return

    setGuesses((current) => {
      if (current.port) return current
      return {
        ...current,
        port: parsed.port,
        confidence: parsed.confidence,
        warnings: parsed.warnings,
      }
    })
  }, [portIndex])

  useEffect(() => {
    const preservedShortenedDraft = preservedShortenedDraftRef.current
    if (preservedShortenedDraft) {
      preservedShortenedDraftRef.current = ""
      setShortenedDraft(preservedShortenedDraft)
    } else {
      setShortenedDraft(shortenedEnquiry)
    }
    setCopyStatus("idle")
    setWhatsappStatus("idle")
  }, [shortenedEnquiry])

  function applyCorrectedShortenedEnquiry(correctedOutput: string, fields: ParserAiFields = {}) {
    const correctedGuess = parseEnquiryWorksheetGuess(correctedOutput, { portNames: portIndex })
    const hasCorrectedFields = Boolean(
      correctedGuess.vesselName ||
      correctedGuess.imo ||
      correctedGuess.port ||
      correctedGuess.buyer ||
      fields.vesselName ||
      fields.imo ||
      fields.port ||
      fields.buyer,
    )
    const nextVesselName = fields.vesselName ? toCaps(fields.vesselName) : correctedGuess.vesselName ? toCaps(correctedGuess.vesselName) : ""
    const nextBuyer = fields.buyer ? toCaps(fields.buyer) : correctedGuess.buyer ? toCaps(correctedGuess.buyer) : ""
    const nextImo = (fields.imo || correctedGuess.imo).replace(/\D/g, "").slice(0, 7)
    const nextPort = fields.port ? fields.port.toLowerCase() : correctedGuess.port

    preservedShortenedDraftRef.current = correctedOutput
    setShortenedDraft(correctedOutput)
    setVlsfoMaxRemarks(detectVlsfoMaxRemarks(correctedOutput))
    setGuesses((current) => ({
      ...current,
      vesselName: nextVesselName || current.vesselName,
      imo: nextImo || current.imo,
      port: nextPort || current.port,
      buyer: nextBuyer || current.buyer,
      confidence: hasCorrectedFields ? correctedGuess.confidence : current.confidence,
      warnings: hasCorrectedFields ? correctedGuess.warnings : current.warnings,
    }))
    setWorksheet((current) => ({
      ...current,
      vesselName: nextVesselName || current.vesselName,
      imo: nextImo || current.imo,
      buyer: nextBuyer || current.buyer,
    }))
  }

  async function runParserAi() {
    const rawText = enquiryText.trim()
    const sourceText = getParserSourceText().trim()
    if ((!rawText && !sourceText) || parserAiStatus === "loading") return

    const deterministicOutput = shortenedEnquiry.trim()
    setParserAiStatus("loading")
    setParserAiMessage("")
    try {
      const response = await fetch("/api/parser-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "enquiryworksheet",
          context: "shortened-enquiry",
          rawText,
          cleanedText: cleanedEnquiryText,
          parserOutput: deterministicOutput,
          currentOutput: shortenedDraft,
          fields: {
            vesselName: guesses.vesselName,
            imo: guesses.imo,
            port: guesses.port,
            buyer: guesses.buyer,
          },
          manualVlsfoMaxRemarks: vlsfoMaxRemarks,
        }),
      })
      const payload = (await response.json().catch(() => ({}))) as ParserAiResponse
      if (!response.ok || !payload.correctedOutput) {
        throw new Error(payload.message || "AI parser failed.")
      }

      const suggestion: ParserAiSuggestion = {
        model: payload.model || "gpt-5.4-mini",
        parserOutput: deterministicOutput,
        correctedOutput: payload.correctedOutput,
        fields: payload.fields || {},
        vlsfoMaxRemarks: Array.isArray(payload.vlsfoMaxRemarks) ? payload.vlsfoMaxRemarks : [],
        confidence: typeof payload.confidence === "number" ? payload.confidence : 0,
        warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
        imoSources: Array.isArray(payload.imoSources) ? payload.imoSources.filter((source) => source?.url) : [],
        appliedAt: new Date().toISOString(),
      }

      applyCorrectedShortenedEnquiry(payload.correctedOutput, payload.fields || {})
      if (suggestion.vlsfoMaxRemarks.length > 0) setVlsfoMaxRemarks(suggestion.vlsfoMaxRemarks)
      setParserAiSuggestion(suggestion)
      setParserAiStatus("applied")
      setParserAiMessage("AI correction applied. Double check before sending.")
      setCopyStatus("idle")
      setWhatsappStatus("idle")
    } catch (error) {
      setParserAiStatus("failed")
      setParserAiMessage(error instanceof Error ? error.message : "AI parser failed.")
    }
  }

  useEffect(() => {
    function handleWhatsappResponse(event: MessageEvent) {
      if (event.source !== window || event.origin !== window.location.origin) return
      const payload = event.data && typeof event.data === "object"
        ? (event.data as { type?: unknown; ok?: unknown; requestId?: unknown; message?: unknown })
        : null
      if (!payload || payload.type !== WHATSAPP_EXTENSION_RESPONSE_TYPE) return
      if (!whatsappRequestIdRef.current || payload.requestId !== whatsappRequestIdRef.current) return

      if (whatsappTimeoutRef.current !== null) window.clearTimeout(whatsappTimeoutRef.current)
      whatsappTimeoutRef.current = null
      setWhatsappStatus(payload.ok ? "sent" : "failed")
    }

    window.addEventListener("message", handleWhatsappResponse)
    return () => {
      window.removeEventListener("message", handleWhatsappResponse)
      if (whatsappTimeoutRef.current !== null) window.clearTimeout(whatsappTimeoutRef.current)
    }
  }, [])

  function toggleVlsfoMaxRemark(remark: VlsfoMaxRemark) {
    setVlsfoMaxRemarks((current) =>
      current.includes(remark)
        ? current.filter((item) => item !== remark)
        : [...current, remark],
    )
  }

  async function copyShortenedEnquiry() {
    if (!shortenedDraft.trim()) return

    try {
      await navigator.clipboard.writeText(shortenedDraft.trim())
      setCopyStatus("copied")
    } catch {
      setCopyStatus("failed")
    }
  }

  function sendShortenedToWhatsappBoard() {
    const text = shortenedDraft.trim()
    if (!text) return

    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    whatsappRequestIdRef.current = requestId
    if (whatsappTimeoutRef.current !== null) window.clearTimeout(whatsappTimeoutRef.current)
    setWhatsappStatus("sending")
    window.postMessage(
      {
        type: WHATSAPP_EXTENSION_REQUEST_TYPE,
        requestId,
        text,
        buyer: (guesses.buyer || worksheet.buyer).trim(),
      },
      window.location.origin,
    )

    whatsappTimeoutRef.current = window.setTimeout(() => {
      if (whatsappRequestIdRef.current !== requestId) return
      whatsappTimeoutRef.current = null
      setWhatsappStatus("failed")
    }, 2500)
  }

  function openParserReport() {
    const aiOutput = parserAiSuggestion?.correctedOutput.trim() || ""
    const parserOutput = parserAiSuggestion?.parserOutput.trim() || shortenedEnquiry.trim()
    setParserReportDraft({
      open: true,
      parserOutput,
      aiOutput,
      aiSources: parserAiSuggestion?.imoSources || [],
      correctedOutput: (shortenedDraft || shortenedEnquiry).trim(),
      note: "",
    })
    setParserReportStatus("idle")
  }

  async function submitParserReport() {
    const rawText = enquiryText.trim()
    const parserOutput = parserReportDraft.parserOutput.trim() || shortenedEnquiry.trim()
    const correctedOutput = parserReportDraft.correctedOutput.trim()
    if (!rawText || !correctedOutput || parserReportStatus === "saving") return

    setParserReportStatus("saving")
    try {
      const response = await fetch("/api/parser-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "enquiryworksheet",
          context: "shortened-enquiry",
          rawText,
          cleanedText: cleanedEnquiryText,
          parserOutput,
          correctedOutput,
          note: parserReportDraft.note,
          pageUrl: window.location.href,
          metadata: {
            guesses,
            worksheet: {
              vesselName: worksheet.vesselName,
              imo: worksheet.imo,
              buyer: worksheet.buyer,
            },
            manualVlsfoMaxRemarks: vlsfoMaxRemarks,
            aiSuggestion: parserAiSuggestion,
            aiFixOutput: parserReportDraft.aiOutput,
            aiSources: parserReportDraft.aiSources,
          },
        }),
      })
      const payload = (await response.json().catch(() => ({}))) as { message?: string }
      if (!response.ok) throw new Error(payload.message || "Failed to save report.")

      applyCorrectedShortenedEnquiry(correctedOutput)
      setCopyStatus("idle")
      setWhatsappStatus("idle")
      await loadParserReportCount()
      setParserReportStatus("saved")
      window.setTimeout(() => {
        setParserReportDraft((current) => ({ ...current, open: false }))
        setParserReportStatus("idle")
      }, 900)
    } catch {
      setParserReportStatus("failed")
    }
  }

  function guessDetails() {
    const parsed = parseEnquiryWorksheetGuess(getParserSourceText(), { portNames: portIndex })
    const nextGuess: EnquiryWorksheetGuess = {
      vesselName: guesses.vesselName || parsed.vesselName,
      imo: guesses.imo || parsed.imo,
      port: guesses.port || parsed.port,
      buyer: guesses.buyer || parsed.buyer,
      confidence: parsed.confidence,
      warnings: parsed.warnings,
    }

    setGuesses(nextGuess)
    return nextGuess
  }

  function generateWorksheet() {
    const nextGuess = guessDetails()
    setWorksheet({
      ...blankWorksheet(userNickname),
      vesselName: toCaps(nextGuess.vesselName),
      imo: nextGuess.imo.replace(/\D/g, "").slice(0, 7),
      buyer: toCaps(nextGuess.buyer),
      workingNotes: formatWorksheetWorkingNotes(getParserSourceText()),
    })
  }

  function clearDraft() {
    try {
      window.localStorage.removeItem(ENQUIRY_WORKSHEET_CACHE_KEY)
    } catch {
      // Ignore storage failures; the visible draft still resets.
    }
    setEnquiryText("")
    setCleanedEnquiryText("")
    setVlsfoMaxRemarks([])
    setCopyStatus("idle")
    setWhatsappStatus("idle")
    whatsappRequestIdRef.current = ""
    if (whatsappTimeoutRef.current !== null) window.clearTimeout(whatsappTimeoutRef.current)
    whatsappTimeoutRef.current = null
    setShortenedDraft("")
    setParserAiStatus("idle")
    setParserAiMessage("")
    setParserAiSuggestion(null)
    setGuesses(emptyGuess())
    setWorksheet(blankWorksheet(userNickname))
  }

  return (
    <main className={styles.page}>
      <div className={styles.workspace}>
        <aside className={styles.sidePanel} aria-label="Enquiry worksheet generator">
          <label className={styles.panelField}>
            <span>ENQUIRY</span>
            <textarea
              value={enquiryText}
              onChange={(event) => handleEnquiryTextChange(event.target.value)}
              placeholder="Paste the full enquiry here."
              aria-label="Enquiry text"
              className={styles.generatorText}
            />
          </label>
          {viscosityCautionDetected ? (
            <div className={styles.cautionAlert}>
              CAUTION: 180 / 120 detected. Check whether VLSFO 180cst max or 120cst max applies.
            </div>
          ) : null}
          {attentionTerms.length > 0 ? (
            <div className={styles.cautionAlert}>
              WARNING: {attentionTerms.join(" / ")} spotted. Check remarks and quantity unit before sending.
            </div>
          ) : null}

          <section className={styles.shortenedPanel} aria-label="Shortened enquiry">
            <div className={styles.shortenedHeader}>
              <span className={styles.shortenedTitle}>
                <span>SHORTENED ENQUIRY</span>
                <span>(USE WITH CAUTION)</span>
              </span>
              <button
                type="button"
                className={styles.copyButton}
                onClick={copyShortenedEnquiry}
                disabled={!shortenedDraft.trim()}
                aria-label="Copy shortened enquiry"
                title="Copy shortened enquiry"
                data-admin-button-style="preserve"
              >
                COPY
              </button>
              <button
                type="button"
                className={styles.aiButton}
                onClick={runParserAi}
                disabled={!enquiryText.trim() || parserAiStatus === "loading"}
                aria-label="Ask AI to correct shortened enquiry"
                title="Ask AI to correct shortened enquiry"
                data-admin-button-style="preserve"
              >
                AI FIX
              </button>
              <button
                type="button"
                className={styles.reportButton}
                onClick={openParserReport}
                disabled={!enquiryText.trim()}
                aria-label="Report incorrect parser output"
                title="Report incorrect parser output"
                data-admin-button-style="preserve"
              >
                REPORT
              </button>
              <button
                type="button"
                className={styles.whatsappButton}
                onClick={sendShortenedToWhatsappBoard}
                disabled={!shortenedDraft.trim() || whatsappStatus === "sending"}
                aria-label="Send shortened enquiry to FCUNO WhatsApp Speed Board"
                title="Send to FCUNO WhatsApp Speed Board"
                data-admin-button-style="preserve"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M3.8 11.2 19.1 4.1c.9-.4 1.8.5 1.4 1.4l-7.1 15.3c-.4.9-1.7.7-1.9-.3l-1.4-6.4-6.4-1.4c-1-.2-1.2-1.5-.3-1.9Z" />
                  <path d="m10.4 13.7 4.2-4.2" />
                </svg>
              </button>
            </div>
            <textarea
              className={styles.shortenedBox}
              value={shortenedDraft}
              onChange={(event) => {
                setShortenedDraft(event.target.value)
                setCopyStatus("idle")
                setWhatsappStatus("idle")
              }}
              placeholder="No shortened enquiry yet."
              aria-label="Editable shortened enquiry"
            />
            <div className={styles.vlsfoRemarkButtons}>
              {vlsfoRemarkOptions.map((remark) => {
                const active = vlsfoMaxRemarks.includes(remark)
                return (
                  <button
                    key={remark}
                    type="button"
                    aria-pressed={active}
                    className={active ? styles.remarkButtonActive : styles.remarkButton}
                    onClick={() => toggleVlsfoMaxRemark(remark)}
                    data-admin-button-style="preserve"
                  >
                    Add {remark}
                  </button>
                )
              })}
            </div>
            {copyStatus === "copied" ? <p className={styles.copyStatus}>Copied.</p> : null}
            {copyStatus === "failed" ? <p className={styles.copyError}>Copy failed.</p> : null}
            {parserAiMessage ? (
              <p className={parserAiStatus === "failed" ? styles.copyError : styles.copyStatus}>
                {parserAiMessage}
              </p>
            ) : null}
            {parserAiSuggestion?.warnings.length ? (
              <p className={styles.copyError}>
                AI warning: {parserAiSuggestion.warnings.join(" / ")}
              </p>
            ) : null}
            {parserAiSuggestion?.imoSources.length ? (
              <p className={styles.copyStatus}>
                IMO source:{" "}
                <a href={parserAiSuggestion.imoSources[0].url} target="_blank" rel="noreferrer">
                  {parserAiSuggestion.imoSources[0].title || parserAiSuggestion.imoSources[0].url}
                </a>
              </p>
            ) : null}
            {whatsappStatus === "sending" ? <p className={styles.copyStatus}>Sending to WhatsApp board...</p> : null}
            {whatsappStatus === "sent" ? <p className={styles.copyStatus}>Sent to FCUNO WhatsApp Speed Board.</p> : null}
            {whatsappStatus === "failed" ? <p className={styles.copyError}>FCUNO WhatsApp Speed Board did not respond. Reload the extension and try again.</p> : null}
          </section>

          <div className={styles.confirmGrid}>
            <label>
              <span>VESSEL NAME</span>
              <input
                value={guesses.vesselName}
                onChange={(event) =>
                  setGuesses((current) => ({ ...current, vesselName: toCaps(event.target.value) }))
                }
                className={styles.capsInput}
              />
            </label>
            <label>
              <span className={styles.fieldLabelRow}>
                <span>IMO</span>
                {!guesses.imo.trim() && imoSearchUrl ? (
                  <a className={styles.imoLookup} href={imoSearchUrl} target="_blank" rel="noreferrer">
                    Google search
                  </a>
                ) : null}
              </span>
              <input
                value={guesses.imo}
                onChange={(event) =>
                  setGuesses((current) => ({
                    ...current,
                    imo: event.target.value.replace(/\D/g, "").slice(0, 7),
                  }))
                }
                inputMode="numeric"
                maxLength={7}
              />
            </label>
            <label>
              <span>PORT</span>
              <input
                value={guesses.port}
                onChange={(event) =>
                  setGuesses((current) => ({ ...current, port: event.target.value.toLowerCase() }))
                }
              />
            </label>
            <label>
              <span>BUYER</span>
              <input
                value={guesses.buyer}
                onChange={(event) =>
                  setGuesses((current) => ({ ...current, buyer: toCaps(event.target.value) }))
                }
                className={styles.capsInput}
              />
            </label>
          </div>

          <div className={styles.panelActions}>
            <button
              type="button"
              className={styles.primaryPanelButton}
              onClick={generateWorksheet}
              data-admin-button-style="preserve"
            >
              Generate
            </button>
            <button
              type="button"
              className={styles.primaryPanelButton}
              onClick={() => window.print()}
              data-admin-view-safe="true"
              data-admin-button-style="preserve"
            >
              Print
            </button>
            <button
              type="button"
              className={styles.secondaryPanelButton}
              onClick={clearDraft}
              data-admin-button-style="preserve"
            >
              Clear
            </button>
          </div>

          {guesses.warnings.length > 0 ? (
            <ul className={styles.parserWarnings}>
              {guesses.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          <p className={styles.reportedCount}>REPORTED ({parserReportCount})</p>
        </aside>

        <section className={styles.sheet} aria-label="Enquiry worksheet">
          <div className={styles.vesselLine}>
            <input
              value={getWorksheetHeader(worksheet)}
              onChange={(event) => updateWorksheetHeader(event.target.value)}
              aria-label="Vessel name and IMO"
              placeholder="VESSEL NAME - IMO"
              className={styles.capsInput}
            />
          </div>

          <div className={styles.topRight}>
            <span className={styles.emptyStamp} aria-hidden="true" />
            <span>{worksheet.date}</span>
            <span>{worksheet.initials || userNickname}</span>
          </div>

          <div className={styles.detailsTable}>
            <label>
              <span>BUYER</span>
              <input
                value={worksheet.buyer}
                onChange={(event) => updateCapsField("buyer", event.target.value)}
                className={styles.capsInput}
              />
            </label>
            <label>
              <span>CREDIT USED / CL</span>
              <input
                value={worksheet.credit}
                onChange={(event) => updateCapsField("credit", event.target.value)}
                className={styles.capsInput}
              />
            </label>
          </div>

          <div className={styles.workingArea}>
            <textarea
              value={worksheet.workingNotes}
              onChange={(event) => updateField("workingNotes", event.target.value)}
              aria-label="Enquiry working notes"
            />
            <label className={styles.compensation}>
              <span>UNOFFICIAL COMPENSATION?</span>
              <input
                value={worksheet.unofficialCompensation}
                onChange={(event) => updateCapsField("unofficialCompensation", event.target.value)}
                aria-label="Unofficial compensation yes or no"
                placeholder="YES / NO"
                className={styles.capsInput}
              />
            </label>
          </div>

          <div className={styles.workflowLayout}>
            <div className={styles.workflowHeaderCell} />
            {workflowActions.map(([, label]) => (
              <div className={styles.workflowHeaderCell} key={label}>
                {label}
              </div>
            ))}
            <div className={`${styles.workflowHeaderCell} ${styles.notesHeader}`}>NOTES</div>
            {workflowLabels.map(([key, label]) => {
              const row = worksheet.workflow[key]
              return (
                <div className={styles.workflowRowContents} key={key}>
                  <strong>{label}</strong>
                  {workflowActions.map(([field]) => {
                    const cell = workflowCells[key][field]
                    if (!cell) return <span className={styles.workflowBlankCell} key={field} />
                    return (
                      <label className={styles.workflowCheck} key={field}>
                        <input
                          type="checkbox"
                          checked={row[field]}
                          onChange={(event) => updateWorkflow(key, field, event.target.checked)}
                          aria-label={`${label} ${field}`}
                        />
                        <input
                          value={row[`${field}Text`]}
                          onChange={(event) => updateWorkflow(key, `${field}Text`, event.target.value)}
                          aria-label={`${label} ${field} text`}
                          className={styles.capsInput}
                        />
                        {cell.suffix ? <span>{cell.suffix}</span> : null}
                      </label>
                    )
                  })}
                  <label className={styles.workflowNote}>
                    <span>{label}</span>
                    <input
                      value={row.note}
                      onChange={(event) => updateWorkflow(key, "note", event.target.value)}
                      className={styles.capsInput}
                    />
                  </label>
                </div>
              )
            })}
          </div>
        </section>
      </div>

      {parserReportDraft.open ? (
        <div className={styles.reportBackdrop} role="dialog" aria-modal="true" aria-labelledby="parser-report-title">
          <div className={styles.reportDialog}>
            <div className={styles.reportHeader}>
              <h2 id="parser-report-title">Report Parser Output</h2>
              <button
                type="button"
                onClick={() => setParserReportDraft((current) => ({ ...current, open: false }))}
                disabled={parserReportStatus === "saving"}
                aria-label="Close report dialog"
                data-admin-button-style="preserve"
              >
                ×
              </button>
            </div>
            <div className={styles.reportBody}>
              <label>
                <span>RAW ENQUIRY</span>
                <textarea value={enquiryText} readOnly />
              </label>
              <label>
                <span>PARSER OUTPUT</span>
                <textarea value={parserReportDraft.parserOutput} readOnly />
              </label>
              {parserReportDraft.aiOutput ? (
                <label>
                  <span>AI FIX</span>
                  <textarea value={parserReportDraft.aiOutput} readOnly />
                </label>
              ) : null}
              {parserReportDraft.aiSources.length ? (
                <p className={styles.copyStatus}>
                  IMO source:{" "}
                  <a href={parserReportDraft.aiSources[0].url} target="_blank" rel="noreferrer">
                    {parserReportDraft.aiSources[0].title || parserReportDraft.aiSources[0].url}
                  </a>
                </p>
              ) : null}
              <label>
                <span>CORRECT VERSION</span>
                <textarea
                  value={parserReportDraft.correctedOutput}
                  onChange={(event) =>
                    setParserReportDraft((current) => ({
                      ...current,
                      correctedOutput: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                <span>NOTE</span>
                <input
                  value={parserReportDraft.note}
                  onChange={(event) =>
                    setParserReportDraft((current) => ({
                      ...current,
                      note: event.target.value,
                    }))
                  }
                  placeholder="Optional"
                />
              </label>
              {parserReportStatus === "saved" ? <p className={styles.copyStatus}>Report saved.</p> : null}
              {parserReportStatus === "failed" ? <p className={styles.copyError}>Report failed. Please try again.</p> : null}
            </div>
            <div className={styles.reportActions}>
              <button
                type="button"
                onClick={() => setParserReportDraft((current) => ({ ...current, open: false }))}
                disabled={parserReportStatus === "saving"}
                data-admin-button-style="preserve"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitParserReport}
                disabled={!parserReportDraft.correctedOutput.trim() || parserReportStatus === "saving"}
                data-admin-button-style="preserve"
              >
                {parserReportStatus === "saving" ? "Saving..." : "Submit Report"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}
