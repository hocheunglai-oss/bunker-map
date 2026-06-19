"use client"

import { useEffect, useMemo, useState } from "react"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import styles from "./enquiryWorksheet.module.css"

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

type WorkflowKey = "bumain" | "nom" | "con" | "bno"

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

type GuessState = {
  vesselName: string
  imo: string
  buyer: string
}

const workflowLabels: Array<[WorkflowKey, string]> = [
  ["bumain", "BUMAIN"],
  ["nom", "NOM"],
  ["con", "CON"],
  ["bno", "BNO"],
]

const vesselSkipWords =
  /\b(BUNKER|BUNKERS|ENQUIRY|INQUIRY|FUEL|QUOTE|QUOTATION|PRICE|PORT|ETA|ETD|DATE|QTY|QUANTITY|BUYER|SELLER|SUPPLIER|PAYMENT|CREDIT|IFO|VLSFO|HSFO|MGO|LSMGO|ULSFO|EMAIL|PHONE|MOBILE)\b/i

function toCaps(value: string) {
  return value.toUpperCase()
}

function todayShort() {
  const date = new Date()
  const day = date.getDate()
  const month = date.getMonth() + 1
  const year = String(date.getFullYear()).slice(-2)
  return `${day}/${month}/${year}`
}

function emptyRow(): WorkflowRow {
  return {
    register: false,
    draft: false,
    approval: false,
    send: false,
    registerText: "",
    draftText: "",
    approvalText: "",
    sendText: "",
    note: "",
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
      con: emptyRow(),
      bno: emptyRow(),
    },
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

function cleanGuess(value: string) {
  return value.replace(/\s+/g, " ").replace(/^[\s:;\-,./]+|[\s:;\-,./]+$/g, "")
}

function guessVesselName(text: string) {
  const labelledMatch = text.match(
    /\b(?:vessel|vsl|ship|m[./\s-]*v|m[./\s-]*t)\s*[:#\-]?\s*([A-Za-z0-9][A-Za-z0-9 '\-./()]{2,60})/i
  )
  if (labelledMatch?.[1]) return cleanGuess(labelledMatch[1])

  const prefixedMatch = text.match(
    /\b((?:M[./\s-]*V|M[./\s-]*T|MV|MT)\s+[A-Za-z0-9][A-Za-z0-9 '\-./()]{2,55})\b/i
  )
  if (prefixedMatch?.[1]) return cleanGuess(prefixedMatch[1])

  const candidate = text
    .split(/\r?\n/)
    .map(cleanGuess)
    .find((line) => {
      if (line.length < 3 || line.length > 45) return false
      if (/\d{7}/.test(line)) return false
      if (/[,:;]/.test(line)) return false
      if (vesselSkipWords.test(line)) return false
      return /[A-Za-z]/.test(line)
    })

  return candidate || ""
}

function guessBuyer(text: string) {
  const match = text.match(/\b(?:buyer|client|account|customer)\s*[:#\-]\s*([^\n\r,;]{2,60})/i)
  return match?.[1] ? cleanGuess(match[1]) : ""
}

function guessEnquiry(text: string): GuessState {
  const imoMatch = text.match(/\bIMO\s*[:#\-]?\s*(\d{7})\b/i) || text.match(/\b(\d{7})\b/)
  return {
    vesselName: toCaps(guessVesselName(text)),
    imo: imoMatch?.[1] || "",
    buyer: toCaps(guessBuyer(text)),
  }
}

export default function EnquiryWorksheetPage() {
  const { displayName, username } = useSimpleAdminAuth()
  const userNickname = useMemo(() => deriveNickname(displayName, username), [displayName, username])
  const [worksheet, setWorksheet] = useState<Worksheet>(() => blankWorksheet())
  const [generatorStep, setGeneratorStep] = useState<"paste" | "confirm" | null>("paste")
  const [enquiryText, setEnquiryText] = useState("")
  const [guesses, setGuesses] = useState<GuessState>({ vesselName: "", imo: "", buyer: "" })

  useEffect(() => {
    document.title = "Enquiry Worksheet - FC Uno"
  }, [])

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

  function openGenerator() {
    setEnquiryText("")
    setGuesses({
      vesselName: worksheet.vesselName,
      imo: worksheet.imo,
      buyer: worksheet.buyer,
    })
    setGeneratorStep("paste")
  }

  function goToConfirmStep() {
    const parsed = guessEnquiry(enquiryText)
    setGuesses((current) => ({
      vesselName: parsed.vesselName || current.vesselName,
      imo: parsed.imo || current.imo,
      buyer: current.buyer || parsed.buyer,
    }))
    setGeneratorStep("confirm")
  }

  function generateWorksheet() {
    setWorksheet({
      ...blankWorksheet(userNickname),
      vesselName: toCaps(guesses.vesselName),
      imo: guesses.imo.replace(/\D/g, "").slice(0, 7),
      buyer: toCaps(guesses.buyer),
      workingNotes: enquiryText,
    })
    setGeneratorStep(null)
  }

  function startBlankWorksheet() {
    setWorksheet(blankWorksheet(userNickname))
    setGeneratorStep(null)
  }

  return (
    <main className={styles.page}>
      <div className={styles.toolbar}>
        <button type="button" onClick={openGenerator} aria-label="New enquiry worksheet">
          New enquiry
        </button>
        <button type="button" onClick={() => window.print()} data-admin-view-safe="true">
          Print
        </button>
      </div>

      <section className={styles.sheet} aria-label="Enquiry worksheet">
        <div className={styles.vesselLine}>
          <span aria-hidden="true">-</span>
          <input
            value={worksheet.vesselName}
            onChange={(event) => updateCapsField("vesselName", event.target.value)}
            aria-label="Vessel name"
            placeholder="VESSEL NAME"
            className={styles.capsInput}
          />
          <span className={styles.smallSquare} aria-hidden="true" />
        </div>

        <div className={styles.topRight}>
          <label className={styles.imoStamp}>
            <span>IMO</span>
            <input
              value={worksheet.imo}
              onChange={(event) => updateCapsField("imo", event.target.value.replace(/\D/g, "").slice(0, 7))}
              aria-label="IMO number"
              inputMode="numeric"
              maxLength={7}
            />
          </label>
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

        <div className={styles.workflowLeft}>
          <div className={styles.workflowHeader}>
            <span />
            <span>REGISTER</span>
            <span>DRAFT</span>
            <span>APPROVAL</span>
            <span>SEND</span>
          </div>
          {workflowLabels.map(([key, label]) => {
            const row = worksheet.workflow[key]
            return (
              <div className={styles.workflowRow} key={key}>
                <strong>{label}</strong>
                {(["register", "draft", "approval", "send"] as const).map((field) => (
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
                  </label>
                ))}
              </div>
            )
          })}
        </div>

        <div className={styles.notesArea}>
          <div className={styles.notesTitle}>NOTES B</div>
          {workflowLabels.map(([key, label]) => (
            <label className={styles.noteRow} key={key}>
              <span>{label}</span>
              <input
                value={worksheet.workflow[key].note}
                onChange={(event) => updateWorkflow(key, "note", event.target.value)}
                className={styles.capsInput}
              />
            </label>
          ))}
        </div>
      </section>

      {generatorStep ? (
        <div className={styles.modalBackdrop} role="presentation">
          <div className={styles.modal} role="dialog" aria-modal="true" aria-label="Generate enquiry worksheet">
            {generatorStep === "paste" ? (
              <>
                <div className={styles.modalHeader}>
                  <h2>Paste enquiry</h2>
                  <button type="button" onClick={() => setGeneratorStep(null)} aria-label="Close generator">
                    ×
                  </button>
                </div>
                <textarea
                  value={enquiryText}
                  onChange={(event) => setEnquiryText(event.target.value)}
                  placeholder="Paste the full enquiry here."
                  aria-label="Enquiry text"
                  className={styles.generatorText}
                  autoFocus
                />
                <div className={styles.modalActions}>
                  <button
                    type="button"
                    className={styles.neutralButton}
                    onClick={startBlankWorksheet}
                    aria-label="New blank worksheet"
                  >
                    Blank worksheet
                  </button>
                  <button type="button" onClick={goToConfirmStep} aria-label="Create worksheet next step">
                    Next
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className={styles.modalHeader}>
                  <h2>Check enquiry details</h2>
                  <button type="button" onClick={() => setGeneratorStep(null)} aria-label="Close generator">
                    ×
                  </button>
                </div>
                <div className={styles.confirmGrid}>
                  <label>
                    <span>VESSEL NAME</span>
                    <input
                      value={guesses.vesselName}
                      onChange={(event) =>
                        setGuesses((current) => ({ ...current, vesselName: toCaps(event.target.value) }))
                      }
                      className={styles.capsInput}
                      autoFocus
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
                <p className={styles.modalNote}>IMO is optional. Correct the guess before generating.</p>
                <div className={styles.modalActions}>
                  <button type="button" className={styles.neutralButton} onClick={() => setGeneratorStep("paste")}>
                    Back
                  </button>
                  <button type="button" onClick={generateWorksheet} aria-label="Generate new worksheet">
                    Generate
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </main>
  )
}
