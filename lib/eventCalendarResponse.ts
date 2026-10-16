import type { OfficeCalendarEvent } from "@/data/eventCalendar"
import { EVENT_CALENDAR_PROTOCOL_VERSION } from "@/lib/eventCalendarProtocol"

type RecordValue = Record<string, unknown>
export type EventCalendarPayload = RecordValue & {
  events?: OfficeCalendarEvent[]
  people?: string[]
  emailRecipientsText?: string
  deletedEventIds?: string[]
  deletedRequiredSeedIds?: string[]
}
export type EventCalendarResponse = {
  payload: EventCalendarPayload | null
  eventVersions: Record<string, string>
  settingVersions: Record<string, string>
  storeVersion: string
  legacyAbsent: boolean
}
export type EventCalendarAcknowledgement = {
  operation: "create" | "update" | "upsert" | "insert" | "delete" | "people" | "settings"
  events: OfficeCalendarEvent[]
  eventIds: string[]
  settings: RecordValue
}

const invalidMessage = "The shared calendar could not be verified. Your unsaved changes have been kept. Refresh the page to check the saved result before trying again."
function invalid(): never { throw new Error(invalidMessage) }
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}
function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** Absence is a supported legacy mode, not an empty or malformed shared list. */
export function validateEventCalendarPayload(value: unknown): EventCalendarPayload | null {
  if (value === null) return null
  if (!record(value)) invalid()
  if (!Object.keys(value).length) return value
  if (!Array.isArray(value.events)) invalid()
  const ids = new Set<string>()
  for (const event of value.events) {
    if (!record(event) || typeof event.id !== "string" || !event.id.trim() || event.id !== event.id.trim() || ids.has(event.id) ||
      !validDate(event.startDate) || !validDate(event.endDate) || event.endDate < event.startDate ||
      typeof event.title !== "string" || !event.title.trim() || !stringList(event.people) || !stringList(event.tags) ||
      (event.uncertainPeople !== undefined && !stringList(event.uncertainPeople)) ||
      (event.eventType !== undefined && (typeof event.eventType !== "string" || !["Public Holiday", "Leave or Travel", "Meeting", "Meeting Room", "Unclassified"].includes(event.eventType)))) invalid()
    ids.add(event.id)
  }
  for (const key of ["people", "deletedEventIds", "deletedRequiredSeedIds"]) {
    if (Object.hasOwn(value, key) && !stringList(value[key])) invalid()
  }
  if (Object.hasOwn(value, "emailRecipientsText") && typeof value.emailRecipientsText !== "string") invalid()
  return value as EventCalendarPayload
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!record(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}
function canonicalJson(value: unknown) { return JSON.stringify(canonical(value)) ?? "null" }
export async function eventCalendarResponseVersion(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
function exactVersionMap(value: unknown, expected: Record<string, string>): Record<string, string> {
  if (!record(value) || Object.keys(value).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, version]) => value[key] !== version)) invalid()
  return expected
}

/** Browser and server use the same payload/hash contract; no transport claim is trusted alone. */
export async function parseEventCalendarResponse(value: unknown, acknowledgement?: EventCalendarAcknowledgement): Promise<EventCalendarResponse> {
  if (!record(value) || value.protocolVersion !== EVENT_CALENDAR_PROTOCOL_VERSION || !Object.hasOwn(value, "payload")) invalid()
  const payload = validateEventCalendarPayload(value.payload)
  const data = payload ?? {}
  const eventEntries = await Promise.all((data.events ?? []).map(async (event) => [event.id, await eventCalendarResponseVersion(event)] as const))
  const expectedSettings = {
    people: await eventCalendarResponseVersion(data.people ?? []),
    emailRecipientsText: await eventCalendarResponseVersion(data.emailRecipientsText ?? null),
  }
  const eventVersions = exactVersionMap(value.eventVersions, Object.fromEntries(eventEntries))
  const settingVersions = exactVersionMap(value.settingVersions, expectedSettings)
  const storeVersion = await eventCalendarResponseVersion(data)
  if (value.storeVersion !== storeVersion) invalid()
  if (acknowledgement) {
    if (value.success !== true || !payload || !Array.isArray(payload.events)) invalid()
    const { operation, settings, events, eventIds } = acknowledgement
    for (const key of ["people", "emailRecipientsText"] as const) {
      if (!Object.hasOwn(settings, key)) continue
      if (operation === "insert" && key === "people") {
        if (!stringList(settings.people) || settings.people.some((person) => !payload.people?.includes(person))) invalid()
      } else if (canonicalJson(payload[key]) !== canonicalJson(settings[key])) invalid()
    }
    if (["create", "update", "upsert"].includes(operation)) {
      const saved = new Map(payload.events.map((event) => [event.id, event]))
      if (events.some((event) => canonicalJson(saved.get(event.id)) !== canonicalJson(event))) invalid()
    }
    if (operation === "insert" && events.some((event) => !payload.events?.some((saved) => saved.id === event.id) && !payload.deletedEventIds?.includes(event.id))) invalid()
    if (operation === "delete" && eventIds.some((id) => payload.events?.some((event) => event.id === id) || !payload.deletedEventIds?.includes(id))) invalid()
    if (Object.hasOwn(settings, "deletedRequiredSeedIds") && (!stringList(settings.deletedRequiredSeedIds) || settings.deletedRequiredSeedIds.some((id) => !payload.deletedRequiredSeedIds?.includes(id)))) invalid()
  }
  return { payload, eventVersions, settingVersions, storeVersion, legacyAbsent: !payload || Object.keys(payload).length === 0 }
}
