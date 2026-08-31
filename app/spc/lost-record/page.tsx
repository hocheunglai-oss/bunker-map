"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { useSpcAuth } from "@/lib/useSpcAuth"
import { canAccessSpcPage, normaliseSpcRole } from "@/lib/spcPages"
import type { SpcEnquiryMeta } from "@/lib/spcEnquiryText"

type SpcEnquiry = {
  id: string
  title: string
  vesselName: string | null
  deliveryDate: string | null
  formattedText: string
  createdByDisplayName: string
  createdAt: string
  updatedAt: string
  meta: SpcEnquiryMeta
}

type LostReasonResponse = {
  buyerReasons?: string[]
  supplierReasons?: string[]
  message?: string
}

type ReviewDraft = {
  supplierLostReason: string
  supplierLostReasonDetails: string
  spcComments: string
}

const lostRecordColumnWidths = [
  116, // date
  128, // buyer trader
  230, // vessel
  136, // ETA
  190, // buyer reason
  228, // supplier reason
  230, // SPC comments
  82, // action
] as const

const lostRecordTableWidth = lostRecordColumnWidths.reduce((total, width) => total + width, 0)

function displayDate(value: string | null | undefined) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date).toUpperCase()
}

function reviewDraft(enquiry: SpcEnquiry): ReviewDraft {
  return {
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

export default function SpcLostRecordPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions, role } = useSpcAuth()
  const [enquiries, setEnquiries] = useState<SpcEnquiry[]>([])
  const [supplierReasons, setSupplierReasons] = useState<string[]>([])
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({})
  const [loading, setLoading] = useState(false)
  const [savingId, setSavingId] = useState("")
  const [message, setMessage] = useState("")
  const [notice, setNotice] = useState("")
  const [reasonDialogOpen, setReasonDialogOpen] = useState(false)
  const [buyerReasonDraft, setBuyerReasonDraft] = useState("")
  const [supplierReasonDraft, setSupplierReasonDraft] = useState("")
  const [savingReasonAudience, setSavingReasonAudience] = useState("")

  const normalizedRole = normaliseSpcRole(role)
  const canView = authenticated && canAccessSpcPage(permissions, "spc-lost-record", "view")
  const canReview = normalizedRole === "SUPPLIER TRADER" || normalizedRole === "ADMIN"
  const canManageReasons = normalizedRole === "ADMIN" && canAccessSpcPage(permissions, "spc-lost-record", "edit")
  const hasPermissionSnapshot = Object.prototype.hasOwnProperty.call(permissions, "spc-lost-record")

  const loadData = useCallback(async () => {
    if (!canView) return
    setLoading(true)
    setMessage("")
    try {
      const [enquiriesResponse, reasonsResponse] = await Promise.all([
        fetch("/api/spc/enquiries?status=cancelled&limit=250&scope=records", { cache: "no-store" }),
        fetch("/api/spc/lost-reasons", { cache: "no-store" }),
      ])
      const enquiryData = (await enquiriesResponse.json()) as { enquiries?: SpcEnquiry[]; message?: string }
      const reasonData = (await reasonsResponse.json()) as LostReasonResponse
      if (!enquiriesResponse.ok) throw new Error(enquiryData.message || "Failed to load lost record.")
      if (!reasonsResponse.ok) throw new Error(reasonData.message || "Failed to load lost reasons.")

      const nextEnquiries = enquiryData.enquiries || []
      const nextBuyerReasons = reasonData.buyerReasons || []
      const nextSupplierReasons = reasonData.supplierReasons || []
      setEnquiries(nextEnquiries)
      setSupplierReasons(nextSupplierReasons)
      setBuyerReasonDraft(nextBuyerReasons.join("\n"))
      setSupplierReasonDraft(nextSupplierReasons.join("\n"))
      setDrafts(Object.fromEntries(nextEnquiries.map((enquiry) => [enquiry.id, reviewDraft(enquiry)])))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load lost record.")
    } finally {
      setLoading(false)
    }
  }, [canView])

  useEffect(() => {
    document.title = "SPC LOST RECORD"
  }, [])

  useEffect(() => {
    if (!authLoading && !authenticated) router.replace("/spc")
    if (!authLoading && authenticated && hasPermissionSnapshot && !canView) router.replace("/spc")
  }, [authLoading, authenticated, canView, hasPermissionSnapshot, router])

  useEffect(() => {
    void loadData()
  }, [loadData])

  function updateReviewDraft(id: string, field: keyof ReviewDraft, value: string) {
    setDrafts((current) => ({
      ...current,
      [id]: {
        ...(current[id] || { supplierLostReason: "", supplierLostReasonDetails: "", spcComments: "" }),
        [field]: value,
        ...(field === "supplierLostReason" && value !== "OTHER" ? { supplierLostReasonDetails: "" } : {}),
      },
    }))
  }

  async function saveReview(enquiry: SpcEnquiry) {
    const draft = drafts[enquiry.id] || reviewDraft(enquiry)
    if (draft.supplierLostReason === "OTHER" && !draft.supplierLostReasonDetails.trim()) {
      setMessage("Please specify the supplier reason for OTHER.")
      return
    }
    setSavingId(enquiry.id)
    setMessage("")
    setNotice("")
    try {
      const response = await fetch("/api/spc/lost-record", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: enquiry.id, ...draft }),
      })
      const data = (await response.json()) as {
        review?: { meta?: SpcEnquiryMeta; updatedAt?: string }
        message?: string
      }
      if (!response.ok) throw new Error(data.message || "Failed to update lost record.")
      setEnquiries((current) => current.map((item) => item.id === enquiry.id
        ? { ...item, meta: data.review?.meta || item.meta, updatedAt: data.review?.updatedAt || item.updatedAt }
        : item))
      setNotice("Lost record updated.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to update lost record.")
    } finally {
      setSavingId("")
    }
  }

  async function saveReasonList(audience: "BUYER TRADER" | "SUPPLIER TRADER") {
    const reasons = cleanReasonLines(audience === "BUYER TRADER" ? buyerReasonDraft : supplierReasonDraft)
    setSavingReasonAudience(audience)
    setMessage("")
    setNotice("")
    try {
      const response = await fetch("/api/spc/lost-reasons", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audience, reasons }),
      })
      const data = (await response.json()) as { reasons?: string[]; message?: string }
      if (!response.ok) throw new Error(data.message || "Failed to update lost reasons.")
      const savedReasons = data.reasons || reasons
      if (audience === "BUYER TRADER") {
        setBuyerReasonDraft(savedReasons.join("\n"))
      } else {
        setSupplierReasons(savedReasons)
        setSupplierReasonDraft(savedReasons.join("\n"))
      }
      setNotice(`${audience === "BUYER TRADER" ? "Buyer" : "Supplier"} lost reasons updated.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to update lost reasons.")
    } finally {
      setSavingReasonAudience("")
    }
  }

  const tableRows = useMemo(() => enquiries, [enquiries])

  if (authLoading || !authenticated || !hasPermissionSnapshot || !canView) {
    return <div className="spc-loading">LOADING...</div>
  }

  return (
    <SpcShell title="SPC LOST RECORD">
      <section className="spc-panel spc-fixture-ledger-panel spc-lost-record-ledger-panel">
        <div className="spc-fixture-ledger-toolbar spc-lost-record-toolbar">
          {notice ? <span className="spc-ledger-notice">{notice}</span> : null}
          {canManageReasons ? (
            <button type="button" className="spc-fixture-refresh-button" onClick={() => setReasonDialogOpen(true)}>
              EDIT LOST REASONS
            </button>
          ) : null}
          <button type="button" className="spc-fixture-refresh-button" onClick={() => void loadData()} disabled={loading}>
            {loading ? "REFRESHING..." : "REFRESH"}
          </button>
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
                <th>ETA</th>
                <th>BUYER LOST REASON</th>
                <th>SUPPLIER LOST REASON</th>
                <th>SPC COMMENTS</th>
                <th>ACTION</th>
              </tr>
            </thead>
            <tbody>
              <tr className="spc-fixture-section-row">
                <td colSpan={8}>LOST RECORD</td>
              </tr>
              {message ? (
                <tr className="spc-fixture-status-row is-error">
                  <td colSpan={8}>{message.toUpperCase()}</td>
                </tr>
              ) : null}
              {tableRows.map((enquiry) => {
                const draft = drafts[enquiry.id] || reviewDraft(enquiry)
                const supplierReasonText = enquiry.meta?.supplierLostReason
                  ? `${enquiry.meta.supplierLostReason}${enquiry.meta.supplierLostReasonDetails ? `: ${enquiry.meta.supplierLostReasonDetails}` : ""}`
                  : "BUYER REASON ACCEPTED"
                return (
                  <tr key={enquiry.id}>
                    <td>{displayDate(enquiry.meta?.outcomeAt || enquiry.updatedAt || enquiry.createdAt)}</td>
                    <td>{enquiry.createdByDisplayName || "-"}</td>
                    <td title={enquiry.formattedText}><strong>{enquiry.vesselName || enquiry.title || "-"}</strong></td>
                    <td>{enquiry.meta?.eta || enquiry.deliveryDate || "-"}</td>
                    <td title={enquiry.meta?.lostReason || "UNKNOWN"}>{enquiry.meta?.lostReason || "UNKNOWN"}</td>
                    <td className="spc-lost-record-editor-cell">
                      {canReview ? (
                        <div className="spc-lost-record-editor">
                          <select value={draft.supplierLostReason} onChange={(event) => updateReviewDraft(enquiry.id, "supplierLostReason", event.target.value)} disabled={savingId === enquiry.id}>
                            <option value="">BUYER REASON ACCEPTED</option>
                            {supplierReasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
                          </select>
                          {draft.supplierLostReason === "OTHER" ? (
                            <input value={draft.supplierLostReasonDetails} onChange={(event) => updateReviewDraft(enquiry.id, "supplierLostReasonDetails", event.target.value)} placeholder="SPECIFY OTHER" maxLength={500} disabled={savingId === enquiry.id} />
                          ) : null}
                        </div>
                      ) : <span title={supplierReasonText}>{supplierReasonText}</span>}
                    </td>
                    <td className="spc-lost-record-editor-cell">
                      {canReview ? (
                        <input value={draft.spcComments} onChange={(event) => updateReviewDraft(enquiry.id, "spcComments", event.target.value)} placeholder="ADD SPC COMMENT" maxLength={2000} disabled={savingId === enquiry.id} />
                      ) : <span title={enquiry.meta?.spcComments || ""}>{enquiry.meta?.spcComments || "-"}</span>}
                    </td>
                    <td>
                      {canReview ? (
                        <button type="button" className="spc-fixture-save-button" onClick={() => void saveReview(enquiry)} disabled={savingId === enquiry.id}>
                          {savingId === enquiry.id ? "SAVING" : "SAVE"}
                        </button>
                      ) : "-"}
                    </td>
                  </tr>
                )
              })}
              {!loading && enquiries.length === 0 ? (
                <tr className="spc-fixture-empty-row"><td colSpan={8}>No lost enquiries yet.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {reasonDialogOpen ? (
        <div className="spc-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setReasonDialogOpen(false)
        }}>
          <div className="spc-dialog spc-lost-reasons-dialog" role="dialog" aria-modal="true" aria-labelledby="spc-lost-reasons-title">
            <div className="spc-dialog-header">
              <h2 id="spc-lost-reasons-title">EDIT LOST REASONS</h2>
              <button type="button" aria-label="Close" onClick={() => setReasonDialogOpen(false)}>×</button>
            </div>
            <div className="spc-lost-reasons-grid">
              <label>
                <span>BUYER TRADER REASONS</span>
                <textarea value={buyerReasonDraft} onChange={(event) => setBuyerReasonDraft(event.target.value)} rows={12} spellCheck={false} />
                <small>ONE REASON PER LINE</small>
                <button type="button" className="spc-blue-action" onClick={() => void saveReasonList("BUYER TRADER")} disabled={Boolean(savingReasonAudience)}>
                  {savingReasonAudience === "BUYER TRADER" ? "SAVING..." : "SAVE BUYER REASONS"}
                </button>
              </label>
              <label>
                <span>SUPPLIER TRADER REASONS</span>
                <textarea value={supplierReasonDraft} onChange={(event) => setSupplierReasonDraft(event.target.value)} rows={12} spellCheck={false} />
                <small>ONE REASON PER LINE. OTHER IS REQUIRED.</small>
                <button type="button" className="spc-blue-action" onClick={() => void saveReasonList("SUPPLIER TRADER")} disabled={Boolean(savingReasonAudience)}>
                  {savingReasonAudience === "SUPPLIER TRADER" ? "SAVING..." : "SAVE SUPPLIER REASONS"}
                </button>
              </label>
            </div>
            <div className="spc-dialog-actions">
              <button type="button" onClick={() => setReasonDialogOpen(false)}>DONE</button>
            </div>
          </div>
        </div>
      ) : null}
    </SpcShell>
  )
}
