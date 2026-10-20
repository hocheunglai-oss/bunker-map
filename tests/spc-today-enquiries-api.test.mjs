import assert from "node:assert/strict"
import test from "node:test"
import { createTodayRoute, todayEnquiry, todayFixture, todayNotes, todayId } from "./fixtures/spc-today-enquiries-api.mjs"

test("Daily Briefing never substitutes a same-name fixture with a conflicting known IMO", async () => {
  const h = createTodayRoute({ enquiries: [todayEnquiry(1)], fixtures: [todayFixture(2, { vessel_imo: "7654321", supplier_name: "WRONG IMO SUPPLIER" })] })
  const r = await h.get()
  assert.equal(r.status, 200)
  assert.equal(r.body.enquiries[0].previousFixture, null)
})

test("Daily Briefing never substitutes a same-name lost record with a conflicting known IMO", async () => {
  const h = createTodayRoute({ enquiries: [todayEnquiry(1), todayEnquiry(2, { status: "cancelled", notes: todayNotes("7654321", { lostReason: "UNKNOWN" }), created_at: "2026-10-15T03:00:00.000Z", updated_at: "2026-10-15T04:00:00.000Z" })] })
  const r = await h.get()
  assert.equal(r.status, 200)
  assert.equal(r.body.enquiries[0].previousLost, null)
})

test("matching IMO takes precedence over a newer name-only legacy fixture even after a vessel rename", async () => {
  const h = createTodayRoute({ enquiries: [todayEnquiry(1)], fixtures: [todayFixture(2, { vessel_name: "PREVIOUS VESSEL NAME", supplier_name: "CORRECT IMO" }), todayFixture(3, { vessel_imo: null, supplier_name: "LEGACY NAME", completed_at: "2026-10-15T05:00:00.000Z" })] })
  assert.equal((await h.get()).body.enquiries[0].previousFixture.supplier, "CORRECT IMO")
})

test("conflicting recent names cannot hide an older valid legacy fallback", async () => {
  const h = createTodayRoute({ enquiries: [todayEnquiry(1)], fixtures: [todayFixture(2, { vessel_imo: "7654321", supplier_name: "WRONG IMO", completed_at: "2026-10-15T05:00:00.000Z" }), todayFixture(3, { vessel_imo: null, supplier_name: "LEGACY NAME" })] })
  assert.equal((await h.get()).body.enquiries[0].previousFixture.supplier, "LEGACY NAME")
})

test("actual missing-IMO legacy fixture and lost records retain normalized-name fallback", async () => {
  const h = createTodayRoute({ enquiries: [todayEnquiry(1), todayEnquiry(2, { status: "cancelled", vessel_name: "Synthetic-Vessel", notes: todayNotes("", { lostReason: "UNKNOWN" }), created_at: "2026-10-15T03:00:00.000Z", updated_at: "2026-10-15T04:00:00.000Z" })], fixtures: [todayFixture(3, { vessel_name: "  synthetic  vessel ", vessel_imo: null })] })
  const r = await h.get()
  assert.equal(r.body.enquiries[0].previousFixture.supplier, "SYNTHETIC SUPPLIER")
  assert.equal(r.body.enquiries[0].previousLost.buyerReason, "UNKNOWN")
})

test("missing target IMO still allows known candidate IMO by normalized legacy vessel name", async () => {
  const h = createTodayRoute({ enquiries: [todayEnquiry(1, { notes: todayNotes("") })], fixtures: [todayFixture(2)] })
  assert.equal((await h.get()).body.enquiries[0].previousFixture.supplier, "SYNTHETIC SUPPLIER")
})

test("same-time and later fixture or lost events are never previous history", async () => {
  const at = "2026-10-16T03:00:00.000Z"
  const h = createTodayRoute({ enquiries: [todayEnquiry(1), todayEnquiry(2, { status: "cancelled", created_at: "2026-10-15T03:00:00.000Z", updated_at: at }), todayEnquiry(3, { status: "cancelled", created_at: "2026-10-15T03:00:00.000Z", updated_at: "2026-10-16T03:00:00.001Z" })], fixtures: [todayFixture(4, { completed_at: at }), todayFixture(5, { completed_at: "2026-10-16T03:00:00.001Z" })] })
  const current = (await h.get()).body.enquiries[0]
  assert.equal(current.previousFixture, null)
  assert.equal(current.previousLost, null)
})

test("history identity is copied before caller mutation and never appears in response", async () => {
  const h = createTodayRoute({ enquiries: [todayEnquiry(1)], fixtures: [todayFixture(2)] })
  const keys = ["imo:7654321", "vessel:synthetic vessel"], map = new Map()
  h.identity.addSpcHistoricalMatch(map, keys, { at: Date.parse("2026-10-15T03:00:00.000Z"), value: "WRONG" })
  keys[0] = "imo:1234567"
  assert.equal(h.identity.firstPreviousSpcIdentityMatch(map, ["imo:1234567", "vessel:synthetic vessel"], "2026-10-16T03:00:00.000Z"), null)
  assert.equal(JSON.stringify((await h.get()).body).includes("identityKeys"), false)
})

test("HK midnight cutoff, stable chronological results and blank prices remain unchanged", async () => {
  const h = createTodayRoute({ enquiries: [todayEnquiry(1), todayEnquiry(2, { created_at: "2026-10-15T15:59:59.999Z" }), todayEnquiry(3, { created_at: "2026-10-15T16:00:00.000Z" })], fixtures: [todayFixture(4, { price: null, barging: null })] })
  const r = await h.get()
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.enquiries.map((row) => row.id), [todayId(3), todayId(1)])
  assert.equal(r.body.enquiries[1].previousFixture.price, "")
  assert.equal(r.body.enquiries[1].previousFixture.barging, "")
  assert.match(r.cache, /private.*no-store/)
})

test("Daily Briefing keeps supplier/admin View access and denies none, buyers and signed-out before queries", async () => {
  for (const options of [{ role: "SUPPLIER TRADER", permission: "view", expected: 200 }, { role: "ADMIN", permission: "view", expected: 200 }, { permission: "none", expected: 403 }, { role: "BUYER TRADER", permission: "view", expected: 403 }, { authenticated: false, expected: 401 }]) {
    const h = createTodayRoute(options), r = await h.get()
    assert.equal(r.status, options.expected)
    assert.equal(h.queries.length, options.expected === 200 ? 1 : 0)
  }
})

test("read transport failure is unavailable, never successful empty history", async () => {
  const h = createTodayRoute({ enquiries: [todayEnquiry(1)], queryError: { table: "spc_fixtures", message: "Synthetic read unavailable" } })
  const r = await h.get()
  assert.equal(r.status, 503)
  assert.equal(r.body.enquiries, undefined)
  assert.equal(r.body.code, "COMPLETE_READ_UNAVAILABLE")
})
