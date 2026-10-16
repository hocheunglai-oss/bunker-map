import type { SpcSession } from "@/lib/spcAuth"
import { createActiveSpcTraderResolver } from "@/lib/spcActiveTraders"
import { createSpcAuditContext, createSpcAuditedSupabaseClient } from "@/lib/spcAudit"
import { normaliseSpcRole } from "@/lib/spcPages"
import { displaySupplierName } from "@/lib/spcSupplierKeys"
import { projectSpcUserReferenceOptions, type SpcUserOption } from "@/lib/spcUsers"

type FuelKey = "hsfo" | "vlsfo" | "lsmgo"

type SpcStatisticsEnquiryRow = {
  id: string
  enquiry_number: string
  title: string
  created_by_username: string
  created_by_display_name: string
  created_at: string
}

type SpcStatisticsFixtureRow = {
  id: string
  fixture_status: string
  fixture_date: string | null
  supplier_trader_username: string
  supplier_trader_display_name: string
  buyer_trader_username: string
  buyer_trader_display_name: string
  account: string | null
  vessel_name: string | null
  hsfo: string | null
  vlsfo: string | null
  lsmgo: string | null
  supplier_name: string | null
  supplier_key: string | null
  created_at: string
  enquiry?: {
    enquiry_number: string
    created_by_username: string
    created_by_display_name: string
    created_at: string
  } | null
}

export type SpcChartPoint = {
  label: string
  value: number
}

export type SpcMonthlyVolumePoint = {
  month: string
  currentYearVolume: number
  lastYearVolume: number
}

export type SpcHitRateRow = {
  label: string
  enquiries: number
  fixtures: number
  hitRate: number
}

export type SpcWorkloadRow = {
  period: string
  enquiries: number
  days: number
  averagePerDay: number
}

export type SpcStatisticsPayload = {
  generatedAt: string
  selectedYear: number
  lastYear: number
  windowLabel: string
  windowStartDate: string
  windowEndDate: string
  yearOptions: number[]
  sourceCounts: {
    graphFixtures: number
    importedFixtures: number
    nativeFixtures: number
    nativeEnquiries: number
  }
  monthlyVolume: SpcMonthlyVolumePoint[]
  volumeBySupplier: SpcChartPoint[]
  fixturesBySupplier: SpcChartPoint[]
  volumeByOffice: SpcChartPoint[]
  fixturesByOffice: SpcChartPoint[]
  workload: SpcWorkloadRow[]
  buyerOfficeHitRate: SpcHitRateRow[]
  buyerTraderHitRate: SpcHitRateRow[]
  supplierTraderFixtureCount: SpcChartPoint[]
}

const fuelColumns: Array<{ key: FuelKey; label: string }> = [
  { key: "hsfo", label: "HSFO" },
  { key: "vlsfo", label: "VLSFO" },
  { key: "lsmgo", label: "LSMGO" },
]

const monthLabels = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
const statisticsWindowDays = 90
const millisecondsPerDay = 86400000
const officeSuffixes: Record<string, string> = {
  GR: "GREECE",
  HK: "HONG KONG",
  IT: "ITALY",
  MC: "MONACO",
  SG: "SINGAPORE",
  US: "USA",
  USA: "USA",
  UAE: "UNITED ARAB EMIRATES",
  VN: "VIETNAM",
}

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim()
}

function upperText(value: unknown) {
  return cleanText(value).toUpperCase()
}

function isImportedEnquiry(enquiryNumber: string | null | undefined) {
  return upperText(enquiryNumber).startsWith("SPCIMP-")
}

function hongKongYear() {
  const value = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
  }).format(new Date())
  return Number(value) || new Date().getFullYear()
}

function hongKongDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || ""
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
  }
}

function hongKongDateString(date = new Date()) {
  const parts = hongKongDateParts(date)
  return `${parts.year}-${parts.month}-${parts.day}`
}

