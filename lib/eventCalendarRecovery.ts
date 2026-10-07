import type { SupabaseClient } from "@supabase/supabase-js"

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
