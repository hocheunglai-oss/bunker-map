import { createHash } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

export type CalendarMutation = {
  operation: "create" | "update" | "upsert" | "insert" | "delete" | "people" | "settings"
  events?: unknown[]
  eventIds?: string[]
  expectedEventVersions?: Record<string, unknown>
  expectedSettingVersions?: Record<string, unknown>
  settings?: Record<string, unknown>
}

const MAX_MUTATION_EVENTS = 500
const MAX_EVENT_ID_LENGTH = 200
const MAX_EVENT_TITLE_LENGTH = 5000
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const EVENT_VERSION_PATTERN = /^[0-9a-f]{64}$/
const EVENT_TYPES = new Set([
  "Public Holiday",
  "Leave or Travel",
  "Meeting",
  "Meeting Room",
  "Unclassified",
])

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

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== "object") return value

  const record = value as Record<string, unknown>
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = canonicalValue(record[key])
      return result
    }, {})
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalValue(value)) ?? "null"
}

export function getEventCalendarRecordVersion(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

export function getEventCalendarEventVersions(value: unknown) {
  const payload = asRecord(value)
  const versions: Record<string, string> = {}

  for (const event of Array.isArray(payload.events) ? payload.events : []) {
    const id = recordId(event)
    if (id) versions[id] = getEventCalendarRecordVersion(event)
  }

  return versions
}

export function getEventCalendarStoreVersion(value: unknown) {
  return getEventCalendarRecordVersion(asRecord(value))
}

function settingValue(payload: Record<string, unknown>, key: "people" | "emailRecipientsText") {
  if (key === "people") return Array.isArray(payload.people) ? payload.people : []
  return typeof payload.emailRecipientsText === "string" ? payload.emailRecipientsText : ""
}

export function getEventCalendarSettingVersions(value: unknown) {
  const payload = asRecord(value)
  return {
    people: getEventCalendarRecordVersion(settingValue(payload, "people")),
    emailRecipientsText: getEventCalendarRecordVersion(settingValue(payload, "emailRecipientsText")),
  }
}

export class EventCalendarConflictError extends Error {
  readonly code = "EVENT_CALENDAR_CONFLICT"
  readonly payload: Record<string, unknown>
  readonly eventVersions: Record<string, string>
  readonly settingVersions: Record<string, string>
  readonly storeVersion: string

  constructor(message: string, currentValue: unknown) {
    super(message)
    this.name = "EventCalendarConflictError"
    this.payload = asRecord(currentValue)
    this.eventVersions = getEventCalendarEventVersions(currentValue)
    this.settingVersions = getEventCalendarSettingVersions(currentValue)
    this.storeVersion = getEventCalendarStoreVersion(currentValue)
  }
}

export class EventCalendarValidationError extends Error {
  readonly code = "EVENT_CALENDAR_INVALID_MUTATION"

  constructor(message: string) {
    super(message)
    this.name = "EventCalendarValidationError"
  }
}

function conflict(currentValue: unknown, message = "This event changed after this tab loaded. Nothing was saved. The calendar has been refreshed; reopen the event and try again."): never {
  throw new EventCalendarConflictError(message, currentValue)
}

function validDate(value: unknown) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function validateStringArray(value: unknown, field: string, index: number) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new EventCalendarValidationError(`Event ${index + 1} has an invalid ${field} list.`)
  }
}

function validatedIncomingEvents(value: unknown) {
  if (!Array.isArray(value)) return []
  if (value.length > MAX_MUTATION_EVENTS) {
    throw new EventCalendarValidationError(`A single calendar change cannot contain more than ${MAX_MUTATION_EVENTS} events.`)
  }

  const ids = new Set<string>()
  return value.map((event, index) => {
    const record = asRecord(event)
    const id = typeof record.id === "string" ? record.id.trim() : ""
    if (!id || record.id !== id || id.length > MAX_EVENT_ID_LENGTH) {
      throw new EventCalendarValidationError(`Event ${index + 1} has an invalid ID.`)
    }
    if (ids.has(id)) {
      throw new EventCalendarValidationError(`The calendar change contains the duplicate event ID ${id}.`)
    }
    ids.add(id)

    if (!validDate(record.startDate) || !validDate(record.endDate)) {
      throw new EventCalendarValidationError(`Event ${index + 1} has an invalid date.`)
    }
    if (String(record.endDate) < String(record.startDate)) {
      throw new EventCalendarValidationError(`Event ${index + 1} ends before it starts.`)
    }
    if (
      typeof record.title !== "string" ||
      !record.title.trim() ||
      record.title.length > MAX_EVENT_TITLE_LENGTH
    ) {
      throw new EventCalendarValidationError(`Event ${index + 1} has an invalid title.`)
    }
    validateStringArray(record.people, "people", index)
    validateStringArray(record.tags, "tags", index)
    if (record.uncertainPeople !== undefined) {
      validateStringArray(record.uncertainPeople, "uncertain people", index)
    }
    if (record.eventType !== undefined && (typeof record.eventType !== "string" || !EVENT_TYPES.has(record.eventType))) {
      throw new EventCalendarValidationError(`Event ${index + 1} has an invalid event type.`)
    }
    return event
  })
}

