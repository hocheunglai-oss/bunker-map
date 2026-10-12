import { PRICE_SETTER_FIELDS, priceSetterSnapshot } from "@/lib/priceSetterMutation"

export type PriceSetterInventoryPort = {
  id: string; name: string; type: "port" | "divider" | null; display_order: number | null
  lat: number | null; lng: number | null; hsfo: number | null; vlsfo: number | null; mgo: number | null
  hsfo_formula: string | null; vlsfo_formula: string | null; mgo_formula: string | null; updated_at: string | null
}
const fields = ["id", "type", "display_order", ...PRICE_SETTER_FIELDS, "updated_at"]
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/

/** A partial or malformed successful response must never enable editing. */
export function confirmPriceSetterInventory(value: unknown): { version: 1; count: number; ports: PriceSetterInventoryPort[] } {
  const fail = () => { throw Error("Could not load the complete saved port list. Please try again.") }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail()
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== 3 || ["version", "count", "ports"].some(key => !Object.hasOwn(input, key))
    || input.version !== 1 || !Number.isSafeInteger(input.count)
    || (input.count as number) < 0 || !Array.isArray(input.ports) || input.ports.length !== input.count) return fail()
  const ids = new Set<string>()
  let previous: PriceSetterInventoryPort | undefined
  for (const value of input.ports) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail()
    const row = value as PriceSetterInventoryPort
    if (Object.keys(row).length !== fields.length || fields.some(key => !Object.hasOwn(row, key))
      || typeof row.id !== "string" || !uuid.test(row.id) || ids.has(row.id)
      || ![null, "port", "divider"].includes(row.type)
      || row.updated_at !== null && typeof row.updated_at !== "string"
      || row.display_order !== null && (!Number.isInteger(row.display_order) || row.display_order < -2147483648 || row.display_order > 2147483647)
      || [row.lat, row.lng, row.hsfo, row.vlsfo, row.mgo].some(number => number !== null && (typeof number !== "number" || !Number.isFinite(number)))
      || [row.hsfo_formula, row.vlsfo_formula, row.mgo_formula].some(formula => formula !== null && typeof formula !== "string")) return fail()
    try { priceSetterSnapshot(row) } catch { return fail() }
    if (previous && (previous.display_order === null && row.display_order !== null
      || previous.display_order !== null && row.display_order !== null && previous.display_order > row.display_order
      || previous.display_order === row.display_order && previous.id >= row.id)) return fail()
    ids.add(row.id)
    previous = row
  }
  return input as { version: 1; count: number; ports: PriceSetterInventoryPort[] }
}
