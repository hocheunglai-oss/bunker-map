export type PriceHistoryRecordId = string | number
export type PriceHistoryPortId = string | number

export type PriceHistoryValues = {
  hsfo: number | null
  vlsfo: number | null
  mgo: number | null
}

export type StoredPriceHistoryRecord = PriceHistoryValues & {
  id: PriceHistoryRecordId
  port_id: PriceHistoryPortId
  recorded_at: string
}

type SupabaseLike = {
  from: (table: string) => any
}

const marketDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Hong_Kong",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

const marketTimestampFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Hong_Kong",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
})

function normaliseHistoryTimestamp(recordedAt: string) {
  const value = recordedAt.trim()
  const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:[T ]([0-2]\d):([0-5]\d)(?::([0-5]\d)(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/i)
  if (!match || Number(match[2] || 0) > 23) throw new Error("A valid price history date is required.")
  const calendarDate = new Date(`${match[1]}T12:00:00Z`)
  if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== match[1]) {
    throw new Error("A valid price history date is required.")
  }
  // The deployed recorded_at column is timestamp WITHOUT time zone. A UTC
  // suffix is discarded by Postgres, not converted to Hong Kong time. Convert
  // explicit instants here; existing timezone-free market timestamps stay local.
  if (!match[6]) return value.replace(" ", "T")
  const parsed = new Date(value.replace(" ", "T"))
  if (!Number.isFinite(parsed.getTime())) throw new Error("A valid price history date is required.")
  const parts = Object.fromEntries(marketTimestampFormatter.formatToParts(parsed).map(({ type, value }) => [type, value]))
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${String(parsed.getUTCMilliseconds()).padStart(3, "0")}`
}

function getErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.trim()) return message
  }

  return "Unknown database error."
}

function throwIfError(result: { error?: unknown }, action: string) {
  if (result.error) {
    throw new Error(`${action}: ${getErrorMessage(result.error)}`)
  }
}

export function getMarketDateKey(recordedAt: string) {
  const value = recordedAt.trim()
  const isoDate = value.match(/^(\d{4}-\d{2}-\d{2})/)?.[1]
  const hasExplicitTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(value)

  if (isoDate && !hasExplicitTimezone) return isoDate

  const parsed = new Date(value)
  if (!Number.isNaN(parsed.getTime())) return marketDateFormatter.format(parsed)

  return isoDate || value
}

export function formatMarketDateNumeric(recordedAt: string | null) {
  if (!recordedAt) return "-"

  const match = getMarketDateKey(recordedAt).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return "-"

  return `${match[3]}/${match[2]}/${match[1]}`
}

export function getNextMarketDateKey(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + 1))
  return date.toISOString().slice(0, 10)
}

export function distinctPriceHistoryDates<T extends { recorded_at: string }>(rows: T[]) {
  const seenDates = new Set<string>()

  return [...rows]
    .sort((a, b) => {
      const aTime = new Date(a.recorded_at).getTime()
      const bTime = new Date(b.recorded_at).getTime()

      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
        return bTime - aTime
      }

      return b.recorded_at.localeCompare(a.recorded_at)
    })
    .filter((row) => {
      const dateKey = getMarketDateKey(row.recorded_at)
      if (seenDates.has(dateKey)) return false
      seenDates.add(dateKey)
      return true
    })
}

export async function savePriceHistoryForMarketDate(
  supabase: SupabaseLike,
  input: {
    portId: PriceHistoryPortId
    recordedAt: string
    values: PriceHistoryValues
  },
) {
  const recordedAt = normaliseHistoryTimestamp(input.recordedAt)
  if (Object.values(input.values).some((value) => value !== null && !Number.isFinite(value))) {
    throw new Error("Prices must be finite numbers or empty.")
  }
  const dateKey = getMarketDateKey(recordedAt)
  const nextDateKey = getNextMarketDateKey(dateKey)
  const existingResult = await supabase
    .from("price_history")
    .select("id,port_id,hsfo,vlsfo,mgo,recorded_at")
    .eq("port_id", input.portId)
    .gte("recorded_at", `${dateKey}T00:00:00`)
    .lt("recorded_at", `${nextDateKey}T00:00:00`)
    .order("recorded_at", { ascending: false })

  throwIfError(existingResult, "Load price history for market date")
  if (!Array.isArray(existingResult.data)) throw new Error("Price history could not be loaded.")

  const existingRows = (existingResult.data ?? []) as StoredPriceHistoryRecord[]
  const payload = {
    port_id: input.portId,
    ...input.values,
    recorded_at: recordedAt,
  }

  if (existingRows.length === 0) {
    const insertResult = await supabase
      .from("price_history")
      .insert(payload)
      .select("id,port_id,hsfo,vlsfo,mgo,recorded_at")
      .single()

    throwIfError(insertResult, "Insert price history")
    if (!insertResult.data) throw new Error("Price history save was not confirmed.")
    return insertResult.data as StoredPriceHistoryRecord
  }

  const retainedRow = existingRows[0]
  const updateResult = await supabase
    .from("price_history")
    .update(payload)
    .eq("id", retainedRow.id)
    .select("id,port_id,hsfo,vlsfo,mgo,recorded_at")
    .single()

  throwIfError(updateResult, "Update price history")
  if (!updateResult.data) throw new Error("Price history save was not confirmed.")

  const duplicateIds = existingRows.slice(1).map((row) => row.id)
  if (duplicateIds.length > 0) {
    const deleteResult = await supabase
      .from("price_history")
      .delete()
      .in("id", duplicateIds)

    throwIfError(deleteResult, "Remove duplicate price history")
  }

  return updateResult.data as StoredPriceHistoryRecord
}
