"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { useSpcAuth } from "@/lib/useSpcAuth"
import { canAccessSpcPage } from "@/lib/spcPages"
import type { SpcEnquiryMeta } from "@/lib/spcEnquiryText"

type SpcEnquiry = {
  id: string
  title: string
  vesselName: string | null
  product: string | null
  deliveryDate: string | null
  supplierName: string | null
  formattedText: string
  createdByDisplayName: string
  createdAt: string
  updatedAt: string
  meta: SpcEnquiryMeta
}

type FixtureDraft = {
  supplier: string
  eta: string
  hsfo: string
  vlsfo: string
  lsmgo: string
  price: string
  barging: string
}

const emptyFixture: FixtureDraft = {
  supplier: "",
  eta: "",
  hsfo: "",
  vlsfo: "",
  lsmgo: "",
  price: "",
  barging: "",
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

function extractFuel(text: string, aliases: string[]) {
  const pattern = new RegExp(`\\b(${aliases.join("|")})\\b\\s*([^/\\n]+)`, "i")
  const match = text.match(pattern)
  return match ? match[2].trim() : ""
}

function draftFromEnquiry(enquiry: SpcEnquiry): FixtureDraft {
  const text = `${enquiry.product || ""} / ${enquiry.formattedText || ""}`
  return {
    supplier: enquiry.meta?.fixtureSupplier || enquiry.supplierName || "",
    eta: enquiry.meta?.eta || enquiry.deliveryDate || "",
    hsfo: enquiry.meta?.hsfo || extractFuel(text, ["hsfo", "ifo"]),
    vlsfo: enquiry.meta?.vlsfo || extractFuel(text, ["vlsfo", "lsfo"]),
    lsmgo: enquiry.meta?.lsmgo || extractFuel(text, ["lsmgo", "mgo"]),
    price: enquiry.meta?.price || "",
    barging: enquiry.meta?.barging || "",
  }
}

export default function SpcFixturesPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions } = useSpcAuth()
  const [enquiries, setEnquiries] = useState<SpcEnquiry[]>([])
  const [suppliers, setSuppliers] = useState<string[]>([])
  const [drafts, setDrafts] = useState<Record<string, FixtureDraft>>({})
  const [loading, setLoading] = useState(false)
  const [savingId, setSavingId] = useState("")
  const [message, setMessage] = useState("")
  const [messageIsError, setMessageIsError] = useState(false)

  const canView = authenticated && canAccessSpcPage(permissions, "spc-fixtures", "view")
  const canEdit = authenticated && canAccessSpcPage(permissions, "spc-fixtures", "edit")
  const hasPermissionSnapshot = Object.prototype.hasOwnProperty.call(permissions, "spc-fixtures")

  const supplierOptions = useMemo(() => {
    const seen = new Set<string>()
    const values = [...suppliers]
    Object.values(drafts).forEach((draft) => {
      if (draft.supplier) values.push(draft.supplier)
    })
    return values.filter((supplier) => {
      const key = supplier.toLowerCase()
      if (!supplier || seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [drafts, suppliers])

  const loadData = useCallback(async () => {
    if (!canView) return
    setLoading(true)
    setMessage("")
    try {
      const [enquiryResponse, supplierResponse] = await Promise.all([
        fetch("/api/spc/enquiries?status=quoted&limit=250", { cache: "no-store" }),
        fetch("/api/spc/suppliers", { cache: "no-store" }),
      ])
      const enquiryData = (await enquiryResponse.json()) as { enquiries?: SpcEnquiry[]; message?: string }
      const supplierData = (await supplierResponse.json()) as { suppliers?: string[]; message?: string }
      if (!enquiryResponse.ok) throw new Error(enquiryData.message || "Failed to load fixtures.")
      if (!supplierResponse.ok) throw new Error(supplierData.message || "Failed to load suppliers.")

      const rows = enquiryData.enquiries || []
      setEnquiries(rows)
      setSuppliers(supplierData.suppliers || [])
      setDrafts((current) => {
        const next: Record<string, FixtureDraft> = {}
        rows.forEach((enquiry) => {
          next[enquiry.id] = current[enquiry.id] || draftFromEnquiry(enquiry)
        })
        return next
      })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load fixtures.")
      setMessageIsError(true)
    } finally {
      setLoading(false)
    }
  }, [canView])

  useEffect(() => {
    document.title = "SPC Fixtures"
  }, [])

  useEffect(() => {
    if (!authLoading && !authenticated) router.replace("/spc")
    if (!authLoading && authenticated && hasPermissionSnapshot && !canView) router.replace("/spc")
  }, [authLoading, authenticated, canView, hasPermissionSnapshot, router])

  useEffect(() => {
    void loadData()
  }, [loadData])

  function updateDraft(id: string, key: keyof FixtureDraft, value: string) {
    setDrafts((current) => ({
      ...current,
      [id]: {
        ...(current[id] || emptyFixture),
        [key]: value,
      },
    }))
  }

  async function saveFixture(enquiry: SpcEnquiry) {
    if (!canEdit) return
    setSavingId(enquiry.id)
    setMessage("")
    try {
      const response = await fetch("/api/spc/enquiries", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: enquiry.id,
          mode: "fixture",
          fixture: drafts[enquiry.id] || emptyFixture,
        }),
      })
      const data = (await response.json()) as { enquiry?: SpcEnquiry; message?: string }
      if (!response.ok || !data.enquiry) throw new Error(data.message || "Failed to save fixture.")
      setEnquiries((current) => current.map((row) => (row.id === enquiry.id ? data.enquiry! : row)))
      setDrafts((current) => ({ ...current, [enquiry.id]: draftFromEnquiry(data.enquiry!) }))
      setMessage("Fixture saved.")
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save fixture.")
      setMessageIsError(true)
    } finally {
      setSavingId("")
    }
  }

  if (authLoading || !authenticated || !hasPermissionSnapshot || !canView) {
    return <div className="spc-loading">Loading...</div>
  }

  return (
    <SpcShell title="SPC Fixtures">
      <div className="spc-page-heading">
        <div>
          <h1>Fixtures</h1>
          <p>{enquiries.length} stemmed enquiries</p>
        </div>
        <button type="button" className="spc-page-action" onClick={() => void loadData()} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {message ? <div className={messageIsError ? "spc-alert is-error" : "spc-alert"}>{message}</div> : null}

      <section className="spc-panel">
        <div className="spc-table-wrap">
          <table className="spc-table spc-fixture-table">
            <thead>
              <tr>
                <th>DATE</th>
                <th>SUPPLIER</th>
                <th>SUPPLIER TRADER</th>
                <th>BUYER TRADER</th>
                <th>VESSEL NAME</th>
                <th>ETA</th>
                <th>HSFO</th>
                <th>VLSFO</th>
                <th>LSMGO</th>
                <th>PRICE</th>
                <th>BARGING</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {enquiries.map((enquiry) => {
                const draft = drafts[enquiry.id] || emptyFixture
                return (
                  <tr key={enquiry.id}>
                    <td>{displayDate(enquiry.createdAt)}</td>
                    <td>
                      <select value={draft.supplier} onChange={(event) => updateDraft(enquiry.id, "supplier", event.target.value)} disabled={!canEdit}>
                        <option value="">Select supplier</option>
                        {supplierOptions.map((supplier) => (
                          <option key={supplier} value={supplier}>{supplier}</option>
                        ))}
                      </select>
                    </td>
                    <td>{enquiry.meta?.stemSupplierTraderDisplayName || "-"}</td>
                    <td>{enquiry.createdByDisplayName || "-"}</td>
                    <td><strong>{enquiry.vesselName || enquiry.title || "-"}</strong></td>
                    <td><input value={draft.eta} onChange={(event) => updateDraft(enquiry.id, "eta", event.target.value)} disabled={!canEdit} /></td>
                    <td><input value={draft.hsfo} onChange={(event) => updateDraft(enquiry.id, "hsfo", event.target.value)} disabled={!canEdit} /></td>
                    <td><input value={draft.vlsfo} onChange={(event) => updateDraft(enquiry.id, "vlsfo", event.target.value)} disabled={!canEdit} /></td>
                    <td><input value={draft.lsmgo} onChange={(event) => updateDraft(enquiry.id, "lsmgo", event.target.value)} disabled={!canEdit} /></td>
                    <td><input value={draft.price} onChange={(event) => updateDraft(enquiry.id, "price", event.target.value)} disabled={!canEdit} /></td>
                    <td><input value={draft.barging} onChange={(event) => updateDraft(enquiry.id, "barging", event.target.value)} disabled={!canEdit} /></td>
                    <td>
                      <button type="button" onClick={() => void saveFixture(enquiry)} disabled={!canEdit || savingId === enquiry.id}>
                        {savingId === enquiry.id ? "Saving" : "Save"}
                      </button>
                    </td>
                  </tr>
                )
              })}
              {!loading && enquiries.length === 0 ? (
                <tr><td colSpan={12}>No fixtures yet.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </SpcShell>
  )
}
