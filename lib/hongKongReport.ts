import {
  distinctPriceHistoryDates,
  type PriceHistoryPortId,
} from "@/lib/priceHistoryRecords"

export type HongKongFuelSnapshot = {
  today: number | null
  last1: number | null
  last2: number | null
}

export type HongKongReportRow = {
  port: string
  todayDate: string | null
  last1Date: string | null
  last2Date: string | null
  hsfo: HongKongFuelSnapshot
  vlsfo: HongKongFuelSnapshot
  mgo: HongKongFuelSnapshot
}

type PortRecord = {
  id: PriceHistoryPortId
  name: string
}

type PriceHistoryRecord = {
  port_id: PriceHistoryPortId
  hsfo: number | null
  vlsfo: number | null
  mgo: number | null
  recorded_at: string
}

type FuelKey = "hsfo" | "vlsfo" | "mgo"

function buildFuelSnapshot(
  today: number | null,
  last1: number | null,
  last2: number | null
): HongKongFuelSnapshot {
  return {
    today,
    last1,
    last2,
  }
}

export function buildHongKongReportRows(
  ports: PortRecord[],
  history: PriceHistoryRecord[],
  portOrder: string[]
): HongKongReportRow[] {
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
      const snapshots = historyByPortId.get(port.id) ?? []
      const today = snapshots[0] ?? null
      const last1 = snapshots[1] ?? null
      const last2 = snapshots[2] ?? null

      function fuel(fuelKey: FuelKey): HongKongFuelSnapshot {
        return buildFuelSnapshot(
          today?.[fuelKey] ?? null,
          last1?.[fuelKey] ?? null,
          last2?.[fuelKey] ?? null
        )
      }

      return {
        port: port.name,
        todayDate: today?.recorded_at ?? null,
        last1Date: last1?.recorded_at ?? null,
        last2Date: last2?.recorded_at ?? null,
        hsfo: fuel("hsfo"),
        vlsfo: fuel("vlsfo"),
        mgo: fuel("mgo"),
      }
    })
}
