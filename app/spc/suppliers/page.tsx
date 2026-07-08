"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { canAccessSpcPage } from "@/lib/spcPages"
import { useSpcAuth } from "@/lib/useSpcAuth"
import type {
  SaveSpcSupplierBargesInput,
  SaveSpcSupplierInput,
  SpcSupplierBarge,
  SpcSupplierDataset,
  SpcSupplierFixture,
  SpcSupplierInfoInput,
  SpcSupplierLegacyFixture,
  SpcSupplierRecord,
} from "@/lib/spcSupplierTypes"

type SupplierResponse = SpcSupplierDataset & {
  message?: string
}

type SupplierDraft = {
  key: string
  name: string
  paymentTerms: string
  qualityClaimBar: string
  supplierTrader: string
  availableGrade: string[]
  foBdn: string
  goBdn: string
}

type BargeDraft = Omit<SpcSupplierBarge, "source">

const gradeOptions = [
  { value: "HSFO", className: "is-hsfo" },
  { value: "VLSFO", className: "is-vlsfo" },
  { value: "LSMGO", className: "is-lsmgo" },
]

const bargeGradeOptions = gradeOptions.map((option) => option.value)

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

function isBelowThirty(value: string | null | undefined) {
  const number = Number(String(value ?? "").match(/\d+(?:\.\d+)?/)?.[0] || Number.NaN)
  return Number.isFinite(number) && number < 30
}

function draftFromRecord(record?: SpcSupplierRecord): SupplierDraft {
  return {
    key: record?.key || "",
    name: record?.name || "",
    paymentTerms: record?.info.paymentTerms || "",
    qualityClaimBar: record?.info.qualityClaimBar || "",
    supplierTrader: record?.info.supplierTrader || "",
    availableGrade: gradeTokens(record?.info.availableGrade || ""),
    foBdn: record?.info.foBdn || "",
    goBdn: record?.info.goBdn || "",
  }
}

function draftInfo(draft: SupplierDraft): SpcSupplierInfoInput {
  return {
    paymentTerms: draft.paymentTerms.trim(),
    qualityClaimBar: draft.qualityClaimBar.trim(),
    supplierTrader: draft.supplierTrader.trim(),
    availableGrade: draft.availableGrade.join(", "),
    foBdn: draft.foBdn.trim(),
    goBdn: draft.goBdn.trim(),
  }
}

function bargeDraftsFromRecord(record: SpcSupplierRecord): BargeDraft[] {
  return record.barges.map((barge, index) => ({
    id: barge.id || `${record.key}-BARGE-${index + 1}`,
    bargeName: barge.bargeName,
    imo: barge.imo,
    grade: barge.grade,
    capacity: barge.capacity,
  }))
}

function bargePayload(supplierKey: string, drafts: BargeDraft[]): SaveSpcSupplierBargesInput {
  return {
    supplierKey,
    barges: drafts.map((draft) => ({
      id: draft.id,
      bargeName: draft.bargeName.trim(),
      imo: draft.imo.trim(),
      grade: draft.grade.trim(),
      capacity: draft.capacity.trim(),
    })),
  }
}

function GradeCells({ value }: { value: string }) {
  const selected = new Set(gradeTokens(value))
  return (
    <div className="spc-supplier-grade-grid">
      {gradeOptions.map((grade) => {
        const active = selected.has(grade.value)
        return (
          <span
            key={grade.value}
            className={`${grade.className}${active ? "" : " is-empty"}`}
          >
            {active ? grade.value : ""}
          </span>
        )
      })}
    </div>
  )
}

function SupplierWarning({ label }: { label: string }) {
  return (
    <span className="spc-supplier-warning" title={label} aria-label={label}>
      !
    </span>
  )
}

