"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { canAccessSpcPage, normaliseSpcRole } from "@/lib/spcPages"
import type {
  SpcTodayEnquiry,
  SpcTodayPreviousFixture,
  SpcTodayPreviousLost,
} from "@/lib/spcTodayEnquiries"
import { useSpcAuth } from "@/lib/useSpcAuth"
import { useSpcRecordPageRead } from "@/lib/useSpcRecordPageRead"
import styles from "../record-pages.module.css"

const EMPTY_ENQUIRIES: SpcTodayEnquiry[] = []
const EMPTY_SELECTION = new Set<string>()

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
  const auth = useSpcAuth()
  return <TodayEnquiriesContents key={JSON.stringify([auth.loading, auth.authenticated, auth.actorKey, auth.username, auth.role, auth.office, auth.permissions["spc-today-enquiries"]])} />
}

function TodayEnquiriesContents() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions, role, actorKey, username, office } = useSpcAuth()
  const [selection, setSelection] = useState<{ pageKey: string; ids: Set<string> }>({ pageKey: "", ids: new Set() })
  const [message, setMessage] = useState("")
  const [notice, setNotice] = useState("")

  const normalizedRole = normaliseSpcRole(role)
  const canView = authenticated &&
    canAccessSpcPage(permissions, "spc-today-enquiries", "view") &&
    (normalizedRole === "SUPPLIER TRADER" || normalizedRole === "ADMIN")
  const hasPermissionSnapshot = Object.prototype.hasOwnProperty.call(permissions, "spc-today-enquiries")
  const owner = !authLoading && canView && hasPermissionSnapshot
    ? JSON.stringify([actorKey, username, role, office, permissions["spc-today-enquiries"]]) : null
  const records = useSpcRecordPageRead("today", owner)
  const ownerRef = useRef(owner)
  const enquiries = records.page?.enquiries || EMPTY_ENQUIRIES
  const pageKey = records.page ? `${records.page.day}:${records.page.mainRevision}:${records.page.pageIndex}` : ""
  const selectedIds = selection.pageKey === pageKey ? selection.ids : EMPTY_SELECTION
  function setSelectedIds(update: Set<string> | ((current: Set<string>) => Set<string>)) {
    setSelection(current => ({ pageKey, ids: typeof update === "function" ? update(current.pageKey === pageKey ? current.ids : EMPTY_SELECTION) : update }))
  }
  const loading = records.loading
  const reloadCurrent = records.reloadCurrent

  useEffect(() => {
    document.title = "SPC DAILY BRIEFING"
  }, [])

  useEffect(() => {
    if (!authLoading && !authenticated) router.replace("/spc")
    if (!authLoading && authenticated && hasPermissionSnapshot && !canView) router.replace("/spc")
  }, [authLoading, authenticated, canView, hasPermissionSnapshot, router])

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") reloadCurrent()
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [reloadCurrent])
  useEffect(() => { ownerRef.current = owner; return () => { ownerRef.current = null } }, [owner])

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
    if (selectedEnquiries.length === 0 || !owner || records.denied || records.loading) return
    const capturedOwner = owner
    setMessage("")
    setNotice("")
    try {
      await copyText(selectedEnquiries.map((enquiry) => enquiry.formattedText).join("\n\n"))
      if (ownerRef.current !== capturedOwner) return
      setNotice(`${selectedEnquiries.length} ${selectedEnquiries.length === 1 ? "enquiry" : "enquiries"} copied.`)
    } catch {
      if (ownerRef.current !== capturedOwner) return
      setMessage("Unable to copy selected enquiries.")
    }
  }

  if (authLoading || !authenticated || !hasPermissionSnapshot || !canView) {
    return <div className="spc-loading">LOADING...</div>
  }
  if (records.denied) return <div className="spc-alert is-error" role="alert">{records.error}</div>

  return (
    <SpcShell title="SPC DAILY BRIEFING">
      <section className="spc-panel spc-fixture-ledger-panel spc-today-enquiries-panel">
        <div className="spc-fixture-ledger-toolbar spc-today-enquiries-toolbar">
          {!message && !records.error && notice ? <span className="spc-ledger-notice">{notice}</span> : null}
          <span className="spc-today-selection-count">{selectedEnquiries.length} SELECTED ON THIS PAGE</span>
          <button type="button" className="spc-fixture-refresh-button" onClick={() => setSelectedIds(new Set(enquiries.map((enquiry) => enquiry.id)))} disabled={enquiries.length === 0 || loading}>SELECT THIS PAGE</button>
          <button type="button" className="spc-fixture-refresh-button" onClick={() => setSelectedIds(new Set())} disabled={selectedIds.size === 0}>CLEAR</button>
          <button type="button" className="spc-today-copy-button" onClick={() => void copySelected()} disabled={selectedEnquiries.length === 0 || loading}>COPY SELECTED ON THIS PAGE</button>
          <button type="button" className="spc-fixture-refresh-button" onClick={() => void records.refresh()} disabled={loading}>{loading ? "REFRESHING..." : "REFRESH"}</button>
        </div>
        {message || records.error ? <div className="spc-alert is-error" role="alert">{message || records.error}</div> : null}
        <div className={styles.controls} aria-label="Record pages">
          <span className={styles.summary}>{records.page ? `${records.page.totalCount} enquiries · Page ${records.page.pageIndex} of ${records.page.pageCount} · ${enquiries.length} on this page` : loading ? "Loading the complete record page..." : "Records are unavailable. Refresh to try again."}</span>
          <button type="button" onClick={records.previous} disabled={loading || !records.page || records.page.pageIndex <= 1}>PREVIOUS PAGE</button>
          <button type="button" onClick={records.next} disabled={loading || !records.page?.nextCursor}>NEXT PAGE</button>
          {records.page ? <span>Last verified {new Date(records.page.checkedAt).toLocaleString("en-GB", { timeZone: "Asia/Hong_Kong" })} HKT</span> : null}
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
              <tr className="spc-fixture-section-row"><td colSpan={6}>{records.page ? records.page.day : "TODAY"} · HONG KONG TIME</td></tr>
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
              {!loading && records.page && !records.error && enquiries.length === 0 ? <tr className="spc-fixture-empty-row"><td colSpan={6}>No enquiries received on {records.page.day}.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </SpcShell>
  )
}
