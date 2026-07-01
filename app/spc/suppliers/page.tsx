"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { canAccessSpcPage } from "@/lib/spcPages"
import { useSpcAuth } from "@/lib/useSpcAuth"
import type {
  SpcSupplierBdnEntry,
  SpcSupplierDataset,
  SpcSupplierRecord,
} from "@/lib/spcSupplierTypes"

type SupplierTab = "overview" | "contacts" | "bdn" | "barges" | "coverage"

type SupplierDraft = {
  info: {
    payment: string
    qualityClaim: string
    hsfo: string
    vlsfo: string
    lsmgo: string
  }
  contact: {
    sales: string
    salesMobile: string
    ops: string
    opsMobile: string
  }
  bdnEntries: Array<{
    rowNumber: number
    sellingEntity: string
    terms: string
    bdnFuelOil: string
    bdnGasOil: string
    pop: string
  }>
}

type SupplierResponse = SpcSupplierDataset & {
  message?: string
}

type SaveResponse = {
  dataset?: SpcSupplierDataset
  record?: SpcSupplierRecord
  saved?: boolean
  message?: string
}

const SUPPLIER_TABS: Array<{ id: SupplierTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "contacts", label: "Contacts" },
  { id: "bdn", label: "BDN" },
  { id: "barges", label: "Barges" },
  { id: "coverage", label: "Coverage" },
]

function blank(value: string | null | undefined) {
  return value?.trim() || "-"
}

function activeBargeCount(record: SpcSupplierRecord) {
  return record.barges.filter((barge) => barge.status.trim().toLowerCase() === "active").length
}

function supplierDraft(record: SpcSupplierRecord): SupplierDraft {
  return {
    info: {
      payment: record.info.payment,
      qualityClaim: record.info.qualityClaim,
      hsfo: record.info.hsfo,
      vlsfo: record.info.vlsfo,
      lsmgo: record.info.lsmgo,
    },
    contact: {
      sales: record.contact.sales,
      salesMobile: record.contact.salesMobile,
      ops: record.contact.ops,
      opsMobile: record.contact.opsMobile,
    },
    bdnEntries: record.bdnEntries.map((entry) => ({
      rowNumber: entry.rowNumber,
      sellingEntity: entry.sellingEntity,
      terms: entry.terms,
      bdnFuelOil: entry.bdnFuelOil,
      bdnGasOil: entry.bdnGasOil,
      pop: entry.pop,
    })),
  }
}

function sameDraft(a: SupplierDraft | null, b: SupplierDraft | null) {
  return JSON.stringify(a) === JSON.stringify(b)
}

