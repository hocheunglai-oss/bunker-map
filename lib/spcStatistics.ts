import type { SpcSession } from "@/lib/spcAuth"
import { createSpcAuditContext, createSpcAuditedSupabaseClient } from "@/lib/spcAudit"
import { normaliseSpcRole } from "@/lib/spcPages"
import { listActiveSpcUserOptions, type SpcUserOption } from "@/lib/spcUsers"

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
const tableStatisticsStartAt = new Date("2026-07-07T12:00:00+08:00")
const officeSuffixes: Record<string, string> = {
  GR: "GREECE",
  HK: "HONG KONG",
  IT: "ITALY",
  MC: "MONACO",
  SG: "SINGAPORE",
  US: "USA",
  USA: "USA",
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

function hkYearStartUtc(year: number) {
  return new Date(`${year}-01-01T00:00:00+08:00`).toISOString()
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

function yearEndDate(year: number) {
  return `${year}-12-31`
}

function daysSinceTableStart(year: number) {
  const currentYear = hongKongYear()
  const start = year === tableStatisticsStartAt.getFullYear()
    ? tableStatisticsStartAt
    : new Date(`${year}-01-01T00:00:00+08:00`)
  const today = hongKongDateParts()
  const end = year === currentYear
    ? new Date(`${today.year}-${today.month}-${today.day}T23:59:59+08:00`)
    : new Date(`${year}-12-31T23:59:59+08:00`)
  if (end.getTime() < start.getTime()) return 1
  const days = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1
  return Math.max(days, 1)
}

function isTableRecord(value: string | null | undefined) {
  const time = new Date(cleanText(value)).getTime()
  return Number.isFinite(time) && time >= tableStatisticsStartAt.getTime()
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
    .replace(/\b(120|180)\s*CST\s*MAX\b/gi, " ")
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
  if (!fuelKey) return upperText(fixture.supplier_name) || "UNKNOWN"
  return upperText(gradeValue(fixture.supplier_name, fuelKey)) || upperText(fixture.supplier_name) || "UNKNOWN"
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
  usersByUsername: Map<string, SpcUserOption>,
  username: string | null | undefined,
  displayName: string | null | undefined,
  account?: string | null,
) {
  const user = usersByUsername.get(cleanText(username).toLowerCase())
  return upperText(user?.office) || upperText(account) || suffixOffice(displayName) || domainOffice(username) || "UNKNOWN"
}

function traderLabel(
  usersByUsername: Map<string, SpcUserOption>,
  username: string | null | undefined,
  displayName: string | null | undefined,
) {
  const user = usersByUsername.get(cleanText(username).toLowerCase())
  const display = upperText(user?.displayName || displayName || username)
  const office = officeFor(usersByUsername, username, displayName)
  const firstName = display.split(/\s+/)[0] || display
  const suffix = office === "HONG KONG" ? "HK" : office === "SINGAPORE" ? "SG" : office === "ITALY" ? "IT" : office === "MONACO" ? "MC" : office === "GREECE" ? "GR" : office
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

async function loadFixtures(
  supabase: ReturnType<typeof createSpcAuditedSupabaseClient>,
  firstYear: number,
  lastYear: number,
) {
  const { data, error } = await supabase
    .from("spc_fixtures")
    .select(`
      id,
      fixture_status,
      fixture_date,
      supplier_trader_username,
      supplier_trader_display_name,
      buyer_trader_username,
      buyer_trader_display_name,
      account,
      vessel_name,
      hsfo,
      vlsfo,
      lsmgo,
      supplier_name,
      supplier_key,
      created_at,
      enquiry:spc_enquiries!spc_fixtures_enquiry_id_fkey(
        enquiry_number,
        created_by_username,
        created_by_display_name,
        created_at
      )
    `)
    .eq("fixture_status", "completed")
    .gte("fixture_date", `${firstYear}-01-01`)
    .lte("fixture_date", yearEndDate(lastYear))
    .order("fixture_date", { ascending: true })
    .range(0, 4999)

  if (error) throw error
  return (data || []) as unknown as SpcStatisticsFixtureRow[]
}

async function loadEnquiries(
  supabase: ReturnType<typeof createSpcAuditedSupabaseClient>,
  year: number,
) {
  const { data, error } = await supabase
    .from("spc_enquiries")
    .select("id,enquiry_number,title,created_by_username,created_by_display_name,created_at")
    .gte("created_at", hkYearStartUtc(year))
    .lt("created_at", hkYearStartUtc(year + 1))
    .order("created_at", { ascending: true })
    .range(0, 4999)

  if (error) throw error
  return (data || []) as unknown as SpcStatisticsEnquiryRow[]
}

export async function loadSpcStatistics(session: SpcSession, yearInput?: number | string | null): Promise<SpcStatisticsPayload> {
  const selectedYear = parseSelectedYear(yearInput)
  const lastYear = selectedYear - 1
  const context = createSpcAuditContext(session, undefined, "spc-statistics")
  const supabase = createSpcAuditedSupabaseClient(context)
  const [fixtures, enquiries, users] = await Promise.all([
    loadFixtures(supabase, lastYear, selectedYear),
    loadEnquiries(supabase, selectedYear),
    listActiveSpcUserOptions(),
  ])
  const usersByUsername = userMap(users)
  const selectedFixtures = fixtures.filter((fixture) => fixtureYear(fixture) === selectedYear)
  const nativeFixtures = selectedFixtures.filter((fixture) => !isImportedEnquiry(fixture.enquiry?.enquiry_number))
  const nativeEnquiries = enquiries.filter((enquiry) => !isImportedEnquiry(enquiry.enquiry_number))
  const tableFixtures = nativeFixtures.filter((fixture) => isTableRecord(fixture.created_at))
  const tableEnquiries = nativeEnquiries.filter((enquiry) => isTableRecord(enquiry.created_at))
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
    .filter((user) => normaliseSpcRole(user.role) === "SUPPLIER TRADER")
    .forEach((user) => {
      supplierTraderFixtureCount.set(traderLabel(usersByUsername, user.username, user.displayName), 0)
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

  selectedFixtures.forEach((fixture) => {
    const office = officeFor(usersByUsername, fixture.buyer_trader_username, fixture.buyer_trader_display_name, fixture.account)
    fuelLines(fixture).forEach((line) => {
      addMetric(volumeBySupplier, line.supplier, line.volume)
      addMetric(fixturesBySupplier, line.supplier)
      addMetric(volumeByOffice, office, line.volume)
      addMetric(fixturesByOffice, office)
    })
  })

  tableFixtures.forEach((fixture) => {
    const office = officeFor(usersByUsername, fixture.buyer_trader_username, fixture.buyer_trader_display_name, fixture.account)
    const trader = traderLabel(usersByUsername, fixture.buyer_trader_username, fixture.buyer_trader_display_name)
    const supplierTrader = traderLabel(usersByUsername, fixture.supplier_trader_username, fixture.supplier_trader_display_name)
    addMetric(officeFixtures, office)
    addMetric(traderFixtures, trader)
    addMetric(supplierTraderFixtureCount, supplierTrader)
  })

  tableEnquiries.forEach((enquiry) => {
    const office = officeFor(usersByUsername, enquiry.created_by_username, enquiry.created_by_display_name)
    const trader = traderLabel(usersByUsername, enquiry.created_by_username, enquiry.created_by_display_name)
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
    yearOptions,
    sourceCounts: {
      graphFixtures: selectedFixtures.length,
      importedFixtures: selectedFixtures.filter((fixture) => isImportedEnquiry(fixture.enquiry?.enquiry_number)).length,
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
      period: selectedYear === tableStatisticsStartAt.getFullYear() ? "FROM 07 JUL 2026" : String(selectedYear),
      enquiries: tableEnquiries.length,
      days: daysSinceTableStart(selectedYear),
      averagePerDay: Math.round((tableEnquiries.length / daysSinceTableStart(selectedYear)) * 100) / 100,
    }],
    buyerOfficeHitRate: hitRateRows(officeEnquiries, officeFixtures),
    buyerTraderHitRate: hitRateRows(traderEnquiries, traderFixtures),
    supplierTraderFixtureCount: pointsFromMap(supplierTraderFixtureCount),
  }
}
