import type { SupabaseClient } from "@supabase/supabase-js"
import type { OfficeCalendarEvent } from "@/data/eventCalendar"
import { HOLIDAY_COUNTRIES, HOLIDAY_SOURCES, type HolidayCountry } from "@/data/publicHolidays"
import { isValidCalendarDate } from "@/lib/eventCalendarDates"
import { holidayBaseline, type HolidaySource } from "@/lib/holidayCalendar"

/** Keep audited importer metadata without accepting arbitrary fields or sources.
 * The original baseline must survive recovery: replacing it would turn genuine
 * manual edits into apparently pristine imports during holiday reconciliation.
 */
export function readRecoverableHolidaySource(value: unknown, eventId: string): HolidaySource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const country = source.country as HolidayCountry
  if (!HOLIDAY_COUNTRIES.includes(country) || !Number.isInteger(source.year)) return undefined
  const year = Number(source.year)
  const allowedUrls = HOLIDAY_SOURCES[country]?.[year] || []
  if (!allowedUrls.length || typeof source.identity !== "string" ||
    !new RegExp(`^${country.toLowerCase()}-${year}-[a-z0-9]+(?:-[a-z0-9]+)*$`).test(source.identity)) return undefined
  if (typeof source.revision !== "string" || !source.revision.trim() || source.revision.length > 100 ||
    typeof source.calendarScope !== "string" || !source.calendarScope.trim() || source.calendarScope.length > 500 ||
    !Array.isArray(source.sourceUrls) || !source.sourceUrls.length || source.sourceUrls.some((url) => !allowedUrls.includes(url))) return undefined
  const stableId = `public-holiday-${source.identity}`
  const legacyPrefix = `public-holiday-${country.toLowerCase()}-`
  if (!Array.isArray(source.deletionIds) || !source.deletionIds.length || source.deletionIds.length > 100 ||
    source.deletionIds.some((id) => typeof id !== "string" ||
      id !== stableId && !(id.startsWith(legacyPrefix) && isValidCalendarDate(id.slice(legacyPrefix.length))))) return undefined
  if (eventId !== stableId && !source.deletionIds.includes(eventId)) return undefined
  if (typeof source.baseline !== "string" || source.baseline.length > 30000) return undefined
  try {
    const baseline = JSON.parse(source.baseline)
    const strings = (input: unknown) => Array.isArray(input) && input.every((item) => typeof item === "string")
    if (!baseline || typeof baseline !== "object" || Array.isArray(baseline) ||
      !isValidCalendarDate(baseline.startDate) || !isValidCalendarDate(baseline.endDate) || baseline.endDate < baseline.startDate ||
      typeof baseline.title !== "string" || !strings(baseline.tags) || !strings(baseline.people) || !strings(baseline.uncertainPeople) ||
      baseline.eventType !== "Public Holiday" || !(baseline.sourceRow === null || Number.isInteger(baseline.sourceRow)) ||
      holidayBaseline(baseline as OfficeCalendarEvent) !== source.baseline) return undefined
  } catch { return undefined }
  return {
    identity: source.identity, country, year, revision: source.revision,
    sourceUrls: [...source.sourceUrls], calendarScope: source.calendarScope,
    deletionIds: [...source.deletionIds], baseline: source.baseline,
  }
}

export type CalendarAuditRow = {
  id: string
  occurred_at: string
  actor_id: string | null
  actor_name: string | null
  before_row: unknown
  after_row: unknown
}

export async function loadEventCalendarHistory(supabase: SupabaseClient, snapshotAt = new Date().toISOString()) {
  const pageSize = 200, maximum = 10000
  const rows: CalendarAuditRow[] = []
  let cursor: CalendarAuditRow | undefined
  while (rows.length < maximum) {
    let query = supabase.from("audit_logs")
      .select("id, occurred_at, actor_id, actor_name, before_row, after_row")
      .eq("table_schema", "public").eq("table_name", "office_calendar_store")
      .or("before_row->>key.eq.event-calendar,after_row->>key.eq.event-calendar")
      .lte("occurred_at", snapshotAt)
      .order("occurred_at", { ascending: false }).order("id", { ascending: false })
      .limit(pageSize)
    // Keyset pagination avoids offsets shifting when new audit rows arrive.
    if (cursor) query = query.or(`occurred_at.lt.${cursor.occurred_at},and(occurred_at.eq.${cursor.occurred_at},id.lt.${cursor.id})`)
    const result = await query
    if (result.error) throw new Error("Calendar recovery history could not be read. Nothing was restored.")
    const page = (result.data || []) as CalendarAuditRow[]
    rows.push(...page)
    if (page.length < pageSize) return { rows, historyComplete: true, historyScanned: rows.length, oldestChecked: rows.at(-1)?.occurred_at || null }
    cursor = page.at(-1)
  }
  return { rows, historyComplete: false, historyScanned: rows.length, oldestChecked: rows.at(-1)?.occurred_at || null }
}
