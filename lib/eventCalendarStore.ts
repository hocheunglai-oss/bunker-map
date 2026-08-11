import type { SupabaseClient } from "@supabase/supabase-js"

type CalendarMutation = {
  operation: "upsert" | "insert" | "delete" | "people" | "settings"
  events?: unknown[]
  eventIds?: string[]
  settings?: Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map((item) => String(item || "").trim()).filter(Boolean)))
}

function recordId(value: unknown) {
  return String(asRecord(value).id || "").trim()
}

export function applyEventCalendarMutation(
  currentValue: unknown,
  mutation: CalendarMutation,
) {
  const current = asRecord(currentValue)
  const incomingEvents = Array.isArray(mutation.events) ? mutation.events : []
  const incomingIds = new Set(incomingEvents.map(recordId).filter(Boolean))
  const eventIds = new Set(stringList(mutation.eventIds))
  const deletedIds = new Set(stringList(current.deletedEventIds))
  let events = Array.isArray(current.events) ? current.events : []

  if (mutation.operation === "upsert") {
    events = [
      ...events.filter((event) => !incomingIds.has(recordId(event))),
      ...incomingEvents.filter((event) => recordId(event)),
    ]
    for (const id of incomingIds) deletedIds.delete(id)
  } else if (mutation.operation === "insert") {
    const existingIds = new Set(events.map(recordId))
    const additions = incomingEvents.filter((event) => {
      const id = recordId(event)
      return id && !existingIds.has(id) && !deletedIds.has(id)
    })
    events = [...events, ...additions]
  } else if (mutation.operation === "delete") {
    events = events.filter((event) => !eventIds.has(recordId(event)))
    for (const id of eventIds) deletedIds.add(id)
  } else if (mutation.operation === "people") {
    const allowedPeople = new Set(stringList(asRecord(mutation.settings).people))
    events = events.map((event) => {
      const record = asRecord(event)
      return {
        ...record,
        people: stringList(record.people).filter((person) => allowedPeople.has(person)),
        uncertainPeople: stringList(record.uncertainPeople).filter((person) => allowedPeople.has(person)),
      }
    })
  }

  return {
    ...current,
    ...asRecord(mutation.settings),
    ...(mutation.operation === "settings" ? {} : {
      events,
      deletedEventIds: Array.from(deletedIds),
    }),
  }
}

export async function mutateEventCalendarStore(
  supabase: SupabaseClient,
  mutation: CalendarMutation,
) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { data: current, error: readError } = await supabase
      .from("office_calendar_store")
      .select("payload, updated_at")
      .eq("key", "event-calendar")
      .maybeSingle()
    if (readError) throw readError

    const nextPayload = applyEventCalendarMutation(current?.payload, mutation)
    const currentUpdatedAt = current?.updated_at
      ? new Date(current.updated_at).getTime()
      : 0
    const nextUpdatedAt = new Date(Math.max(Date.now(), currentUpdatedAt + 1)).toISOString()

    if (!current) {
      const { data: inserted, error: insertError } = await supabase
        .from("office_calendar_store")
        .insert({ key: "event-calendar", payload: nextPayload, updated_at: nextUpdatedAt })
        .select("payload")
        .maybeSingle()
      if (!insertError && inserted) return inserted.payload
      if (insertError?.code !== "23505") throw insertError
      continue
    }

    const { data: updated, error: updateError } = await supabase
      .from("office_calendar_store")
      .update({ payload: nextPayload, updated_at: nextUpdatedAt })
      .eq("key", "event-calendar")
      .eq("updated_at", current.updated_at)
      .select("payload")
      .maybeSingle()
    if (updateError) throw updateError
    if (updated) return updated.payload
  }

  throw new Error("Event Calendar changed repeatedly while saving. Please retry.")
}
