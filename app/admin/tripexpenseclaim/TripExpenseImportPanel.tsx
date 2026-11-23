"use client"

import { useEffect, useRef, useState, type ChangeEvent } from "react"
import { RECEIPT_TYPES } from "@/lib/tripExpenseClaim"
import { TRIP_IMPORT_SECTION, type PreparedTripClaim } from "@/lib/tripExpenseImport"
import { prepareTripUpload } from "@/lib/tripExpenseUpload"
import styles from "./tripExpense.module.css"

const accept = [".zip", ".xlsx", ...Object.keys(RECEIPT_TYPES).map(type => "." + type)].join(",")
type ImportReport = { count: number; issues: string[] }

export function TripExpenseImportPanel({
  disabled, reviewed, allowReplace, onBusy, onPrepared, onReviewed,
}: {
  disabled: boolean
  reviewed: boolean
  allowReplace: () => boolean
  onBusy: (busy: boolean) => void
  onPrepared: (draft: PreparedTripClaim, receipts: Map<string, File>) => void
  onReviewed: (reviewed: boolean) => void
}) {
  const [progress, setProgress] = useState("")
  const [report, setReport] = useState<ImportReport | null>(null)
  const [error, setError] = useState("")
  const preparing = useRef<AbortController | null>(null)

  useEffect(() => () => preparing.current?.abort(), [])

  async function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ""
    if (!files.length || preparing.current || !allowReplace()) return
    const controller = new AbortController()
    preparing.current = controller
    setError("")
    setProgress("Reading files…")
    onBusy(true)
    try {
      const { draft, receipts } = await prepareTripUpload(files, controller.signal, (done, total) => {
        if (!controller.signal.aborted) setProgress("Reading documents " + done + "/" + total + "…")
      })
      if (controller.signal.aborted) return
      if (!draft.items.length) throw new Error(draft.issues.join(" ") || "No expenses found. Check the files or enter the claim manually.")
      onPrepared(draft, receipts)
      setReport({ count: draft.items.length, issues: draft.issues })
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not prepare the claim. Try again.")
    } finally {
      preparing.current = null
      if (!controller.signal.aborted) {
        setProgress("")
        onBusy(false)
      }
    }
  }

  return (
    <section id={TRIP_IMPORT_SECTION} className={styles.importPanel} aria-labelledby="trip-import-heading">
      <div className={styles.importToolbar}>
        <div>
          <h2 id="trip-import-heading">Prepare from Upload</h2>
          <p>Upload a ZIP, Excel form or receipts. OpenAI reads receipt files.</p>
        </div>
        <label className={styles.fileButton} data-disabled={Boolean(progress) || disabled}>
          <span>Choose Files</span>
          <input type="file" multiple accept={accept} aria-label="Choose claim files"
            disabled={Boolean(progress) || disabled} onChange={chooseFiles} />
        </label>
      </div>
      <p className={styles.importStatus} role="status">
        {progress || (report ? report.count + (report.count === 1 ? " expense prepared" : " expenses prepared") : "")}
      </p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {report?.issues.length ? (
        <details className={styles.importReview} open>
          <summary>Review {report.issues.length} {report.issues.length === 1 ? "note" : "notes"}</summary>
          <ul>{report.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>
          <label className={styles.importConfirm}>
            <input type="checkbox" checked={reviewed} required disabled={disabled || Boolean(progress)}
              onChange={event => onReviewed(event.target.checked)} />
            I reviewed the imported expenses
          </label>
        </details>
      ) : null}
    </section>
  )
}
