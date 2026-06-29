"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { useSpcAuth } from "@/lib/useSpcAuth"

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
  createdByDisplayName: string
  createdAt: string
}

type EnquiriesResponse = {
  enquiries?: SpcEnquiry[]
  message?: string
}

type DraftEnquiry = {
  title: string
  vesselName: string
  port: string
  product: string
  quantity: string
  deliveryDate: string
  supplierName: string
  notes: string
}

const emptyDraft: DraftEnquiry = {
  title: "",
  vesselName: "",
  port: "",
  product: "",
  quantity: "",
  deliveryDate: "",
  supplierName: "",
  notes: "",
}

function displayDate(value: string | null) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)
}

export default function SpcBuyerPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, role } = useSpcAuth()
  const [draft, setDraft] = useState<DraftEnquiry>(emptyDraft)
  const [enquiries, setEnquiries] = useState<SpcEnquiry[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [messageIsError, setMessageIsError] = useState(false)

  const recentCount = useMemo(() => enquiries.length, [enquiries.length])

  const loadEnquiries = useCallback(async () => {
    if (!authenticated || role !== "buyer_trader") return
    setLoading(true)
    try {
      const response = await fetch("/api/spc/enquiries", { cache: "no-store" })
      const data = (await response.json()) as EnquiriesResponse
      if (!response.ok) throw new Error(data.message || "Failed to load SPC enquiries.")
      setEnquiries(data.enquiries || [])
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load SPC enquiries.")
      setMessageIsError(true)
    } finally {
      setLoading(false)
    }
  }, [authenticated, role])

  useEffect(() => {
    document.title = "SPC Buyer Enquiries"
  }, [])

  useEffect(() => {
    if (!authLoading && (!authenticated || role !== "buyer_trader")) router.replace("/spc")
  }, [authLoading, authenticated, role, router])

  useEffect(() => {
    void loadEnquiries()
  }, [loadEnquiries])

  function updateDraft(key: keyof DraftEnquiry, value: string) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  async function saveEnquiry(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setMessage("")

    try {
      const response = await fetch("/api/spc/enquiries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      })
      const data = (await response.json()) as { enquiry?: SpcEnquiry; message?: string }
      if (!response.ok || !data.enquiry) {
        throw new Error(data.message || "Failed to save SPC enquiry.")
      }
      setDraft(emptyDraft)
      setEnquiries((current) => [data.enquiry!, ...current])
      setMessage("Enquiry saved.")
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save SPC enquiry.")
      setMessageIsError(true)
    } finally {
      setSaving(false)
    }
  }

  if (authLoading || !authenticated || role !== "buyer_trader") {
    return <div className="spc-loading">Loading...</div>
  }

  return (
    <SpcShell title="SPC Buyer Enquiries">
      <div className="spc-page-heading">
        <div>
          <h1>Buyer Enquiries</h1>
          <p>{recentCount} historic enquiries</p>
        </div>
      </div>

      {message ? (
        <div className={messageIsError ? "spc-alert is-error" : "spc-alert"}>
          {message}
        </div>
      ) : null}

      <section className="spc-panel">
        <div className="spc-panel-header">
          <h2>New Enquiry</h2>
        </div>
        <form onSubmit={saveEnquiry} className="spc-enquiry-form">
          <label>
            <span>Title</span>
            <input
              value={draft.title}
              onChange={(event) => updateDraft("title", event.target.value)}
              placeholder="Supplier / vessel / product"
              required
            />
          </label>
          <label>
            <span>Vessel Name</span>
            <input value={draft.vesselName} onChange={(event) => updateDraft("vesselName", event.target.value)} />
          </label>
          <label>
            <span>Port</span>
            <input value={draft.port} onChange={(event) => updateDraft("port", event.target.value)} />
          </label>
          <label>
            <span>Product</span>
            <input value={draft.product} onChange={(event) => updateDraft("product", event.target.value)} />
          </label>
          <label>
            <span>Quantity</span>
            <input value={draft.quantity} onChange={(event) => updateDraft("quantity", event.target.value)} />
          </label>
          <label>
            <span>Delivery Date</span>
            <input
              type="date"
              value={draft.deliveryDate}
              onChange={(event) => updateDraft("deliveryDate", event.target.value)}
            />
          </label>
          <label>
            <span>Supplier</span>
            <input value={draft.supplierName} onChange={(event) => updateDraft("supplierName", event.target.value)} />
          </label>
          <label className="spc-enquiry-notes">
            <span>Details</span>
            <textarea
              value={draft.notes}
              onChange={(event) => updateDraft("notes", event.target.value)}
              rows={5}
            />
          </label>
          <div className="spc-form-actions">
            <button type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save Enquiry"}
            </button>
          </div>
        </form>
      </section>

      <section className="spc-panel">
        <div className="spc-panel-header">
          <h2>Historic Enquiries</h2>
          <button type="button" onClick={() => void loadEnquiries()} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        <div className="spc-table-wrap">
          <table className="spc-table">
            <thead>
              <tr>
                <th>Enquiry</th>
                <th>Vessel</th>
                <th>Port</th>
                <th>Product</th>
                <th>Supplier</th>
                <th>Created</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {enquiries.map((enquiry) => (
                <tr key={enquiry.id}>
                  <td>
                    <strong>{enquiry.title}</strong>
                    <span>{enquiry.enquiryNumber}</span>
                  </td>
                  <td>{enquiry.vesselName || "-"}</td>
                  <td>{enquiry.port || "-"}</td>
                  <td>{enquiry.product || "-"}</td>
                  <td>{enquiry.supplierName || "-"}</td>
                  <td>{displayDate(enquiry.createdAt)}</td>
                  <td><span className="spc-status-pill">{enquiry.status}</span></td>
                </tr>
              ))}
              {!loading && enquiries.length === 0 ? (
                <tr>
                  <td colSpan={7}>No enquiries yet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </SpcShell>
  )
}
