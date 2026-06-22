"use client"

import { useEffect, useMemo, useState } from "react"
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
    buyer: "",
    simplifiedEnquiry: "",
    confidence: "low",
    warnings: [],
  }
}

function getWorksheetHeader(worksheet: Worksheet) {
  if (worksheet.vesselName && worksheet.imo) return `${worksheet.vesselName} - ${worksheet.imo}`
  return worksheet.vesselName || worksheet.imo
}

export default function EnquiryWorksheetPage() {
  const { displayName, username } = useSimpleAdminAuth()
  const userNickname = useMemo(() => deriveNickname(displayName, username), [displayName, username])
  const [worksheet, setWorksheet] = useState<Worksheet>(() => blankWorksheet())
  const [enquiryText, setEnquiryText] = useState("")
  const [guesses, setGuesses] = useState<EnquiryWorksheetGuess>(() => emptyGuess())

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
    setGuesses(value.trim() ? parseEnquiryWorksheetGuess(value) : emptyGuess())
  }

  function guessDetails() {
    const parsed = parseEnquiryWorksheetGuess(enquiryText)
    setGuesses((current) => ({
      vesselName: parsed.vesselName || current.vesselName,
      imo: parsed.imo || current.imo,
      buyer: current.buyer || parsed.buyer,
      simplifiedEnquiry: parsed.simplifiedEnquiry,
      confidence: parsed.confidence,
      warnings: parsed.warnings,
    }))
  }

  function generateWorksheet() {
    const parsed = parseEnquiryWorksheetGuess(enquiryText)
    const nextGuess: EnquiryWorksheetGuess = {
      vesselName: guesses.vesselName || parsed.vesselName,
      imo: guesses.imo || parsed.imo,
      buyer: guesses.buyer || parsed.buyer,
      simplifiedEnquiry: parsed.simplifiedEnquiry,
      confidence: parsed.confidence,
      warnings: parsed.warnings,
    }

    setGuesses(nextGuess)
    setWorksheet({
      ...blankWorksheet(userNickname),
      vesselName: toCaps(nextGuess.vesselName),
      imo: nextGuess.imo.replace(/\D/g, "").slice(0, 7),
      buyer: toCaps(nextGuess.buyer),
      workingNotes: enquiryText,
    })
  }

  function startBlankWorksheet() {
    setWorksheet(blankWorksheet(userNickname))
    setEnquiryText("")
    setGuesses(emptyGuess())
  }

  return (
    <main className={styles.page}>
      <div className={styles.workspace}>
        <section className={styles.sheet} aria-label="Enquiry worksheet">
          <div className={styles.vesselLine}>
            <span aria-hidden="true">-</span>
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

        <aside className={styles.sidePanel} aria-label="Enquiry worksheet generator">
          <div className={styles.panelHeader}>
            <span>ENQUIRY WORKSHEET</span>
            <h2>Paste and generate</h2>
          </div>

          <label className={styles.panelField}>
            <span>PASTE ENQUIRY</span>
            <textarea
              value={enquiryText}
              onChange={(event) => handleEnquiryTextChange(event.target.value)}
              placeholder="Paste the full enquiry here."
              aria-label="Enquiry text"
              className={styles.generatorText}
            />
          </label>

          <div className={styles.panelActions}>
            <button type="button" className={styles.primaryPanelButton} onClick={guessDetails}>
              Guess details
            </button>
            <button type="button" className={styles.primaryPanelButton} onClick={generateWorksheet}>
              Generate worksheet
            </button>
            <button
              type="button"
              className={styles.neutralButton}
              onClick={startBlankWorksheet}
              aria-label="New blank worksheet"
            >
              Blank
            </button>
            <button
              type="button"
              className={styles.primaryPanelButton}
              onClick={() => window.print()}
              data-admin-view-safe="true"
            >
              Print
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

          <label className={styles.panelField}>
            <span>SIMPLIFIED ENQUIRY</span>
            <textarea
              value={guesses.simplifiedEnquiry}
              readOnly
              placeholder="Example: panda 006 / 9677026 / port klang 8 jun / lsfo 650mts"
              className={styles.simplifiedText}
              aria-label="Simplified enquiry"
            />
          </label>

          <p className={styles.modalNote}>IMO is optional. Check the guess before generating.</p>
          {guesses.warnings.length > 0 ? (
            <ul className={styles.parserWarnings}>
              {guesses.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </aside>
      </div>
    </main>
  )
}
