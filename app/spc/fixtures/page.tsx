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

type FuelKey = "hsfo" | "vlsfo" | "lsmgo"

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
  74, // date
  130, // supplier trader office
  100, // supplier trader PIC
  112, // customer trader office
  100, // customer trader PIC
  80, // account
  110, // ETA
  160, // vessel
  66, // HSFO
  66, // VLSFO
  66, // LSMGO
  140, // supplier
  78, // price
  78, // barging
  72, // action
] as const

const fixtureColumnSpan = fixtureColumnWidths.length

const fuelColumns: Array<{ key: FuelKey; label: string }> = [
  { key: "hsfo", label: "HSFO" },
  { key: "vlsfo", label: "VLSFO" },
  { key: "lsmgo", label: "LSMGO" },
]

const defaultOfficeOptions = ["ITALY", "HONG KONG", "SINGAPORE", "MONACO", "FRANCE", "USA", "KOREA", "JAPAN", "VIETNAM"]

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

function compactPersonName(value: string | null | undefined) {
  const cleaned = cleanText(value).split("|")[0].trim()
  if (!cleaned) return ""
  const withoutDomain = cleaned.includes("@") ? cleaned.split("@")[0] : cleaned
  return withoutDomain.split(/\s+/)[0] || withoutDomain
}

function userFromChoice(users: SpcUserOption[], value: string) {
  const cleaned = cleanText(value)
  if (!cleaned) return null
  const lower = cleaned.toLowerCase()
  const username = cleaned.includes("|") ? cleanText(cleaned.split("|").pop()).toLowerCase() : lower
  const exactMatch = users.find((user) => {
    const userName = user.username.toLowerCase()
    const displayName = user.displayName.toLowerCase()
    const label = userOptionValue(user).toLowerCase()
    return userName === username || userName === lower || displayName === lower || label === lower
  })
  if (exactMatch) return exactMatch

  const firstNameMatches = users.filter((user) => compactPersonName(user.displayName || user.username).toLowerCase() === lower)
  if (firstNameMatches.length === 1) return firstNameMatches[0]

  return null
}

