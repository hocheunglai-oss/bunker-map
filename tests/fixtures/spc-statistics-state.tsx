import React from "react"
import { createRoot } from "react-dom/client"
import Statistics from "../../app/spc/statistics/page"

const h = (window as any).__statisticsHarness = {
  auth: { loading: false, authenticated: true, username: "first@example.test", role: "BUYER TRADER", office: "HONG KONG", permissions: { "spc-statistics": "view" } },
  pending: [] as any[], bodies: [] as any[], requests: [] as any[], routes: [] as string[],
  render() {},
  report(count = 123) {
    const selectedYear = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric" }).format(new Date()))
    return { generatedAt: new Date().toISOString(), selectedYear, lastYear: selectedYear - 1,
      windowLabel: "LAST 90 DAYS", windowStartDate: "2026-07-19", windowEndDate: "2026-10-16", yearOptions: [selectedYear, selectedYear - 1],
      sourceCounts: { graphFixtures: 1, importedFixtures: 0, nativeFixtures: 1, nativeEnquiries: count },
      monthlyVolume: ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"].map(month => ({ month, currentYearVolume: month === "OCT" ? 100 : 0, lastYearVolume: 0 })),
      volumeBySupplier: [{ label: "SYNTHETIC SUPPLIER", value: 100 }], fixturesBySupplier: [{ label: "SYNTHETIC SUPPLIER", value: 1 }],
      volumeByOffice: [{ label: "HONG KONG", value: 100 }], fixturesByOffice: [{ label: "HONG KONG", value: 1 }],
      workload: [{ period: "LAST 90 DAYS", enquiries: count, days: 90, averagePerDay: Math.round(count / 90 * 100) / 100 }],
      buyerOfficeHitRate: [{ label: "HONG KONG", enquiries: count, fixtures: 1, hitRate: Math.round(100 / count * 10) / 10 }],
      buyerTraderHitRate: [{ label: "SYNTHETIC BUYER", enquiries: count, fixtures: 1, hitRate: Math.round(100 / count * 10) / 10 }],
      supplierTraderFixtureCount: [{ label: "SYNTHETIC SUPPLIER TRADER", value: 1 }] }
  },
  release(index = 0, status = 200, payload?: unknown) {
    const item = this.pending.splice(index, 1)[0]
    if (!item) throw Error("No pending synthetic request")
    item.resolve(Response.json(payload ?? (status === 200 ? this.report() : { message: "Statistics could not be refreshed. Please retry." }), { status }))
  },
  reject(index = 0) { this.pending.splice(index, 1)[0].reject(Error("Synthetic network unavailable")) },
  raw(status: number, body: string) { this.pending.splice(0, 1)[0].resolve(new Response(body, { status })) },
  deferBody() {
    const item = this.pending.splice(0, 1)[0], response = Response.json(this.report(700))
    response.json = () => new Promise(resolve => this.bodies.push(resolve))
    item.resolve(response)
  },
  releaseBody() { this.bodies.splice(0, 1)[0](this.report(700)) },
  empty() {
    const value = this.report(0)
    value.sourceCounts = { graphFixtures: 0, importedFixtures: 0, nativeFixtures: 0, nativeEnquiries: 0 }
    value.monthlyVolume.forEach((row: { currentYearVolume: number }) => { row.currentYearVolume = 0 })
    for (const key of ["volumeBySupplier", "fixturesBySupplier", "volumeByOffice", "fixturesByOffice", "buyerOfficeHitRate", "buyerTraderHitRate", "supplierTraderFixtureCount"] as const) value[key] = []
    return value
  },
}
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin)
  if (url.origin !== location.origin || url.pathname !== "/api/spc/statistics") throw Error("Unexpected fetch: " + url.pathname)
  h.requests.push({ url: url.href, username: h.auth.username, aborted: init.signal?.aborted || false })
  // Intentionally deliver even after abort to prove ownership rather than transport cooperation.
  return new Promise<Response>((resolve, reject) => h.pending.push({ resolve, reject, signal: init.signal }))
}
const app = createRoot(document.getElementById("root")!)
h.render = () => app.render(<div className="fc-admin-scope spc-scope"><Statistics /></div>)
h.render()
