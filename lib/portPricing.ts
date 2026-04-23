export type FuelKey = "hsfo" | "vlsfo" | "mgo"

export type FormulaCapablePort = {
  id?: number | string
  name: string
  hsfo: number | null
  vlsfo: number | null
  mgo: number | null
  hsfo_formula?: string | null
  vlsfo_formula?: string | null
  mgo_formula?: string | null
}

export function parseSimpleFormula(formula: string | null | undefined) {
  if (!formula) return null

  const trimmed = formula.trim()
  const match = trimmed.match(/^(.*?)\s*([+-])\s*(-?\d+(?:\.\d+)?)$/)
  if (!match) return null

  const refName = match[1].trim().toLowerCase()
  const operator = match[2]
  const amount = Number(match[3])

  if (!refName || (operator !== "+" && operator !== "-") || Number.isNaN(amount)) {
    return null
  }

  return { refName, operator, amount }
}

export function applyFormula(base: number | null, formula: string | null | undefined): number | null {
  if (base == null || !formula) return null

  const parsed = parseSimpleFormula(formula)
  if (!parsed) return null

  return parsed.operator === "+" ? base + parsed.amount : base - parsed.amount
}

export function hasFormulaForAnyFuel(port: FormulaCapablePort) {
  return Boolean(
    port.hsfo_formula?.trim() ||
      port.vlsfo_formula?.trim() ||
      port.mgo_formula?.trim()
  )
}

export function resolvePortFuelValue(
  port: FormulaCapablePort,
  portsByName: Map<string, FormulaCapablePort>,
  fuel: FuelKey,
  seen = new Set<string>()
): number | null {
  const seenKey = `${port.name.toLowerCase()}-${fuel}`
  if (seen.has(seenKey)) return null
  seen.add(seenKey)

  const formula = port[`${fuel}_formula` as const]

  // When a formula exists, treat it as the source of truth even if
  // an older direct number is still sitting on the port row.
  if (formula?.trim()) {
    const parsed = parseSimpleFormula(formula)
    if (!parsed) return null

    const refPort = portsByName.get(parsed.refName)
    if (!refPort) return null

    const base = resolvePortFuelValue(refPort, portsByName, fuel, seen)
    return applyFormula(base, formula)
  }

  return port[fuel]
}
