import { priceSetterSnapshot, type PriceSetterSnapshot } from "@/lib/priceSetterMutation"
import { getPriceHistoryDateParts } from "@/lib/adminPriceHistory"
import type { PriceHistoryValues, StoredPriceHistoryRecord } from "@/lib/priceHistoryRecords"

export const HISTORY_MARKETS = {
  hongkong: { page: "hongkong-price-history", names: ["Hong Kong"] },
  taiwan: { page: "taiwan-price-history", names: ["Kaohsiung", "Taichung"] },
} as const
export type HistoryMarket = keyof typeof HISTORY_MARKETS
/** Identify a configured root without changing its exact saved CAS/display name. */
export function marketPortHasName(port: { name: string }, name: string) {
  return port.name.trim().toLowerCase() === name.trim().toLowerCase()
}
export type HistoryPortSnapshot = PriceSetterSnapshot & { id: string }
export type MarketHistoryChange = {
  day: string
  operation: "save" | "delete"
  expectedPorts: HistoryPortSnapshot[]
  expectedRows: StoredPriceHistoryRecord[]
  values: (PriceHistoryValues & { port_id: string })[]
}
export class HistoryValidationError extends Error {}
const UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i
const PORT_KEYS = ["id", "name", "lat", "lng", "hsfo", "vlsfo", "mgo", "hsfo_formula", "vlsfo_formula", "mgo_formula", "updated_at"]
const ROW_KEYS = ["id", "port_id", "hsfo", "vlsfo", "mgo", "recorded_at"]

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HistoryValidationError("Reload saved history before editing.")
  return value as Record<string, unknown>
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new HistoryValidationError("Reload saved history before editing.")
}
function id(value: unknown) {
  if (typeof value !== "string" || !UUID.test(value)) throw new HistoryValidationError("Select existing market records.")
  return value
}
export function parseHistoryMarket(value: unknown): HistoryMarket {
  if (value !== "hongkong" && value !== "taiwan") throw new HistoryValidationError("Select Hong Kong or Taiwan history.")
  return value
}
export function historyPrice(value: unknown): number | null {
  if (value === null || typeof value === "string" && !value.trim()) return null
  if (typeof value !== "number" && (typeof value !== "string" || value.length > 100 || !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) {
    throw new HistoryValidationError("Prices must be positive numbers, zero or empty.")
  }
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw new HistoryValidationError("Prices must be positive numbers, zero or empty.")
  return number
}
function values(value: Record<string, unknown>, stored = false): PriceHistoryValues {
  const result = {} as PriceHistoryValues
  for (const key of ["hsfo", "vlsfo", "mgo"] as const) {
    if (!Object.hasOwn(value, key) || stored && value[key] !== null && typeof value[key] !== "number") throw new HistoryValidationError("Reload saved prices before editing.")
    result[key] = historyPrice(value[key])
  }
  return result
}
export function parseHistoryPorts(value: unknown, market: HistoryMarket): HistoryPortSnapshot[] {
  if (!Array.isArray(value) || value.length !== HISTORY_MARKETS[market].names.length) throw new HistoryValidationError("The market ports could not be loaded. Reload before editing.")
  const ports = value.map(item => {
    const row = object(item)
    exactKeys(row, PORT_KEYS)
    try { return { id: id(row.id), ...priceSetterSnapshot(row) } }
    catch { throw new HistoryValidationError("The market prices could not be loaded. Reload before editing.") }
  }).sort((a,b) => a.id.localeCompare(b.id))
  if (new Set(ports.map(port => port.id)).size !== ports.length || new Set(ports.map(port => port.name.trim().toLowerCase())).size !== ports.length
    || HISTORY_MARKETS[market].names.some(name => !ports.some(port => marketPortHasName(port, name)))) throw new HistoryValidationError("The market ports changed. Reload before editing.")
  return ports
}
export function parseHistoryRows(value: unknown, ports: Array<Pick<HistoryPortSnapshot, "id">>, day?: string): StoredPriceHistoryRecord[] {
  if (!Array.isArray(value) || value.length > 50_000 || day && value.length > 200) throw new HistoryValidationError("History could not be loaded completely. Reload before editing.")
  const ids = new Set<string>(), portIds = new Set(ports.map(port => port.id))
  return value.map(item => {
    const row = object(item)
    exactKeys(row, ROW_KEYS)
    const rowId = id(row.id), portId = id(row.port_id)
    if (ids.has(rowId) || !portIds.has(portId) || typeof row.recorded_at !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(row.recorded_at)) throw new HistoryValidationError("Saved history is incomplete or invalid. Reload before editing.")
    const date = getPriceHistoryDateParts(row.recorded_at).dateKey
    if (!date || day && date !== day) throw new HistoryValidationError("The saved history date is invalid. Reload before editing.")
    ids.add(rowId)
    return { id: rowId, port_id: portId, recorded_at: row.recorded_at, ...values(row, true) }
  }).sort((a,b) => String(a.id).localeCompare(String(b.id)))
}
export function validateMarketHistoryChange(value: unknown, market: HistoryMarket): MarketHistoryChange {
  const input = object(value)
  exactKeys(input, ["day", "operation", "expectedPorts", "expectedRows", "values"])
  if (typeof input.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.day) || getPriceHistoryDateParts(input.day).dateKey !== input.day
    || input.day < "1900-01-01" || input.day > "9999-12-30") throw new HistoryValidationError("Enter a valid history date.")
  if (input.operation !== "save" && input.operation !== "delete") throw new HistoryValidationError("Select a history action.")
  const expectedPorts = parseHistoryPorts(input.expectedPorts, market)
  const expectedRows = parseHistoryRows(input.expectedRows, expectedPorts, input.day)
  if (!Array.isArray(input.values)) throw new HistoryValidationError("Enter the complete market prices.")
  if (input.operation === "delete") {
    if (!expectedRows.length || input.values.length) throw new HistoryValidationError("Select an existing history day to remove.")
    return { day: input.day, operation: input.operation, expectedPorts, expectedRows, values: [] }
  }
  if (input.values.length !== expectedPorts.length) throw new HistoryValidationError("Enter the complete market prices.")
  const prices = input.values.map(value => {
    const row = object(value); exactKeys(row, ["port_id", "hsfo", "vlsfo", "mgo"])
    const portId = id(row.port_id), port = expectedPorts.find(port => port.id === portId)
    const result = { port_id: portId, ...values(row) }
    if (!port || market === "taiwan" && marketPortHasName(port, "Taichung") && result.hsfo !== null) throw new HistoryValidationError("Check the market and product selection.")
    return result
  }).sort((a,b) => a.port_id.localeCompare(b.port_id))
  if (new Set(prices.map(row => row.port_id)).size !== expectedPorts.length) throw new HistoryValidationError("Enter each market port once.")
  return { day: input.day, operation: input.operation, expectedPorts, expectedRows, values: prices }
}

