"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { useSpcAuth } from "@/lib/useSpcAuth"
import { canAccessSpcPage } from "@/lib/spcPages"
import { createActiveSpcTraderResolver } from "@/lib/spcActiveTraders"
import { displaySupplierName } from "@/lib/spcSupplierKeys"

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
  isActive?: boolean
}

type SupplierRecord = {
  key: string
  name: string
  aliases?: string[]
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
  supplierRecords?: SupplierRecord[]
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
  126, // date
  96, // supplier trader
  96, // buyer trader
  104, // account
  184, // ETA
  220, // vessel
  97, // HSFO
  97, // VLSFO
  97, // LSMGO
  130, // supplier
  74, // price
  74, // barging
] as const

const fixtureColumnSpan = fixtureColumnWidths.length
const fixtureTableWidth = fixtureColumnWidths.reduce((total, width) => total + width, 0)
const fixtureActionRailGap = 8
const fixtureActionRailWidth = 118
const fixtureLedgerCanvasWidth = fixtureTableWidth + fixtureActionRailGap + fixtureActionRailWidth

const fuelColumns: Array<{ key: FuelKey; label: string }> = [
  { key: "hsfo", label: "HSFO" },
  { key: "vlsfo", label: "VLSFO" },
  { key: "lsmgo", label: "LSMGO" },
]

const fuelLabels: Record<FuelKey, string> = {
  hsfo: "HSFO",
  vlsfo: "VLSFO",
  lsmgo: "LSMGO",
}

const defaultOfficeOptions = ["ITALY", "HONG KONG", "SINGAPORE", "MONACO", "FRANCE", "USA", "KOREA", "JAPAN", "VIETNAM"]

const monthOptions = [
  { value: "01", label: "JAN" },
  { value: "02", label: "FEB" },
  { value: "03", label: "MAR" },
  { value: "04", label: "APR" },
  { value: "05", label: "MAY" },
  { value: "06", label: "JUN" },
  { value: "07", label: "JUL" },
  { value: "08", label: "AUG" },
  { value: "09", label: "SEP" },
  { value: "10", label: "OCT" },
  { value: "11", label: "NOV" },
  { value: "12", label: "DEC" },
]

function hongKongYearMonth() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date())
  return {
    year: parts.find((part) => part.type === "year")?.value || String(new Date().getFullYear()),
    month: parts.find((part) => part.type === "month")?.value || String(new Date().getMonth() + 1).padStart(2, "0"),
  }
}

function cleanText(value: string | null | undefined) {
  return String(value || "").trim()
}

function formatNumberString(value: string | null | undefined) {
  const match = cleanText(value)
    .replace(/[–—]/g, "-")
    .match(/\d[\d,]*(?:\.\d*)?/)
  if (!match) return ""
  const raw = match[0].replace(/,/g, "")
  const [integerRaw, decimalRaw = ""] = raw.split(".")
  const integer = (integerRaw || "0").replace(/^0+(?=\d)/, "") || "0"
  const formattedInteger = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  if (raw.includes(".")) return `${formattedInteger}.${decimalRaw}`
  return formattedInteger
}

function formatIntegerString(value: string | null | undefined) {
  return formatNumberString(value)
}

function formatQuantityString(value: string | null | undefined) {
  const text = cleanText(value).replace(/[–—]/g, "-")
  if (!text.includes("-")) return formatIntegerString(text)
  const [leftRaw, ...rightRawParts] = text.split("-")
  const left = formatIntegerString(leftRaw)
  const rightRaw = rightRawParts.join("")
  const right = formatIntegerString(rightRaw)
  if (left && !right && text.trim().endsWith("-")) return `${left}-`
  if (left && right) return `${left}-${right}`
  return left || right
}

function numericDisplay(value: string | null | undefined) {
  return formatIntegerString(value) || "-"
}

function quantityDisplay(value: string | null | undefined) {
  return formatQuantityString(value) || "-"
}

function parseGradeValues(value: string | null | undefined) {
  const text = cleanText(value)
  const map: Partial<Record<FuelKey, string>> = {}
  if (!text) return { encoded: false, map }
  const parts = text.split("/").map((part) => part.trim()).filter(Boolean)
  let encoded = parts.length > 0
  parts.forEach((part) => {
    const match = part.match(/^(HSFO|VLSFO|LSMGO)\s*[:=]\s*(.+)$/i)
    if (!match) {
      encoded = false
      return
    }
    const label = match[1].toUpperCase()
    const key = fuelColumns.find((column) => column.label === label)?.key
    if (key) map[key] = cleanText(match[2])
  })
  return { encoded, map: encoded ? map : {} }
}

function serializeGradeValues(map: Partial<Record<FuelKey, string>>) {
  return fuelColumns
    .map(({ key, label }) => {
      const value = cleanText(map[key])
      return value ? `${label}: ${value}` : ""
    })
    .filter(Boolean)
    .join(" / ")
}