function SupplierEditDialog({
  draft,
  traderOptions,
  saving,
  onChange,
  onClose,
  onSave,
  onDelete,
}: {
  draft: SupplierDraft
  traderOptions: string[]
  saving: boolean
  onChange: (draft: SupplierDraft) => void
  onClose: () => void
  onSave: () => void
  onDelete: () => void
}) {
  const isExisting = Boolean(draft.key)
  const update = (field: keyof SupplierDraft, value: string | string[]) => {
    onChange({ ...draft, [field]: value })
  }
  const toggleGrade = (grade: string) => {
    const selected = new Set(draft.availableGrade)
    if (selected.has(grade)) selected.delete(grade)
    else selected.add(grade)
    update("availableGrade", gradeOptions.map((option) => option.value).filter((option) => selected.has(option)))
  }

  return (
    <div className="spc-supplier-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="spc-supplier-modal is-edit" role="dialog" aria-modal="true" aria-label="Edit supplier" onMouseDown={(event) => event.stopPropagation()}>
        <div className="spc-supplier-modal-header">
          <div>
            <h2>{isExisting ? draft.name : "ADD NEW SUPPLIER"}</h2>
            <p>SUPPLIER DETAILS</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving}>Close</button>
        </div>
        <div className="spc-supplier-edit-form">
          <label className="is-wide">
            <span>SUPPLIER</span>
            <input value={draft.name} onChange={(event) => update("name", event.target.value)} disabled={saving || isExisting} />
          </label>
          <label>
            <span>PAYMENT TERMS</span>
            <input value={draft.paymentTerms} inputMode="numeric" onChange={(event) => update("paymentTerms", event.target.value)} disabled={saving} />
          </label>
          <label>
            <span>QUALITY CLAIM BAR</span>
            <input value={draft.qualityClaimBar} inputMode="numeric" onChange={(event) => update("qualityClaimBar", event.target.value)} disabled={saving} />
          </label>
          <label className="is-wide">
            <span>SUPPLIER TRADER</span>
            <input list="spc-supplier-traders" value={draft.supplierTrader} onChange={(event) => update("supplierTrader", event.target.value)} disabled={saving} />
            <datalist id="spc-supplier-traders">
              {traderOptions.map((trader) => <option key={trader} value={trader} />)}
            </datalist>
          </label>
          <div className="spc-supplier-grade-editor is-wide">
            <span>AVAILABLE GRADE</span>
            <div>
              {gradeOptions.map((grade) => (
                <label key={grade.value} className={grade.className}>
                  <input
                    type="checkbox"
                    checked={draft.availableGrade.includes(grade.value)}
                    onChange={() => toggleGrade(grade.value)}
                    disabled={saving}
                  />
                  <span>{grade.value}</span>
                </label>
              ))}
            </div>
          </div>
          <label>
            <span>FO BDN</span>
            <input value={draft.foBdn} onChange={(event) => update("foBdn", event.target.value)} disabled={saving} />
          </label>
          <label>
            <span>GO BDN</span>
            <input value={draft.goBdn} onChange={(event) => update("goBdn", event.target.value)} disabled={saving} />
          </label>
        </div>
        <div className="spc-supplier-edit-actions">
          {isExisting ? (
            <button type="button" className="is-danger" onClick={onDelete} disabled={saving}>DELETE</button>
          ) : <span />}
          <button type="button" onClick={onClose} disabled={saving}>CANCEL</button>
          <button type="button" className="is-primary" onClick={onSave} disabled={saving}>
            {saving ? "SAVING" : "SAVE"}
          </button>
        </div>
      </section>
    </div>
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

function BargeFleetDialog({
  supplier,
  drafts,
  saving,
  onChange,
  onClose,
  onSave,
}: {
  supplier: SpcSupplierRecord
  drafts: BargeDraft[]
  saving: boolean
  onChange: (drafts: BargeDraft[]) => void
  onClose: () => void
  onSave: () => void
}) {
  const updateDraft = (index: number, field: keyof BargeDraft, value: string) => {
    onChange(drafts.map((draft, draftIndex) =>
      draftIndex === index ? { ...draft, [field]: value } : draft,
    ))
  }
  const addDraft = () => {
    onChange([
      ...drafts,
      {
        id: `${supplier.key}-BARGE-${Date.now()}`,
        bargeName: "",
        imo: "",
        grade: "",
        capacity: "",
      },
    ])
  }
  const removeDraft = (index: number) => {
    onChange(drafts.filter((_, draftIndex) => draftIndex !== index))
  }

  return (
    <div className="spc-supplier-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="spc-supplier-modal is-wide" role="dialog" aria-modal="true" aria-label={`${supplier.name} barge fleet`} onMouseDown={(event) => event.stopPropagation()}>
        <div className="spc-supplier-modal-header">
          <div>
            <h2>{supplier.name}</h2>
            <p>BARGE FLEET · {drafts.length}</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving}>Close</button>
        </div>
        <div className="spc-supplier-barge-panel">
          <div className="spc-table-wrap">
            <table className="spc-table spc-supplier-popup-table spc-supplier-barge-table">
              <thead>
                <tr>
                  <th>BARGE NAME</th>
                  <th>IMO</th>
                  <th>GRADE</th>
                  <th>CAPACITY</th>
                  <th>REMOVE</th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((draft, index) => (
                  <tr key={draft.id || index}>
                    <td>
                      <input
                        value={draft.bargeName}
                        onChange={(event) => updateDraft(index, "bargeName", event.target.value)}
                        disabled={saving}
                      />
                    </td>
                    <td>
                      <input
                        value={draft.imo}
                        inputMode="numeric"
                        onChange={(event) => updateDraft(index, "imo", event.target.value)}
                        disabled={saving}
                      />
                    </td>
                    <td>
                      <select
                        value={draft.grade}
                        onChange={(event) => updateDraft(index, "grade", event.target.value)}
                        disabled={saving}
                      >
                        <option value="">-</option>
                        {bargeGradeOptions.map((grade) => (
                          <option key={grade} value={grade}>{grade}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        value={draft.capacity}
                        placeholder="MTS / CBM"
                        onChange={(event) => updateDraft(index, "capacity", event.target.value)}
                        disabled={saving}
                      />
                    </td>
                    <td>
                      <button type="button" className="spc-supplier-mini-button is-danger" onClick={() => removeDraft(index)} disabled={saving}>
                        REMOVE
                      </button>
                    </td>
                  </tr>
                ))}
                {drafts.length === 0 ? (
                  <tr><td colSpan={5}>NO BARGE RECORDS.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
        <div className="spc-supplier-edit-actions">
          <button type="button" onClick={addDraft} disabled={saving}>ADD BARGE</button>
          <button type="button" onClick={onClose} disabled={saving}>CANCEL</button>
          <button type="button" className="is-primary" onClick={onSave} disabled={saving}>
            {saving ? "SAVING" : "SAVE"}
          </button>
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
  const [traderFilter, setTraderFilter] = useState("ALL")
  const [gradeFilter, setGradeFilter] = useState("ALL")
  const [requestedSupplier, setRequestedSupplier] = useState("")
  const [moreInfoKey, setMoreInfoKey] = useState("")
  const [fixtureKey, setFixtureKey] = useState("")
  const [bargeKey, setBargeKey] = useState("")
  const [bargeDrafts, setBargeDrafts] = useState<BargeDraft[]>([])
  const [editingDraft, setEditingDraft] = useState<SupplierDraft | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [messageIsError, setMessageIsError] = useState(false)

  const canView = authenticated && canAccessSpcPage(permissions, "spc-suppliers", "view")
  const canEdit = authenticated && canAccessSpcPage(permissions, "spc-suppliers", "edit")
  const hasPermissionSnapshot = Object.prototype.hasOwnProperty.call(permissions, "spc-suppliers")
  const records = dataset?.records || []
  const searchValue = query.trim().toLowerCase()

  const traderOptions = useMemo(() => {
    return Array.from(new Set(records.map((record) => record.info.supplierTrader.trim()).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b))
  }, [records])

  const filteredRecords = useMemo(() => {
    const filtered = records.filter((record) => {
      if (searchValue && !record.searchText.includes(searchValue)) return false
      if (traderFilter !== "ALL" && traderFilter !== "SORT" && record.info.supplierTrader.trim() !== traderFilter) return false
      if (gradeFilter !== "ALL" && !gradeTokens(record.info.availableGrade).includes(gradeFilter)) return false
      return true
    })
    if (traderFilter !== "SORT") return filtered
    return [...filtered].sort((a, b) =>
      a.info.supplierTrader.localeCompare(b.info.supplierTrader) ||
      a.name.localeCompare(b.name),
    )
  }, [records, searchValue, traderFilter, gradeFilter])

  const moreInfoSupplier = records.find((record) => record.key === moreInfoKey) || null
  const fixtureSupplier = records.find((record) => record.key === fixtureKey) || null
  const bargeSupplier = records.find((record) => record.key === bargeKey) || null

  function openEditor(record?: SpcSupplierRecord) {
    if (!canEdit) return
    setEditingDraft(draftFromRecord(record))
    setMessage("")
  }

  function openBargeEditor(record: SpcSupplierRecord) {
    setBargeKey(record.key)
    setBargeDrafts(bargeDraftsFromRecord(record))
    setMessage("")
  }

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

  async function saveSupplierDraft() {
    if (!editingDraft) return
    const supplier: SaveSpcSupplierInput = {
      key: editingDraft.key,
      name: editingDraft.name,
      info: draftInfo(editingDraft),
    }
    setSaving(true)
    setMessage("")
    try {
      const response = await fetch("/api/spc/suppliers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", supplier }),
      })
      const data = (await response.json()) as SupplierResponse
      if (!response.ok) throw new Error(data.message || "Failed to save supplier.")
      setDataset(data)
      setEditingDraft(null)
      setMessage("Supplier saved.")
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save supplier.")
      setMessageIsError(true)
    } finally {
      setSaving(false)
    }
  }

  async function deleteSupplierDraft() {
    if (!editingDraft?.key) return
    if (!window.confirm(`Delete ${editingDraft.name}?`)) return
    setSaving(true)
    setMessage("")
    try {
      const response = await fetch("/api/spc/suppliers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", key: editingDraft.key }),
      })
      const data = (await response.json()) as SupplierResponse
      if (!response.ok) throw new Error(data.message || "Failed to delete supplier.")
      setDataset(data)
      setEditingDraft(null)
      setMessage("Supplier deleted.")
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to delete supplier.")
      setMessageIsError(true)
    } finally {
      setSaving(false)
    }
  }

  async function saveBargeDrafts() {
    if (!bargeSupplier) return
    setSaving(true)
    setMessage("")
    try {
      const response = await fetch("/api/spc/suppliers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save-barges",
          barges: bargePayload(bargeSupplier.key, bargeDrafts),
        }),
      })
      const data = (await response.json()) as SupplierResponse
      if (!response.ok) throw new Error(data.message || "Failed to save barge fleet.")
      setDataset(data)
      setBargeKey("")
      setBargeDrafts([])
      setMessage("Barge fleet saved.")
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save barge fleet.")
      setMessageIsError(true)
    } finally {
      setSaving(false)
    }
  }

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

  useEffect(() => {
    if (traderFilter !== "ALL" && traderFilter !== "SORT" && !traderOptions.includes(traderFilter)) {
      setTraderFilter("ALL")
    }
  }, [traderFilter, traderOptions])

  if (authLoading || !authenticated || !hasPermissionSnapshot || !canView) {
    return <div className="spc-loading">Loading...</div>
  }

  return (
    <SpcShell title="SPC Supplier Database">
      <div className="spc-supplier-db-page">
        <div className="spc-supplier-toolbar">
          <div className="spc-supplier-add-group">
            <button type="button" onClick={() => openEditor()} disabled={!canEdit}>
              ADD NEW SUPPLIER
            </button>
            <span>
              {filteredRecords.length === records.length
                ? `TOTAL: ${records.length} SUPPLIERS`
                : `TOTAL: ${filteredRecords.length} / ${records.length} SUPPLIERS`}
            </span>
          </div>
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

        {message ? <div className={messageIsError ? "spc-alert is-error" : "spc-alert"}>{message}</div> : null}

        <section className="spc-supplier-ledger-panel">
          <div className="spc-table-wrap">
            <table className="spc-table spc-supplier-ledger-table">
              <thead>
                <tr>
                  <th>SUPPLIER</th>
                  <th>PAYMENT TERMS</th>
                  <th>QUALITY CLAIM BAR</th>
                  <th>
                    <label className="spc-supplier-header-menu">
                      <span className="sr-only">Filter or sort supplier trader</span>
                      <select value={traderFilter} onChange={(event) => setTraderFilter(event.target.value)}>
                        <option value="ALL">ALL TRADERS</option>
                        <option value="SORT">SORT BY NAME OF TRADER</option>
                        {traderOptions.map((trader) => (
                          <option key={trader} value={trader}>{trader}</option>
                        ))}
                      </select>
                    </label>
                  </th>
                  <th>
                    <label className="spc-supplier-header-menu">
                      <span className="sr-only">Filter by available grade</span>
                      <select value={gradeFilter} onChange={(event) => setGradeFilter(event.target.value)}>
                        <option value="ALL">ALL GRADES</option>
                        {gradeOptions.map((grade) => (
                          <option key={grade.value} value={grade.value}>{grade.value}</option>
                        ))}
                      </select>
                    </label>
                  </th>
                  <th>INFORMATION</th>
                </tr>
              </thead>
              <tbody>
                {filteredRecords.map((record) => (
                  <tr key={record.key}>
                    <td><strong>{record.name}</strong></td>
                    <td className={isBelowThirty(record.info.paymentTerms) ? "is-supplier-alert-value" : ""}>
                      {blank(record.info.paymentTerms)}
                    </td>
                    <td className={isBelowThirty(record.info.qualityClaimBar) ? "is-supplier-alert-value" : ""}>
                      {blank(record.info.qualityClaimBar)}
                    </td>
                    <td>{blank(record.info.supplierTrader)}</td>
                    <td><GradeCells value={record.info.availableGrade} /></td>
                    <td>
                      <div className="spc-supplier-info-actions">
                        <button type="button" className="spc-supplier-mini-button is-more" onClick={() => setMoreInfoKey(record.key)}>
                          BDN
                        </button>
                        <button type="button" className="spc-supplier-mini-button is-fixtures" onClick={() => setFixtureKey(record.key)} title={fixtureSummary(record.fixtures)}>
                          FIXTURES
                        </button>
                        <button
                          type="button"
                          className={`spc-supplier-mini-button is-barge${record.barges.length > 0 ? " has-barges" : ""}`}
                          onClick={() => openBargeEditor(record)}
                          title={`${record.barges.length} BARGE${record.barges.length === 1 ? "" : "S"}`}
                        >
                          BARGE FLEET ({record.barges.length})
                        </button>
                        <button type="button" className="spc-supplier-mini-button is-edit" onClick={() => openEditor(record)} disabled={!canEdit}>
                          EDIT
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!loading && filteredRecords.length === 0 ? (
                  <tr><td colSpan={6}>NO SUPPLIERS FOUND.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <LegacyFixtureList fixtures={dataset?.legacyFixtures || []} />

        {moreInfoSupplier ? <MoreInfoDialog supplier={moreInfoSupplier} onClose={() => setMoreInfoKey("")} /> : null}
        {fixtureSupplier ? <FixtureDialog supplier={fixtureSupplier} onClose={() => setFixtureKey("")} /> : null}
        {bargeSupplier ? (
          <BargeFleetDialog
            supplier={bargeSupplier}
            drafts={bargeDrafts}
            saving={saving}
            onChange={setBargeDrafts}
            onClose={() => {
              setBargeKey("")
              setBargeDrafts([])
            }}
            onSave={() => void saveBargeDrafts()}
          />
        ) : null}
        {editingDraft ? (
          <SupplierEditDialog
            draft={editingDraft}
            traderOptions={traderOptions}
            saving={saving}
            onChange={setEditingDraft}
            onClose={() => setEditingDraft(null)}
            onSave={() => void saveSupplierDraft()}
            onDelete={() => void deleteSupplierDraft()}
          />
        ) : null}
      </div>
    </SpcShell>
  )
}