function last90DayWindow() {
  const endDate = hongKongDateString()
  const end = new Date(`${endDate}T23:59:59+08:00`)
  const start = new Date(end.getTime() - (statisticsWindowDays - 1) * millisecondsPerDay)
  const startDate = hongKongDateString(start)
  const startIso = new Date(`${startDate}T00:00:00+08:00`).toISOString()
  const endIso = end.toISOString()
  return {
    label: "LAST 90 DAYS",
    startDate,
    endDate,
    startIso,
    endIso,
    startTime: new Date(startIso).getTime(),
    endTime: new Date(endIso).getTime(),
    days: statisticsWindowDays,
  }
}

function isFixtureDateInWindow(value: string | null | undefined, startDate: string, endDate: string) {
  const date = cleanText(value).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= startDate && date <= endDate
}

function isCreatedInWindow(value: string | null | undefined, startTime: number, endTime: number) {
  const time = new Date(cleanText(value)).getTime()
  return Number.isFinite(time) && time >= startTime && time <= endTime
}

function parseSelectedYear(value: number | string | null | undefined) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 2000 && parsed <= 2100 ? parsed : hongKongYear()
}

function addMetric(map: Map<string, number>, key: string, value = 1) {
  const label = key || "UNKNOWN"
  map.set(label, (map.get(label) || 0) + value)
}

function pointsFromMap(map: Map<string, number>, limit = 12) {
  return Array.from(map.entries())
    .map(([label, value]) => ({ label, value: Math.round(value * 10) / 10 }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
    .slice(0, limit)
}

function parseGradeValues(value: unknown) {
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
    const key = fuelColumns.find((column) => column.label === match[1].toUpperCase())?.key
    if (key) map[key] = cleanText(match[2])
  })
  return { encoded, map: encoded ? map : {} }
}

function gradeValue(value: unknown, key: FuelKey) {
  const text = cleanText(value)
  const parsed = parseGradeValues(text)
  if (parsed.encoded) return cleanText(parsed.map[key])
  return text
}

function quantityMedium(value: unknown) {
  const cleaned = cleanText(value)
    .replace(/[–—]/g, "-")
    .replace(/\b(80|120|180)\s*CST\s*MAX\b/gi, " ")
    .replace(/\bCST\b/gi, " ")
  if (!cleaned) return 0
  const range = cleaned.match(/(\d[\d,]*(?:\.\d+)?)\s*-\s*(\d[\d,]*(?:\.\d+)?)/)
  if (range) {
    const left = Number(range[1].replace(/,/g, ""))
    const right = Number(range[2].replace(/,/g, ""))
    if (Number.isFinite(left) && Number.isFinite(right)) return (left + right) / 2
  }
  const number = cleaned.match(/\d[\d,]*(?:\.\d+)?/)
  if (!number) return 0
  const parsed = Number(number[0].replace(/,/g, ""))
  return Number.isFinite(parsed) ? parsed : 0
}

function fixtureYear(fixture: SpcStatisticsFixtureRow) {
  return Number(cleanText(fixture.fixture_date).slice(0, 4))
}

function fixtureMonthIndex(fixture: SpcStatisticsFixtureRow) {
  const month = Number(cleanText(fixture.fixture_date).slice(5, 7))
  return Number.isInteger(month) && month >= 1 && month <= 12 ? month - 1 : -1
}

function supplierForFuel(fixture: SpcStatisticsFixtureRow, fuelKey: FuelKey | null) {
  if (!fuelKey) return upperText(displaySupplierName(fixture.supplier_name)) || "UNKNOWN"
  return upperText(displaySupplierName(gradeValue(fixture.supplier_name, fuelKey))) || upperText(displaySupplierName(fixture.supplier_name)) || "UNKNOWN"
}

function suffixOffice(displayName: string | null | undefined) {
  const match = upperText(displayName).match(/-([A-Z]{2,3})$/)
  return match ? officeSuffixes[match[1]] || match[1] : ""
}

function domainOffice(username: string | null | undefined) {
  const value = cleanText(username).toLowerCase()
  if (value.endsWith(".hk")) return "HONG KONG"
  if (value.endsWith(".sg")) return "SINGAPORE"
  if (value.endsWith(".it")) return "ITALY"
  if (value.endsWith(".mc")) return "MONACO"
  if (value.endsWith(".gr")) return "GREECE"
  return ""
}

