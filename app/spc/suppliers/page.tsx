"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { canAccessSpcPage } from "@/lib/spcPages"
import { useSpcAuth } from "@/lib/useSpcAuth"
import type {
  SaveSpcSupplierBargesInput,
  SaveSpcSupplierContactsInput,
  SaveSpcSupplierInput,
  SpcSupplierBarge,
  SpcSupplierContact,
  SpcSupplierDataset,
  SpcSupplierFixture,
  SpcSupplierInfoInput,
  SpcSupplierLegacyFixture,
  SpcSupplierRecord,
  SpcSupplierEditVersions,
  SpcSupplierMutation,
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
  expectedVersions?: SpcSupplierEditVersions
}

type BargeDraft = Omit<SpcSupplierBarge, "source">
type ContactDraft = Omit<SpcSupplierContact, "source">

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
    expectedVersions: record?.editVersions,
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

function bargePayload(supplierKey: string, drafts: BargeDraft[], mutation: SpcSupplierMutation): SaveSpcSupplierBargesInput {
  return {
    supplierKey,
    ...mutation,
    barges: drafts.map((draft) => ({
      id: draft.id,
      bargeName: draft.bargeName.trim(),
      imo: draft.imo.trim(),
      grade: draft.grade.trim(),
      capacity: draft.capacity.trim(),
    })),
  }
}

function contactDraftsFromRecord(record: SpcSupplierRecord): ContactDraft[] {
  return record.contacts.map((contact, index) => ({
    id: contact.id || `${record.key}-CONTACT-${index + 1}`,
    role: contact.role,
    name: contact.name,
    mobile: contact.mobile,
  }))
}

