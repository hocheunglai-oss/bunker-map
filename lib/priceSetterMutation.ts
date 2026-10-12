import { parseSimpleFormula } from "@/lib/portPricing"

export const PRICE_SETTER_FIELDS = ["name", "lat", "lng", "hsfo", "vlsfo", "mgo", "hsfo_formula", "vlsfo_formula", "mgo_formula"] as const
export type PriceSetterChanges = {
  name: string
  lat: number | null
  lng: number | null
  hsfo: number | null
  vlsfo: number | null
  mgo: number | null
  hsfo_formula: string | null
  vlsfo_formula: string | null
  mgo_formula: string | null
}
export type PriceSetterSnapshot = PriceSetterChanges & { updated_at: string | null }
export class PriceSetterValidationError extends Error {}

export type PriceSetterCreation = { operation: "create"; requestId: string; kind: "port" | "divider" }
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i

export function validatePriceSetterCreation(value: unknown): PriceSetterCreation {
  const input = object(value)
  if (Object.keys(input).length !== 3 || input.operation !== "create"
    || typeof input.requestId !== "string" || !uuid.test(input.requestId)
    || !["port", "divider"].includes(input.kind as string)) {
    throw new PriceSetterValidationError("Choose Add Port or Add Divider and try again.")
  }
  return { operation: "create", requestId: input.requestId.toLowerCase(), kind: input.kind as "port" | "divider" }
}

export function confirmPriceSetterCreation(value: unknown, input: PriceSetterCreation) {
  try {
    const result = object(value)
    if (Object.keys(result).length !== 5 || result.requestId !== input.requestId || result.kind !== input.kind
      || typeof result.portId !== "string" || !uuid.test(result.portId) || typeof result.replayed !== "boolean") throw Error("Unconfirmed")
    if (result.port === null) {
      if (!result.replayed) throw Error("Unconfirmed")
      return { portId: result.portId, replayed: true, port: null, snapshot: null }
    }
    const port = object(result.port)
    if (port.id !== result.portId || [...PRICE_SETTER_FIELDS, "updated_at", "type", "display_order"].some(key => !Object.hasOwn(port, key))
      || ![null, "port", "divider"].includes(port.type as string | null)
      || port.display_order !== null && (typeof port.display_order !== "number" || !Number.isInteger(port.display_order)
        || port.display_order < -2147483648 || port.display_order > 2147483647)) throw Error("Unconfirmed")
    const snapshot = priceSetterSnapshot(port)
    // Replays return current saved values, never reset a subsequently edited row.
    if (!result.replayed && (port.type !== input.kind || typeof port.display_order !== "number" || port.display_order < 1
      || input.kind === "divider" && snapshot.name !== "Section"
      || input.kind === "port" && !/^New Port(?: (?:[2-9]|[1-9]\d+))?$/.test(snapshot.name)
      || [...PRICE_SETTER_FIELDS.filter(key => key !== "name"), "updated_at"].some(key => port[key] !== null))) throw Error("Unconfirmed")
    return { portId: result.portId, replayed: result.replayed, port: port as Record<string, unknown> & { id: string; name: string }, snapshot }
  } catch {
    throw Error("The addition could not be confirmed. Reload saved ports before retrying the same addition.")
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PriceSetterValidationError("Price details must be an object.")
  return value as Record<string, unknown>
}

function numeric(value: unknown, field: string) {
  if (value === null || value === undefined || typeof value === "string" && !value.trim()) return null
  if (typeof value !== "number" && (typeof value !== "string" || value.length > 100
    || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) {
    throw new PriceSetterValidationError(`${field.toUpperCase()} must be a number or empty.`)
  }
  const result = Number(value)
  if (!Number.isFinite(result)) throw new PriceSetterValidationError(`${field.toUpperCase()} must be a finite number.`)
  if (field === "lat" && Math.abs(result) > 90 || field === "lng" && Math.abs(result) > 180
    || ["hsfo", "vlsfo", "mgo"].includes(field) && result < 0) {
    throw new PriceSetterValidationError(`${field.toUpperCase()} is outside its allowed range.`)
  }
  return result
}

function fields(value: unknown, validateFormula: boolean, trimName: boolean): PriceSetterChanges {
  const input = object(value)
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 200) throw new PriceSetterValidationError("Enter a port name of up to 200 characters.")
  const result: Record<string, unknown> = { name: trimName ? input.name.trim() : input.name }
  for (const field of ["lat", "lng", "hsfo", "vlsfo", "mgo"]) result[field] = numeric(input[field], field)
  for (const field of ["hsfo_formula", "vlsfo_formula", "mgo_formula"]) {
    const value = input[field]
    if (value != null && (typeof value !== "string" || value.length > 200)) throw new PriceSetterValidationError("Formula wording must be no longer than 200 characters.")
    const formula = typeof value === "string" ? (validateFormula ? value.trim() : value) : null
    if (validateFormula && formula && !parseSimpleFormula(formula)) throw new PriceSetterValidationError("Use a formula such as Taichung + 0, or leave it empty.")
    result[field] = validateFormula ? formula || null : formula
  }
  return result as PriceSetterChanges
}

export function buildPriceSetterChanges(port: unknown) {
  return fields(port, true, true)
}

export function priceSetterSnapshot(port: unknown): PriceSetterSnapshot {
  const input = object(port)
  const updatedAt = input.updated_at ?? null
  if (updatedAt !== null && (typeof updatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(updatedAt)
    || !Number.isFinite(Date.parse(`${updatedAt}T12:00:00Z`))
    || new Date(`${updatedAt}T12:00:00Z`).toISOString().slice(0, 10) !== updatedAt)) throw new PriceSetterValidationError("Reload the saved port before editing.")
  return { ...fields(input, false, false), updated_at: updatedAt as string | null }
}

export function validatePriceSetterSave(value: unknown) {
  const input = object(value)
  if (Object.keys(input).some((key) => !["portId", "expected", "changes"].includes(key))) throw new PriceSetterValidationError("Unsupported price-save fields.")
  if (typeof input.portId !== "string" || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(input.portId)) throw new PriceSetterValidationError("Select an existing port.")
  const expected = object(input.expected), changes = object(input.changes)
  for (const [row, keys] of [[expected, [...PRICE_SETTER_FIELDS, "updated_at"]], [changes, PRICE_SETTER_FIELDS]] as const) {
    if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)) || Object.keys(row).some((key) => !(keys as readonly string[]).includes(key))) {
      throw new PriceSetterValidationError("Reload the saved port before editing.")
    }
  }
  return { portId: input.portId, expected: priceSetterSnapshot(expected), changes: buildPriceSetterChanges(changes) }
}

