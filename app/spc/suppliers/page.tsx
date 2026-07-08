"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { canAccessSpcPage } from "@/lib/spcPages"
import { useSpcAuth } from "@/lib/useSpcAuth"
import type {
  SpcSupplierDataset,
  SpcSupplierFixture,
  SpcSupplierLegacyFixture,
  SpcSupplierRecord,
} from "@/lib/spcSupplierTypes"

type SupplierResponse = SpcSupplierDataset & {
  message?: string
}

function blank(value: string | null | undefined) {
  return value?.trim() || "-"
}

function formatDate(value: string | null | undefined) {
  const text = value?.slice(0, 10) || ""
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return blank(value)
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
  return `${match[3]} ${months[Number(match[2]) - 1] || match[2]} ${match[1]}`
}

function gradeTokens(value: string) {
  return value
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean)
}

function fixtureSummary(fixtures: SpcSupplierFixture[]) {
  if (fixtures.length === 0) return "0"
  const latest = fixtures[0]?.fixtureDate ? formatDate(fixtures[0].fixtureDate) : ""
  return latest ? `${fixtures.length} · ${latest}` : String(fixtures.length)
}

function SupplierWarning({ label }: { label: string }) {
  return (
    <span className="spc-supplier-warning" title={label} aria-label={label}>
      !
    </span>
  )
}

function MoreInfoDialog({
  supplier,
  onClose,
}: {
  supplier: SpcSupplierRecord
  onClose: () => void
}) {
  return (
    <div className="spc-supplier-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="spc-supplier-modal" role="dialog" aria-modal="true" aria-label={`${supplier.name} more info`} onMouseDown={(event) => event.stopPropagation()}>
        <div className="spc-supplier-modal-header">
          <div>
            <h2>{supplier.name}</h2>
            <p>MORE INFO</p>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </div>
        <table className="spc-table spc-supplier-popup-table">
          <tbody>
            <tr>
              <th>FO BDN</th>
              <td>{blank(supplier.info.foBdn)}</td>
            </tr>
            <tr>
              <th>GO BDN</th>
              <td>{blank(supplier.info.goBdn)}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  )
}

