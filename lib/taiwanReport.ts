export type FuelKey = "hsfo" | "vlsfo" | "mgo"

export type FuelSnapshot = {
  today: number | null
  last: number | null
  change: number | null
}

export type TaiwanReportRow = {
  port: string
  hsfo: FuelSnapshot
  vlsfo: FuelSnapshot
  mgo: FuelSnapshot
}

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

type PriceHistoryRecord = {
  port_id: number
  hsfo: number | null
  vlsfo: number | null
  mgo: number | null
  recorded_at: string
}

function buildFuelSnapshot(today: number | null, last: number | null): FuelSnapshot {
  return {
    today,
    last,
    change: today != null && last != null ? today - last : null,
  }
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

function resolveValue(
  port: PortRecord,
  portsByName: Map<string, PortRecord>,
  historyByPortId: Map<number, PriceHistoryRecord[]>,
  fuel: FuelKey,
  version: "today" | "last"
): number | null {
  const portHistory = historyByPortId.get(port.id) ?? []
  const currentEntry = portHistory[0] ?? null
  const previousEntry = portHistory[1] ?? null

  const directCurrent = currentEntry?.[fuel] ?? null
  if (version === "today" && directCurrent != null) return directCurrent

  const directPrevious = previousEntry?.[fuel] ?? null
  if (version === "last" && directPrevious != null) return directPrevious

  const directPortValue = port[fuel]
  const formula = port[`${fuel}_formula` as const]

  if (formula) {
    const parsed = parseSimpleFormula(formula)
    if (!parsed) return null

    const refPort = portsByName.get(parsed.refName)
    if (!refPort) return null

    const refBase = resolveValue(refPort, portsByName, historyByPortId, fuel, version)

    return applyFormula(refBase, formula)
  }

  if (version === "today") {
    return directPortValue ?? null
  }

  return null
}

export function formatReportDate(recordedAt: string): string {
  const reportTime = new Date(recordedAt)

  return [
    String(reportTime.getDate()).padStart(2, "0"),
    reportTime.toLocaleString("en-GB", { month: "short" }),
    reportTime.getFullYear(),
  ].join(" ")
}

export function buildTaiwanReportRows(
  ports: PortRecord[],
  history: PriceHistoryRecord[],
  portOrder: string[]
): TaiwanReportRow[] {
  const portsByName = new Map(
    ports.map((port) => [port.name.toLowerCase(), port] as const)
  )
  const historyByPortId = new Map<number, PriceHistoryRecord[]>()

  for (const entry of history) {
    const existing = historyByPortId.get(entry.port_id) ?? []
    existing.push(entry)
    historyByPortId.set(entry.port_id, existing)
  }

  return [...ports]
    .sort((a, b) => portOrder.indexOf(a.name) - portOrder.indexOf(b.name))
    .map((port) => {
      const hsfoToday = port.name === "Kaohsiung"
        ? resolveValue(port, portsByName, historyByPortId, "hsfo", "today")
        : null
      const hsfoLast = port.name === "Kaohsiung"
        ? resolveValue(port, portsByName, historyByPortId, "hsfo", "last")
        : null

      const vlsfoToday = resolveValue(port, portsByName, historyByPortId, "vlsfo", "today")
      const vlsfoLast = resolveValue(port, portsByName, historyByPortId, "vlsfo", "last")

      const mgoToday = resolveValue(port, portsByName, historyByPortId, "mgo", "today")
      const mgoLast = resolveValue(port, portsByName, historyByPortId, "mgo", "last")

      return {
        port: port.name,
        hsfo: buildFuelSnapshot(hsfoToday, hsfoLast),
        vlsfo: buildFuelSnapshot(vlsfoToday, vlsfoLast),
        mgo: buildFuelSnapshot(mgoToday, mgoLast),
      }
    })
}