function gradeValue(value: string | null | undefined, key: FuelKey | null, fallbackPlain = true) {
  const text = cleanText(value)
  if (!key) return text
  const parsed = parseGradeValues(text)
  if (parsed.encoded) return cleanText(parsed.map[key])
  return fallbackPlain ? text : ""
}

function normalizeSupplierDisplayField(value: string | null | undefined) {
  const parsed = parseGradeValues(value)
  if (parsed.encoded) {
    const nextMap: Partial<Record<FuelKey, string>> = {}
    fuelColumns.forEach(({ key }) => {
      const supplier = displaySupplierName(parsed.map[key])
      if (supplier) nextMap[key] = supplier
    })
    return serializeGradeValues(nextMap)
  }
  return displaySupplierName(value)
}

function gradeNumberDisplay(value: string | null | undefined, key: FuelKey | null) {
  return numericDisplay(gradeValue(value, key))
}

function officeMatch(value: string | null | undefined, options: string[]) {
  const cleaned = cleanText(value).toUpperCase()
  if (!cleaned) return ""
  const uniqueOptions = Array.from(new Set(options.map((option) => option.trim().toUpperCase()).filter(Boolean)))
  const exact = uniqueOptions.find((option) => option === cleaned)
  if (exact) return exact
  const withoutTrailingS = cleaned.endsWith("S") ? cleaned.slice(0, -1) : cleaned
  const singular = uniqueOptions.find((option) => option === withoutTrailingS)
  if (singular) return singular
  const prefix = uniqueOptions.find((option) => cleaned.startsWith(option))
  if (prefix) return prefix
  const closeMatches = uniqueOptions.filter((option) => editDistance(cleaned, option) <= 2)
  return closeMatches.length === 1 ? closeMatches[0] : ""
}

function editDistance(left: string, right: string) {
  const rows = Array.from({ length: left.length + 1 }, (_, index) => [index])
  for (let column = 1; column <= right.length; column += 1) rows[0][column] = column
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      rows[row][column] = Math.min(
        rows[row - 1][column] + 1,
        rows[row][column - 1] + 1,
        rows[row - 1][column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      )
    }
  }
  return rows[left.length][right.length]
}

function monthCode(value: string | null | undefined) {
  const token = cleanText(value).toUpperCase().slice(0, 3)
  return monthOptions.find((month) => month.label === token)?.label || ""
}

function validDay(value: string | null | undefined) {
  const day = Number(cleanText(value))
  return Number.isInteger(day) && day >= 1 && day <= 31 ? String(day) : ""
}

function normalizeEta(value: string | null | undefined) {
  const text = cleanText(value)
    .toUpperCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
  if (!text) return ""

  const single = text.match(/^(\d{1,2})\s*([A-Z]{3,})$/)
  if (single) {
    const day = validDay(single[1])
    const month = monthCode(single[2])
    return day && month ? `${day} ${month}` : ""
  }

  const sameMonth = text.match(/^(\d{1,2})\s*-\s*(\d{1,2})\s*([A-Z]{3,})$/)
  if (sameMonth) {
    const startDay = validDay(sameMonth[1])
    const endDay = validDay(sameMonth[2])
    const month = monthCode(sameMonth[3])
    return startDay && endDay && month ? `${startDay} - ${endDay} ${month}` : ""
  }

  const crossMonth = text.match(/^(\d{1,2})\s*([A-Z]{3,})\s*-\s*(\d{1,2})\s*([A-Z]{3,})$/)
  if (crossMonth) {
    const startDay = validDay(crossMonth[1])
    const startMonth = monthCode(crossMonth[2])
    const endDay = validDay(crossMonth[3])
    const endMonth = monthCode(crossMonth[4])
    return startDay && startMonth && endDay && endMonth ? `${startDay} ${startMonth} - ${endDay} ${endMonth}` : ""
  }

  return ""
}

function parseEtaParts(value: string | null | undefined) {
  const eta = normalizeEta(value)
  const crossMonth = eta.match(/^(\d{1,2})\s+([A-Z]{3})\s+-\s+(\d{1,2})\s+([A-Z]{3})$/)
  if (crossMonth) {
    return { startDay: crossMonth[1], startMonth: crossMonth[2], endDay: crossMonth[3], endMonth: crossMonth[4] }
  }
  const sameMonth = eta.match(/^(\d{1,2})\s+-\s+(\d{1,2})\s+([A-Z]{3})$/)
  if (sameMonth) {
    return { startDay: sameMonth[1], startMonth: sameMonth[3], endDay: sameMonth[2], endMonth: sameMonth[3] }
  }
  const single = eta.match(/^(\d{1,2})\s+([A-Z]{3})$/)
  if (single) {
    return { startDay: single[1], startMonth: single[2], endDay: "", endMonth: single[2] }
  }
  const currentMonth = monthOptions[new Date().getMonth()]?.label || "JAN"
  return { startDay: "", startMonth: currentMonth, endDay: "", endMonth: currentMonth }
}