// A destructive operation compares all editable values plus row kind/order.
// The UI supplies the saved baseline, never unsaved price/name drafts.
export function priceSetterDeletionSnapshot(port: unknown) {
  const row = object(port)
  const type = row.type ?? null, displayOrder = row.display_order ?? null
  if (type !== null && type !== "port" && type !== "divider"
    || displayOrder !== null && (typeof displayOrder !== "number" || !Number.isInteger(displayOrder)
      || displayOrder < -2147483648 || displayOrder > 2147483647)) {
    throw new PriceSetterValidationError("Reload saved ports before deleting.")
  }
  return { ...priceSetterSnapshot(row), type: type as string | null, display_order: displayOrder as number | null }
}

export function priceSetterDeletionFallbacks(name: string, fallbacks: Record<string, unknown>) {
  const expected: Record<string, string> = {}
  for (const fuel of ["hsfo", "vlsfo", "mgo"]) {
    const key = `${name.toLowerCase()}::${fuel}`
    if (Object.hasOwn(fallbacks, key)) {
      if (!["-", "NA", "SE"].includes(fallbacks[key] as string)) throw new PriceSetterValidationError("Reload report settings before deleting.")
      expected[key] = fallbacks[key] as string
    }
  }
  return expected
}

export function validatePriceSetterDeletion(value: unknown) {
  const input = object(value), expected = object(input.expected), fallbacks = object(input.expectedFallbacks)
  const keys = [...PRICE_SETTER_FIELDS, "updated_at", "type", "display_order"]
  if (Object.keys(input).length !== 3 || !["portId", "expected", "expectedFallbacks"].every(key => Object.hasOwn(input, key))
    || typeof input.portId !== "string" || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(input.portId)
    || Object.keys(expected).length !== keys.length || keys.some(key => !Object.hasOwn(expected, key))) {
    throw new PriceSetterValidationError("Reload saved ports before deleting.")
  }
  const snapshot = priceSetterDeletionSnapshot(expected)
  const targetFallbacks = priceSetterDeletionFallbacks(snapshot.name, fallbacks)
  if (Object.keys(fallbacks).length !== Object.keys(targetFallbacks).length
    || snapshot.type === "divider" && Object.keys(fallbacks).length) throw new PriceSetterValidationError("Reload report settings before deleting.")
  return { portId: input.portId, expected: snapshot, expectedFallbacks: targetFallbacks }
}

export function confirmPriceSetterDeletion(value: unknown, portId: string) {
  try {
    const result = object(value)
    if (Object.keys(result).length !== 2 || result.deletedId !== portId || typeof result.replayed !== "boolean") throw Error("Unconfirmed")
    return result as { deletedId: string; replayed: boolean }
  } catch {
    throw new Error("Deletion could not be confirmed. Reload saved ports to check.")
  }
}

// Treat a malformed success response as unconfirmed, never as a saved price.
// Both the endpoint and UI validate the complete response before advancing any
// row's baseline, including linked rows returned by a basis-port rename.
export function confirmPriceSetterSave(value: unknown, portId: string, changes: PriceSetterChanges, expectedDay?: string) {
  const unconfirmed = () => new Error("The save could not be confirmed. Reload saved ports to check; your draft is still here.")
  try {
    const result = object(value), history = object(result.history)
    if (typeof result.replayed !== "boolean" || !Array.isArray(result.ports) || !result.ports.length) throw unconfirmed()
    const ids = new Set<string>()
    const rows = result.ports.map((value: unknown) => {
      const row = object(value)
      if (typeof row.id !== "string" || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(row.id)
        || ids.has(row.id) || [...PRICE_SETTER_FIELDS, "updated_at"].some((key) => !Object.hasOwn(row, key))) throw unconfirmed()
      ids.add(row.id)
      return { row: row as Record<string, unknown> & { id: string }, snapshot: priceSetterSnapshot(row) }
    })
    const target = rows.find(({ row }) => row.id === portId)?.snapshot
    if (!target || PRICE_SETTER_FIELDS.some((field) => target[field] !== changes[field]) || !target.updated_at
      || expectedDay && target.updated_at !== expectedDay || typeof history.id !== "string" || history.port_id !== portId
      || typeof history.recorded_at !== "string"
      || !new RegExp(`^${target.updated_at}T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,6})?$`).test(history.recorded_at)
      || ["hsfo", "vlsfo", "mgo"].some((field) => history[field] !== changes[field as "hsfo" | "vlsfo" | "mgo"])) throw unconfirmed()
    return rows
  } catch { throw unconfirmed() }
}
