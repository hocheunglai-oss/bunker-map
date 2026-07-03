"use client"

import { useEffect, useMemo, useState } from "react"
import {
  buildShortenedEnquiry,
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
  const [whatsappRequestId, setWhatsappRequestId] = useState("")

  useEffect(() => {
    document.title = "Enquiry Worksheet - FC Uno"
  }, [])

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
    setShortenedDraft(shortenedEnquiry)
    setCopyStatus("idle")
    setWhatsappStatus("idle")
  }, [shortenedEnquiry])

  useEffect(() => {
    function handleWhatsappResponse(event: MessageEvent) {
      if (event.source !== window || event.origin !== window.location.origin) return
      const payload = event.data && typeof event.data === "object"
        ? (event.data as { type?: unknown; ok?: unknown; requestId?: unknown; message?: unknown })
        : null
      if (!payload || payload.type !== WHATSAPP_EXTENSION_RESPONSE_TYPE) return
      if (whatsappRequestId && payload.requestId !== whatsappRequestId) return

      setWhatsappStatus(payload.ok ? "sent" : "failed")
    }

    window.addEventListener("message", handleWhatsappResponse)
    return () => window.removeEventListener("message", handleWhatsappResponse)
  }, [whatsappRequestId])

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
    setWhatsappRequestId(requestId)
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

    window.setTimeout(() => {
      setWhatsappStatus((current) => (current === "sending" ? "failed" : current))
    }, 2500)
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
      workingNotes: getParserSourceText(),
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
    setWhatsappRequestId("")
    setShortenedDraft("")
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

          <section className={styles.shortenedPanel} aria-label="Shortened enquiry">
            <div className={styles.shortenedHeader}>
              <span>SHORTENED ENQUIRY (USE WITH CAUTION)</span>
              <button
                type="button"
                className={styles.copyButton}
                onClick={copyShortenedEnquiry}
                disabled={!shortenedDraft.trim()}
                aria-label="Copy shortened enquiry"
                title="Copy shortened enquiry"
                data-admin-button-style="preserve"
              >
                ⧉
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
              <span>IMO</span>
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
    </main>
  )
}