function etaFromParts(parts: { startDay: string; startMonth: string; endDay: string; endMonth: string }) {
  const startDay = validDay(parts.startDay)
  const startMonth = monthCode(parts.startMonth)
  const endDay = validDay(parts.endDay)
  const endMonth = monthCode(parts.endMonth) || startMonth
  if (!startDay || !startMonth) return ""
  if (!endDay) return `${startDay} ${startMonth}`
  if (endMonth && endMonth !== startMonth) return `${startDay} ${startMonth} - ${endDay} ${endMonth}`
  return `${startDay} - ${endDay} ${startMonth}`
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

function officeCode(value: string | null | undefined) {
  const office = cleanText(value).toUpperCase()
  if (!office) return ""
  const known: Record<string, string> = {
    "HONG KONG": "HK",
    SINGAPORE: "SG",
    ITALY: "IT",
    GENOA: "IT",
    MONACO: "MC",
    GREECE: "GR",
    FRANCE: "FR",
    USA: "US",
    UAE: "AE",
    "UNITED ARAB EMIRATES": "AE",
    KOREA: "KR",
    JAPAN: "JP",
    VIETNAM: "VN",
  }
  if (known[office]) return known[office]
  const words = office.split(/\s+/).filter(Boolean)
  if (words.length > 1) return words.map((word) => word[0]).join("").slice(0, 3)
  return office.slice(0, 3)
}

function traderCode(user: SpcUserOption | null, fallback: string) {
  const name = (compactPersonName(user?.displayName || fallback) || cleanText(fallback)).toUpperCase()
  if (!name) return "-"
  const code = officeCode(user?.office)
  return code ? `${name}-${code}` : name
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
    earliestEta: normalizeEta(fixture.earliestEta) || cleanText(fixture.earliestEta),
    vesselName: cleanText(fixture.vesselName),
    hsfo: formatQuantityString(fixture.hsfo),
    vlsfo: formatQuantityString(fixture.vlsfo),
    lsmgo: formatQuantityString(fixture.lsmgo),
    supplierName: normalizeSupplierDisplayField(fixture.supplierName),
    price: parseGradeValues(fixture.price).encoded
      ? serializeGradeValues(parseGradeValues(fixture.price).map)
      : formatIntegerString(fixture.price),
    barging: parseGradeValues(fixture.barging).encoded
      ? serializeGradeValues(parseGradeValues(fixture.barging).map)
      : formatIntegerString(fixture.barging),
  }
}

