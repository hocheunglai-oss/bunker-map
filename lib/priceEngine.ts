import { evaluate } from "mathjs"

export function calculateFormula(
  formula: string,
  variables: Record<string, number>
): number | null {
  try {
    const result = evaluate(formula, variables)
    return Number(result)
  } catch (error) {
    console.error("Formula error:", error)
    return null
  }
}
export function resolvePrice(
  port: string,
  prices: any[],
  cache: Record<string, number> = {}
): number | null {

  if (cache[port]) return cache[port]

  const record = prices.find(p => p.port === port)

  if (!record) return null

  if (record.price !== undefined) {
    cache[port] = record.price
    return record.price
  }

  if (record.formula) {

    const variables: Record<string, number> = {}

    for (const p of prices) {
      const value = resolvePrice(p.port, prices, cache)
      if (value !== null) {
        variables[p.port] = value
      }
    }

    const result = calculateFormula(record.formula, variables)

    if (result !== null) {
      cache[port] = result
    }

    return result
  }

  return null
}