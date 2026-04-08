import {
  applyFormula,
  parseSimpleFormula,
  type FuelKey,
  type FormulaCapablePort,
} from "@/lib/portPricing"

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

type PortRecord = FormulaCapablePort & {
  id: number
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

function resolveValue(
  port: PortRecord,
  portsByName: Map<string, PortRecord>,
  historyByPortId: Map<number, PriceHistoryRecord[]>,
  fuel: FuelKey,
  version: "today" | "last",
  seen = new Set<string>()
): number | null {
  const seenKey = `${port.name.toLowerCase()}-${fuel}-${version}`
  if (seen.has(seenKey)) return null
  seen.add(seenKey)

  const portHistory = historyByPortId.get(port.id) ?? []
  const currentEntry = portHistory[0] ?? null
  const previousEntry = portHistory[1] ?? null

  const formula = port[`${fuel}_formula` as const]

  if (formula?.trim()) {
    const parsed = parseSimpleFormula(formula)
    if (!parsed) return null

    const refPort = portsByName.get(parsed.refName)
    if (!refPort) return null

    const refBase = resolveValue(refPort, portsByName, historyByPortId, fuel, version, seen)

    return applyFormula(refBase, formula)
  }

  const directCurrent = currentEntry?.[fuel] ?? null
  if (version === "today" && directCurrent != null) return directCurrent

  const directPrevious = previousEntry?.[fuel] ?? null
  if (version === "last" && directPrevious != null) return directPrevious

  return version === "today" ? port[fuel] ?? null : null
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
