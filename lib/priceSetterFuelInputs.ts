import { parseSimpleFormula, type FuelKey } from "@/lib/portPricing"
import { getTaiwanBasisFormula } from "@/lib/taiwanReport"
import { buildPriceSetterChanges, PriceSetterValidationError, type PriceSetterChanges } from "@/lib/priceSetterMutation"

type FuelInputPort = { name: string } & Partial<Record<FuelKey, number | string | null>> &
  Partial<Record<`${FuelKey}_formula`, string | null>>
export type PriceSetterFuelDrafts = Partial<Record<FuelKey, string>>

// Retain partial numeric text until Save validates it. Switching to a formula
// (or back to a number) explicitly clears the alternative, never reviving a
// hidden stale price. The caller retains the exact text independently of mode.
function numericDraft(value: string) {
  const text = value.trim()
  if (text.length > 200) return false
  // A complete exponent is a number, but a reference such as "E + 0" is
  // a formula. Only genuinely partial numeric text gets the draft exception.
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)
    || !parseSimpleFormula(text) && /^[+-]?\d*(?:\.\d*)?(?:e[+-]?\d*)?$/i.test(text)
}

export function priceSetterFuelEdit(fuel: FuelKey, value: string, allowsFormula = true) {
  return !allowsFormula || !value.trim() || numericDraft(value)
    ? { [fuel]: value, [`${fuel}_formula`]: null }
    : { [fuel]: null, [`${fuel}_formula`]: value }
}

export function priceSetterFuelInput(port: FuelInputPort, fuel: FuelKey, draft?: string, allowsFormula = true) {
  const formula = port[`${fuel}_formula`]
  const defaultFormula = getTaiwanBasisFormula(port.name, fuel)
  const isFormula = allowsFormula && (draft === undefined ? Boolean(formula?.trim() || defaultFormula)
    : Boolean(defaultFormula || draft.trim() && !numericDraft(draft)))
  return {
    isFormula,
    value: draft ?? (formula?.trim() ? formula : defaultFormula ?? port[fuel] ?? ""),
  }
}

export function buildPriceSetterFuelChanges(port: FuelInputPort, drafts: PriceSetterFuelDrafts = {}): PriceSetterChanges {
  const result = { ...port }
  for (const fuel of ["hsfo", "vlsfo", "mgo"] as const) {
    const defaultFormula = getTaiwanBasisFormula(port.name, fuel)
    if (!defaultFormula) continue
    // These report fuels have an established Taichung basis. A direct/empty
    // draft must not appear saved while the report silently uses that basis.
    if (Object.hasOwn(drafts, fuel) && !port[`${fuel}_formula`]?.trim()) {
      throw new PriceSetterValidationError(`${port.name} ${fuel.toUpperCase()} uses a formula. Enter a formula such as Taichung + 0.`)
    }
    result[`${fuel}_formula`] = port[`${fuel}_formula`]?.trim() ? port[`${fuel}_formula`] : defaultFormula
  }
  return buildPriceSetterChanges(result)
}
