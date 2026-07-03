"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { useSpcAuth } from "@/lib/useSpcAuth"
import { canAccessSpcPage } from "@/lib/spcPages"

type SpcFixtureStatus = "pending" | "completed" | "cancelled"

type SpcFixture = {
  id: string
  enquiryId: string
  enquiryNumber: string
  enquiryTitle: string
  fixtureStatus: SpcFixtureStatus
  fixtureDate: string | null
  supplierTraderUsername: string
  supplierTraderDisplayName: string
  buyerTraderUsername: string
  buyerTraderDisplayName: string
  account: string | null
  commission: string | null
  earliestEta: string | null
  vesselName: string | null
  hsfo: string | null
  vlsfo: string | null
  lsmgo: string | null
  supplierName: string | null
  supplierKey: string | null
  price: string | null
  barging: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

type SpcUserOption = {
  id: string
  username: string
  displayName: string
  role: string
  office: string
}

type SupplierRecord = {
  key: string
  name: string
}

type FixtureDraft = {
  fixtureDate: string
  supplierTrader: string
  buyerTrader: string
  account: string
  commission: string
  earliestEta: string
  vesselName: string
  hsfo: string
  vlsfo: string
  lsmgo: string
  supplierName: string
  price: string
  barging: string
}

type FixturesResponse = {
  fixtures?: SpcFixture[]
  users?: SpcUserOption[]
  message?: string
}

type SuppliersResponse = {
  records?: SupplierRecord[]
  suppliers?: string[]
  message?: string
}

const emptyDraft: FixtureDraft = {
  fixtureDate: "",
  supplierTrader: "",
  buyerTrader: "",
  account: "",
  commission: "",
  earliestEta: "",
  vesselName: "",
  hsfo: "",
  vlsfo: "",
  lsmgo: "",
  supplierName: "",
  price: "",
  barging: "",
}

const fixtureColumnWidths = [
  86, // date
  126, // supplier trader office
  78, // supplier trader PIC
  130, // customer trader office
  78, // customer trader PIC
  76, // account
  80, // commission
  116, // earliest ETA
  164, // vessel
  78, // HSFO
  78, // VLSFO
  78, // LSMGO
  204, // supplier
  92, // price
  92, // barging
  98, // action
] as const

const fixtureColumnSpan = fixtureColumnWidths.length

function cleanText(value: string | null | undefined) {
  return String(value || "").trim()
}

function userOptionValue(user: Pick<SpcUserOption, "username" | "displayName">) {
  return user.displayName || user.username
}

function traderValue(displayName: string | null | undefined, username: string | null | undefined) {
  const cleanUsername = cleanText(username)
  return cleanText(displayName) || cleanUsername
}

function userFromChoice(users: SpcUserOption[], value: string) {
  const cleaned = cleanText(value)
  if (!cleaned) return null
  const lower = cleaned.toLowerCase()
  const username = cleaned.includes("|") ? cleanText(cleaned.split("|").pop()).toLowerCase() : lower
  return users.find((user) => {
    const userName = user.username.toLowerCase()
    const displayName = user.displayName.toLowerCase()
    const label = userOptionValue(user).toLowerCase()
    return userName === username || userName === lower || displayName === lower || label === lower
  }) || null
}

function traderPic(value: string) {
  const cleaned = cleanText(value)
  if (!cleaned) return "-"
  return cleanText(cleaned.split("|")[0]) || cleaned
}

function dateInput(value: string | null | undefined) {
  const cleanValue = cleanText(value)
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleanValue)) return cleanValue
  const date = new Date(cleanValue)
  if (Number.isNaN(date.getTime())) return ""
  return date.toISOString().slice(0, 10)
}

function displayDate(value: string | null | undefined) {
  if (!value) return "-"
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date)
}

function blank(value: string | null | undefined) {
  return cleanText(value) || "-"
}