function contactPayload(supplierKey: string, drafts: ContactDraft[], mutation: SpcSupplierMutation): SaveSpcSupplierContactsInput {
  return {
    supplierKey,
    ...mutation,
    contacts: drafts.map((draft) => ({
      id: draft.id,
      role: draft.role,
      name: draft.name.trim(),
      mobile: draft.mobile.trim(),
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
  error,
}: {
  draft: SupplierDraft
  traderOptions: string[]
  saving: boolean
  onChange: (draft: SupplierDraft) => void
  onClose: () => void
  onSave: () => void
  onDelete: () => void
  error: string
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
    <div className="spc-supplier-modal-backdrop" role="presentation" onMouseDown={() => { if (!saving) onClose() }}>
      <section className="spc-supplier-modal is-edit" role="dialog" aria-modal="true" aria-label="Edit supplier" onMouseDown={(event) => event.stopPropagation()}>
        <div className="spc-supplier-modal-header">
          <div>
            <h2>{isExisting ? draft.name : "ADD NEW SUPPLIER"}</h2>
            <p>SUPPLIER DETAILS</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving}>Close</button>
        </div>
        <div className="spc-supplier-edit-form" style={{ minHeight: 0, overflow: "auto" }}>
          {error ? <div role="alert" className="spc-alert is-error" style={{ gridColumn: "1 / -1" }}>{error}</div> : null}
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
  error,
  editable,
}: {
  supplier: SpcSupplierRecord
  drafts: BargeDraft[]
  saving: boolean
  onChange: (drafts: BargeDraft[]) => void
  onClose: () => void
  onSave: () => void
  error: string
  editable: boolean
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
    <div className="spc-supplier-modal-backdrop" role="presentation" onMouseDown={() => { if (!saving) onClose() }}>
      <section className="spc-supplier-modal is-wide" role="dialog" aria-modal="true" aria-label={`${supplier.name} barge fleet`} onMouseDown={(event) => event.stopPropagation()}>
        <div className="spc-supplier-modal-header">
          <div>
            <h2>{supplier.name}</h2>
            <p>BARGE FLEET · {drafts.length}</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving}>Close</button>
        </div>
        <div className="spc-supplier-barge-panel">
          {error ? <div role="alert" className="spc-alert is-error">{error}</div> : null}
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
                        disabled={saving || !editable}
                      />
                    </td>
                    <td>
                      <input
                        value={draft.imo}
                        inputMode="numeric"
                        onChange={(event) => updateDraft(index, "imo", event.target.value)}
                        disabled={saving || !editable}
                      />
                    </td>
                    <td>
                      <select
                        value={draft.grade}
                        onChange={(event) => updateDraft(index, "grade", event.target.value)}
                        disabled={saving || !editable}
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
                        disabled={saving || !editable}
                      />
                    </td>
                    <td>
                      <button type="button" className="spc-supplier-mini-button is-danger" onClick={() => removeDraft(index)} disabled={saving || !editable}>
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
          <button type="button" onClick={addDraft} disabled={saving || !editable}>ADD BARGE</button>
          <button type="button" onClick={onClose} disabled={saving}>CANCEL</button>
          <button type="button" className="is-primary" onClick={onSave} disabled={saving || !editable}>
            {saving ? "SAVING" : "SAVE"}
          </button>
        </div>
      </section>
    </div>
  )
}

function ContactDialog({
  supplier,
  drafts,
  saving,
  onChange,
  onClose,
  onSave,
  error,
  editable,
}: {
  supplier: SpcSupplierRecord
  drafts: ContactDraft[]
  saving: boolean
  onChange: (drafts: ContactDraft[]) => void
  onClose: () => void
  onSave: () => void
  error: string
  editable: boolean
}) {
  const updateDraft = (index: number, field: keyof ContactDraft, value: string) => {
    onChange(drafts.map((draft, draftIndex) =>
      draftIndex === index ? { ...draft, [field]: value } : draft,
    ))
  }
  const addDraft = (role: ContactDraft["role"]) => {
    onChange([
      ...drafts,
      {
        id: `${supplier.key}-CONTACT-${Date.now()}`,
        role,
        name: "",
        mobile: "",
      },
    ])
  }
  const removeDraft = (index: number) => {
    onChange(drafts.filter((_, draftIndex) => draftIndex !== index))
  }

  return (
    <div className="spc-supplier-modal-backdrop" role="presentation" onMouseDown={() => { if (!saving) onClose() }}>
      <section className="spc-supplier-modal is-wide" role="dialog" aria-modal="true" aria-label={`${supplier.name} contacts`} onMouseDown={(event) => event.stopPropagation()}>
        <div className="spc-supplier-modal-header">
          <div>
            <h2>{supplier.name}</h2>
            <p>CONTACT</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving}>Close</button>
        </div>
        <div className="spc-supplier-barge-panel">
          {error ? <div role="alert" className="spc-alert is-error">{error}</div> : null}
          <div className="spc-table-wrap">
            <table className="spc-table spc-supplier-popup-table spc-supplier-contact-table">
              <thead>
                <tr>
                  <th>ROLE</th>
                  <th>CONTACT</th>
                  <th>MOBILE</th>
                  <th>REMOVE</th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((draft, index) => (
                  <tr key={draft.id || index}>
                    <td>
                      <select
                        value={draft.role}
                        onChange={(event) => updateDraft(index, "role", event.target.value)}
                        disabled={saving || !editable}
                      >
                        <option value="sales">SALES</option>
                        <option value="ops">OPS</option>
                      </select>
                    </td>
                    <td>
                      <input
                        value={draft.name}
                        onChange={(event) => updateDraft(index, "name", event.target.value)}
                        disabled={saving || !editable}
                      />
                    </td>
                    <td>
                      <input
                        value={draft.mobile}
                        inputMode="tel"
                        onChange={(event) => updateDraft(index, "mobile", event.target.value)}
                        disabled={saving || !editable}
                      />
                    </td>
                    <td>
                      <button type="button" className="spc-supplier-mini-button is-danger" onClick={() => removeDraft(index)} disabled={saving || !editable}>
                        REMOVE
                      </button>
                    </td>
                  </tr>
                ))}
                {drafts.length === 0 ? (
                  <tr><td colSpan={4}>NO CONTACT RECORDS.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
        <div className="spc-supplier-edit-actions is-contact-actions">
          <button type="button" onClick={() => addDraft("sales")} disabled={saving || !editable}>ADD SALES</button>
          <button type="button" onClick={() => addDraft("ops")} disabled={saving || !editable}>ADD OPS</button>
          <button type="button" onClick={onClose} disabled={saving}>CANCEL</button>
          <button type="button" className="is-primary" onClick={onSave} disabled={saving || !editable}>
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
  const [bargeSupplier, setBargeSupplier] = useState<SpcSupplierRecord | null>(null)
  const [bargeDrafts, setBargeDrafts] = useState<BargeDraft[]>([])
  const [contactSupplier, setContactSupplier] = useState<SpcSupplierRecord | null>(null)
  const [contactDrafts, setContactDrafts] = useState<ContactDraft[]>([])
  const [editingDraft, setEditingDraft] = useState<SupplierDraft | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [messageIsError, setMessageIsError] = useState(false)
  const saveIntent = useRef<{ fingerprint: string; requestId: string } | null>(null)
  const savingRef = useRef(false)
  const loadGeneration = useRef(0)

  const canView = authenticated && canAccessSpcPage(permissions, "spc-suppliers", "view")
  const canEdit = authenticated && canAccessSpcPage(permissions, "spc-suppliers", "edit")
  const hasPermissionSnapshot = Object.prototype.hasOwnProperty.call(permissions, "spc-suppliers")
  const records = useMemo(() => dataset?.records || [], [dataset])
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

  function openEditor(record?: SpcSupplierRecord) {
    if (!canEdit || savingRef.current) return
    saveIntent.current = null
    setEditingDraft(draftFromRecord(record))
    setMessage("")
  }

  function openBargeEditor(record: SpcSupplierRecord) {
    if (savingRef.current) return
    saveIntent.current = null
    setBargeSupplier(record)
    setBargeDrafts(bargeDraftsFromRecord(record))
    setMessage("")
  }

  function openContactEditor(record: SpcSupplierRecord) {
    if (savingRef.current) return
    saveIntent.current = null
    setContactSupplier(record)
    setContactDrafts(contactDraftsFromRecord(record))
    setMessage("")
  }

  const loadData = useCallback(async () => {
    if (!canView) return
    const generation = ++loadGeneration.current
    setLoading(true)
    setMessage("")
    try {
      const response = await fetch("/api/spc/suppliers", { cache: "no-store" })
      const data = (await response.json()) as SupplierResponse
      if (!response.ok) throw new Error(data.message || "Failed to load supplier database.")
      if (generation !== loadGeneration.current) return
      setDataset(data)
      setMessage((data.warnings || []).join(" "))
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
      if (generation !== loadGeneration.current) return
      setMessage(error instanceof Error ? error.message : "Failed to load supplier database.")
      setMessageIsError(true)
    } finally {
      if (generation === loadGeneration.current) setLoading(false)
    }
  }, [canView, requestedSupplier])

  function mutationFor(intent: object, expectedVersions?: Partial<SpcSupplierEditVersions>): SpcSupplierMutation {
    const fingerprint = JSON.stringify([intent, expectedVersions || {}])
    if (saveIntent.current?.fingerprint !== fingerprint) {
      saveIntent.current = { fingerprint, requestId: crypto.randomUUID() }
    }
    return { requestId: saveIntent.current.requestId, expectedVersions }
  }

  function beginSave() {
    if (!canEdit || savingRef.current) return false
    savingRef.current = true
    ++loadGeneration.current
    setLoading(false)
    setSaving(true)
    setMessage("")
    return true
  }

  function verifySave(data: SupplierResponse, requestId: string) {
    if (!data.mutation || data.mutation.requestId !== requestId || !Array.isArray(data.records)) {
      throw new Error("Supplier save could not be verified. Your draft is kept. Retry the same save to check its result.")
    }
  }

  async function saveSupplierDraft() {
    if (!editingDraft || !beginSave()) return
    const values = { key: editingDraft.key, name: editingDraft.name, info: draftInfo(editingDraft) }
    const supplier: SaveSpcSupplierInput = {
      ...values,
      ...mutationFor({ action: "save", ...values }, editingDraft.expectedVersions),
    }
    try {
      const response = await fetch("/api/spc/suppliers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", supplier }),
      })
      const data = (await response.json()) as SupplierResponse
      if (!response.ok) throw new Error(data.message || "Failed to save supplier.")
      verifySave(data, supplier.requestId)
      setDataset(data)
      setEditingDraft(null)
      setMessage("Supplier saved.")
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save supplier.")
      setMessageIsError(true)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  async function deleteSupplierDraft() {
    if (!editingDraft?.key) return
    if (!window.confirm(`Delete ${editingDraft.name}?`)) return
    if (!beginSave()) return
    const mutation = mutationFor({ action: "delete", key: editingDraft.key }, editingDraft.expectedVersions)
    try {
      const response = await fetch("/api/spc/suppliers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", key: editingDraft.key, ...mutation }),
      })
      const data = (await response.json()) as SupplierResponse
      if (!response.ok) throw new Error(data.message || "Failed to delete supplier.")
      verifySave(data, mutation.requestId)
      setDataset(data)
      setEditingDraft(null)
      setMessage("Supplier deleted.")
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to delete supplier.")
      setMessageIsError(true)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  async function saveBargeDrafts() {
    if (!bargeSupplier || !beginSave()) return
    const mutation = mutationFor({ action: "save-barges", key: bargeSupplier.key, drafts: bargeDrafts }, { barges: bargeSupplier.editVersions.barges })
    try {
      const response = await fetch("/api/spc/suppliers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save-barges",
          barges: bargePayload(bargeSupplier.key, bargeDrafts, mutation),
        }),
      })
      const data = (await response.json()) as SupplierResponse
      if (!response.ok) throw new Error(data.message || "Failed to save barge fleet.")
      verifySave(data, mutation.requestId)
      setDataset(data)
      setBargeSupplier(null)
      setBargeDrafts([])
      setMessage("Barge fleet saved.")
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save barge fleet.")
      setMessageIsError(true)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  async function saveContactDrafts() {
    if (!contactSupplier || !beginSave()) return
    const mutation = mutationFor({ action: "save-contacts", key: contactSupplier.key, drafts: contactDrafts }, { contacts: contactSupplier.editVersions.contacts })
    try {
      const response = await fetch("/api/spc/suppliers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save-contacts",
          contacts: contactPayload(contactSupplier.key, contactDrafts, mutation),
        }),
      })
      const data = (await response.json()) as SupplierResponse
      if (!response.ok) throw new Error(data.message || "Failed to save contacts.")
      verifySave(data, mutation.requestId)
      setDataset(data)
      setContactSupplier(null)
      setContactDrafts([])
      setMessage("Contacts saved.")
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save contacts.")
      setMessageIsError(true)
    } finally {
      savingRef.current = false
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
              {loading && records.length === 0
                ? "TOTAL: LOADING SUPPLIERS..."
                : filteredRecords.length === records.length
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
          <button type="button" onClick={() => void loadData()} disabled={loading || saving}>
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
                    <td>
                      <button
                        type="button"
                        className="spc-supplier-name-button"
                        onClick={() => openEditor(record)}
                        disabled={!canEdit}
                        title={canEdit ? "Edit supplier" : undefined}
                      >
                        {record.name}
                      </button>
                    </td>
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
                        <button
                          type="button"
                          className={`spc-supplier-mini-button is-contact${record.contacts.length > 0 ? " has-contacts" : ""}`}
                          onClick={() => openContactEditor(record)}
                          title={`${record.contacts.length} CONTACT${record.contacts.length === 1 ? "" : "S"}`}
                        >
                          CONTACT
                        </button>
                        <button
                          type="button"
                          className={`spc-supplier-mini-button is-barge${record.barges.length > 0 ? " has-barges" : ""}`}
                          onClick={() => openBargeEditor(record)}
                          title={`${record.barges.length} BARGE${record.barges.length === 1 ? "" : "S"}`}
                        >
                          BARGE FLEET ({record.barges.length})
                        </button>
                        <button type="button" className="spc-supplier-mini-button is-fixtures" onClick={() => setFixtureKey(record.key)} title={fixtureSummary(record.fixtures)}>
                          FIXTURES
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
            editable={canEdit && Boolean(bargeSupplier.editVersions.barges)}
            drafts={bargeDrafts}
            saving={saving}
            error={messageIsError ? message : ""}
            onChange={setBargeDrafts}
            onClose={() => {
              if (savingRef.current) return
              setBargeSupplier(null)
              setBargeDrafts([])
            }}
            onSave={() => void saveBargeDrafts()}
          />
        ) : null}
        {contactSupplier ? (
          <ContactDialog
            supplier={contactSupplier}
            editable={canEdit && Boolean(contactSupplier.editVersions.contacts)}
            drafts={contactDrafts}
            saving={saving}
            error={messageIsError ? message : ""}
            onChange={setContactDrafts}
            onClose={() => {
              if (savingRef.current) return
              setContactSupplier(null)
              setContactDrafts([])
            }}
            onSave={() => void saveContactDrafts()}
          />
        ) : null}
        {editingDraft ? (
          <SupplierEditDialog
            draft={editingDraft}
            traderOptions={traderOptions}
            saving={saving}
            error={messageIsError ? message : ""}
            onChange={setEditingDraft}
            onClose={() => { if (!savingRef.current) setEditingDraft(null) }}
            onSave={() => void saveSupplierDraft()}
            onDelete={() => void deleteSupplierDraft()}
          />
        ) : null}
      </div>
    </SpcShell>
  )
}
