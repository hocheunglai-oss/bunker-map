import type { SupabaseClient } from "@supabase/supabase-js"

export function compareAndSetCalendarPayload(
  supabase: SupabaseClient,
  key: string,
  updatedAt: string,
  payload: unknown,
) {
  const nextUpdatedAt = new Date(Math.max(Date.now(), Date.parse(updatedAt) + 1)).toISOString()
  return supabase.from("office_calendar_store")
    .update({ payload, updated_at: nextUpdatedAt })
    .eq("key", key)
    .eq("updated_at", updatedAt)
    .select("payload,updated_at")
    .maybeSingle()
}
