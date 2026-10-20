"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { useSpcAuth } from "@/lib/useSpcAuth"
import { canAccessSpcPage, normaliseSpcRole } from "@/lib/spcPages"
import type { SpcEnquiryMeta } from "@/lib/spcEnquiryText"
import { SpcRecordPageError, spcRecordTimestampMicros, type SpcLostRecordEnquiry as SpcEnquiry } from "@/lib/spcRecordPageResponse"
import { fetchSpcRecordJson, useSpcRecordPageRead } from "@/lib/useSpcRecordPageRead"
import styles from "../record-pages.module.css"


type ReviewDraft = {
  expectedUpdatedAt: string
  supplierLostReason: string
  supplierLostReasonDetails: string
  spcComments: string
}

const lostRecordColumnWidths = [
  116, // date
  128, // buyer trader
  230, // vessel
  90, // IMO
  136, // ETA
  190, // buyer reason
  228, // supplier reason
  230, // SPC comments
  82, // action
] as const

const lostRecordColumnSpan = lostRecordColumnWidths.length
const lostRecordTableWidth = lostRecordColumnWidths.reduce((total, width) => total + width, 0)

function displayDate(value: string | null | undefined) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date).toUpperCase()
}

function reviewDraft(enquiry: SpcEnquiry): ReviewDraft {
  return {
    expectedUpdatedAt: enquiry.updatedAt,
    supplierLostReason: enquiry.meta?.supplierLostReason || "",
    supplierLostReasonDetails: enquiry.meta?.supplierLostReasonDetails || "",
    spcComments: enquiry.meta?.spcComments || "",
  }
}

function cleanReasonLines(value: string) {
  return Array.from(
    new Set(
      value
        .split("\n")
        .map((reason) => reason.trim().replace(/\s+/g, " ").toUpperCase())
        .filter(Boolean),
    ),
  )
}

function reasons(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(reason => typeof reason !== "string" || !reason.trim())) throw new Error("Lost reasons could not be verified. Your reason drafts are kept.")
  return value
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The response could not be verified. Your drafts are kept.")
  return value as Record<string, unknown>
}

export default function SpcLostRecordPage() {
  const auth = useSpcAuth()
  // A changed authorization owner gets a fresh editor, not the previous user's
  // state for one render. Read/write cancellation remains a separate boundary.
  return <LostRecordContents key={JSON.stringify([auth.loading, auth.authenticated, auth.actorKey, auth.username, auth.role, auth.office, auth.permissions["spc-lost-record"]])} />
}

