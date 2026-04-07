export type ChinaFuelValues = {
  hsfo: number | null
  vlsfo: number | null
  mgo: number | null
}

export type ChinaReportSection = {
  title: string
  rows: Array<
    ChinaFuelValues & {
      port: string
    }
  >
}

type FuelKey = "hsfo" | "vlsfo" | "mgo"

type PortRecord = {
  id: number
  name: string
  hsfo: number | null
  vlsfo: number | null
  mgo: number | null
  hsfo_formula?: string | null
  vlsfo_formula?: string | null
  mgo_formula?: string | null
}

function parseSimpleFormula(formula: string) {
  const parts = formula.trim().split(/\s+/)
  if (parts.length !== 3) return null

  const refName = parts[0].toLowerCase()
  const operator = parts[1]
  const amount = Number(parts[2])

  if ((operator !== "+" && operator !== "-") || Number.isNaN(amount)) {
    return null
  }

  return { refName, operator, amount }
}

function applyFormula(base: number | null, formula: string | null | undefined): number | null {
  if (base == null || !formula) return null
  const parsed = parseSimpleFormula(formula)
  if (!parsed) return null
  return parsed.operator === "+" ? base + parsed.amount : base - parsed.amount
}

function resolveCurrentValue(
  port: PortRecord,
  portsByName: Map<string, PortRecord>,
  fuel: FuelKey,
  seen = new Set<string>()
): number | null {
  const seenKey = `${port.name.toLowerCase()}-${fuel}`
  if (seen.has(seenKey)) return null
  seen.add(seenKey)

  const directValue = port[fuel]
  if (directValue != null) return directValue

  const formula = port[`${fuel}_formula` as const]
  if (!formula) return null

  const parsed = parseSimpleFormula(formula)
  if (!parsed) return null

  const refPort = portsByName.get(parsed.refName)
  if (!refPort) return null

  const base = resolveCurrentValue(refPort, portsByName, fuel, seen)
  return applyFormula(base, formula)
}

export function buildChinaReportSections(
  ports: PortRecord[],
  sections: Array<{ title: string; ports: string[] }>
): ChinaReportSection[] {
  const portsByName = new Map(
    ports.map((port) => [port.name.toLowerCase(), port] as const)
  )

  return sections
    .map((section) => {
      const rows = section.ports
        .map((portName) => portsByName.get(portName.toLowerCase()))
        .filter((port): port is PortRecord => Boolean(port))
        .map((port) => ({
          port: port.name,
          hsfo: resolveCurrentValue(port, portsByName, "hsfo"),
          vlsfo: resolveCurrentValue(port, portsByName, "vlsfo"),
          mgo: resolveCurrentValue(port, portsByName, "mgo"),
        }))

      return {
        title: section.title,
        rows,
      }
    })
    .filter((section) => section.rows.length > 0)
}
