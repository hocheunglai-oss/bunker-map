import { normaliseHistoryTimestamp, type PriceHistoryPortId, type StoredPriceHistoryRecord } from "@/lib/priceHistoryRecords"

const displayDate = new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "short", day: "2-digit", timeZone: "UTC" })
const TAIWAN_SPLIT_EFFECTIVE_FROM = "2026-04-21"

// recorded_at is a market-local timestamp WITHOUT time zone. Never interpret
// it in the viewer's browser timezone. Keep microseconds for duplicate ranking.
function sortKey(value: string) {
  try {
    const normalized = normaliseHistoryTimestamp(value)
    const [date, time = "00:00:00"] = normalized.split("T")
    const [clock, fraction = ""] = time.split(".")
    return `${date}T${clock.length === 5 ? clock + ":00" : clock}.${fraction.padEnd(6, "0")}`
  } catch { return "" }
}

export function getPriceHistoryDateParts(value: string) {
  const dateKey = sortKey(value).slice(0, 10)
  return { dateKey, year: dateKey.slice(0, 4), month: dateKey.slice(5, 7), day: dateKey.slice(8, 10) }
}

export function formatPriceHistoryDate(value: string) {
  const { dateKey } = getPriceHistoryDateParts(value)
  return dateKey ? displayDate.format(new Date(`${dateKey}T12:00:00Z`)) : "-"
}

export function compareAdminPriceHistoryRows(a: { id: string | number; recorded_at: string }, b: { id: string | number; recorded_at: string }) {
  const aTime = sortKey(a.recorded_at), bTime = sortKey(b.recorded_at)
  if (aTime !== bTime) return aTime < bTime ? 1 : -1
  if (typeof a.id === "number" && typeof b.id === "number") return b.id - a.id
  const aId = String(a.id), bId = String(b.id)
  return aId === bId ? 0 : aId < bId ? 1 : -1
}

export function sortAdminPriceHistoryRows<T extends { id: string | number; recorded_at: string }>(rows: T[]) {
  return [...rows].sort(compareAdminPriceHistoryRows)
}

export type CombinedTaiwanHistoryRow = {
  dateKey: string
  recorded_at: string
  kaohsiungRow: StoredPriceHistoryRecord | null
  taichungRow: StoredPriceHistoryRecord | null
  hsfo: number | null
  vlsfoKaohsiung: number | null
  vlsfoTaichung: number | null
  mgoKaohsiung: number | null
  mgoTaichung: number | null
}

export function combineTaiwanPriceHistory(rows: StoredPriceHistoryRecord[], kaohsiungId: PriceHistoryPortId | null, taichungId: PriceHistoryPortId | null): CombinedTaiwanHistoryRow[] {
  const grouped = new Map<string, { recorded_at: string; kaohsiungRow: StoredPriceHistoryRecord | null; taichungRow: StoredPriceHistoryRecord | null }>()
  for (const row of sortAdminPriceHistoryRows(rows)) {
    if (row.port_id !== kaohsiungId && row.port_id !== taichungId) continue
    const { dateKey } = getPriceHistoryDateParts(row.recorded_at)
    if (!dateKey) continue
    const current = grouped.get(dateKey) ?? { recorded_at: row.recorded_at, kaohsiungRow: null, taichungRow: null }
    // First per port/day is the authoritative newest record, regardless of
    // incoming order. Older duplicates must not overwrite it during grouping.
    if (row.port_id === kaohsiungId && !current.kaohsiungRow) current.kaohsiungRow = row
    if (row.port_id === taichungId && !current.taichungRow) current.taichungRow = row
    grouped.set(dateKey, current)
  }
  return [...grouped].map(([dateKey, value]) => {
    const khh = value.kaohsiungRow, txg = value.taichungRow, beforeSplit = dateKey < TAIWAN_SPLIT_EFFECTIVE_FROM
    return {
      dateKey, ...value, hsfo: khh?.hsfo ?? null,
      vlsfoKaohsiung: khh?.vlsfo ?? null, mgoKaohsiung: khh?.mgo ?? null,
      vlsfoTaichung: txg?.vlsfo ?? (beforeSplit ? khh?.vlsfo ?? null : null),
      mgoTaichung: txg?.mgo ?? (beforeSplit ? khh?.mgo ?? null : null),
    }
  })
}
