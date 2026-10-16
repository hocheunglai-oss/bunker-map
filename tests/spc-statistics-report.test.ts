import assert from "node:assert/strict"
import test from "node:test"
import { parseSpcStatisticsReport } from "../lib/spcStatisticsReport"

function report() {
  return { generatedAt: "2026-10-16T05:00:00.123456Z", selectedYear: 2026, lastYear: 2025, windowLabel: "LAST 90 DAYS", windowStartDate: "2026-07-19", windowEndDate: "2026-10-16", yearOptions: [2026, 2025],
    sourceCounts: { graphFixtures: 2, importedFixtures: 1, nativeFixtures: 3, nativeEnquiries: 2 },
    monthlyVolume: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"].map(month => ({ month, currentYearVolume: 0, lastYearVolume: 0 })),
    volumeBySupplier: [], fixturesBySupplier: [], volumeByOffice: [], fixturesByOffice: [], supplierTraderFixtureCount: [],
    workload: [{ period: "LAST 90 DAYS", enquiries: 2, days: 90, averagePerDay: 0.02 }], buyerOfficeHitRate: [{ label: "HONG KONG", enquiries: 2, fixtures: 3, hitRate: 150 }], buyerTraderHitRate: [{ label: "SYNTHETIC", enquiries: 2, fixtures: 3, hitRate: 150 }] }
}
test("SPC client validates complete report without inventing bounds for existing imported/native and >100 hit rates", () => {
  const value = report(); assert.deepEqual(parseSpcStatisticsReport(value, 2026), value)
})
test("SPC client rejects malformed, stale-period, non-finite and contradictory payloads", () => {
  const mutations = [
    (v: ReturnType<typeof report>) => { v.selectedYear = 2025 },
    (v: ReturnType<typeof report>) => { v.windowStartDate = "2026-02-31" },
    (v: ReturnType<typeof report>) => { v.windowEndDate = "2026-10-15" },
    (v: ReturnType<typeof report>) => { v.monthlyVolume.pop() },
    (v: ReturnType<typeof report>) => { v.monthlyVolume[0].currentYearVolume = Infinity },
    (v: ReturnType<typeof report>) => { v.sourceCounts.nativeEnquiries = Number.MAX_SAFE_INTEGER + 1 },
    (v: ReturnType<typeof report>) => { v.sourceCounts.importedFixtures = 3 },
    (v: ReturnType<typeof report>) => { v.workload[0].averagePerDay = 99 },
    (v: ReturnType<typeof report>) => { v.buyerOfficeHitRate[0].hitRate = 100 },
    (v: ReturnType<typeof report>) => { v.buyerTraderHitRate[0].enquiries = -1 },
    (v: ReturnType<typeof report>) => { v.buyerTraderHitRate = [] },
    (v: ReturnType<typeof report>) => { v.buyerOfficeHitRate.push(v.buyerOfficeHitRate[0]) },
  ]
  for (const mutate of mutations) { const value = report(); mutate(value); assert.throws(() => parseSpcStatisticsReport(value, 2026), /could not be verified/) }
  for (const value of [null, [], {}, { message: "error" }]) assert.throws(() => parseSpcStatisticsReport(value, 2026), /could not be verified/)
})
test("SPC verified empty report remains distinguishable from unavailable", () => {
  const value = report(); value.sourceCounts = { graphFixtures: 0, importedFixtures: 0, nativeFixtures: 0, nativeEnquiries: 0 }; value.workload[0].enquiries = 0; value.workload[0].averagePerDay = 0; value.buyerOfficeHitRate = []; value.buyerTraderHitRate = []
  assert.equal(parseSpcStatisticsReport(value, 2026).sourceCounts.nativeEnquiries, 0)
})