function draftFromFixture(fixture: SpcFixture): FixtureDraft {
  return {
    fixtureDate: dateInput(fixture.fixtureDate),
    supplierTrader: traderValue(fixture.supplierTraderDisplayName, fixture.supplierTraderUsername),
    buyerTrader: traderValue(fixture.buyerTraderDisplayName, fixture.buyerTraderUsername),
    account: cleanText(fixture.account),
    commission: cleanText(fixture.commission),
    earliestEta: cleanText(fixture.earliestEta),
    vesselName: cleanText(fixture.vesselName),
    hsfo: cleanText(fixture.hsfo),
    vlsfo: cleanText(fixture.vlsfo),
    lsmgo: cleanText(fixture.lsmgo),
    supplierName: cleanText(fixture.supplierName),
    price: cleanText(fixture.price),
    barging: cleanText(fixture.barging),
  }
}

export default function SpcFixturesPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions } = useSpcAuth()
  const [fixtures, setFixtures] = useState<SpcFixture[]>([])
  const [users, setUsers] = useState<SpcUserOption[]>([])
  const [supplierRecords, setSupplierRecords] = useState<SupplierRecord[]>([])
  const [drafts, setDrafts] = useState<Record<string, FixtureDraft>>({})
  const [editingId, setEditingId] = useState("")
  const [loading, setLoading] = useState(false)
  const [savingId, setSavingId] = useState("")
  const [message, setMessage] = useState("")
  const [messageIsError, setMessageIsError] = useState(false)

  const canView = authenticated && canAccessSpcPage(permissions, "spc-fixtures", "view")
  const canEdit = authenticated && canAccessSpcPage(permissions, "spc-fixtures", "edit")
  const hasPermissionSnapshot = Object.prototype.hasOwnProperty.call(permissions, "spc-fixtures")

  const pendingFixtures = useMemo(
    () => fixtures.filter((fixture) => fixture.fixtureStatus === "pending"),
    [fixtures],
  )
  const completedFixtures = useMemo(
    () => fixtures.filter((fixture) => fixture.fixtureStatus === "completed"),
    [fixtures],
  )

  const supplierOptions = useMemo(() => {
    const values = [
      ...supplierRecords.map((record) => record.name),
      ...fixtures.map((fixture) => fixture.supplierName || ""),
      ...Object.values(drafts).map((draft) => draft.supplierName),
    ]
    const seen = new Set<string>()
    return values
      .map((value) => value.trim())
      .filter((value) => {
        const key = value.toLowerCase()
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
      .sort((a, b) => a.localeCompare(b))
  }, [drafts, fixtures, supplierRecords])

  const loadData = useCallback(async () => {
    if (!canView) return
    setLoading(true)
    setMessage("")
    try {
      const [fixtureResponse, supplierResponse] = await Promise.all([
        fetch("/api/spc/fixtures?limit=500", { cache: "no-store" }),
        fetch("/api/spc/suppliers", { cache: "no-store" }),
      ])
      const fixtureData = (await fixtureResponse.json()) as FixturesResponse
      const supplierData = (await supplierResponse.json()) as SuppliersResponse
      if (!fixtureResponse.ok) throw new Error(fixtureData.message || "Failed to load fixtures.")
      if (!supplierResponse.ok) throw new Error(supplierData.message || "Failed to load suppliers.")

      const rows = fixtureData.fixtures || []
      setFixtures(rows)
      setUsers(fixtureData.users || [])
      setSupplierRecords(supplierData.records || (supplierData.suppliers || []).map((name) => ({ key: name, name })))
      setDrafts((current) => {
        const next: Record<string, FixtureDraft> = {}
        rows.forEach((fixture) => {
          next[fixture.id] = current[fixture.id] || draftFromFixture(fixture)
        })
        return next
      })
      setMessageIsError(false)
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
        ...(current[id] || emptyDraft),
        [key]: value,
      },
    }))
  }

  async function submitFixture(fixture: SpcFixture, action: "save" | "complete") {
    if (!canEdit) return
    setSavingId(`${fixture.id}:${action}`)
    setMessage("")
    try {
      const response = await fetch("/api/spc/fixtures", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: fixture.id,
          action,
          fixture: drafts[fixture.id] || draftFromFixture(fixture),
        }),
      })
      const data = (await response.json()) as { fixture?: SpcFixture; message?: string }
      if (!response.ok || !data.fixture) throw new Error(data.message || "Failed to save fixture.")
      setFixtures((current) => current.map((row) => (row.id === fixture.id ? data.fixture! : row)))
      setDrafts((current) => ({ ...current, [fixture.id]: draftFromFixture(data.fixture!) }))
      setEditingId("")
      setMessage(action === "complete" ? "Fixture completed." : "Fixture saved.")
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save fixture.")
      setMessageIsError(true)
    } finally {
      setSavingId("")
    }
  }

  function supplierHref(fixture: SpcFixture, draft: FixtureDraft) {
    const query = draft.supplierName || fixture.supplierKey || fixture.supplierName || ""
    return `/spc/suppliers?supplier=${encodeURIComponent(query)}`
  }

  function inputCell(
    fixture: SpcFixture,
    draft: FixtureDraft,
    key: keyof FixtureDraft,
    options?: { type?: string; list?: string; className?: string },
  ) {
    return (
      <input
        type={options?.type || "text"}
        list={options?.list}
        className={options?.className}
        value={draft[key]}
        onChange={(event) => updateDraft(fixture.id, key, event.target.value)}
        disabled={!canEdit}
      />
    )
  }

  function staticOrInput(
    fixture: SpcFixture,
    draft: FixtureDraft,
    key: keyof FixtureDraft,
    editing: boolean,
    options?: { type?: string; list?: string; className?: string },
  ) {
    if (editing) return inputCell(fixture, draft, key, options)
    if (key === "fixtureDate") return displayDate(draft.fixtureDate)
    return blank(draft[key])
  }

  function sheetInput(
    fixture: SpcFixture,
    draft: FixtureDraft,
    key: keyof FixtureDraft,
    options?: { list?: string },
  ) {
    return (
      <input
        list={options?.list}
        value={draft[key]}
        onChange={(event) => updateDraft(fixture.id, key, event.target.value)}
        disabled={!canEdit}
      />
    )
  }

  function renderFixtureRows(rows: SpcFixture[], mode: "pending" | "completed") {
    return rows.map((fixture) => {
      const draft = drafts[fixture.id] || draftFromFixture(fixture)
      const editing = canEdit && (fixture.fixtureStatus === "pending" || editingId === fixture.id)
      const supplierTrader = userFromChoice(users, draft.supplierTrader)
      const buyerTrader = userFromChoice(users, draft.buyerTrader)
      const supplierContent = editing ? (
        sheetInput(fixture, draft, "supplierName", { list: "spc-fixture-suppliers" })
      ) : draft.supplierName ? (
        <a className="spc-fixture-supplier-link" href={supplierHref(fixture, draft)} target="_blank" rel="noreferrer">
          {draft.supplierName}
        </a>
      ) : "-"
      return (
        <tr
          key={fixture.id}
          className={fixture.fixtureStatus === "pending" ? "is-pending" : ""}
          onDoubleClick={() => {
            if (canEdit && mode === "completed") setEditingId(fixture.id)
          }}
        >
          <td>{displayDate(draft.fixtureDate)}</td>
          <td>{blank(supplierTrader?.office)}</td>
          <td>{editing ? sheetInput(fixture, draft, "supplierTrader", { list: "spc-fixture-users" }) : traderPic(draft.supplierTrader)}</td>
          <td>{blank(buyerTrader?.office)}</td>
          <td>{editing ? sheetInput(fixture, draft, "buyerTrader", { list: "spc-fixture-users" }) : traderPic(draft.buyerTrader)}</td>
          <td>{staticOrInput(fixture, draft, "account", editing)}</td>
          <td>{staticOrInput(fixture, draft, "commission", editing)}</td>
          <td>{staticOrInput(fixture, draft, "earliestEta", editing)}</td>
          <td><strong>{staticOrInput(fixture, draft, "vesselName", editing)}</strong></td>
          <td>{staticOrInput(fixture, draft, "hsfo", editing)}</td>
          <td>{staticOrInput(fixture, draft, "vlsfo", editing)}</td>
          <td>{staticOrInput(fixture, draft, "lsmgo", editing)}</td>
          <td>{supplierContent}</td>
          <td>{staticOrInput(fixture, draft, "price", editing)}</td>
          <td>{staticOrInput(fixture, draft, "barging", editing)}</td>
          <td className="spc-fixture-action-cell">
            {editing ? (
              <div className="spc-fixture-row-actions">
                {fixture.fixtureStatus === "pending" ? (
                  <button
                    type="button"
                    className="is-primary"
                    onClick={() => void submitFixture(fixture, "complete")}
                    disabled={!canEdit || savingId === `${fixture.id}:complete`}
                  >
                    {savingId === `${fixture.id}:complete` ? "Completing" : "Complete"}
                  </button>
                ) : null}
                {fixture.fixtureStatus === "completed" ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void submitFixture(fixture, "save")}
                      disabled={!canEdit || savingId === `${fixture.id}:save`}
                    >
                      {savingId === `${fixture.id}:save` ? "Saving" : "Save"}
                    </button>
                    <button type="button" onClick={() => {
                      setDrafts((current) => ({ ...current, [fixture.id]: draftFromFixture(fixture) }))
                      setEditingId("")
                    }}>
                      Cancel
                    </button>
                  </>
                ) : null}
                {fixture.fixtureStatus !== "pending" && fixture.fixtureStatus !== "completed" ? (
                  <button
                    type="button"
                    onClick={() => void submitFixture(fixture, "save")}
                    disabled={!canEdit || savingId === `${fixture.id}:save`}
                  >
                    Save
                  </button>
                ) : null}
              </div>
            ) : null}
          </td>
        </tr>
      )
    })
  }

  if (authLoading || !authenticated || !hasPermissionSnapshot || !canView) {
    return <div className="spc-loading">Loading...</div>
  }

  return (
    <SpcShell title="SPC Fixtures">
      <div className="spc-page-heading">
        <div>
          <h1>Fixtures</h1>
          <p>{pendingFixtures.length} new stems · {completedFixtures.length} completed fixtures</p>
        </div>
        <button type="button" className="spc-page-action" onClick={() => void loadData()} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {message ? <div className={messageIsError ? "spc-alert is-error" : "spc-alert"}>{message}</div> : null}

      <datalist id="spc-fixture-users">
        {users.map((user) => (
          <option key={user.id} value={userOptionValue(user)} />
        ))}
      </datalist>
      <datalist id="spc-fixture-suppliers">
        {supplierOptions.map((supplier) => (
          <option key={supplier} value={supplier} />
        ))}
      </datalist>

      <section className="spc-panel spc-fixture-ledger-panel">
        <div className="spc-table-wrap">
          <table className="spc-table spc-fixture-table">
            <colgroup>
              {fixtureColumnWidths.map((width, index) => (
                <col key={`${width}-${index}`} style={{ width }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th>DATE</th>
                <th>SUPPLIER TRADER</th>
                <th>PIC</th>
                <th>CUSTOMER TRADER</th>
                <th>PIC</th>
                <th>ACCT</th>
                <th>$0.25/mt</th>
                <th>EARLIEST ETA</th>
                <th>VESSEL</th>
                <th>HSFO</th>
                <th>VLSFO</th>
                <th>LSMGO</th>
                <th>SUPPLIER</th>
                <th>Price</th>
                <th>Barging</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr className="spc-fixture-section-row">
                <td colSpan={fixtureColumnSpan}>NEW STEMS</td>
              </tr>
              {renderFixtureRows(pendingFixtures, "pending")}
              {!loading && pendingFixtures.length === 0 ? (
                <tr className="spc-fixture-empty-row"><td colSpan={fixtureColumnSpan}>No new stems.</td></tr>
              ) : null}
              <tr className="spc-fixture-section-row">
                <td colSpan={fixtureColumnSpan}>FIXTURE TABLE</td>
              </tr>
              {renderFixtureRows(completedFixtures, "completed")}
              {!loading && completedFixtures.length === 0 ? (
                <tr className="spc-fixture-empty-row"><td colSpan={fixtureColumnSpan}>No completed fixtures.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </SpcShell>
  )
}
