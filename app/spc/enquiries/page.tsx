"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { useSpcAuth } from "@/lib/useSpcAuth"
import { canAccessSpcPage } from "@/lib/spcPages"
import {
  buildSpcStandardEnquiry,
  cleanSpcEnquiryText,
  cleanSpcFuelValue,
  parseSpcEnquiryText,
  writeSpcEnquiryNotes,
  type ParsedSpcEnquiry,
  type SpcEnquiryMeta,
} from "@/lib/spcEnquiryText"

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

type DraftEnquiry = ParsedSpcEnquiry & {
  standardText: string
}

type OutcomeDraft = {
  id: string
  type: "stem" | "lost"
  lostReason: string
  supplierTraderUsername: string
}

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

function statusLabel(status: string) {
  if (status === "quoted") return "STEM"
  if (status === "cancelled") return "LOST"
  return status || "sent"
}

function standardTextForDraft(draft: Pick<DraftEnquiry, "vesselName" | "imo" | "eta" | "hsfo" | "vlsfo" | "lsmgo" | "remarks">) {
  return buildSpcStandardEnquiry(draft)
}

function normaliseDraft(rawText: string): DraftEnquiry {
  const parsed = parseSpcEnquiryText(rawText)
  return {
    ...parsed,
    standardText: parsed.standardText,
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
  return status === "quoted" || status === "cancelled"
}

export default function SpcEnquiriesPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions } = useSpcAuth()
  const [draft, setDraft] = useState<DraftEnquiry>(emptyDraft)
  const [enquiries, setEnquiries] = useState<SpcEnquiry[]>([])
  const [supplierTraders, setSupplierTraders] = useState<SupplierTrader[]>([])
  const [outcomeDraft, setOutcomeDraft] = useState<OutcomeDraft | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [updatingId, setUpdatingId] = useState("")
  const [message, setMessage] = useState("")
  const [messageIsError, setMessageIsError] = useState(false)

  const canView = authenticated && canAccessSpcPage(permissions, "spc-buyer-enquiries", "view")
  const canEdit = authenticated && canAccessSpcPage(permissions, "spc-buyer-enquiries", "edit")
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

  const loadEnquiries = useCallback(async () => {
    if (!canView) return
    setLoading(true)
    try {
      const response = await fetch("/api/spc/enquiries?limit=200", { cache: "no-store" })
      const data = (await response.json()) as EnquiriesResponse
      if (!response.ok) throw new Error(data.message || "Failed to load enquiries.")
      setEnquiries(data.enquiries || [])
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load enquiries.")
      setMessageIsError(true)
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
      setMessage(error instanceof Error ? error.message : "Failed to load supplier traders.")
      setMessageIsError(true)
    }
  }, [canEdit])

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

  function updateDraft(key: keyof DraftEnquiry, value: string) {
    setDraft((current) => {
      const next = { ...current, [key]: value }
      if (key === "rawText") return normaliseDraft(value)
      if (key !== "standardText") {
        if (key === "hsfo") next.hsfo = cleanSpcFuelValue(value, "hsfo")
        if (key === "vlsfo") next.vlsfo = cleanSpcFuelValue(value, "vlsfo")
        if (key === "lsmgo") next.lsmgo = cleanSpcFuelValue(value, "lsmgo")
        next.standardText = standardTextForDraft(next)
        next.title = [next.vesselName || "new enquiry", next.eta]
          .filter(Boolean)
          .join(" / ")
      }
      return next
    })
  }

  async function sendEnquiry(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canEdit) return
    setSaving(true)
    setMessage("")

    const standardText = cleanSpcEnquiryText(draft.standardText || draft.rawText)
    const hasFuel = Boolean(draft.hsfo || draft.vlsfo || draft.lsmgo)
    if (!draft.vesselName.trim() || !draft.imo.trim() || !draft.eta.trim() || !hasFuel) {
      setMessage("VESSEL, IMO, ETA and at least one fuel are required.")
      setMessageIsError(true)
      setSaving(false)
      return
    }

    const payload = {
      title: draft.title || draft.vesselName || standardText.slice(0, 80),
      vesselName: draft.vesselName,
      product: [draft.hsfo && `hsfo ${draft.hsfo}`, draft.vlsfo && `vlsfo ${draft.vlsfo}`, draft.lsmgo && `lsmgo ${draft.lsmgo}`]
        .filter(Boolean)
        .join(" / "),
      notes: writeSpcEnquiryNotes(standardText, {
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
      setDraft(emptyDraft)
      setEnquiries((current) => [data.enquiry!, ...current])
      setMessage("Enquiry sent.")
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to send enquiry.")
      setMessageIsError(true)
    } finally {
      setSaving(false)
    }
  }

  function openOutcome(enquiry: SpcEnquiry, type: "stem" | "lost") {
    setMessage("")
    setOutcomeDraft({
      id: enquiry.id,
      type,
      lostReason: LOST_REASONS[0],
      supplierTraderUsername: supplierTraders[0]?.username || "",
    })
  }

  async function confirmOutcome() {
    if (!canEdit || !outcomeDraft) return
    const supplierTrader = supplierTraders.find(
      (user) => user.username === outcomeDraft.supplierTraderUsername,
    )
    setUpdatingId(outcomeDraft.id)
    setMessage("")
    try {
      const response = await fetch("/api/spc/enquiries", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: outcomeDraft.id,
          outcome: outcomeDraft.type,
          lostReason: outcomeDraft.type === "lost" ? outcomeDraft.lostReason : "",
          supplierTraderUsername:
            outcomeDraft.type === "stem" ? outcomeDraft.supplierTraderUsername : "",
          supplierTraderDisplayName: outcomeDraft.type === "stem" ? supplierTrader?.displayName || "" : "",
        }),
      })
      const data = (await response.json()) as { enquiry?: SpcEnquiry; message?: string }
      if (!response.ok || !data.enquiry) {
        throw new Error(data.message || "Failed to update enquiry.")
      }
      setEnquiries((current) =>
        current.map((enquiry) => (enquiry.id === outcomeDraft.id ? data.enquiry! : enquiry)),
      )
      setOutcomeDraft(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to update enquiry.")
      setMessageIsError(true)
    } finally {
      setUpdatingId("")
    }
  }

  function matchesFor(enquiry: SpcEnquiry) {
    const key = normaliseVesselName(enquiry.vesselName || enquiry.title)
    if (!key) return []
    return (outcomeMatchesByVessel.get(key) || []).filter((match) => match.id !== enquiry.id)
  }

  if (authLoading || !canView) {
    return <div className="spc-loading">Loading...</div>
  }

  return (
    <SpcShell title="SPC Enquiries">
      {message ? (
        <div className={messageIsError ? "spc-alert is-error" : "spc-alert"}>
          {message}
        </div>
      ) : null}

      <div className="spc-enquiries-layout">
        <section className="spc-panel spc-enquiry-entry-panel">
          <div className="spc-panel-header">
            <h2>New Enquiry</h2>
            <button type="button" onClick={() => setDraft(emptyDraft)} disabled={!canEdit || saving}>
              Clear
            </button>
          </div>
          <form onSubmit={sendEnquiry} className="spc-enquiry-entry-form">
            <label className="spc-enquiry-raw">
              <span>Paste Your Enquiry Here</span>
              <textarea
                value={draft.rawText}
                onChange={(event) => updateDraft("rawText", event.target.value)}
                placeholder=""
                rows={4}
                disabled={!canEdit}
              />
            </label>
            <div className="spc-enquiry-fields">
              <label>
                <span>Vessel</span>
                <input value={draft.vesselName} onChange={(event) => updateDraft("vesselName", event.target.value)} disabled={!canEdit} required />
              </label>
              <label>
                <span>IMO</span>
                <input value={draft.imo} onChange={(event) => updateDraft("imo", event.target.value)} disabled={!canEdit} required />
              </label>
              <label>
                <span>ETA</span>
                <input value={draft.eta} onChange={(event) => updateDraft("eta", event.target.value)} disabled={!canEdit} required />
              </label>
              <label>
                <span>HSFO</span>
                <input value={draft.hsfo} onChange={(event) => updateDraft("hsfo", event.target.value)} disabled={!canEdit} />
              </label>
              <label>
                <span>VLSFO</span>
                <input value={draft.vlsfo} onChange={(event) => updateDraft("vlsfo", event.target.value)} disabled={!canEdit} />
              </label>
              <label>
                <span>LSMGO</span>
                <input value={draft.lsmgo} onChange={(event) => updateDraft("lsmgo", event.target.value)} disabled={!canEdit} />
              </label>
              <label className="spc-enquiry-remarks">
                <span>Remarks</span>
                <input value={draft.remarks} onChange={(event) => updateDraft("remarks", event.target.value)} disabled={!canEdit} />
              </label>
            </div>
            <label className="spc-enquiry-preview-field">
              <span>Standard Format Preview</span>
              <textarea
                value={draft.standardText}
                onChange={(event) => updateDraft("standardText", event.target.value)}
                placeholder="Standard enquiry preview"
                rows={3}
                readOnly
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

        <section className="spc-panel spc-sent-enquiries-panel">
          <div className="spc-panel-header">
            <h2>Sent Enquiries</h2>
          </div>
          <div className="spc-sent-enquiries-list">
            {enquiries.map((enquiry) => {
              const matches = matchesFor(enquiry)
              return (
                <article key={enquiry.id} className="spc-sent-enquiry-card">
                  <div className="spc-sent-enquiry-topline">
                    <strong>{enquiry.vesselName || enquiry.title || enquiry.enquiryNumber}</strong>
                    <span className={`spc-status-pill is-${enquiry.status}`}>{statusLabel(enquiry.status)}</span>
                  </div>
                  <p>{enquiry.formattedText || enquiry.title}</p>
                  {enquiry.status === "quoted" && enquiry.meta?.stemSupplierTraderDisplayName ? (
                    <div className="spc-outcome-note">Stemmed to {enquiry.meta.stemSupplierTraderDisplayName}</div>
                  ) : null}
                  {enquiry.status === "cancelled" && enquiry.meta?.lostReason ? (
                    <div className="spc-outcome-note is-lost">Lost: {enquiry.meta.lostReason}</div>
                  ) : null}
                  {matches.length > 0 ? (
                    <div className="spc-enquiry-match">
                      <strong>Previous vessel record</strong>
                      {matches.slice(0, 3).map((match) => (
                        <span key={match.id}>
                          {statusLabel(match.status)} · {displayTime(match.meta?.outcomeAt || match.updatedAt)} ·{" "}
                          {match.status === "cancelled"
                            ? match.meta?.lostReason || "No reason"
                            : match.meta?.stemSupplierTraderDisplayName || "No supplier trader"}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="spc-sent-enquiry-meta">
                    <span>{enquiry.createdByDisplayName}</span>
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
                    </div>
                  ) : null}
                </article>
              )
            })}
            {!loading && enquiries.length === 0 ? (
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
    </SpcShell>
  )
}