function FixtureDialog({
  supplier,
  onClose,
}: {
  supplier: SpcSupplierRecord
  onClose: () => void
}) {
  return (
    <div className="spc-supplier-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="spc-supplier-modal is-wide" role="dialog" aria-modal="true" aria-label={`${supplier.name} fixtures`} onMouseDown={(event) => event.stopPropagation()}>
        <div className="spc-supplier-modal-header">
          <div>
            <h2>{supplier.name}</h2>
            <p>PREVIOUS FIXTURES</p>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </div>
        <div className="spc-table-wrap">
          <table className="spc-table spc-supplier-popup-table">
            <thead>
              <tr>
                <th>DATE</th>
                <th>VESSEL</th>
                <th>GRADE</th>
                <th>QTY</th>
                <th>SUPPLIER</th>
                <th>PRICE</th>
                <th>BARGING</th>
                <th>BUYER TRADER</th>
                <th>SUPPLIER TRADER</th>
              </tr>
            </thead>
            <tbody>
              {supplier.fixtures.map((fixture) => (
                <tr key={fixture.id}>
                  <td>{formatDate(fixture.fixtureDate)}</td>
                  <td><strong>{blank(fixture.vesselName)}</strong></td>
                  <td>{blank(fixture.grade)}</td>
                  <td>{blank(fixture.quantity)}</td>
                  <td>
                    {fixture.supplierName}
                    {fixture.renamed ? <span className="spc-supplier-was">was {fixture.recordedSupplier}</span> : null}
                  </td>
                  <td>{blank(fixture.price)}</td>
                  <td>{blank(fixture.barging)}</td>
                  <td>{blank(fixture.buyerTrader)}</td>
                  <td>{blank(fixture.supplierTrader)}</td>
                </tr>
              ))}
              {supplier.fixtures.length === 0 ? (
                <tr><td colSpan={9}>NO PREVIOUS FIXTURES.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function LegacyFixtureList({ fixtures }: { fixtures: SpcSupplierLegacyFixture[] }) {
  if (fixtures.length === 0) return null
  const visible = fixtures.slice(0, 12)
  return (
    <section className="spc-supplier-legacy">
      <div className="spc-supplier-legacy-title">
        <SupplierWarning label="CLOSED DOWN OR RENAMED" />
        <span>FIXTURE SUPPLIER NAMES NOT IN CURRENT LIST</span>
      </div>
      <div className="spc-supplier-legacy-grid">
        {visible.map((fixture) => (
          <div key={fixture.id} className="spc-supplier-legacy-item">
            <strong>{fixture.legacySupplier}</strong>
            <span>{formatDate(fixture.fixtureDate)} · {blank(fixture.vesselName)} · {blank(fixture.grade)} {blank(fixture.quantity)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

export default function SpcSuppliersPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions } = useSpcAuth()
  const [dataset, setDataset] = useState<SpcSupplierDataset | null>(null)
  const [query, setQuery] = useState("")
  const [requestedSupplier, setRequestedSupplier] = useState("")
  const [moreInfoKey, setMoreInfoKey] = useState("")
  const [fixtureKey, setFixtureKey] = useState("")
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState("")
  const [messageIsError, setMessageIsError] = useState(false)

  const canView = authenticated && canAccessSpcPage(permissions, "spc-suppliers", "view")
  const hasPermissionSnapshot = Object.prototype.hasOwnProperty.call(permissions, "spc-suppliers")
  const records = dataset?.records || []
  const searchValue = query.trim().toLowerCase()

  const filteredRecords = useMemo(() => {
    if (!searchValue) return records
    return records.filter((record) => record.searchText.includes(searchValue))
  }, [records, searchValue])

  const moreInfoSupplier = records.find((record) => record.key === moreInfoKey) || null
  const fixtureSupplier = records.find((record) => record.key === fixtureKey) || null

  const loadData = useCallback(async () => {
    if (!canView) return
    setLoading(true)
    setMessage("")
    try {
      const response = await fetch("/api/spc/suppliers", { cache: "no-store" })
      const data = (await response.json()) as SupplierResponse
      if (!response.ok) throw new Error(data.message || "Failed to load supplier database.")
      setDataset(data)
      if (requestedSupplier) {
        const target = requestedSupplier.toLowerCase()
        const match = data.records.find((record) =>
          record.key.toLowerCase() === target ||
          record.name.toLowerCase().includes(target) ||
          record.searchText.includes(target),
        )
        if (match) setFixtureKey(match.key)
        setQuery((current) => current || requestedSupplier)
      }
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load supplier database.")
      setMessageIsError(true)
    } finally {
      setLoading(false)
    }
  }, [canView, requestedSupplier])

  useEffect(() => {
    document.title = "SPC Supplier Database"
  }, [])

  useEffect(() => {
    setRequestedSupplier(new URLSearchParams(window.location.search).get("supplier")?.trim() || "")
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
    <SpcShell title="SPC Supplier Database">
      <div className="spc-supplier-db-page">
        <div className="spc-page-heading spc-supplier-db-heading">
          <div>
            <h1>Supplier Database</h1>
            <p>{dataset?.counts.suppliers || 0} suppliers · {dataset?.counts.fixtureRows || 0} fixture rows</p>
          </div>
          <div className="spc-supplier-db-actions">
            <label>
              <span className="sr-only">Search supplier database</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="SEARCH"
              />
            </label>
            <button type="button" onClick={() => void loadData()} disabled={loading}>
              {loading ? "REFRESHING" : "REFRESH"}
            </button>
          </div>
        </div>

        {message ? <div className={messageIsError ? "spc-alert is-error" : "spc-alert"}>{message}</div> : null}

        <section className="spc-supplier-ledger-panel">
          <div className="spc-table-wrap">
            <table className="spc-table spc-supplier-ledger-table">
              <thead>
                <tr>
                  <th>SUPPLIER</th>
                  <th>PAYMENT TERMS</th>
                  <th>QUALITY CLAIM BAR</th>
                  <th>SUPPLIER TRADER</th>
                  <th>AVAILABLE GRADE</th>
                  <th>MORE INFO</th>
                  <th>FIXTURE</th>
                </tr>
              </thead>
              <tbody>
                {filteredRecords.map((record) => (
                  <tr key={record.key}>
                    <td><strong>{record.name}</strong></td>
                    <td>{blank(record.info.paymentTerms)}</td>
                    <td>{blank(record.info.qualityClaimBar)}</td>
                    <td>{blank(record.info.supplierTrader)}</td>
                    <td>
                      <div className="spc-supplier-grade-list">
                        {gradeTokens(record.info.availableGrade).map((grade) => (
                          <span key={grade}>{grade}</span>
                        ))}
                        {gradeTokens(record.info.availableGrade).length === 0 ? "-" : null}
                      </div>
                    </td>
                    <td>
                      <button type="button" className="spc-supplier-mini-button" onClick={() => setMoreInfoKey(record.key)}>
                        MORE INFO
                      </button>
                    </td>
                    <td>
                      <button type="button" className="spc-supplier-mini-button" onClick={() => setFixtureKey(record.key)}>
                        {fixtureSummary(record.fixtures)}
                      </button>
                    </td>
                  </tr>
                ))}
                {!loading && filteredRecords.length === 0 ? (
                  <tr><td colSpan={7}>NO SUPPLIERS FOUND.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <LegacyFixtureList fixtures={dataset?.legacyFixtures || []} />

        {moreInfoSupplier ? <MoreInfoDialog supplier={moreInfoSupplier} onClose={() => setMoreInfoKey("")} /> : null}
        {fixtureSupplier ? <FixtureDialog supplier={fixtureSupplier} onClose={() => setFixtureKey("")} /> : null}
      </div>
    </SpcShell>
  )
}