function LostRecordContents() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions, role, actorKey, username, office } = useSpcAuth()
  const [supplierReasons, setSupplierReasons] = useState<string[]>([])
  const [draftState, setDraftState] = useState<{ readSequence: number; values: Record<string, ReviewDraft> }>({ readSequence: 0, values: {} })
  const [savingId, setSavingId] = useState("")
  const [reviewRefreshAfter, setReviewRefreshAfter] = useState<number | null>(null)
  const savingIdRef = useRef("")
  const [message, setMessage] = useState("")
  const [notice, setNotice] = useState("")
  const [reasonDialogOpen, setReasonDialogOpen] = useState(false)
  const [buyerReasonDraft, setBuyerReasonDraft] = useState("")
  const [supplierReasonDraft, setSupplierReasonDraft] = useState("")
  const [savingReasonAudience, setSavingReasonAudience] = useState("")
  const [reasonError, setReasonError] = useState("")
  const [reasonBaseline, setReasonBaseline] = useState({ buyer: "", supplier: "" })
  const [reasonsVerified, setReasonsVerified] = useState(false)
  const [reasonsLoading, setReasonsLoading] = useState(false)
  const [reasonReload, setReasonReload] = useState(0)
  const reasonSavingRef = useRef("")
  const requests = useRef(new Set<AbortController>())
  const actionSequence = useRef(0)

  const normalizedRole = normaliseSpcRole(role)
  const canView = authenticated && canAccessSpcPage(permissions, "spc-lost-record", "view")
  const canReview = normalizedRole === "SUPPLIER TRADER" || normalizedRole === "ADMIN"
  const canManageReasons = normalizedRole === "ADMIN" && canAccessSpcPage(permissions, "spc-lost-record", "edit")
  const hasPermissionSnapshot = Object.prototype.hasOwnProperty.call(permissions, "spc-lost-record")
  const owner = !authLoading && canView && hasPermissionSnapshot
    ? JSON.stringify([actorKey, username, role, office, permissions["spc-lost-record"]]) : null
  const ownerRef = useRef(owner)
  const records = useSpcRecordPageRead("lost", owner)
  const enquiries = records.page?.enquiries || []
  const drafts = draftState.readSequence === records.readSequence ? draftState.values : {}
  const loading = records.loading
  const reviewNeedsRefresh = reviewRefreshAfter !== null && records.readSequence <= reviewRefreshAfter
  const busy = Boolean(savingId || savingReasonAudience)
  const dirtyReviews = enquiries.some(enquiry => {
    const draft = drafts[enquiry.id], saved = reviewDraft(enquiry)
    return draft && (draft.supplierLostReason !== saved.supplierLostReason || draft.supplierLostReasonDetails !== saved.supplierLostReasonDetails || draft.spcComments !== saved.spcComments)
  })
  const dirtyReasons = buyerReasonDraft !== reasonBaseline.buyer || supplierReasonDraft !== reasonBaseline.supplier
  const dirtyRef = useRef(false)
  useLayoutEffect(() => { dirtyRef.current = dirtyReviews || dirtyReasons }, [dirtyReviews, dirtyReasons])

  useEffect(() => {
    document.title = "SPC LOST RECORD"
  }, [])

  useEffect(() => {
    if (!authLoading && !authenticated) router.replace("/spc")
    if (!authLoading && authenticated && hasPermissionSnapshot && !canView) router.replace("/spc")
  }, [authLoading, authenticated, canView, hasPermissionSnapshot, router])

  useEffect(() => {
    ownerRef.current = owner
    const pendingRequests = requests.current
    return () => { ownerRef.current = null; for (const request of pendingRequests) request.abort(); pendingRequests.clear() }
  }, [owner])

  useEffect(() => {
    if (!owner) return
    const sequence = actionSequence.current
    let active = true
    const controller = new AbortController()
    const pendingRequests = requests.current
    pendingRequests.add(controller)
    const owns = () => active && ownerRef.current === owner && sequence === actionSequence.current
    void (async () => {
      setReasonsLoading(true); setReasonError("")
      try {
        const data = object(await fetchSpcRecordJson("/api/spc/lost-reasons", {}, controller.signal))
        const buyer = reasons(data.buyerReasons), supplier = reasons(data.supplierReasons)
        if (!owns()) return
        setSupplierReasons(supplier); setBuyerReasonDraft(buyer.join("\n")); setSupplierReasonDraft(supplier.join("\n"))
        setReasonBaseline({ buyer: buyer.join("\n"), supplier: supplier.join("\n") }); setReasonsVerified(true)
      } catch (error) {
        if (!owns()) return
        if (error instanceof SpcRecordPageError && (error.status === 401 || error.status === 403)) records.deny()
        else setReasonError("Lost reasons are unavailable. Refresh this page before editing reasons or reviews.")
      } finally { pendingRequests.delete(controller); if (owns()) setReasonsLoading(false) }
    })()
    return () => { active = false; controller.abort(); pendingRequests.delete(controller) }
    // The reason-list lifecycle is owned by the session, not record-page reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, reasonReload])

  useEffect(() => {
    const click = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element) || !target.closest("a[href]")) return
      if (savingIdRef.current || reasonSavingRef.current) {
        event.preventDefault(); event.stopPropagation(); setMessage("Wait for the current save to finish before leaving this page.")
      } else if (dirtyRef.current && !window.confirm("Discard your unsaved record and reason changes and leave this page?")) {
        event.preventDefault(); event.stopPropagation()
      }
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current || savingIdRef.current || reasonSavingRef.current) { event.preventDefault(); event.returnValue = "" }
    }
    document.addEventListener("click", click, true)
    window.addEventListener("beforeunload", beforeUnload)
    return () => { document.removeEventListener("click", click, true); window.removeEventListener("beforeunload", beforeUnload) }
  }, [])

  function updateReviewDraft(id: string, field: Exclude<keyof ReviewDraft, "expectedUpdatedAt">, value: string) {
    const enquiry = enquiries.find(item => item.id === id)
    if (!enquiry) return
    setDraftState((state) => {
      const current = state.readSequence === records.readSequence ? state.values : {}
      return { readSequence: records.readSequence, values: { ...current, [id]: {
        ...(current[id] || reviewDraft(enquiry)),
        [field]: value,
        ...(field === "supplierLostReason" && value !== "OTHER" ? { supplierLostReasonDetails: "" } : {}),
      } } }
    })
  }

  async function saveReview(enquiry: SpcEnquiry) {
    if (!owner || ownerRef.current !== owner || !canReview || !reasonsVerified || reviewNeedsRefresh || savingIdRef.current || reasonSavingRef.current || loading) return
    const draft = drafts[enquiry.id] || reviewDraft(enquiry)
    if (draft.supplierLostReason === "OTHER" && !draft.supplierLostReasonDetails.trim()) {
      setMessage("Please specify the supplier reason for OTHER.")
      return
    }
    savingIdRef.current = enquiry.id
    records.cancelRead()
    const capturedOwner = owner, sequence = actionSequence.current, controller = new AbortController()
    requests.current.add(controller)
    const owns = () => ownerRef.current === capturedOwner && sequence === actionSequence.current
    setSavingId(enquiry.id)
    setMessage("")
    setNotice("")
    try {
      const data = object(await fetchSpcRecordJson("/api/spc/lost-record", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: enquiry.id, ...draft }),
      }, controller.signal))
      if (!owns()) return
      const review = object(data.review), meta = object(review.meta)
      if (data.success !== true || review.id !== enquiry.id || Object.values(meta).some(value => typeof value !== "string") || typeof review.updatedAt !== "string" || spcRecordTimestampMicros(review.updatedAt) <= spcRecordTimestampMicros(draft.expectedUpdatedAt) ||
        (meta.supplierLostReason || "") !== draft.supplierLostReason.trim().replace(/\s+/g, " ").toUpperCase().slice(0, 160) ||
        (meta.supplierLostReasonDetails || "") !== draft.supplierLostReasonDetails.trim() || (meta.spcComments || "") !== draft.spcComments.trim()) {
        throw new Error("The saved record could not be verified. Your draft is kept. Refresh and review the record before saving again.")
      }
      const saved = { ...enquiry, meta: meta as SpcEnquiryMeta, updatedAt: review.updatedAt }
      records.updateRows((current) => current.map((item) => item.id === enquiry.id
        ? { ...item, meta: saved.meta, updatedAt: saved.updatedAt }
        : item))
      setDraftState((state) => {
        const current = state.readSequence === records.readSequence ? state.values : {}
        return { readSequence: records.readSequence, values: { ...current, [enquiry.id]: current[enquiry.id] && JSON.stringify(current[enquiry.id]) !== JSON.stringify(draft)
          ? { ...current[enquiry.id], expectedUpdatedAt: saved.updatedAt } : reviewDraft(saved) } }
      })
      setMessage("")
      setNotice("Lost record updated.")
    } catch (error) {
      if (!owns()) return
      if (error instanceof SpcRecordPageError && (error.status === 401 || error.status === 403)) records.deny()
      else {
        setReviewRefreshAfter(records.readSequence)
        records.invalidateNavigation()
        setMessage(error instanceof SpcRecordPageError ? error.message : "The saved record could not be verified. Your draft is kept. Refresh and review the record before saving again.")
      }
    } finally {
      requests.current.delete(controller)
      if (owns()) { savingIdRef.current = ""; setSavingId("") }
    }
  }

  function navigateRecords(action: () => void) {
    if (savingIdRef.current || reasonSavingRef.current || loading) return
    if (dirtyReviews && !window.confirm("Discard your unsaved lost-record changes and load the requested page?")) return
    setMessage(""); setNotice("")
    action()
  }

  async function saveReasonList(audience: "BUYER TRADER" | "SUPPLIER TRADER") {
    if (!owner || ownerRef.current !== owner || !canManageReasons || !reasonsVerified || savingIdRef.current || reasonSavingRef.current || loading) return
    const captured = audience === "BUYER TRADER" ? buyerReasonDraft : supplierReasonDraft
    const nextReasons = cleanReasonLines(captured)
    if (!nextReasons.length || nextReasons.length > 50 || nextReasons.some(value => value.length > 160) || (audience === "SUPPLIER TRADER" && !nextReasons.includes("OTHER"))) {
      setReasonError("Enter 1–50 reasons, up to 160 characters each. Supplier reasons must include OTHER.")
      return
    }
    const capturedOwner = owner, sequence = actionSequence.current, controller = new AbortController()
    const owns = () => ownerRef.current === capturedOwner && sequence === actionSequence.current
    reasonSavingRef.current = audience
    requests.current.add(controller)
    records.cancelRead()
    setSavingReasonAudience(audience)
    setReasonError("")
    setNotice("")
    try {
      const data = object(await fetchSpcRecordJson("/api/spc/lost-reasons", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audience, reasons: nextReasons }),
      }, controller.signal))
      if (!owns()) return
      const savedReasons = reasons(data.reasons)
      if (data.success !== true || JSON.stringify(savedReasons) !== JSON.stringify(nextReasons)) throw new Error("Lost reasons could not be verified.")
      if (audience === "BUYER TRADER") {
        setBuyerReasonDraft(current => current === captured ? savedReasons.join("\n") : current)
        setReasonBaseline(current => ({ ...current, buyer: savedReasons.join("\n") }))
      } else {
        setSupplierReasons(savedReasons)
        setSupplierReasonDraft(current => current === captured ? savedReasons.join("\n") : current)
        setReasonBaseline(current => ({ ...current, supplier: savedReasons.join("\n") }))
      }
      setNotice(`${audience === "BUYER TRADER" ? "Buyer" : "Supplier"} lost reasons updated.`)
    } catch (error) {
      if (!owns()) return
      if (error instanceof SpcRecordPageError && (error.status === 401 || error.status === 403)) records.deny()
      else {
        // An uncertain write may already have reached the server. Only a
        // successfully verified reason read can make another write safe.
        setReasonsVerified(false)
        setReasonError(error instanceof SpcRecordPageError ? error.message : "Lost reasons could not be verified. Your reason drafts are kept.")
      }
    } finally {
      requests.current.delete(controller)
      if (owns()) { reasonSavingRef.current = ""; setSavingReasonAudience("") }
    }
  }

  function closeReasonDialog() {
    if (reasonSavingRef.current) return
    if ((buyerReasonDraft !== reasonBaseline.buyer || supplierReasonDraft !== reasonBaseline.supplier) && !window.confirm("Close this editor? Unsaved reason drafts will be kept on this page.")) return
    setReasonDialogOpen(false)
  }

  function retryReasons() {
    if (savingIdRef.current || reasonSavingRef.current || reasonsLoading) return
    if (dirtyReasons && !window.confirm("Discard your unsaved reason changes and reload the lost reasons?")) return
    setReasonReload(current => current + 1)
  }

  if (authLoading || !authenticated || !hasPermissionSnapshot || !canView) {
    return <div className="spc-loading">LOADING...</div>
  }
  if (records.denied) return <div className="spc-alert is-error" role="alert">{records.error}</div>

  return (
    <SpcShell title="SPC LOST RECORD">
      <section className="spc-panel spc-fixture-ledger-panel spc-lost-record-ledger-panel">
        <div className="spc-fixture-ledger-toolbar spc-lost-record-toolbar">
          {notice ? <span className="spc-ledger-notice">{notice}</span> : null}
          {canManageReasons ? (
            <button type="button" className="spc-fixture-refresh-button" onClick={() => setReasonDialogOpen(true)} disabled={busy || !reasonsVerified}>
              EDIT LOST REASONS
            </button>
          ) : null}
          <button type="button" className="spc-fixture-refresh-button" onClick={() => navigateRecords(() => { void records.refresh() })} disabled={loading || busy}>
            {loading ? "REFRESHING..." : "REFRESH"}
          </button>
        </div>
        {message || records.error || (!reasonDialogOpen && reasonError) ? <div className="spc-alert is-error" role="alert">{(message || records.error || reasonError).toUpperCase()}</div> : null}
        <div className={styles.controls} aria-label="Record pages">
          <span className={styles.summary}>{records.page ? `${records.page.totalCount} lost enquiries · Page ${records.page.pageIndex} of ${records.page.pageCount} · ${enquiries.length} on this page` : loading ? "Loading the complete record page..." : "Records are unavailable. Refresh to try again."}</span>
          <button type="button" onClick={() => navigateRecords(records.previous)} disabled={loading || busy || records.navigationStale || !records.page || records.page.pageIndex <= 1}>PREVIOUS PAGE</button>
          <button type="button" onClick={() => navigateRecords(records.next)} disabled={loading || busy || records.navigationStale || !records.page?.nextCursor}>NEXT PAGE</button>
          {records.page ? <span>Last verified {new Date(records.page.checkedAt).toLocaleString("en-GB", { timeZone: "Asia/Hong_Kong" })} HKT</span> : null}
          {reasonError ? <button type="button" onClick={retryReasons} disabled={busy || reasonsLoading}>RETRY LOST REASONS</button> : null}
          {reviewNeedsRefresh ? <p className={styles.warning}>The last save result is unverified. Refresh successfully before saving again or changing pages. Your drafts are kept until then.</p> : records.navigationStale ? <p className={styles.warning}>A record was updated. Refresh before changing pages. Other unsaved drafts are kept.</p> : null}
        </div>
        <div className="spc-table-wrap">
          <table className="spc-table spc-fixture-table spc-lost-record-table" style={{ width: lostRecordTableWidth, minWidth: lostRecordTableWidth }}>
            <colgroup>
              {lostRecordColumnWidths.map((width, index) => (
                <col key={`${width}-${index}`} style={{ width }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th>DATE</th>
                <th>BUYER TRADER</th>
                <th>VESSEL NAME</th>
                <th>IMO</th>
                <th>ETA</th>
                <th>BUYER LOST REASON</th>
                <th>SUPPLIER LOST REASON</th>
                <th>SPC COMMENTS</th>
                <th>ACTION</th>
              </tr>
            </thead>
            <tbody>
              <tr className="spc-fixture-section-row">
                <td colSpan={lostRecordColumnSpan}>LOST RECORD</td>
              </tr>
              {enquiries.map((enquiry) => {
                const draft = drafts[enquiry.id] || reviewDraft(enquiry)
                const supplierReasonText = enquiry.meta?.supplierLostReason
                  ? `${enquiry.meta.supplierLostReason}${enquiry.meta.supplierLostReasonDetails ? `: ${enquiry.meta.supplierLostReasonDetails}` : ""}`
                  : "BUYER REASON ACCEPTED"
                return (
                  <tr key={enquiry.id}>
                    <td>{displayDate(enquiry.meta?.outcomeAt || enquiry.updatedAt || enquiry.createdAt)}</td>
                    <td>{enquiry.createdByDisplayName || "-"}</td>
                    <td title={enquiry.formattedText}><strong>{enquiry.vesselName || enquiry.title || "-"}</strong></td>
                    <td>{enquiry.meta?.imo || "-"}</td>
                    <td>{enquiry.meta?.eta || enquiry.deliveryDate || "-"}</td>
                    <td title={enquiry.meta?.lostReason || "UNKNOWN"}>{enquiry.meta?.lostReason || "UNKNOWN"}</td>
                    <td className="spc-lost-record-editor-cell">
                      {canReview ? (
                        <div className="spc-lost-record-editor">
                          <select value={draft.supplierLostReason} onChange={(event) => updateReviewDraft(enquiry.id, "supplierLostReason", event.target.value)} disabled={busy || loading || !reasonsVerified}>
                            <option value="">BUYER REASON ACCEPTED</option>
                            {supplierReasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
                          </select>
                          {draft.supplierLostReason === "OTHER" ? (
                            <input value={draft.supplierLostReasonDetails} onChange={(event) => updateReviewDraft(enquiry.id, "supplierLostReasonDetails", event.target.value)} placeholder="SPECIFY OTHER" maxLength={500} disabled={busy || loading || !reasonsVerified} />
                          ) : null}
                        </div>
                      ) : <span title={supplierReasonText}>{supplierReasonText}</span>}
                    </td>
                    <td className="spc-lost-record-editor-cell">
                      {canReview ? (
                        <input value={draft.spcComments} onChange={(event) => updateReviewDraft(enquiry.id, "spcComments", event.target.value)} placeholder="ADD SPC COMMENT" maxLength={2000} disabled={busy || loading || !reasonsVerified} />
                      ) : <span title={enquiry.meta?.spcComments || ""}>{enquiry.meta?.spcComments || "-"}</span>}
                    </td>
                    <td>
                      {canReview ? (
                        <button type="button" className="spc-fixture-save-button" onClick={() => void saveReview(enquiry)} disabled={busy || loading || !reasonsVerified || reviewNeedsRefresh}>
                          {savingId === enquiry.id ? "SAVING" : "SAVE"}
                        </button>
                      ) : "-"}
                    </td>
                  </tr>
                )
              })}
              {!loading && records.page && !records.error && enquiries.length === 0 ? (
                <tr className="spc-fixture-empty-row"><td colSpan={lostRecordColumnSpan}>No lost enquiries yet.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {reasonDialogOpen ? (
        <div className="spc-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeReasonDialog()
        }}>
          <div className={`spc-dialog spc-lost-reasons-dialog ${styles.reasonDialog}`} role="dialog" aria-modal="true" aria-labelledby="spc-lost-reasons-title">
            <div className="spc-dialog-header">
              <h2 id="spc-lost-reasons-title">EDIT LOST REASONS</h2>
              <button type="button" aria-label="Close" disabled={busy} onClick={closeReasonDialog}>×</button>
            </div>
            {reasonError ? <div className="spc-alert is-error" role="alert">{reasonError}</div> : null}
            {reasonError ? <button type="button" onClick={retryReasons} disabled={busy || reasonsLoading}>RETRY LOST REASONS</button> : null}
            <div className="spc-lost-reasons-grid">
              <label>
                <span>BUYER TRADER REASONS</span>
                <textarea value={buyerReasonDraft} onChange={(event) => setBuyerReasonDraft(event.target.value)} rows={12} spellCheck={false} disabled={busy} />
                <small>ONE REASON PER LINE</small>
                <button type="button" className="spc-blue-action" onClick={() => void saveReasonList("BUYER TRADER")} disabled={busy || loading || reasonsLoading || !reasonsVerified}>
                  {savingReasonAudience === "BUYER TRADER" ? "SAVING..." : "SAVE BUYER REASONS"}
                </button>
              </label>
              <label>
                <span>SUPPLIER TRADER REASONS</span>
                <textarea value={supplierReasonDraft} onChange={(event) => setSupplierReasonDraft(event.target.value)} rows={12} spellCheck={false} disabled={busy} />
                <small>ONE REASON PER LINE. OTHER IS REQUIRED.</small>
                <button type="button" className="spc-blue-action" onClick={() => void saveReasonList("SUPPLIER TRADER")} disabled={busy || loading || reasonsLoading || !reasonsVerified}>
                  {savingReasonAudience === "SUPPLIER TRADER" ? "SAVING..." : "SAVE SUPPLIER REASONS"}
                </button>
              </label>
            </div>
            <div className="spc-dialog-actions">
              <button type="button" disabled={busy} onClick={closeReasonDialog}>DONE</button>
            </div>
          </div>
        </div>
      ) : null}
    </SpcShell>
  )
}