function expectedEventVersions(value: unknown) {
  const versions: Record<string, string> = {}
  for (const [id, version] of Object.entries(asRecord(value))) {
    const normalizedId = id.trim()
    const normalizedVersion = typeof version === "string" ? version.trim().toLowerCase() : ""
    if (normalizedId && EVENT_VERSION_PATTERN.test(normalizedVersion)) {
      versions[normalizedId] = normalizedVersion
    }
  }
  return versions
}

function expectedSettingVersions(value: unknown) {
  const versions: Record<string, string> = {}
  for (const [key, version] of Object.entries(asRecord(value))) {
    const normalizedVersion = typeof version === "string" ? version.trim().toLowerCase() : ""
    if (["people", "emailRecipientsText"].includes(key) && EVENT_VERSION_PATTERN.test(normalizedVersion)) {
      versions[key] = normalizedVersion
    }
  }
  return versions
}

function safeMutationSettings(mutation: CalendarMutation) {
  const source = asRecord(mutation.settings)
  const allowedKeys = mutation.operation === "settings"
    ? new Set(["people", "emailRecipientsText", "deletedRequiredSeedIds"])
    : mutation.operation === "insert"
      ? new Set(["people"])
    : mutation.operation === "people"
      ? new Set(["people"])
      : mutation.operation === "delete"
        ? new Set(["deletedRequiredSeedIds"])
        : new Set<string>()
  const unknownKeys = Object.keys(source).filter((key) => !allowedKeys.has(key))
  if (unknownKeys.length) {
    throw new EventCalendarValidationError(`Event Calendar settings cannot change ${unknownKeys.join(", ")}.`)
  }

  const settings: Record<string, unknown> = {}
  if (Object.hasOwn(source, "people")) {
    if (!Array.isArray(source.people) || source.people.some((item) => typeof item !== "string")) {
      throw new EventCalendarValidationError("The Event Calendar people list is invalid.")
    }
    settings.people = stringList(source.people)
  }
  if (Object.hasOwn(source, "emailRecipientsText")) {
    if (typeof source.emailRecipientsText !== "string" || source.emailRecipientsText.length > 20000) {
      throw new EventCalendarValidationError("The Event Calendar email recipient list is invalid.")
    }
    settings.emailRecipientsText = source.emailRecipientsText
  }
  if (Object.hasOwn(source, "deletedRequiredSeedIds")) {
    if (!Array.isArray(source.deletedRequiredSeedIds)) {
      throw new EventCalendarValidationError("The required-event deletion list is invalid.")
    }
    settings.deletedRequiredSeedIds = stringList(source.deletedRequiredSeedIds)
  }
  if (mutation.operation === "people" && !Object.hasOwn(settings, "people")) {
    throw new EventCalendarValidationError("The Event Calendar people list is required.")
  }
  return settings
}

function recordsEqual(left: unknown, right: unknown) {
  return canonicalJson(left) === canonicalJson(right)
}

