import type { FallbackMap, FallbackValue } from "@/lib/reportFallbackKeys"
import { PRICE_SETTER_FIELDS, priceSetterSnapshot } from "@/lib/priceSetterMutation"

const values = new Set(["-", "NA", "SE"])
export function validateFallbackKey(key: unknown): key is string {
  return typeof key === "string" && key.length <= 260 && key === key.toLowerCase()
    && /^.+::(?:hsfo|vlsfo|mgo)$/.test(key) && Boolean(key.slice(0, key.lastIndexOf("::")).trim())
}

export function parsePriceSetterFallbacks(content: unknown): FallbackMap {
  if (content === null || content === "") return {}
  if (typeof content !== "string") throw new Error("Report settings could not be read.")
  let parsed: unknown
  try { parsed = JSON.parse(content) } catch { throw new Error("Report settings could not be read.") }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.entries(parsed).some(([key, value]) => !validateFallbackKey(key) || typeof value !== "string" || !values.has(value))) {
    throw new Error("Report settings could not be read.")
  }
  return parsed as FallbackMap
}

// A response contains the whole server map, but must not silently refresh the
// conflict baseline of a different override whose draft is still unresolved.
export function mergeConfirmedFallbackBaseline(confirmed: FallbackMap, previous: FallbackMap, draftKeys: string[], savedKey: string): FallbackMap {
  const baseline = { ...confirmed }
  for (const key of draftKeys) {
    if (key === savedKey) continue
    if (Object.hasOwn(previous, key)) baseline[key] = previous[key]
    else delete baseline[key]
  }
  return baseline
}

export function confirmPriceSetterDivider(value: unknown, portId: string, name: string) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    const port = (value as Record<string, unknown>).port
    if (!port || typeof port !== "object" || Array.isArray(port)) throw new Error()
    const row = port as Record<string, unknown>
    if (row.id !== portId || row.type !== "divider" || row.name !== name
      || [...PRICE_SETTER_FIELDS, "updated_at"].some(key => !Object.hasOwn(row, key))) throw new Error()
    return { port: row, snapshot: priceSetterSnapshot(row) }
  } catch { throw new Error("The save could not be confirmed. Your draft is still here.") }
}

export type PriceSetterSettingChange =
  | { operation: "fallback"; key: string; expectedValue: FallbackValue | null; value: FallbackValue }
  | { operation: "divider"; portId: string; expectedName: string; name: string }

export function validatePriceSetterSettingChange(value: unknown): PriceSetterSettingChange {
  const invalid = () => new Error("Check the report setting or divider name before saving.")
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid()
  const input = value as Record<string, unknown>
  const keys = input.operation === "fallback" ? ["operation", "key", "expectedValue", "value"] : ["operation", "portId", "expectedName", "name"]
  if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) throw invalid()
  if (input.operation === "fallback") {
    if (!validateFallbackKey(input.key) || input.expectedValue !== null && (typeof input.expectedValue !== "string" || !values.has(input.expectedValue))
      || typeof input.value !== "string" || !values.has(input.value)) throw invalid()
    return input as PriceSetterSettingChange
  }
  if (input.operation !== "divider" || typeof input.portId !== "string" || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(input.portId)
    || typeof input.expectedName !== "string" || typeof input.name !== "string" || !input.name.trim() || input.name.length > 200) throw invalid()
  return { operation: "divider", portId: input.portId, expectedName: input.expectedName, name: input.name.trim() }
}