function traderPic(value: string) {
  const cleaned = cleanText(value)
  if (!cleaned) return "-"
  return compactPersonName(cleaned) || cleaned
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
  }).format(date).toUpperCase()
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
  const { loading: authLoading, authenticated, username, permissions } = useSpcAuth()
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

  const officeOptions = useMemo(() => {
    const values = [
      ...defaultOfficeOptions,
      ...users.map((user) => user.office),
      ...fixtures.map((fixture) => fixture.account || ""),
      ...Object.values(drafts).map((draft) => draft.account),
    ]
    const seen = new Set<string>()
    return values
      .map((value) => value.trim().toUpperCase())
      .filter((value) => {
        if (!value || seen.has(value)) return false
        seen.add(value)
        return true
      })
      .sort((a, b) => a.localeCompare(b))
  }, [drafts, fixtures, users])

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
    document.title = "SPC FIXTURES"
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

  function sameUsername(left: string | null | undefined, right: string | null | undefined) {
    return cleanText(left).toLowerCase() === cleanText(right).toLowerCase()
  }

  function canEditFixture(fixture: SpcFixture, mode: "pending" | "completed") {
    if (!canEdit) return false
    if (fixture.fixtureStatus === "pending") {
      return sameUsername(username, fixture.supplierTraderUsername)
    }
    return mode === "completed"
  }

  function fuelRows(draft: FixtureDraft): Array<{ key: FuelKey | null; label: string }> {
    const rows = fuelColumns
      .filter(({ key }) => cleanText(draft[key]))
      .map(({ key, label }) => ({ key, label }))
    return rows.length ? rows : [{ key: null, label: "" }]
  }

  function missingCompleteFields(draft: FixtureDraft) {
    const required: Array<[string, boolean]> = [
      ["DATE", Boolean(cleanText(draft.fixtureDate))],
      ["SUPPLIER TRADER", Boolean(cleanText(draft.supplierTrader))],
      ["PIC", Boolean(cleanText(draft.supplierTrader))],
      ["CUSTOMER TRADER", Boolean(cleanText(draft.buyerTrader))],
      ["ACCT", Boolean(cleanText(draft.account))],
      ["ETA", Boolean(cleanText(draft.earliestEta))],
      ["VESSEL", Boolean(cleanText(draft.vesselName))],
      ["GRADE", fuelColumns.some(({ key }) => Boolean(cleanText(draft[key])))],
      ["SUPPLIER", Boolean(cleanText(draft.supplierName))],
      ["PRICE", Boolean(cleanText(draft.price))],
    ]
    return required.filter(([, ok]) => !ok).map(([label]) => label)
  }

  async function submitFixture(fixture: SpcFixture, action: "save" | "complete") {
    if (!canEdit) return
    if (fixture.fixtureStatus === "pending" && !sameUsername(username, fixture.supplierTraderUsername)) {
      setMessage("ONLY THE ASSIGNED SUPPLIER TRADER CAN EDIT THIS NEW STEM.")
      setMessageIsError(true)
      return
    }
    const draft = drafts[fixture.id] || draftFromFixture(fixture)
    if (action === "complete") {
      const missing = missingCompleteFields(draft)
      if (missing.length > 0) {
        setMessage(`COMPLETE ${missing.join(", ")} BEFORE COMPLETING.`)
        setMessageIsError(true)
        return
      }
    }
    setSavingId(`${fixture.id}:${action}`)
    setMessage("")
    try {
      const response = await fetch("/api/spc/fixtures", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: fixture.id,
          action,
          fixture: draft,
        }),
      })
      const data = (await response.json()) as { fixture?: SpcFixture; message?: string }
      if (!response.ok || !data.fixture) throw new Error(data.message || "Failed to save fixture.")
      setFixtures((current) => current.map((row) => (row.id === fixture.id ? data.fixture! : row)))
      setDrafts((current) => ({ ...current, [fixture.id]: draftFromFixture(data.fixture!) }))
      setEditingId("")
      setMessage(action === "complete" ? "FIXTURE COMPLETED." : "FIXTURE SAVED.")
      setMessageIsError(false)
    } catch (error) {
      setMessage((error instanceof Error ? error.message : "Failed to save fixture.").toUpperCase())
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

  function renderFixtureRows(rows: SpcFixture[], mode: "pending" | "completed") {
    return rows.flatMap((fixture) => {
      const draft = drafts[fixture.id] || draftFromFixture(fixture)
      const rowCanEdit = canEditFixture(fixture, mode)
      const editing = rowCanEdit && (fixture.fixtureStatus === "pending" || editingId === fixture.id)
      const supplierTrader = userFromChoice(users, draft.supplierTrader)
      const buyerTrader = userFromChoice(users, draft.buyerTrader)
      const missing = missingCompleteFields(draft)
      const supplierContent = editing ? (
        sheetInput(fixture, draft, "supplierName", { type: "search", list: "spc-fixture-suppliers", className: "is-sheet-pill" })
      ) : draft.supplierName ? (
        <a className="spc-fixture-supplier-link" href={supplierHref(fixture, draft)} target="_blank" rel="noreferrer">
          {draft.supplierName}
        </a>
      ) : "-"
      return fuelRows(draft).map((fuelRow) => (
        <tr
          key={`${fixture.id}-${fuelRow.key || "fuel"}`}
          className={fixture.fixtureStatus === "pending" ? "is-pending" : ""}
          onDoubleClick={() => {
            if (rowCanEdit && mode === "completed") setEditingId(fixture.id)
          }}
        >
          <td>{displayDate(draft.fixtureDate)}</td>
          <td>{blank(supplierTrader?.office)}</td>
          <td>{traderPic(draft.supplierTrader)}</td>
          <td>{blank(buyerTrader?.office)}</td>
          <td>{traderPic(draft.buyerTrader)}</td>
          <td>{staticOrInput(fixture, draft, "account", editing, { list: "spc-fixture-offices", className: "is-sheet-pill" })}</td>
          <td>{staticOrInput(fixture, draft, "earliestEta", editing)}</td>
          <td><strong>{staticOrInput(fixture, draft, "vesselName", editing)}</strong></td>
          {fuelColumns.map(({ key }) => (
            <td key={key}>
              {fuelRow.key === key || (!fuelRow.key && editing)
                ? staticOrInput(fixture, draft, key, editing)
                : ""}
            </td>
          ))}
          <td>{supplierContent}</td>
          <td>{staticOrInput(fixture, draft, "price", editing)}</td>
          <td>{staticOrInput(fixture, draft, "barging", editing)}</td>
          <td className="spc-fixture-action-cell">
            {editing ? (
              <div className="spc-fixture-row-actions">
                {fixture.fixtureStatus === "pending" ? (
                  <button
                    type="button"
                    onClick={() => void submitFixture(fixture, "complete")}
                    disabled={missing.length > 0 || savingId === `${fixture.id}:complete`}
                    title={missing.length > 0 ? `MISSING: ${missing.join(", ")}` : "COMPLETE"}
                  >
                    {savingId === `${fixture.id}:complete` ? "COMPLETING" : "COMPLETE"}
                  </button>
                ) : null}
                {fixture.fixtureStatus === "completed" ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void submitFixture(fixture, "save")}
                      disabled={!canEdit || savingId === `${fixture.id}:save`}
                    >
                      {savingId === `${fixture.id}:save` ? "SAVING" : "SAVE"}
                    </button>
                    <button type="button" onClick={() => {
                      setDrafts((current) => ({ ...current, [fixture.id]: draftFromFixture(fixture) }))
                      setEditingId("")
                    }}>
                      CANCEL
                    </button>
                  </>
                ) : null}
                {fixture.fixtureStatus !== "pending" && fixture.fixtureStatus !== "completed" ? (
                  <button
                    type="button"
                    onClick={() => void submitFixture(fixture, "save")}
                    disabled={!canEdit || savingId === `${fixture.id}:save`}
                  >
                    SAVE
                  </button>
                ) : null}
              </div>
            ) : null}
          </td>
        </tr>
      ))
    })
  }

  if (authLoading || !authenticated || !hasPermissionSnapshot || !canView) {
    return <div className="spc-loading">LOADING...</div>
  }

  return (
    <SpcShell title="SPC FIXTURES">
      <datalist id="spc-fixture-users">
        {users.map((user) => (
          <option key={user.id} value={userOptionValue(user)} />
        ))}
      </datalist>
      <datalist id="spc-fixture-offices">
        {officeOptions.map((office) => (
          <option key={office} value={office} />
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
                <th>ETA</th>
                <th>VESSEL</th>
                <th>HSFO</th>
                <th>VLSFO</th>
                <th>LSMGO</th>
                <th>SUPPLIER</th>
                <th>PRICE</th>
                <th>BARGING</th>
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
              {message ? (
                <tr className={messageIsError ? "spc-fixture-status-row is-error" : "spc-fixture-status-row"}>
                  <td colSpan={fixtureColumnSpan}>{message}</td>
                </tr>
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