export function applyEventCalendarMutation(
  currentValue: unknown,
  mutation: CalendarMutation,
) {
  const current = asRecord(currentValue)
  const incomingEvents = validatedIncomingEvents(mutation.events)
  const requestedEventIds = stringList(mutation.eventIds)
  const expectedVersions = expectedEventVersions(mutation.expectedEventVersions)
  const expectedSettings = expectedSettingVersions(mutation.expectedSettingVersions)
  const settings = safeMutationSettings(mutation)
  const deletedIds = new Set(stringList(current.deletedEventIds))
  let events = Array.isArray(current.events) ? [...current.events] : []

  const rebuildEventIndex = () => new Map(
    events
      .map((event, index) => [recordId(event), { event, index }] as const)
      .filter(([id]) => Boolean(id)),
  )

  if (["create", "update", "upsert"].includes(mutation.operation) && !incomingEvents.length) {
    throw new EventCalendarValidationError("At least one valid event is required for this calendar change.")
  }
  if (mutation.operation === "insert" && !incomingEvents.length && !Object.hasOwn(settings, "people")) {
    throw new EventCalendarValidationError("At least one valid event is required for this calendar change.")
  }

  if (mutation.operation === "create" || mutation.operation === "update" || mutation.operation === "upsert") {
    const eventIndex = rebuildEventIndex()

    for (const incomingEvent of incomingEvents) {
      const id = recordId(incomingEvent)
      const existing = eventIndex.get(id)

      if (mutation.operation === "create") {
        if (deletedIds.has(id)) {
          conflict(current, "This event ID was previously deleted. Nothing was overwritten; reopen the calendar and create the event again.")
        }
        if (existing) {
          if (recordsEqual(existing.event, incomingEvent)) continue
          conflict(current, "Another event already uses this ID. Nothing was overwritten; reopen the calendar and create the event again.")
        }
        events.push(incomingEvent)
        eventIndex.set(id, { event: incomingEvent, index: events.length - 1 })
        continue
      }

      if (!existing) {
        if (mutation.operation === "upsert" && !expectedVersions[id] && !deletedIds.has(id)) {
          events.push(incomingEvent)
          eventIndex.set(id, { event: incomingEvent, index: events.length - 1 })
          continue
        }
        conflict(current, "This event was deleted or is no longer available. Nothing was saved; refresh the calendar before continuing.")
      }

      if (recordsEqual(existing.event, incomingEvent)) continue
      if (!expectedVersions[id] || expectedVersions[id] !== getEventCalendarRecordVersion(existing.event)) {
        conflict(current)
      }

      events[existing.index] = incomingEvent
      eventIndex.set(id, { event: incomingEvent, index: existing.index })
    }
  } else if (mutation.operation === "insert") {
    const eventIndex = rebuildEventIndex()
    for (const incomingEvent of incomingEvents) {
      const id = recordId(incomingEvent)
      if (eventIndex.has(id) || deletedIds.has(id)) continue
      events.push(incomingEvent)
      eventIndex.set(id, { event: incomingEvent, index: events.length - 1 })
    }
  } else if (mutation.operation === "delete") {
    if (!requestedEventIds.length) {
      throw new EventCalendarValidationError("At least one event ID is required for deletion.")
    }
    const eventIndex = rebuildEventIndex()
    for (const id of requestedEventIds) {
      const existing = eventIndex.get(id)
      if (!existing) {
        if (deletedIds.has(id)) continue
        conflict(current, "This event is no longer available. Nothing else was changed; refresh the calendar before continuing.")
      }
      if (!expectedVersions[id] || expectedVersions[id] !== getEventCalendarRecordVersion(existing.event)) {
        conflict(current)
      }
    }

    const deletionSet = new Set(requestedEventIds)
    events = events.filter((event) => !deletionSet.has(recordId(event)))
    for (const id of requestedEventIds) deletedIds.add(id)
  }

  const nextSettings: Record<string, unknown> = {}
  if (Object.hasOwn(settings, "people")) {
    const currentPeople = stringList(current.people)
    const requestedPeople = stringList(settings.people)
    if (mutation.operation === "insert") {
      nextSettings.people = Array.from(new Set([...currentPeople, ...requestedPeople]))
    } else {
      if (
        !recordsEqual(currentPeople, requestedPeople) &&
        expectedSettings.people !== getEventCalendarRecordVersion(settingValue(current, "people"))
      ) {
        conflict(current, "The People list changed after this window opened. Nothing was overwritten; reopen People Columns and try again.")
      }
      nextSettings.people = requestedPeople
    }
  }
  if (Object.hasOwn(settings, "emailRecipientsText")) {
    const currentEmailRecipients = settingValue(current, "emailRecipientsText")
    if (
      !recordsEqual(currentEmailRecipients, settings.emailRecipientsText) &&
      expectedSettings.emailRecipientsText !== getEventCalendarRecordVersion(currentEmailRecipients)
    ) {
      conflict(current, "The email reminder list changed after this window opened. Nothing was overwritten; reopen Email Reminders and try again.")
    }
    nextSettings.emailRecipientsText = settings.emailRecipientsText
  }
  if (Object.hasOwn(settings, "deletedRequiredSeedIds")) {
    nextSettings.deletedRequiredSeedIds = Array.from(new Set([
      ...stringList(current.deletedRequiredSeedIds),
      ...stringList(settings.deletedRequiredSeedIds),
    ]))
  }

  return {
    ...current,
    ...nextSettings,
    events,
    deletedEventIds: Array.from(deletedIds),
  }
}

export async function mutateEventCalendarStore(
  supabase: SupabaseClient,
  mutation: CalendarMutation,
) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const { data: current, error: readError } = await supabase
      .from("office_calendar_store")
      .select("payload, updated_at")
      .eq("key", "event-calendar")
      .maybeSingle()
    if (readError) throw readError

    const nextPayload = applyEventCalendarMutation(current?.payload, mutation)
    if (current && canonicalJson(nextPayload) === canonicalJson(current.payload)) {
      return current.payload
    }

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

  throw new Error("Event Calendar changed repeatedly while saving. Nothing was changed by this request; please retry.")
}
