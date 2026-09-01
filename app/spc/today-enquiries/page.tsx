"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { canAccessSpcPage, normaliseSpcRole } from "@/lib/spcPages"
import type {
  SpcTodayEnquiry,
  SpcTodayPreviousFixture,
  SpcTodayPreviousLost,
} from "@/lib/spcTodayEnquiries"
import { useSpcAuth } from "@/lib/useSpcAuth"

type TodayResponse = {
  enquiries?: SpcTodayEnquiry[]
  message?: string
}

const todayColumnWidths = [
  48, // select
  82, // time
  132, // buyer
  430, // enquiry
  330, // previous fixture
  330, // previous lost
] as const

const todayTableWidth = todayColumnWidths.reduce((total, width) => total + width, 0)

function displayTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)
}

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

function fixtureText(fixture: SpcTodayPreviousFixture | null) {
  if (!fixture) return "NO PREVIOUS FIXTURE"
  return [
    displayDate(fixture.date),
    fixture.supplier,
    fixture.price ? `PRICE ${fixture.price}` : "",
    fixture.barging ? `BARGING ${fixture.barging}` : "",
    fixture.supplierTrader,
  ].filter(Boolean).join(" · ")
}

function lostText(lost: SpcTodayPreviousLost | null) {
  if (!lost) return "NO PREVIOUS LOST RECORD"
  const supplierReason = lost.supplierReason
    ? `${lost.supplierReason}${lost.supplierReasonDetails ? `: ${lost.supplierReasonDetails}` : ""}`
    : ""
  return [displayDate(lost.date), lost.buyerReason, supplierReason, lost.spcComments].filter(Boolean).join(" · ")
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const textarea = document.createElement("textarea")
  textarea.value = value
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand("copy")
  textarea.remove()
}

export default function SpcTodayEnquiriesPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions, role } = useSpcAuth()
  const [enquiries, setEnquiries] = useState<SpcTodayEnquiry[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState("")
  const [notice, setNotice] = useState("")

  const normalizedRole = normaliseSpcRole(role)
  const canView = authenticated &&
    canAccessSpcPage(permissions, "spc-today-enquiries", "view") &&
    (normalizedRole === "SUPPLIER TRADER" || normalizedRole === "ADMIN")
  const hasPermissionSnapshot = Object.prototype.hasOwnProperty.call(permissions, "spc-today-enquiries")

  const loadData = useCallback(async (quiet = false) => {
    if (!canView) return
    if (!quiet) setLoading(true)
    setMessage("")
    try {
      const response = await fetch("/api/spc/today-enquiries", { cache: "no-store" })
      const data = (await response.json()) as TodayResponse
      if (!response.ok) throw new Error(data.message || "Failed to load today's enquiries.")
      const nextEnquiries = data.enquiries || []
      setEnquiries(nextEnquiries)
      setSelectedIds((current) => new Set([...current].filter((id) => nextEnquiries.some((item) => item.id === id))))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load today's enquiries.")
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [canView])

  useEffect(() => {
    document.title = "SPC DAILY BRIEFING"
  }, [])

  useEffect(() => {
    if (!authLoading && !authenticated) router.replace("/spc")
    if (!authLoading && authenticated && hasPermissionSnapshot && !canView) router.replace("/spc")
  }, [authLoading, authenticated, canView, hasPermissionSnapshot, router])

  useEffect(() => {
    void loadData()
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadData(true)
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [loadData])

  const selectedEnquiries = useMemo(
    () => enquiries.filter((enquiry) => selectedIds.has(enquiry.id)),
    [enquiries, selectedIds],
  )

  function toggleSelected(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function copySelected() {
    if (selectedEnquiries.length === 0) return
    setMessage("")
    setNotice("")
    try {
      await copyText(selectedEnquiries.map((enquiry) => enquiry.formattedText).join("\n\n"))
      setNotice(`${selectedEnquiries.length} ${selectedEnquiries.length === 1 ? "enquiry" : "enquiries"} copied.`)
    } catch {
      setMessage("Unable to copy selected enquiries.")
    }
  }

  if (authLoading || !authenticated || !hasPermissionSnapshot || !canView) {
    return <div className="spc-loading">LOADING...</div>
  }

  return (
    <SpcShell title="SPC DAILY BRIEFING">
      <section className="spc-panel spc-fixture-ledger-panel spc-today-enquiries-panel">
        <div className="spc-fixture-ledger-toolbar spc-today-enquiries-toolbar">
          {message ? <span className="spc-ledger-message is-error">{message}</span> : null}
          {!message && notice ? <span className="spc-ledger-notice">{notice}</span> : null}
          <span className="spc-today-selection-count">{selectedIds.size} SELECTED</span>
          <button type="button" className="spc-fixture-refresh-button" onClick={() => setSelectedIds(new Set(enquiries.map((enquiry) => enquiry.id)))} disabled={enquiries.length === 0}>SELECT ALL</button>
          <button type="button" className="spc-fixture-refresh-button" onClick={() => setSelectedIds(new Set())} disabled={selectedIds.size === 0}>CLEAR</button>
          <button type="button" className="spc-today-copy-button" onClick={() => void copySelected()} disabled={selectedIds.size === 0}>COPY SELECTED</button>
          <button type="button" className="spc-fixture-refresh-button" onClick={() => void loadData()} disabled={loading}>{loading ? "REFRESHING..." : "REFRESH"}</button>
        </div>
        <div className="spc-table-wrap">
          <table className="spc-table spc-fixture-table spc-today-enquiries-table" style={{ width: todayTableWidth, minWidth: todayTableWidth }}>
            <colgroup>
              {todayColumnWidths.map((width, index) => <col key={`${width}-${index}`} style={{ width }} />)}
            </colgroup>
            <thead>
              <tr>
                <th>SELECT</th>
                <th>TIME</th>
                <th>BUYER TRADER</th>
                <th>ENQUIRY</th>
                <th>PREVIOUS FIXTURE</th>
                <th>PREVIOUS LOST RECORD</th>
              </tr>
            </thead>
            <tbody>
              <tr className="spc-fixture-section-row"><td colSpan={6}>TODAY · HONG KONG TIME</td></tr>
              {enquiries.map((enquiry) => {
                const selected = selectedIds.has(enquiry.id)
                return (
                  <tr key={enquiry.id} className={selected ? "is-selected" : ""} onClick={() => toggleSelected(enquiry.id)}>
                    <td><input type="checkbox" checked={selected} onChange={() => toggleSelected(enquiry.id)} onClick={(event) => event.stopPropagation()} aria-label={`Select ${enquiry.vesselName}`} /></td>
                    <td>{displayTime(enquiry.createdAt)}</td>
                    <td title={enquiry.createdByDisplayName}>{enquiry.createdByDisplayName}</td>
                    <td title={enquiry.formattedText}><strong>{enquiry.formattedText}</strong></td>
                    <td className={enquiry.previousFixture ? "has-history" : ""} title={fixtureText(enquiry.previousFixture)}>{fixtureText(enquiry.previousFixture)}</td>
                    <td className={enquiry.previousLost ? "has-history is-lost" : ""} title={lostText(enquiry.previousLost)}>{lostText(enquiry.previousLost)}</td>
                  </tr>
                )
              })}
              {!loading && enquiries.length === 0 ? <tr className="spc-fixture-empty-row"><td colSpan={6}>No enquiries received today.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </SpcShell>
  )
}