export function confirmMarketHistoryChange(value: unknown, market: HistoryMarket, input: MarketHistoryChange) {
  try {
    const data = object(value)
    if (data.market !== market || data.day !== input.day || data.operation !== input.operation || typeof data.replayed !== "boolean") throw Error()
    const ports = parseHistoryPorts(data.ports, market)
    if (ports.some(port => !input.expectedPorts.some(expected => expected.id === port.id))) throw Error()
    const rows = parseHistoryRows(data.rows, ports, input.day)
    if (input.operation === "delete" ? rows.length !== 0 : rows.length !== input.values.length
      || input.values.some(price => !rows.some(row => row.port_id === price.port_id && row.recorded_at === `${input.day}T12:00:00`
        && row.hsfo === price.hsfo && row.vlsfo === price.vlsfo && row.mgo === price.mgo))) throw Error()
    return { market, day: input.day, operation: input.operation, replayed: data.replayed, ports, rows }
  } catch { throw new Error("The history change could not be confirmed. Your draft is still here; reload saved history to check before retrying.") }
}

export function parseMarketHistorySnapshot(value: unknown, market: HistoryMarket) {
  const data = object(value)
  exactKeys(data, ["market", "ports", "rows"])
  if (data.market !== market) throw new HistoryValidationError("The wrong market was returned. Reload saved history.")
  const ports = parseHistoryPorts(data.ports, market)
  return { market, ports, rows: parseHistoryRows(data.rows, ports) }
}
export type MarketHistorySnapshot = ReturnType<typeof parseMarketHistorySnapshot>
