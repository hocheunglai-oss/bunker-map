import {
  applyFormula,
  parseSimpleFormula,
  type FuelKey,
  type FormulaCapablePort,
} from "@/lib/portPricing"
import {
  distinctPriceHistoryDates,
  getMarketDateKey,
  type PriceHistoryPortId,
} from "@/lib/priceHistoryRecords"

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
  id: PriceHistoryPortId
}

type PriceHistoryRecord = {
  port_id: PriceHistoryPortId
  hsfo: number | null
  vlsfo: number | null
  mgo: number | null
  recorded_at: string
}

const taiwanBasisPortFallbacks: Partial<Record<string, Partial<Record<FuelKey, string>>>> = {
  keelung: { vlsfo: "taichung + 0", mgo: "taichung + 0" },
  suao: { vlsfo: "taichung + 0", mgo: "taichung + 0" },
  hualien: { vlsfo: "taichung + 0", mgo: "taichung + 0" },
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
  historyByPortId: Map<PriceHistoryPortId, PriceHistoryRecord[]>,
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
  const fallbackFormula = taiwanBasisPortFallbacks[port.name.toLowerCase()]?.[fuel] ?? null
  const effectiveFormula = formula?.trim() ? formula : fallbackFormula

  if (effectiveFormula?.trim()) {
    const parsed = parseSimpleFormula(effectiveFormula)
    if (!parsed) return null

    const refPort = portsByName.get(parsed.refName)
    if (!refPort) return null

    const refBase = resolveValue(refPort, portsByName, historyByPortId, fuel, version, seen)

    return applyFormula(refBase, effectiveFormula)
  }

  const directCurrent = currentEntry?.[fuel] ?? null
  if (version === "today" && directCurrent != null) return directCurrent

  const directPrevious = previousEntry?.[fuel] ?? null
  if (version === "last" && directPrevious != null) return directPrevious

  return version === "today" ? port[fuel] ?? null : null
}

export function formatReportDate(recordedAt: string): string {
  const [year, month, day] = getMarketDateKey(recordedAt).split("-").map(Number)
  const reportTime = new Date(Date.UTC(year, month - 1, day))

  return [
    String(reportTime.getUTCDate()).padStart(2, "0"),
    reportTime.toLocaleString("en-GB", { month: "short", timeZone: "UTC" }),
    reportTime.getUTCFullYear(),
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
  const historyByPortId = new Map<PriceHistoryPortId, PriceHistoryRecord[]>()

  for (const entry of history) {
    const existing = historyByPortId.get(entry.port_id) ?? []
    existing.push(entry)
    historyByPortId.set(entry.port_id, existing)
  }

  for (const [portId, entries] of historyByPortId) {
    historyByPortId.set(portId, distinctPriceHistoryDates(entries))
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
