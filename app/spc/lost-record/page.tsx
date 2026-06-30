"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { useSpcAuth } from "@/lib/useSpcAuth"
import { canAccessSpcPage } from "@/lib/spcPages"
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

function displayDate(value: string | null | undefined) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date)
}

export default function SpcLostRecordPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions } = useSpcAuth()
  const [enquiries, setEnquiries] = useState<SpcEnquiry[]>([])
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState("")

  const canView = authenticated && canAccessSpcPage(permissions, "spc-lost-record", "view")
  const hasPermissionSnapshot = Object.prototype.hasOwnProperty.call(permissions, "spc-lost-record")

  const loadData = useCallback(async () => {
    if (!canView) return
    setLoading(true)
    setMessage("")
    try {
      const response = await fetch("/api/spc/enquiries?status=cancelled&limit=250", { cache: "no-store" })
      const data = (await response.json()) as { enquiries?: SpcEnquiry[]; message?: string }
      if (!response.ok) throw new Error(data.message || "Failed to load lost record.")
      setEnquiries(data.enquiries || [])
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load lost record.")
    } finally {
      setLoading(false)
    }
  }, [canView])

  useEffect(() => {
    document.title = "SPC Lost Record"
  }, [])

  useEffect(() => {
    if (!authLoading && !authenticated) router.replace("/spc")
    if (!authLoading && authenticated && hasPermissionSnapshot && !canView) router.replace("/spc")
  }, [authLoading, authenticated, canView, hasPermissionSnapshot, router])

  useEffect(() => {
    void loadData()
  }, [loadData])

  if (authLoading || !authenticated || !hasPermissionSnapshot || !canView) {
    return <div className="spc-loading">Loading...</div>
  }

  return (
    <SpcShell title="SPC Lost Record">
      <div className="spc-page-heading">
        <div>
          <h1>Lost Record</h1>
          <p>{enquiries.length} lost enquiries</p>
        </div>
        <button type="button" className="spc-page-action" onClick={() => void loadData()} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {message ? <div className="spc-alert is-error">{message}</div> : null}

      <section className="spc-panel">
        <div className="spc-table-wrap">
          <table className="spc-table">
            <thead>
              <tr>
                <th>DATE</th>
                <th>BUYER TRADER</th>
                <th>VESSEL NAME</th>
                <th>ETA</th>
                <th>LOST REASON</th>
              </tr>
            </thead>
            <tbody>
              {enquiries.map((enquiry) => (
                <tr key={enquiry.id}>
                  <td>{displayDate(enquiry.meta?.outcomeAt || enquiry.updatedAt || enquiry.createdAt)}</td>
                  <td>{enquiry.createdByDisplayName || "-"}</td>
                  <td><strong>{enquiry.vesselName || enquiry.title || "-"}</strong></td>
                  <td>{enquiry.meta?.eta || enquiry.deliveryDate || "-"}</td>
                  <td><span className="spc-status-pill is-cancelled">{enquiry.meta?.lostReason || "UNKNOWN"}</span></td>
                </tr>
              ))}
              {!loading && enquiries.length === 0 ? (
                <tr><td colSpan={5}>No lost enquiries yet.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </SpcShell>
  )
}
