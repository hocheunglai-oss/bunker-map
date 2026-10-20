import { createRecordPageRoute } from "./spc-record-page-api.mjs"
export const todayClock = "2026-10-16T04:00:00.000Z"
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [todayClock])) }
  static now() { return Date.parse(todayClock) }
}
export const todayId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
export const todayNotes = (imo, extra = {}) => `Synthetic enquiry\n\n---SPC_META---\n${JSON.stringify({ imo, ...extra })}`
export const todayEnquiry = (n, overrides = {}) => ({
  id: todayId(n), enquiry_number: `SYNTHETIC-${n}`, title: "SYNTHETIC VESSEL",
  vessel_name: "SYNTHETIC VESSEL", port: "SINGAPORE", product: "VLSFO", quantity: "500",
  delivery_date: "2026-10-20", supplier_name: null, status: "open", notes: todayNotes("1234567"),
  created_by_username: "synthetic@example.test", created_by_display_name: "Synthetic",
  created_at: "2026-10-16T03:00:00.000Z", updated_at: "2026-10-16T03:00:00.000Z", ...overrides,
})
export const todayFixture = (n, overrides = {}) => ({
  id: todayId(n), fixture_status: "completed", fixture_date: "2026-10-15",
  supplier_trader_display_name: "Synthetic supplier", buyer_trader_display_name: "Synthetic buyer",
  vessel_name: "SYNTHETIC VESSEL", vessel_imo: "1234567", supplier_name: "SYNTHETIC SUPPLIER",
  price: "500", barging: "0", completed_at: "2026-10-15T03:00:00.000Z",
  created_at: "2026-10-15T02:00:00.000Z", enquiry: { vessel_name: null }, ...overrides,
})

export const createTodayRoute = options => createRecordPageRoute({ kind: "today", ...options })
