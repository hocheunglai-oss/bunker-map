import type { SpcStatisticsPayload } from "@/lib/spcStatistics"

export class SpcStatisticsReportError extends Error {
  constructor() { super("Statistics could not be verified. Please refresh."); this.name = "SpcStatisticsReportError" }
}
function fail(): never { throw new SpcStatisticsReportError() }
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail()
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) fail()
}
function number(value: unknown, integer = false): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER && (!integer || Number.isSafeInteger(value)) ? value : fail()
}
function text(value: unknown): string { return typeof value === "string" && value.trim() ? value : fail() }
function date(value: unknown): number {
  const raw = text(value), parsed = Date.parse(raw + "T00:00:00Z")
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== raw) fail()
  return parsed
}
function rows(value: unknown, fields: string[], numeric: string[], integer: string[] = []) {
  if (!Array.isArray(value)) return fail()
  const labels = new Set<string>()
  for (const item of value) {
    const row = record(item); keys(row, fields)
    const label = text(row.label)
    if (labels.has(label)) fail()
    labels.add(label)
    numeric.forEach(key => number(row[key], integer.includes(key)))
  }
  return value as Record<string, unknown>[]
}

// Rendering validation only: keep imported/native, per-grade counts and existing
// financial calculations in the server library. Hit rate can legitimately exceed100.
export function parseSpcStatisticsReport(value: unknown, expectedYear: number): SpcStatisticsPayload {
  const report = record(value)
  keys(report, ["generatedAt", "selectedYear", "lastYear", "windowLabel", "windowStartDate", "windowEndDate", "yearOptions", "sourceCounts", "monthlyVolume", "volumeBySupplier", "fixturesBySupplier", "volumeByOffice", "fixturesByOffice", "workload", "buyerOfficeHitRate", "buyerTraderHitRate", "supplierTraderFixtureCount"])
  if (report.selectedYear !== expectedYear || report.lastYear !== expectedYear - 1 || report.windowLabel !== "LAST 90 DAYS") fail()
  const generatedAt = text(report.generatedAt)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(generatedAt) || !Number.isFinite(Date.parse(generatedAt))) fail()
  if (date(report.windowEndDate) - date(report.windowStartDate) !== 89 * 86400000) fail()
  if (!Array.isArray(report.yearOptions) || !report.yearOptions.includes(expectedYear) || !report.yearOptions.includes(expectedYear - 1) || new Set(report.yearOptions).size !== report.yearOptions.length) fail()
  report.yearOptions.forEach(year => number(year, true))
  const counts = record(report.sourceCounts)
  keys(counts, ["graphFixtures", "importedFixtures", "nativeFixtures", "nativeEnquiries"])
  Object.values(counts).forEach(value => number(value, true))
  if (number(counts.importedFixtures) > number(counts.graphFixtures)) fail()
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
  if (!Array.isArray(report.monthlyVolume) || report.monthlyVolume.length !== 12) fail()
  report.monthlyVolume.forEach((item, index) => {
    const row = record(item); keys(row, ["month", "currentYearVolume", "lastYearVolume"])
    if (row.month !== months[index]) fail()
    number(row.currentYearVolume); number(row.lastYearVolume)
  })
  for (const key of ["volumeBySupplier", "fixturesBySupplier", "volumeByOffice", "fixturesByOffice", "supplierTraderFixtureCount"]) {
    const points = rows(report[key], ["label", "value"], ["value"], key.startsWith("fixtures") || key === "supplierTraderFixtureCount" ? ["value"] : [])
    if (points.length > 12) fail()
  }
  if (!Array.isArray(report.workload) || report.workload.length !== 1) fail()
  const workload = record(report.workload[0]); keys(workload, ["period", "enquiries", "days", "averagePerDay"])
  if (workload.period !== "LAST 90 DAYS" || workload.days !== 90 || workload.enquiries !== counts.nativeEnquiries || number(workload.averagePerDay) !== Math.round(number(workload.enquiries, true) / 90 * 100) / 100) fail()
  for (const key of ["buyerOfficeHitRate", "buyerTraderHitRate"]) {
    const rates = rows(report[key], ["label", "enquiries", "fixtures", "hitRate"], ["enquiries", "fixtures", "hitRate"], ["enquiries", "fixtures"])
    for (const row of rates) {
      const expected = number(row.enquiries) > 0 ? Math.round(number(row.fixtures) / number(row.enquiries) * 1000) / 10 : 0
      if (row.hitRate !== expected) fail()
    }
    if (rates.reduce((sum, row) => sum + number(row.enquiries), 0) !== counts.nativeEnquiries || rates.reduce((sum, row) => sum + number(row.fixtures), 0) !== counts.nativeFixtures) fail()
  }
  return report as SpcStatisticsPayload
}
