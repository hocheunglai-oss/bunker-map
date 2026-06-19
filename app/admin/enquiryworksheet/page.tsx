"use client"

import { useEffect, useRef, useState } from "react"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import styles from "./enquiryWorksheet.module.css"

const STORE_KEY = "enquiry-worksheet"
const LOCAL_KEY = "fc-enquiry-worksheet"

type WorkflowRow = {
  register: boolean
  draft: boolean
  approval: boolean
  send: boolean
  detail: string
  notes: string
}

type Worksheet = {
  imo: string
  date: string
  initials: string
  buyer: string
  credit: string
  workingNotes: string
  unofficialCompensation: "" | "YES" | "NO"
  workflow: Record<"bumain" | "nom" | "con" | "bno", WorkflowRow>
}

const emptyRow = (): WorkflowRow => ({
  register: false,
  draft: false,
  approval: false,
  send: false,
  detail: "",
  notes: "",
})

function today() {
  const date = new Date()
  const day = String(date.getDate()).padStart(2, "0")
  const month = String(date.getMonth() + 1).padStart(2, "0")
  return `${day}/${month}/${date.getFullYear()}`
}

function blankWorksheet(initials = ""): Worksheet {
  return {
    imo: "",
    date: today(),
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

function normalizeWorksheet(value: unknown, initials = ""): Worksheet {
  const fallback = blankWorksheet(initials)
  if (!value || typeof value !== "object") return fallback
  const source = value as Partial<Worksheet>
  const workflow = source.workflow && typeof source.workflow === "object" ? source.workflow : {}

  const normalizeRow = (key: keyof Worksheet["workflow"]) => {
    const row = (workflow as Partial<Worksheet["workflow"]>)[key]
    return {
      register: Boolean(row?.register),
      draft: Boolean(row?.draft),
      approval: Boolean(row?.approval),
      send: Boolean(row?.send),
      detail: typeof row?.detail === "string" ? row.detail : "",
      notes: typeof row?.notes === "string" ? row.notes : "",
    }
  }

  return {
    imo: typeof source.imo === "string" ? source.imo : "",
    date: typeof source.date === "string" ? source.date : fallback.date,
    initials: typeof source.initials === "string" ? source.initials : initials,
    buyer: typeof source.buyer === "string" ? source.buyer : "",
    credit: typeof source.credit === "string" ? source.credit : "",
    workingNotes: typeof source.workingNotes === "string" ? source.workingNotes : "",
    unofficialCompensation:
      source.unofficialCompensation === "YES" || source.unofficialCompensation === "NO"
        ? source.unofficialCompensation
        : "",
    workflow: {
      bumain: normalizeRow("bumain"),
      nom: normalizeRow("nom"),
      con: normalizeRow("con"),
      bno: normalizeRow("bno"),
    },
  }
}

const workflowLabels: Array<[keyof Worksheet["workflow"], string]> = [
  ["bumain", "BUMAIN"],
  ["nom", "NOM"],
  ["con", "CON"],
  ["bno", "BNO"],
]

export default function EnquiryWorksheetPage() {
  const { authenticated, displayName, username } = useSimpleAdminAuth()
  const userInitials = (displayName || username || "").trim().slice(0, 2).toUpperCase()
  const [worksheet, setWorksheet] = useState<Worksheet>(() => blankWorksheet())
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState("")
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    document.title = "Enquiry Worksheet - FC Uno"
  }, [])

  useEffect(() => {
    let cancelled = false

    async function load() {
      let next = blankWorksheet(userInitials)
      try {
        const local = window.localStorage.getItem(LOCAL_KEY)
        if (local) next = normalizeWorksheet(JSON.parse(local), userInitials)
      } catch {
        // The shared copy below remains authoritative when local storage is unavailable.
      }

      try {
        const response = await fetch(`/api/office-calendar-store/${STORE_KEY}`, { cache: "no-store" })
        const data = await response.json()
        if (response.ok && data?.payload?.worksheet) {
          next = normalizeWorksheet(data.payload.worksheet, userInitials)
        }
      } catch {
        setStatus("Using the locally saved copy.")
      }

      if (!cancelled) {
        setWorksheet(next)
        setLoaded(true)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [userInitials])

  useEffect(() => {
    if (!loaded) return
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(worksheet))
  }, [loaded, worksheet])

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [])

  function updateField<K extends keyof Worksheet>(key: K, value: Worksheet[K]) {
    setWorksheet((current) => ({ ...current, [key]: value }))
    setStatus("")
  }

  function updateWorkflow(
    key: keyof Worksheet["workflow"],
    field: keyof WorkflowRow,
    value: string | boolean
  ) {
    setWorksheet((current) => ({
      ...current,
      workflow: {
        ...current.workflow,
        [key]: { ...current.workflow[key], [field]: value },
      },
    }))
    setStatus("")
  }

  async function saveWorksheet() {
    if (!authenticated) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setStatus("Saving…")

    try {
      const response = await fetch(`/api/office-calendar-store/${STORE_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worksheet }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data?.message || "Could not save worksheet.")
      setStatus("Saved.")
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save worksheet.")
    }
  }

  function clearWorksheet() {
    if (!window.confirm("Clear every field and start a new enquiry worksheet?")) return
    setWorksheet(blankWorksheet(userInitials))
    setStatus("New worksheet ready. Save when required.")
  }

  if (!loaded) return <main className={styles.loading}>Loading worksheet…</main>

  return (
    <main className={styles.page}>
      <div className={styles.toolbar}>
        <button type="button" onClick={saveWorksheet}>Save</button>
        <button type="button" onClick={() => window.print()}>Print</button>
        <button type="button" className={styles.neutralButton} onClick={clearWorksheet}>
          New blank worksheet
        </button>
        <span role="status">{status}</span>
      </div>

      <section className={styles.sheet} aria-label="Enquiry worksheet">
        <div className={styles.topLine}>
          <label className={styles.imoField}>
            <span>IMO</span>
            <input
              value={worksheet.imo}
              onChange={(event) => updateField("imo", event.target.value)}
              aria-label="IMO number"
            />
          </label>
          <div className={styles.identityFields}>
            <input
              value={worksheet.date}
              onChange={(event) => updateField("date", event.target.value)}
              aria-label="Date"
            />
            <input
              value={worksheet.initials}
              onChange={(event) => updateField("initials", event.target.value.toUpperCase())}
              aria-label="Initials"
              maxLength={4}
            />
          </div>
        </div>

        <div className={styles.detailsTable}>
          <label>
            <span>BUYER</span>
            <input value={worksheet.buyer} onChange={(event) => updateField("buyer", event.target.value)} />
          </label>
          <label>
            <span>CREDIT USED / CL</span>
            <input value={worksheet.credit} onChange={(event) => updateField("credit", event.target.value)} />
          </label>
        </div>

        <div className={styles.workingArea}>
          <textarea
            value={worksheet.workingNotes}
            onChange={(event) => updateField("workingNotes", event.target.value)}
            aria-label="Enquiry working notes"
          />
          <fieldset className={styles.compensation}>
            <legend>UNOFFICIAL COMPENSATION?</legend>
            <label>
              <input
                type="radio"
                name="compensation"
                checked={worksheet.unofficialCompensation === "YES"}
                onChange={() => updateField("unofficialCompensation", "YES")}
              />
              YES
            </label>
            <label>
              <input
                type="radio"
                name="compensation"
                checked={worksheet.unofficialCompensation === "NO"}
                onChange={() => updateField("unofficialCompensation", "NO")}
              />
              NO
            </label>
          </fieldset>
        </div>

        <div className={styles.workflow}>
          <div className={styles.workflowHead}>
            <span />
            <span>REGISTER</span>
            <span>DRAFT</span>
            <span>APPROVAL</span>
            <span>SEND</span>
            <span>DETAIL</span>
            <span>NOTES</span>
          </div>
          {workflowLabels.map(([key, label]) => {
            const row = worksheet.workflow[key]
            return (
              <div className={styles.workflowRow} key={key}>
                <strong>{label}</strong>
                {(["register", "draft", "approval", "send"] as const).map((field) => (
                  <input
                    key={field}
                    type="checkbox"
                    checked={row[field]}
                    onChange={(event) => updateWorkflow(key, field, event.target.checked)}
                    aria-label={`${label} ${field}`}
                  />
                ))}
                <input
                  value={row.detail}
                  onChange={(event) => updateWorkflow(key, "detail", event.target.value)}
                  aria-label={`${label} detail`}
                />
                <input
                  value={row.notes}
                  onChange={(event) => updateWorkflow(key, "notes", event.target.value)}
                  aria-label={`${label} notes`}
                />
              </div>
            )
          })}
        </div>
      </section>
    </main>
  )
}