function userMap(users: SpcUserOption[]) {
  return new Map(users.map((user) => [user.username.toLowerCase(), user]))
}

function officeFor(
  activeTraders: ReturnType<typeof createActiveSpcTraderResolver>,
  usersByUsername: Map<string, SpcUserOption>,
  username: string | null | undefined,
  displayName: string | null | undefined,
  account?: string | null,
) {
  const user = usersByUsername.get(cleanText(username).toLowerCase())
  return (
    upperText(user?.office) ||
    upperText(activeTraders.officeForTrader(username, displayName)) ||
    upperText(account) ||
    suffixOffice(displayName) ||
    domainOffice(username) ||
    "UNKNOWN"
  )
}

function traderLabel(
  activeTraders: ReturnType<typeof createActiveSpcTraderResolver>,
  usersByUsername: Map<string, SpcUserOption>,
  username: string | null | undefined,
  displayName: string | null | undefined,
  account?: string | null,
) {
  const user = activeTraders.resolveUser(username, displayName)
  if (!user) return upperText(activeTraders.displayNameOrRetired(username, displayName, account)) || "UNKNOWN"
  const display = upperText(user.displayName || displayName || username)
  const office = officeFor(activeTraders, usersByUsername, user.username, user.displayName)
  const firstName = display.split(/\s+/)[0] || display
  const suffix = office === "HONG KONG" ? "HK" : office === "SINGAPORE" ? "SG" : office === "ITALY" ? "IT" : office === "MONACO" ? "MC" : office === "GREECE" ? "GR" : office === "UNITED ARAB EMIRATES" || office === "UAE" ? "AE" : office
  return suffix && firstName ? `${firstName}-${suffix}` : firstName || "UNKNOWN"
}

function fuelLines(fixture: SpcStatisticsFixtureRow) {
  const lines = fuelColumns
    .map(({ key, label }) => ({
      fuelKey: key,
      fuelLabel: label,
      volume: quantityMedium(fixture[key]),
      supplier: supplierForFuel(fixture, key),
    }))
    .filter((line) => line.volume > 0)

  if (lines.length > 0) return lines
  return [{
    fuelKey: null,
    fuelLabel: "",
    volume: 0,
    supplier: supplierForFuel(fixture, null),
  }]
}

function hitRateRows(enquiryCounts: Map<string, number>, fixtureCounts: Map<string, number>) {
  const labels = new Set([...enquiryCounts.keys(), ...fixtureCounts.keys()])
  return Array.from(labels)
    .map((label) => {
      const enquiries = enquiryCounts.get(label) || 0
      const fixtures = fixtureCounts.get(label) || 0
      return {
        label,
        enquiries,
        fixtures,
        hitRate: enquiries > 0 ? Math.round((fixtures / enquiries) * 1000) / 10 : 0,
      }
    })
    .sort((a, b) => b.hitRate - a.hitRate || b.fixtures - a.fixtures || b.enquiries - a.enquiries || a.label.localeCompare(b.label))
}

type StatisticsSourceBounds = { firstFixtureYear: number; lastFixtureYear: number; windowStart: string; windowEnd: string }
type StatisticsUserRow = { id: string; username: string; display_name: string | null; role: string; is_active: boolean }
type StatisticsSource = { fixtures: SpcStatisticsFixtureRow[]; enquiries: SpcStatisticsEnquiryRow[]; users: StatisticsUserRow[]; buyerEnquiryNumbers: string[]; roles: Array<Record<string, string | null>>; profiles: Array<Record<string, string | null>> }

const statisticsSourceFields = {
  fixtures: ["id", "fixture_status", "fixture_date", "supplier_trader_username", "supplier_trader_display_name", "buyer_trader_username", "buyer_trader_display_name", "account", "vessel_name", "hsfo", "vlsfo", "lsmgo", "supplier_name", "supplier_key", "created_at", "enquiry"],
  enquiries: ["id", "enquiry_number", "title", "created_by_username", "created_by_display_name", "created_at"],
  users: ["id", "username", "display_name", "role", "is_active"],
  roles: ["userId", "username", "role"],
  profiles: ["userId", "username", "office"],
} as const
const sourceFailure = () => new Error("SPC statistics source is incomplete or invalid. Refresh again; no partial totals were produced.")

function sourceObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw sourceFailure()
  return value as Record<string, unknown>
}
function exactSourceFields(row: Record<string, unknown>, fields: readonly string[]) {
  if (Object.keys(row).length !== fields.length || fields.some((key) => !Object.prototype.hasOwnProperty.call(row, key))) throw sourceFailure()
}
function sourceText(value: unknown, nullable = false) {
  if ((nullable && value === null) || typeof value === "string") return
  throw sourceFailure()
}
function sourceTime(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime())) throw sourceFailure()
}
function sourceId(value: unknown) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw sourceFailure()
}

function parseStatisticsSource(value: unknown, expected: StatisticsSourceBounds): StatisticsSource {
  const source = sourceObject(value)
  exactSourceFields(source, ["schema", "complete", "bounds", "fixtures", "enquiries", "users", "buyerEnquiryNumbers", "roles", "profiles", "counts"])
  if (source.schema !== "fcuno.spc-statistics-source/v1" || source.complete !== true) throw sourceFailure()
  const bounds = sourceObject(source.bounds)
  exactSourceFields(bounds, ["firstFixtureYear", "lastFixtureYear", "windowStart", "windowEnd"])
  if (bounds.firstFixtureYear !== expected.firstFixtureYear || bounds.lastFixtureYear !== expected.lastFixtureYear) throw sourceFailure()
  for (const key of ["windowStart", "windowEnd"] as const) {
    sourceTime(bounds[key])
    if (new Date(bounds[key] as string).getTime() !== new Date(expected[key]).getTime()) throw sourceFailure()
  }
  const counts = sourceObject(source.counts)
  const kinds = ["fixtures", "enquiries", "users", "buyerEnquiryNumbers", "roles", "profiles"] as const
  exactSourceFields(counts, kinds)
  // SQL measures each bounded projection before materialising its aggregate.
  // Verify that same complete wire contract here without another giant stringify.
  let bytes = 4096
  for (const kind of kinds) {
    const rows = source[kind]
    if (!Array.isArray(rows) || !Number.isSafeInteger(counts[kind]) || counts[kind] !== rows.length) throw sourceFailure()
    const ids = new Set<string>()
    for (const item of rows) {
      const encoded = JSON.stringify(item)
      bytes += Buffer.byteLength(encoded, "utf8") + 2
      if (bytes > 32 * 1024 * 1024) throw sourceFailure()
      if (kind === "buyerEnquiryNumbers") { sourceText(item); continue }
      const row = sourceObject(item)
      exactSourceFields(row, statisticsSourceFields[kind])
      if (kind === "roles" || kind === "profiles") {
        for (const field of statisticsSourceFields[kind]) sourceText(row[field], true)
        continue
      }
      sourceId(row.id)
      if (ids.has(row.id as string)) throw sourceFailure()
      ids.add(row.id as string)
      if (kind === "users") {
        sourceText(row.username); sourceText(row.display_name, true); sourceText(row.role)
        if (typeof row.is_active !== "boolean") throw sourceFailure()
        continue
      }
      sourceTime(row.created_at)
      if (kind === "enquiries") {
        for (const field of ["enquiry_number", "title", "created_by_username", "created_by_display_name"]) sourceText(row[field])
        continue
      }
      if (row.fixture_status !== "completed" || typeof row.fixture_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.fixture_date)) throw sourceFailure()
      for (const field of ["supplier_trader_username", "supplier_trader_display_name", "buyer_trader_username", "buyer_trader_display_name"]) sourceText(row[field])
      for (const field of ["account", "vessel_name", "hsfo", "vlsfo", "lsmgo", "supplier_name", "supplier_key"]) sourceText(row[field], true)
      if (row.enquiry !== null) {
        const enquiry = sourceObject(row.enquiry)
        exactSourceFields(enquiry, ["enquiry_number", "created_by_username", "created_by_display_name", "created_at"])
        for (const field of ["enquiry_number", "created_by_username", "created_by_display_name"]) sourceText(enquiry[field])
        sourceTime(enquiry.created_at)
      }
    }
  }
  return source as unknown as StatisticsSource
}