export default function SpcSuppliersPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions } = useSpcAuth()
  const [dataset, setDataset] = useState<SpcSupplierDataset | null>(null)
  const [selectedKey, setSelectedKey] = useState("")
  const [activeTab, setActiveTab] = useState<SupplierTab>("overview")
  const [query, setQuery] = useState("")
  const [draft, setDraft] = useState<SupplierDraft | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [messageIsError, setMessageIsError] = useState(false)

  const canView = authenticated && canAccessSpcPage(permissions, "spc-suppliers", "view")
  const canEdit = authenticated && canAccessSpcPage(permissions, "spc-suppliers", "edit")
  const hasPermissionSnapshot = Object.prototype.hasOwnProperty.call(permissions, "spc-suppliers")

  const records = dataset?.records || []
  const selectedSupplier = useMemo(
    () => records.find((record) => record.key === selectedKey) || records[0] || null,
    [records, selectedKey],
  )
  const savedDraft = useMemo(
    () => (selectedSupplier ? supplierDraft(selectedSupplier) : null),
    [selectedSupplier],
  )
  const dirty = Boolean(selectedSupplier && draft && !sameDraft(draft, savedDraft))
  const normalizedQuery = query.trim().toLowerCase()
  const filteredRecords = useMemo(() => {
    if (!normalizedQuery) return records
    return records.filter((record) => record.searchText.includes(normalizedQuery))
  }, [normalizedQuery, records])

  const loadData = useCallback(async () => {
    if (!canView) return
    setLoading(true)
    setMessage("")
    try {
      const response = await fetch("/api/spc/suppliers", { cache: "no-store" })
      const data = (await response.json()) as SupplierResponse
      if (!response.ok) throw new Error(data.message || "Failed to load supplier database.")
      setDataset(data)
      setSelectedKey((current) =>
        current && data.records.some((record) => record.key === current)
          ? current
          : data.records[0]?.key || "",
      )
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load supplier database.")
      setMessageIsError(true)
    } finally {
      setLoading(false)
    }
  }, [canView])

  useEffect(() => {
    document.title = "SPC Supplier Database"
  }, [])

  useEffect(() => {
    if (!authLoading && !authenticated) router.replace("/spc")
    if (!authLoading && authenticated && hasPermissionSnapshot && !canView) router.replace("/spc")
  }, [authLoading, authenticated, canView, hasPermissionSnapshot, router])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    setDraft(savedDraft)
  }, [savedDraft])

  function updateInfo(key: keyof NonNullable<SupplierDraft["info"]>, value: string) {
    setDraft((current) =>
      current
        ? {
            ...current,
            info: {
              ...current.info,
              [key]: value,
            },
          }
        : current,
    )
  }

  function updateContact(key: keyof NonNullable<SupplierDraft["contact"]>, value: string) {
    setDraft((current) =>
      current
        ? {
            ...current,
            contact: {
              ...current.contact,
              [key]: value,
            },
          }
        : current,
    )
  }

  function updateBdn(rowNumber: number, key: keyof Omit<SpcSupplierBdnEntry, "id" | "supplier" | "rowNumber">, value: string) {
    setDraft((current) =>
      current
        ? {
            ...current,
            bdnEntries: current.bdnEntries.map((entry) =>
              entry.rowNumber === rowNumber
                ? {
                    ...entry,
                    [key]: value,
                  }
                : entry,
            ),
          }
        : current,
    )
  }

  async function saveSupplier() {
    if (!canEdit || !selectedSupplier || !draft || !dirty) return
    setSaving(true)
    setMessage("")
    try {
      const response = await fetch("/api/spc/suppliers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplierKey: selectedSupplier.key,
          ...draft,
        }),
      })
      const data = (await response.json()) as SaveResponse
      if (!response.ok || !data.dataset || !data.record) {
        throw new Error(data.message || "Failed to save supplier.")
      }

      setDataset(data.dataset)
      setSelectedKey(data.record.key)
      setMessage(data.saved ? "Supplier saved." : "No changes to save.")
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save supplier.")
      setMessageIsError(true)
    } finally {
      setSaving(false)
    }
  }

  if (authLoading || !authenticated || !hasPermissionSnapshot || !canView) {
    return <div className="spc-loading">Loading...</div>
  }

  return (
    <SpcShell title="SPC Supplier Database">
      <div className="spc-page-heading">
        <div>
          <h1>Supplier Database</h1>
          <p>
            {dataset?.counts.suppliers || 0} suppliers · {dataset?.counts.activeBarges || 0} active barges ·{" "}
            {dataset?.counts.coverageRows || 0} coverage rows
          </p>
        </div>
        <div className="spc-supplier-heading-actions">
          <a href={dataset?.spreadsheetUrl || "#"} target="_blank" rel="noreferrer">
            Sheet
          </a>
          <button type="button" className="spc-page-action" onClick={() => void loadData()} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {message ? <div className={messageIsError ? "spc-alert is-error" : "spc-alert"}>{message}</div> : null}

      <div className="spc-supplier-workspace">
        <aside className="spc-panel spc-supplier-list-panel">
          <div className="spc-panel-header">
            <h2>Suppliers</h2>
            <span>{filteredRecords.length}</span>
          </div>
          <label className="spc-supplier-search">
            <span className="sr-only">Search suppliers</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search supplier, barge, contact..."
            />
          </label>
          <div className="spc-supplier-list">
            {filteredRecords.map((record) => (
              <button
                type="button"
                key={record.key}
                className={selectedSupplier?.key === record.key ? "is-active" : ""}
                onClick={() => {
                  setSelectedKey(record.key)
                  setActiveTab("overview")
                }}
              >
                <strong>{record.name}</strong>
                <span>
                  {blank(record.info.payment)} DDD · {activeBargeCount(record)} active barges · {record.coverage.length} coverage
                </span>
              </button>
            ))}
            {!loading && filteredRecords.length === 0 ? <p className="spc-empty">No suppliers found.</p> : null}
          </div>
        </aside>

        <section className="spc-panel spc-supplier-detail-panel">
          {selectedSupplier && draft ? (
            <>
              <div className="spc-supplier-detail-header">
                <div>
                  <h2>{selectedSupplier.name}</h2>
                  <div className="spc-supplier-aliases">
                    {selectedSupplier.aliases.slice(0, 4).map((alias) => (
                      <span key={alias}>{alias}</span>
                    ))}
                  </div>
                </div>
                <button type="button" onClick={() => void saveSupplier()} disabled={!canEdit || !dirty || saving}>
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>

              <div className="spc-supplier-facts">
                <div><span>Payment</span><strong>{blank(selectedSupplier.info.payment)}</strong></div>
                <div><span>Quality Claim</span><strong>{blank(selectedSupplier.info.qualityClaim)}</strong></div>
                <div><span>BDN Rows</span><strong>{selectedSupplier.bdnEntries.length}</strong></div>
                <div><span>Barges</span><strong>{selectedSupplier.barges.length}</strong></div>
              </div>

              <div className="spc-supplier-tabs" role="tablist" aria-label="Supplier database sections">
                {SUPPLIER_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab.id}
                    className={activeTab === tab.id ? "is-active" : ""}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {activeTab === "overview" ? (
                <div className="spc-supplier-form-grid">
                  <label>
                    <span>Payment</span>
                    <input value={draft.info.payment || ""} onChange={(event) => updateInfo("payment", event.target.value)} disabled={!canEdit || !selectedSupplier.info.rowNumber} />
                  </label>
                  <label>
                    <span>Quality Claim</span>
                    <input value={draft.info.qualityClaim || ""} onChange={(event) => updateInfo("qualityClaim", event.target.value)} disabled={!canEdit || !selectedSupplier.info.rowNumber} />
                  </label>
                  <label>
                    <span>HSFO</span>
                    <input value={draft.info.hsfo || ""} onChange={(event) => updateInfo("hsfo", event.target.value)} disabled={!canEdit || !selectedSupplier.info.rowNumber} />
                  </label>
                  <label>
                    <span>VLSFO / LSFO</span>
                    <input value={draft.info.vlsfo || ""} onChange={(event) => updateInfo("vlsfo", event.target.value)} disabled={!canEdit || !selectedSupplier.info.rowNumber} />
                  </label>
                  <label>
                    <span>LSMGO</span>
                    <input value={draft.info.lsmgo || ""} onChange={(event) => updateInfo("lsmgo", event.target.value)} disabled={!canEdit || !selectedSupplier.info.rowNumber} />
                  </label>
                </div>
              ) : null}

              {activeTab === "contacts" ? (
                <div className="spc-supplier-form-grid is-contacts">
                  <label>
                    <span>Sales</span>
                    <textarea value={draft.contact.sales || ""} onChange={(event) => updateContact("sales", event.target.value)} disabled={!canEdit || !selectedSupplier.contact.rowNumber} />
                  </label>
                  <label>
                    <span>Sales Mobile</span>
                    <textarea value={draft.contact.salesMobile || ""} onChange={(event) => updateContact("salesMobile", event.target.value)} disabled={!canEdit || !selectedSupplier.contact.rowNumber} />
                  </label>
                  <label>
                    <span>Ops</span>
                    <textarea value={draft.contact.ops || ""} onChange={(event) => updateContact("ops", event.target.value)} disabled={!canEdit || !selectedSupplier.contact.rowNumber} />
                  </label>
                  <label>
                    <span>Ops Mobile</span>
                    <textarea value={draft.contact.opsMobile || ""} onChange={(event) => updateContact("opsMobile", event.target.value)} disabled={!canEdit || !selectedSupplier.contact.rowNumber} />
                  </label>
                </div>
              ) : null}

              {activeTab === "bdn" ? (
                <div className="spc-table-wrap">
                  <table className="spc-table spc-supplier-edit-table">
                    <thead>
                      <tr>
                        <th>Selling Entity</th>
                        <th>Terms</th>
                        <th>BDN Fuel Oil</th>
                        <th>BDN Gas Oil</th>
                        <th>POP</th>
                      </tr>
                    </thead>
                    <tbody>
                      {draft.bdnEntries.map((entry) => (
                        <tr key={entry.rowNumber}>
                          <td><input value={entry.sellingEntity || ""} onChange={(event) => updateBdn(entry.rowNumber, "sellingEntity", event.target.value)} disabled={!canEdit} /></td>
                          <td><input value={entry.terms || ""} onChange={(event) => updateBdn(entry.rowNumber, "terms", event.target.value)} disabled={!canEdit} /></td>
                          <td><input value={entry.bdnFuelOil || ""} onChange={(event) => updateBdn(entry.rowNumber, "bdnFuelOil", event.target.value)} disabled={!canEdit} /></td>
                          <td><input value={entry.bdnGasOil || ""} onChange={(event) => updateBdn(entry.rowNumber, "bdnGasOil", event.target.value)} disabled={!canEdit} /></td>
                          <td><input value={entry.pop || ""} onChange={(event) => updateBdn(entry.rowNumber, "pop", event.target.value)} disabled={!canEdit} /></td>
                        </tr>
                      ))}
                      {draft.bdnEntries.length === 0 ? <tr><td colSpan={5}>No BDN rows.</td></tr> : null}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {activeTab === "barges" ? (
                <div className="spc-table-wrap">
                  <table className="spc-table spc-supplier-read-table">
                    <thead>
                      <tr>
                        <th>Grade</th>
                        <th>Barge Name</th>
                        <th>IMO Number</th>
                        <th>Load MT</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedSupplier.barges.map((barge) => (
                        <tr key={barge.id}>
                          <td>{blank(barge.grade)}</td>
                          <td><strong>{blank(barge.bargeName)}</strong></td>
                          <td>{blank(barge.imoNumber)}</td>
                          <td>{blank(barge.loadMt)}</td>
                          <td><span className={barge.status.toLowerCase() === "active" ? "spc-supplier-pill is-active" : "spc-supplier-pill"}>{blank(barge.status)}</span></td>
                        </tr>
                      ))}
                      {selectedSupplier.barges.length === 0 ? <tr><td colSpan={5}>No barges.</td></tr> : null}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {activeTab === "coverage" ? (
                <div className="spc-table-wrap">
                  <table className="spc-table spc-supplier-read-table">
                    <thead>
                      <tr>
                        <th>Trader</th>
                        <th>Supplier Cell</th>
                        <th>HSFO</th>
                        <th>VLSFO</th>
                        <th>LSMGO</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedSupplier.coverage.map((coverage) => (
                        <tr key={coverage.id}>
                          <td><strong>{coverage.trader}</strong></td>
                          <td>{blank(coverage.supplier)}</td>
                          <td>{blank(coverage.hsfo)}</td>
                          <td>{blank(coverage.vlsfo)}</td>
                          <td>{blank(coverage.lsmgo)}</td>
                        </tr>
                      ))}
                      {selectedSupplier.coverage.length === 0 ? <tr><td colSpan={5}>No coverage rows.</td></tr> : null}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          ) : (
            <p className="spc-empty">No supplier selected.</p>
          )}
        </section>
      </div>
    </SpcShell>
  )
}