export default function SpcFixturesPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, role, permissions } = useSpcAuth()
  const fixtureTableRef = useRef<HTMLDivElement | null>(null)
  const fixtureCanvasRef = useRef<HTMLDivElement | null>(null)
  const supplierMenuFocusSuppressionRef = useRef("")
  const initialPeriod = useMemo(() => hongKongYearMonth(), [])
  const [fixtures, setFixtures] = useState<SpcFixture[]>([])
  const [users, setUsers] = useState<SpcUserOption[]>([])
  const [supplierRecords, setSupplierRecords] = useState<SupplierRecord[]>([])
  const [drafts, setDrafts] = useState<Record<string, FixtureDraft>>({})
  const [editingId, setEditingId] = useState("")
  const [actionPositions, setActionPositions] = useState<Record<string, number>>({})
  const [supplierMenuKey, setSupplierMenuKey] = useState("")
  const [supplierSearchQuery, setSupplierSearchQuery] = useState("")
  const [fixtureYearFilter, setFixtureYearFilter] = useState(initialPeriod.year)
  const [fixtureMonthFilter, setFixtureMonthFilter] = useState("")
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
  const activeTraderResolver = useMemo(() => createActiveSpcTraderResolver(users), [users])
  const completedFixtures = useMemo(
    () => fixtures.filter((fixture) => fixture.fixtureStatus === "completed"),
    [fixtures],
  )
  const fixtureYearOptions = useMemo(() => {
    const years = new Set<string>([initialPeriod.year])
    completedFixtures.forEach((fixture) => {
      const year = cleanText(fixture.fixtureDate).slice(0, 4)
      if (/^\d{4}$/.test(year)) years.add(year)
    })
    return Array.from(years).sort((a, b) => b.localeCompare(a))
  }, [completedFixtures, initialPeriod.year])
  const filteredCompletedFixtures = useMemo(
    () =>
      completedFixtures.filter((fixture) => {
        const date = cleanText(fixture.fixtureDate)
        const yearMatches = !fixtureYearFilter || date.slice(0, 4) === fixtureYearFilter
        const monthMatches = !fixtureMonthFilter || date.slice(5, 7) === fixtureMonthFilter
        return yearMatches && monthMatches
      }),
    [completedFixtures, fixtureMonthFilter, fixtureYearFilter],
  )

  const supplierOptions = useMemo(() => {
    const supplierValues = (value: string | null | undefined) => {
      const parsed = parseGradeValues(value)
      if (parsed.encoded) return fuelColumns.map(({ key }) => parsed.map[key] || "")
      return [value || ""]
    }
    const values = [
      ...supplierRecords.flatMap((record) => [record.name, ...(record.aliases || [])]),
      ...fixtures.flatMap((fixture) => supplierValues(fixture.supplierName)),
    ]
    const seen = new Set<string>()
    return values
      .map((value) => displaySupplierName(value))
      .filter((value) => {
        const key = value.toLowerCase()
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
      .sort((a, b) => a.localeCompare(b))
  }, [fixtures, supplierRecords])

  const officeOptions = useMemo(() => {
    const values = [
      ...defaultOfficeOptions,
      ...users.map((user) => user.office),
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
  }, [users])

  const loadData = useCallback(async () => {
    if (!canView) return
    setLoading(true)
    setMessage("")
    try {
      const fixtureResponse = await fetch("/api/spc/fixtures?limit=5000", { cache: "no-store" })
      const fixtureData = (await fixtureResponse.json()) as FixturesResponse
      if (!fixtureResponse.ok) throw new Error(fixtureData.message || "Failed to load fixtures.")

      const rows = fixtureData.fixtures || []
      setFixtures(rows)
      setUsers(fixtureData.users || [])
      setSupplierRecords(fixtureData.supplierRecords || [])
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

  const floatingActionRows = useMemo(() => {
    const rows: Array<{
      key: string
      fixture: SpcFixture
      editing: boolean
      missing: string[]
    }> = []
    pendingFixtures.forEach((fixture) => {
      if (!canEditFixture(fixture, "pending")) return
      const draft = drafts[fixture.id] || draftFromFixture(fixture)
      const missing = prepareDraftForSubmit(draft, true).errors
      fuelRows(draft).forEach((fuelRow) => {
        rows.push({
          key: `${fixture.id}:${fuelRow.key || "all"}`,
          fixture,
          editing: true,
          missing,
        })
      })
    })
    if (editingId) {
      const fixtureId = editingId.split(":")[0] || editingId
      const fixture = filteredCompletedFixtures.find((row) => row.id === fixtureId)
      if (fixture && canEditFixture(fixture, "completed")) {
        rows.push({
          key: editingId,
          fixture,
          editing: true,
          missing: [],
        })
      }
    }
    return rows
  }, [drafts, editingId, filteredCompletedFixtures, pendingFixtures, role, canEdit, officeOptions])

  useLayoutEffect(() => {
    function measureActions() {
      const canvas = fixtureCanvasRef.current
      if (!canvas) return
      const canvasRect = canvas.getBoundingClientRect()
      const next: Record<string, number> = {}
      const actionNodes = new Map(
        Array.from(canvas.querySelectorAll<HTMLElement>("[data-fixture-action-key]"))
          .map((node) => [node.dataset.fixtureActionKey || "", node] as const),
      )
      floatingActionRows.forEach((row) => {
        const node = actionNodes.get(row.key)
        if (!node) return
        const rect = node.getBoundingClientRect()
        next[row.key] = rect.top - canvasRect.top + rect.height / 2
      })
      setActionPositions(next)
    }
    measureActions()
    const animationFrame = window.requestAnimationFrame(measureActions)
    window.addEventListener("resize", measureActions)
    window.addEventListener("scroll", measureActions, true)
    return () => {
      window.cancelAnimationFrame(animationFrame)
      window.removeEventListener("resize", measureActions)
      window.removeEventListener("scroll", measureActions, true)
    }
  }, [floatingActionRows])

  useEffect(() => {
    if (!editingId) return

    function closeCompletedEdit(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      if (fixtureTableRef.current?.contains(target)) return
      const fixtureId = editingId.split(":")[0] || editingId
      const fixture = fixtures.find((row) => row.id === fixtureId)
      if (fixture) {
        setDrafts((current) => ({ ...current, [fixtureId]: draftFromFixture(fixture) }))
      }
      setEditingId("")
    }

    document.addEventListener("pointerdown", closeCompletedEdit)
    return () => document.removeEventListener("pointerdown", closeCompletedEdit)
  }, [editingId, fixtures])

  function updateDraft(id: string, key: keyof FixtureDraft, value: string) {
    setDrafts((current) => ({
      ...current,
      [id]: {
        ...(current[id] || emptyDraft),
        [key]: value,
      },
    }))
  }

  function updateGradeDraft(id: string, key: "supplierName" | "price" | "barging", fuelKey: FuelKey | null, value: string) {
    if (!fuelKey) {
      updateDraft(id, key, value)
      return
    }
    setDrafts((current) => {
      const draft = current[id] || emptyDraft
      const parsed = parseGradeValues(draft[key])
      const nextMap = parsed.encoded ? { ...parsed.map } : {}
      nextMap[fuelKey] = value
      return {
        ...current,
        [id]: {
          ...draft,
          [key]: serializeGradeValues(nextMap),
        },
      }
    })
  }

  function canEditFixture(fixture: SpcFixture, mode: "pending" | "completed") {
    if (!canEdit) return false
    if (fixture.fixtureStatus === "pending") {
      return role === "SUPPLIER TRADER" || role === "ADMIN"
    }
    return mode === "completed"
  }

  function fuelRows(draft: FixtureDraft): Array<{ key: FuelKey | null; label: string }> {
    const rows = fuelColumns
      .filter(({ key }) => cleanText(draft[key]))
      .map(({ key, label }) => ({ key, label }))
    return rows.length ? rows : [{ key: null, label: "" }]
  }

  function activeFuelKeys(draft: FixtureDraft) {
    return fuelColumns
      .filter(({ key }) => Boolean(formatQuantityString(draft[key])))
      .map(({ key }) => key)
  }

  function normalizedGradeField(value: string, keys: FuelKey[], numeric = false) {
    const parsed = parseGradeValues(value)
    if (parsed.encoded) {
      const nextMap: Partial<Record<FuelKey, string>> = {}
      keys.forEach((key) => {
        const nextValue = numeric ? formatIntegerString(parsed.map[key]) : cleanText(parsed.map[key])
        if (nextValue) nextMap[key] = nextValue
      })
      return serializeGradeValues(nextMap)
    }
    return numeric ? formatIntegerString(value) : cleanText(value)
  }

  function prepareDraftForSubmit(draft: FixtureDraft, requireComplete: boolean) {
    const errors: string[] = []
    const account = officeMatch(draft.account, officeOptions)
    const eta = normalizeEta(draft.earliestEta)
    const normalized: FixtureDraft = {
      ...draft,
      account,
      earliestEta: eta,
      hsfo: formatQuantityString(draft.hsfo),
      vlsfo: formatQuantityString(draft.vlsfo),
      lsmgo: formatQuantityString(draft.lsmgo),
    }
    const activeKeys = activeFuelKeys(normalized)
    normalized.supplierName = normalizedGradeField(draft.supplierName, activeKeys, false)
    normalized.price = normalizedGradeField(draft.price, activeKeys, true)
    normalized.barging = normalizedGradeField(draft.barging, activeKeys, true)

    if (cleanText(draft.account) && !account) errors.push("SELECT A VALID ACCT")
    if (cleanText(draft.earliestEta) && !eta) errors.push("SELECT A VALID ETA")
    if (requireComplete) {
      const required: Array<[string, boolean]> = [
        ["DATE", Boolean(cleanText(normalized.fixtureDate))],
        ["SUPPLIER TRADER", Boolean(cleanText(normalized.supplierTrader))],
        ["BUYER TRADER", Boolean(cleanText(normalized.buyerTrader))],
        ["ACCT", Boolean(account)],
        ["ETA", Boolean(eta)],
        ["VESSEL", Boolean(cleanText(normalized.vesselName))],
        ["GRADE", activeKeys.length > 0],
      ]
      errors.push(...required.filter(([, ok]) => !ok).map(([label]) => label))
      activeKeys.forEach((key) => {
        if (!gradeValue(normalized.supplierName, key)) errors.push(`SUPPLIER ${fuelLabels[key]}`)
        if (!formatIntegerString(gradeValue(normalized.price, key))) errors.push(`PRICE ${fuelLabels[key]}`)
      })
    }
    return { draft: normalized, errors }
  }

  async function submitFixture(fixture: SpcFixture, action: "save" | "complete") {
    if (!canEdit) return
    if (fixture.fixtureStatus === "pending" && role !== "SUPPLIER TRADER" && role !== "ADMIN") {
      setMessage("ONLY SUPPLIER TRADERS AND ADMINS CAN EDIT THIS NEW STEM.")
      setMessageIsError(true)
      return
    }
    const draft = drafts[fixture.id] || draftFromFixture(fixture)
    const prepared = prepareDraftForSubmit(draft, action === "complete")
    if (prepared.errors.length > 0) {
      setMessage(`${action === "complete" ? "COMPLETE" : "FIX"} ${prepared.errors.join(", ")} BEFORE SAVING.`)
      setMessageIsError(true)
      return
    }
    const fixtureLabel = cleanText(prepared.draft.vesselName || fixture.vesselName || fixture.enquiryTitle || fixture.enquiryNumber).toUpperCase()
    const confirmMessage = action === "complete" ? `COMPLETE FIXTURE ${fixtureLabel}?` : `UPDATE FIXTURE ${fixtureLabel}?`
    if (!window.confirm(confirmMessage)) return
    setSavingId(`${fixture.id}:${action}`)
    setMessage("")
    try {
      const response = await fetch("/api/spc/fixtures", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: fixture.id,
          action,
          fixture: prepared.draft,
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

  async function deleteFixture(fixture: SpcFixture) {
    if (!canEdit) return
    if (!window.confirm(`DELETE FIXTURE ${cleanText(fixture.vesselName || fixture.enquiryTitle || fixture.enquiryNumber).toUpperCase()}?`)) return
    setSavingId(`${fixture.id}:delete`)
    setMessage("")
    try {
      const response = await fetch("/api/spc/fixtures", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: fixture.id,
          action: "delete",
        }),
      })
      const data = (await response.json()) as { id?: string; message?: string }
      if (!response.ok || data.id !== fixture.id) throw new Error(data.message || "Failed to delete fixture.")
      setFixtures((current) => current.filter((row) => row.id !== fixture.id))
      setDrafts((current) => {
        const next = { ...current }
        delete next[fixture.id]
        return next
      })
      setEditingId("")
      setMessage("FIXTURE DELETED.")
      setMessageIsError(false)
    } catch (error) {
      setMessage((error instanceof Error ? error.message : "Failed to delete fixture.").toUpperCase())
      setMessageIsError(true)
    } finally {
      setSavingId("")
    }
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

  function accountSelect(fixture: SpcFixture, draft: FixtureDraft, editing: boolean) {
    if (!editing) return blank(officeMatch(draft.account, officeOptions) || draft.account)
    const value = officeMatch(draft.account, officeOptions)
    return (
      <select
        className="is-sheet-pill"
        value={value}
        onChange={(event) => updateDraft(fixture.id, "account", event.target.value)}
        disabled={!canEdit}
      >
        <option value="">ACCT</option>
        {officeOptions.map((office) => (
          <option key={office} value={office}>{office}</option>
        ))}
      </select>
    )
  }

  function etaEditor(fixture: SpcFixture, draft: FixtureDraft, editing: boolean) {
    if (!editing) return blank(normalizeEta(draft.earliestEta) || draft.earliestEta)
    const parts = parseEtaParts(draft.earliestEta)
    const dayOptions = Array.from({ length: 31 }, (_, index) => String(index + 1))
    const updateEta = (next: typeof parts) => updateDraft(fixture.id, "earliestEta", etaFromParts(next))
    return (
      <div className="spc-fixture-eta-editor">
        <select
          aria-label="ETA start day"
          value={parts.startDay}
          onChange={(event) => updateEta({ ...parts, startDay: event.target.value })}
          disabled={!canEdit}
        >
          <option value="">DD</option>
          {dayOptions.map((day) => <option key={day} value={day}>{day}</option>)}
        </select>
        <select
          aria-label="ETA start month"
          value={parts.startMonth}
          onChange={(event) => updateEta({ ...parts, startMonth: event.target.value, endMonth: parts.endDay ? event.target.value : parts.endMonth })}
          disabled={!canEdit}
        >
          {monthOptions.map((month) => <option key={month.label} value={month.label}>{month.label}</option>)}
        </select>
        <select
          aria-label="ETA end day"
          value={parts.endDay}
          onChange={(event) => updateEta({ ...parts, endDay: event.target.value })}
          disabled={!canEdit}
        >
          <option value="">-</option>
          {dayOptions.map((day) => <option key={day} value={day}>{day}</option>)}
        </select>
        <select
          aria-label="ETA end month"
          value={parts.endMonth}
          onChange={(event) => updateEta({ ...parts, endMonth: event.target.value })}
          disabled={!canEdit || !parts.endDay}
        >
          {monthOptions.map((month) => <option key={month.label} value={month.label}>{month.label}</option>)}
        </select>
      </div>
    )
  }

  function numericCell(fixture: SpcFixture, draft: FixtureDraft, key: "hsfo" | "vlsfo" | "lsmgo", editing: boolean) {
    if (!editing) return quantityDisplay(draft[key])
    return (
      <input
        inputMode="text"
        value={draft[key]}
        onChange={(event) => updateDraft(fixture.id, key, event.target.value)}
        disabled={!canEdit}
      />
    )
  }

  function gradeSupplierCell(fixture: SpcFixture, draft: FixtureDraft, key: FuelKey | null, editing: boolean) {
    const value = gradeValue(draft.supplierName, key)
    if (editing) {
      const pickerKey = `${fixture.id}:${key || "all"}`
      const menuId = `spc-fixture-supplier-menu-${fixture.id}-${key || "all"}`
      const query = supplierSearchQuery.trim().toLowerCase()
      const matches = supplierOptions
        .filter((supplier) => !query || supplier.toLowerCase().includes(query))
        .slice(0, 50)
      const menuIsOpen = supplierMenuKey === pickerKey
      return (
        <div
          className={`spc-fixture-supplier-picker${menuIsOpen ? " is-open" : ""}`}
          onBlur={(event) => {
            if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
            setSupplierMenuKey((current) => (current === pickerKey ? "" : current))
            setSupplierSearchQuery("")
          }}
        >
          <input
            type="text"
            autoComplete="off"
            className="is-sheet-pill spc-fixture-supplier-input"
            value={value}
            role="combobox"
            aria-label={`${key ? fuelLabels[key] : "Fixture"} supplier`}
            aria-expanded={menuIsOpen}
            aria-controls={menuId}
            aria-autocomplete="list"
            onFocus={() => {
              if (supplierMenuFocusSuppressionRef.current === pickerKey) {
                supplierMenuFocusSuppressionRef.current = ""
                return
              }
              if (supplierMenuKey !== pickerKey) setSupplierSearchQuery("")
              setSupplierMenuKey(pickerKey)
            }}
            onChange={(event) => {
              updateGradeDraft(fixture.id, "supplierName", key, event.target.value)
              if (supplierMenuKey !== pickerKey) setSupplierSearchQuery("")
              setSupplierMenuKey(pickerKey)
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSupplierMenuKey("")
                setSupplierSearchQuery("")
              }
            }}
            disabled={!canEdit}
          />
          {menuIsOpen ? (
            <div className="spc-fixture-supplier-menu">
              <input
                type="search"
                className="spc-fixture-supplier-search"
                aria-label="Search suppliers"
                placeholder="SEARCH SUPPLIERS"
                value={supplierSearchQuery}
                onChange={(event) => setSupplierSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    const supplierInput = event.currentTarget
                      .closest(".spc-fixture-supplier-picker")
                      ?.querySelector<HTMLInputElement>(".spc-fixture-supplier-input")
                    supplierMenuFocusSuppressionRef.current = pickerKey
                    setSupplierMenuKey("")
                    setSupplierSearchQuery("")
                    window.requestAnimationFrame(() => supplierInput?.focus())
                  }
                }}
              />
              <div id={menuId} className="spc-fixture-supplier-options" role="listbox" aria-label="Supplier options">
                {matches.length > 0 ? (
                  matches.map((supplier) => (
                    <button
                      type="button"
                      key={supplier}
                      className="spc-fixture-supplier-option"
                      role="option"
                      aria-selected={supplier.toLowerCase() === value.toLowerCase()}
                      onClick={() => {
                        updateGradeDraft(fixture.id, "supplierName", key, supplier)
                        setSupplierMenuKey("")
                        setSupplierSearchQuery("")
                      }}
                    >
                      {supplier}
                    </button>
                  ))
                ) : (
                  <div className="spc-fixture-supplier-empty">NO MATCHES</div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      )
    }
    return value ? (
      <a className="spc-fixture-supplier-link" href={`/spc/suppliers?supplier=${encodeURIComponent(value)}`} target="_blank" rel="noreferrer">
        {value}
      </a>
    ) : "-"
  }

  function gradeNumberCell(
    fixture: SpcFixture,
    draft: FixtureDraft,
    field: "price" | "barging",
    key: FuelKey | null,
    editing: boolean,
  ) {
    const value = gradeValue(draft[field], key)
    if (editing) {
      return (
        <input
          inputMode="decimal"
          value={value}
          onChange={(event) => updateGradeDraft(fixture.id, field, key, event.target.value)}
          disabled={!canEdit}
        />
      )
    }
    return gradeNumberDisplay(draft[field], key)
  }

  function rowActionButtons(fixture: SpcFixture, editing: boolean, missing: string[]) {
    if (fixture.fixtureStatus === "pending") {
      const ready = missing.length === 0
      return (
        <button
          type="button"
          className={`spc-fixture-complete-button${ready ? " is-ready" : ""}`}
          onClick={() => void submitFixture(fixture, "complete")}
          disabled={!ready || savingId === `${fixture.id}:complete`}
          title={!ready ? `MISSING: ${missing.join(", ")}` : "COMPLETE"}
        >
          {savingId === `${fixture.id}:complete` ? "COMPLETING" : "COMPLETE"}
        </button>
      )
    }
    if (!editing) return null
    return (
      <div className="spc-fixture-row-actions">
        <button
          type="button"
          className="spc-fixture-save-button"
          onClick={() => void submitFixture(fixture, "save")}
          disabled={!canEdit || savingId === `${fixture.id}:save`}
        >
          {savingId === `${fixture.id}:save` ? "UPDATING" : "UPDATE"}
        </button>
        <button
          type="button"
          className="spc-fixture-delete-button"
          onClick={() => void deleteFixture(fixture)}
          disabled={!canEdit || savingId === `${fixture.id}:delete`}
        >
          {savingId === `${fixture.id}:delete` ? "DELETING" : "DELETE"}
        </button>
      </div>
    )
  }

  function renderFixtureRows(rows: SpcFixture[], mode: "pending" | "completed") {
    return rows.flatMap((fixture) => {
      const draft = drafts[fixture.id] || draftFromFixture(fixture)
      const rowCanEdit = canEditFixture(fixture, mode)
      const supplierTrader = activeTraderResolver.resolveUser(
        fixture.supplierTraderUsername,
        fixture.supplierTraderDisplayName,
      )
      const buyerTrader = activeTraderResolver.resolveUser(
        fixture.buyerTraderUsername,
        fixture.buyerTraderDisplayName,
      )
      const supplierTraderDisplay = activeTraderResolver.displayNameOrRetired(
        fixture.supplierTraderUsername,
        fixture.supplierTraderDisplayName,
      )
      const buyerTraderDisplay = activeTraderResolver.displayNameOrRetired(
        fixture.buyerTraderUsername,
        fixture.buyerTraderDisplayName,
        fixture.account,
      )
      const gradeRows = fuelRows(draft)
      return gradeRows.map((fuelRow) => {
        const rowKey = `${fixture.id}:${fuelRow.key || "all"}`
        const editing = rowCanEdit && (fixture.fixtureStatus === "pending" || editingId === rowKey)
        return (
          <tr
            key={rowKey}
            className={`${fixture.fixtureStatus === "pending" ? "is-pending" : ""}${editing ? " is-editing" : ""}`}
            data-fixture-action-key={rowCanEdit && (fixture.fixtureStatus === "pending" || editing) ? rowKey : undefined}
            onDoubleClick={() => {
              if (rowCanEdit && mode === "completed") {
                setSupplierMenuKey("")
                setEditingId(rowKey)
              }
            }}
          >
            <td>{displayDate(draft.fixtureDate)}</td>
            <td>{traderCode(supplierTrader, supplierTraderDisplay)}</td>
            <td>{traderCode(buyerTrader, buyerTraderDisplay)}</td>
            <td>{accountSelect(fixture, draft, editing)}</td>
            <td>{etaEditor(fixture, draft, editing)}</td>
            <td><strong>{staticOrInput(fixture, draft, "vesselName", editing)}</strong></td>
            {fuelColumns.map(({ key }) => (
              <td key={key}>
                {fuelRow.key === key || (!fuelRow.key && editing)
                  ? numericCell(fixture, draft, key, editing)
                  : ""}
              </td>
            ))}
            <td>{gradeSupplierCell(fixture, draft, fuelRow.key, editing)}</td>
            <td>{gradeNumberCell(fixture, draft, "price", fuelRow.key, editing)}</td>
            <td>{gradeNumberCell(fixture, draft, "barging", fuelRow.key, editing)}</td>
          </tr>
        )
      })
    })
  }

  if (authLoading || !authenticated || !hasPermissionSnapshot || !canView) {
    return <div className="spc-loading">LOADING...</div>
  }

  return (
    <SpcShell title="SPC FIXTURES">
      <section className="spc-panel spc-fixture-ledger-panel">
        <div className="spc-fixture-ledger-toolbar">
          <button type="button" className="spc-fixture-refresh-button" onClick={() => void loadData()} disabled={loading}>
            {loading ? "REFRESHING..." : "REFRESH"}
          </button>
        </div>
        <div className="spc-table-wrap" ref={fixtureTableRef}>
          <div
            className="spc-fixture-ledger-canvas"
            ref={fixtureCanvasRef}
            style={{ width: fixtureLedgerCanvasWidth, minWidth: fixtureLedgerCanvasWidth }}
          >
          <table className="spc-table spc-fixture-table" style={{ width: fixtureTableWidth, minWidth: fixtureTableWidth }}>
            <colgroup>
              {fixtureColumnWidths.map((width, index) => (
                <col key={`${width}-${index}`} style={{ width }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th>DATE</th>
                <th>SUPPLIER TRADER</th>
                <th>BUYER TRADER</th>
                <th>ACCT</th>
                <th>ETA</th>
                <th>VESSEL</th>
                <th>HSFO</th>
                <th>VLSFO</th>
                <th>LSMGO</th>
                <th>SUPPLIER</th>
                <th>PRICE</th>
                <th>BARGING</th>
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
                <td colSpan={fixtureColumnSpan}>
                  <div className="spc-fixture-section-content">
                    <span>FIXTURE TABLE</span>
                    <span className="spc-fixture-section-filters">
                      <select
                        aria-label="Fixture year filter"
                        value={fixtureYearFilter}
                        onChange={(event) => setFixtureYearFilter(event.target.value)}
                      >
                        <option value="">ALL YEARS</option>
                        {fixtureYearOptions.map((year) => (
                          <option key={year} value={year}>{year}</option>
                        ))}
                      </select>
                      <select
                        aria-label="Fixture month filter"
                        value={fixtureMonthFilter}
                        onChange={(event) => setFixtureMonthFilter(event.target.value)}
                      >
                        <option value="">ALL MONTHS</option>
                        {monthOptions.map((month) => (
                          <option key={month.value} value={month.value}>{month.label}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => {
                          setFixtureYearFilter("")
                          setFixtureMonthFilter("")
                        }}
                        disabled={!fixtureYearFilter && !fixtureMonthFilter}
                      >
                        SHOW ALL RECORDS
                      </button>
                    </span>
                  </div>
                </td>
              </tr>
              {renderFixtureRows(filteredCompletedFixtures, "completed")}
              {!loading && filteredCompletedFixtures.length === 0 ? (
                <tr className="spc-fixture-empty-row"><td colSpan={fixtureColumnSpan}>No completed fixtures for selected period.</td></tr>
              ) : null}
            </tbody>
          </table>
          {floatingActionRows.map((row) => (
            <div
              key={row.key}
              className="spc-fixture-external-actions"
              data-fixture-action-panel={row.key}
              style={{
                top: actionPositions[row.key] ?? -1000,
                left: fixtureTableWidth + fixtureActionRailGap,
                width: fixtureActionRailWidth,
              }}
            >
              {rowActionButtons(row.fixture, row.editing, row.missing)}
            </div>
          ))}
          </div>
        </div>
      </section>
    </SpcShell>
  )
}