async function loadStatisticsSource(supabase: ReturnType<typeof createSpcAuditedSupabaseClient>, bounds: StatisticsSourceBounds) {
  const { data, error } = await supabase.rpc("read_spc_statistics_source", {
    p_first_fixture_year: bounds.firstFixtureYear,
    p_last_fixture_year: bounds.lastFixtureYear,
    p_window_start: bounds.windowStart,
    p_window_end: bounds.windowEnd,
  })
  if (error) throw error
  return parseStatisticsSource(data, bounds)
}

export async function loadSpcStatistics(session: SpcSession, yearInput?: number | string | null): Promise<SpcStatisticsPayload> {
  const selectedYear = parseSelectedYear(yearInput)
  const lastYear = selectedYear - 1
  const statisticsWindow = last90DayWindow()
  const windowStartYear = Number(statisticsWindow.startDate.slice(0, 4))
  const windowEndYear = Number(statisticsWindow.endDate.slice(0, 4))
  const firstFixtureYear = Math.min(lastYear, windowStartYear)
  const lastFixtureYear = Math.max(selectedYear, windowEndYear)
  const context = createSpcAuditContext(session, undefined, "spc-statistics")
  const supabase = createSpcAuditedSupabaseClient(context)
  const source = await loadStatisticsSource(supabase, {
    firstFixtureYear,
    lastFixtureYear,
    windowStart: statisticsWindow.startIso,
    windowEnd: statisticsWindow.endIso,
  })
  const { fixtures, enquiries } = source
  const users = projectSpcUserReferenceOptions(source.users, { userRoles: source.roles, userProfiles: source.profiles })
  const spcBuyerEnquiryNumbers = new Set(source.buyerEnquiryNumbers.map(cleanText).filter(Boolean))
  const usersByUsername = userMap(users)
  const activeTraders = createActiveSpcTraderResolver(users)
  const nativeEnquiries = enquiries.filter((enquiry) => (
    !isImportedEnquiry(enquiry.enquiry_number)
    && spcBuyerEnquiryNumbers.has(cleanText(enquiry.enquiry_number))
  ))
  const graphWindowFixtures = fixtures.filter((fixture) => (
    isFixtureDateInWindow(fixture.fixture_date, statisticsWindow.startDate, statisticsWindow.endDate)
  ))
  const tableFixtures = fixtures.filter((fixture) => (
    !isImportedEnquiry(fixture.enquiry?.enquiry_number)
    && spcBuyerEnquiryNumbers.has(cleanText(fixture.enquiry?.enquiry_number))
    && isCreatedInWindow(fixture.created_at, statisticsWindow.startTime, statisticsWindow.endTime)
  ))
  const tableEnquiries = nativeEnquiries.filter((enquiry) => (
    isCreatedInWindow(enquiry.created_at, statisticsWindow.startTime, statisticsWindow.endTime)
  ))
  const currentMonthly = Array.from({ length: 12 }, () => 0)
  const lastMonthly = Array.from({ length: 12 }, () => 0)
  const volumeBySupplier = new Map<string, number>()
  const fixturesBySupplier = new Map<string, number>()
  const volumeByOffice = new Map<string, number>()
  const fixturesByOffice = new Map<string, number>()
  const supplierTraderFixtureCount = new Map<string, number>()
  const officeEnquiries = new Map<string, number>()
  const officeFixtures = new Map<string, number>()
  const traderEnquiries = new Map<string, number>()
  const traderFixtures = new Map<string, number>()

  users
    .filter((user) => user.isActive !== false && normaliseSpcRole(user.role) === "SUPPLIER TRADER")
    .forEach((user) => {
      supplierTraderFixtureCount.set(traderLabel(activeTraders, usersByUsername, user.username, user.displayName), 0)
    })

  fixtures.forEach((fixture) => {
    const year = fixtureYear(fixture)
    const monthIndex = fixtureMonthIndex(fixture)
    if (monthIndex < 0) return
    const lines = fuelLines(fixture)
    const totalVolume = lines.reduce((total, line) => total + line.volume, 0)
    if (year === selectedYear) currentMonthly[monthIndex] += totalVolume
    if (year === lastYear) lastMonthly[monthIndex] += totalVolume
  })

  graphWindowFixtures.forEach((fixture) => {
    const office = officeFor(activeTraders, usersByUsername, fixture.buyer_trader_username, fixture.buyer_trader_display_name, fixture.account)
    fuelLines(fixture).forEach((line) => {
      addMetric(volumeBySupplier, line.supplier, line.volume)
      addMetric(fixturesBySupplier, line.supplier)
      addMetric(volumeByOffice, office, line.volume)
      addMetric(fixturesByOffice, office)
    })
  })

  tableFixtures.forEach((fixture) => {
    const office = officeFor(activeTraders, usersByUsername, fixture.buyer_trader_username, fixture.buyer_trader_display_name, fixture.account)
    const trader = traderLabel(activeTraders, usersByUsername, fixture.buyer_trader_username, fixture.buyer_trader_display_name, fixture.account)
    const supplierTrader = traderLabel(activeTraders, usersByUsername, fixture.supplier_trader_username, fixture.supplier_trader_display_name)
    addMetric(officeFixtures, office)
    addMetric(traderFixtures, trader)
    addMetric(supplierTraderFixtureCount, supplierTrader)
  })

  tableEnquiries.forEach((enquiry) => {
    const office = officeFor(activeTraders, usersByUsername, enquiry.created_by_username, enquiry.created_by_display_name)
    const trader = traderLabel(activeTraders, usersByUsername, enquiry.created_by_username, enquiry.created_by_display_name)
    addMetric(officeEnquiries, office)
    addMetric(traderEnquiries, trader)
  })

  const yearOptions = Array.from(new Set([
    selectedYear,
    lastYear,
    ...fixtures.map(fixtureYear).filter((year) => Number.isInteger(year)),
    ...enquiries.map((enquiry) => Number(cleanText(enquiry.created_at).slice(0, 4))).filter((year) => Number.isInteger(year)),
  ])).sort((a, b) => b - a)

  return {
    generatedAt: new Date().toISOString(),
    selectedYear,
    lastYear,
    windowLabel: statisticsWindow.label,
    windowStartDate: statisticsWindow.startDate,
    windowEndDate: statisticsWindow.endDate,
    yearOptions,
    sourceCounts: {
      graphFixtures: graphWindowFixtures.length,
      importedFixtures: graphWindowFixtures.filter((fixture) => isImportedEnquiry(fixture.enquiry?.enquiry_number)).length,
      nativeFixtures: tableFixtures.length,
      nativeEnquiries: tableEnquiries.length,
    },
    monthlyVolume: monthLabels.map((month, index) => ({
      month,
      currentYearVolume: Math.round(currentMonthly[index] * 10) / 10,
      lastYearVolume: Math.round(lastMonthly[index] * 10) / 10,
    })),
    volumeBySupplier: pointsFromMap(volumeBySupplier),
    fixturesBySupplier: pointsFromMap(fixturesBySupplier),
    volumeByOffice: pointsFromMap(volumeByOffice),
    fixturesByOffice: pointsFromMap(fixturesByOffice),
    workload: [{
      period: statisticsWindow.label,
      enquiries: tableEnquiries.length,
      days: statisticsWindow.days,
      averagePerDay: Math.round((tableEnquiries.length / statisticsWindow.days) * 100) / 100,
    }],
    buyerOfficeHitRate: hitRateRows(officeEnquiries, officeFixtures),
    buyerTraderHitRate: hitRateRows(traderEnquiries, traderFixtures),
    supplierTraderFixtureCount: pointsFromMap(supplierTraderFixtureCount),
  }
}
