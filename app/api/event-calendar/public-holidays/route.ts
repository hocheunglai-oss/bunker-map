import { NextResponse } from "next/server"
import type { OfficeCalendarEvent } from "@/data/eventCalendar"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { createAdminAuditContext, createAdminAuditedSupabaseClient } from "@/lib/adminAudit"
import { getVerifiedPublicHolidays, parseHolidayRequest } from "@/lib/holidayCalendar"
import { planHolidayReconciliation } from "@/lib/eventCalendarImport"
import { EVENT_CALENDAR_PROTOCOL_VERSION } from "@/lib/eventCalendarProtocol"
import {
  EventCalendarConflictError, EventCalendarValidationError,
  getEventCalendarEventVersions, getEventCalendarSettingVersions, getEventCalendarStoreVersion,
  mutateEventCalendarStoreBatch, type CalendarMutation,
} from "@/lib/eventCalendarStore"

function canonicalResponse(payload: Record<string, unknown>) {
  return { payload, protocolVersion: EVENT_CALENDAR_PROTOCOL_VERSION,
    eventVersions: getEventCalendarEventVersions(payload), settingVersions: getEventCalendarSettingVersions(payload),
    storeVersion: getEventCalendarStoreVersion(payload) }
}

function errorResponse(error: unknown) {
  if (error instanceof EventCalendarConflictError) {
    return NextResponse.json({ code: error.code, message: error.message, ...canonicalResponse(error.payload) }, { status: 409 })
  }
  const message = error instanceof Error ? error.message : "Could not check public holidays."
  const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403
    : error instanceof EventCalendarValidationError ? 400 : 500
  return NextResponse.json({ message }, { status })
}

function parseRequest(years: unknown, countries: unknown) {
  try { return parseHolidayRequest(years, countries) }
  catch (error) { throw new EventCalendarValidationError(error instanceof Error ? error.message : "Invalid holiday selection.") }
}

export async function GET(request: Request) {
  try {
    await requireAdminPagePermission("event-calendar", "view")
    const { searchParams } = new URL(request.url)
    const selection = parseRequest(searchParams.get("years"), searchParams.get("countries"))
    return NextResponse.json(getVerifiedPublicHolidays(selection.years, selection.countries), { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) { return errorResponse(error) }
}

// Preview is read-only. Apply recalculates the plan from server-side references,
// never client-supplied records, and commits all corrections in one audited CAS.
export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermission("event-calendar", "edit")
    const body = await request.json().catch(() => null)
    if (!body || !["preview", "apply"].includes(body.action)) throw new EventCalendarValidationError("Choose preview or apply.")
    const selection = parseRequest(body.years, body.countries)
    const reference = getVerifiedPublicHolidays(selection.years, selection.countries)
    const supabase = createAdminAuditedSupabaseClient(createAdminAuditContext(session, request, "event-calendar"), { useServiceRole: true })
    const { data, error } = await supabase.from("office_calendar_store").select("payload").eq("key", "event-calendar").maybeSingle()
    if (error) throw error
    if (!data?.payload || !Array.isArray(data.payload.events)) throw new EventCalendarValidationError("Load the shared Event Calendar before updating holidays.")
    const payload = data.payload as Record<string, unknown>
    const current = payload.events as OfficeCalendarEvent[]
    if (current.some((event) => !event || typeof event.id !== "string" || typeof event.title !== "string" ||
      typeof event.startDate !== "string" || typeof event.endDate !== "string" || !Array.isArray(event.tags) || !Array.isArray(event.people))) {
      throw new EventCalendarValidationError("The shared calendar needs review before holidays can be updated.")
    }
    const deletedEventIds = [...new Set([
      ...(Array.isArray(payload.deletedEventIds) ? payload.deletedEventIds : []),
      ...(Array.isArray(payload.deletedRequiredSeedIds) ? payload.deletedRequiredSeedIds : []),
    ].filter((id): id is string => typeof id === "string"))]
    const plan = planHolidayReconciliation(current, reference.events, { coverage: reference.coverage, deletedEventIds })
    const response = { coverage: reference.coverage, complete: plan.complete, revision: reference.revision,
      years: reference.years, countries: reference.countries, plan,
      counts: { additions: plan.additions.length, updates: plan.updates.length, removals: plan.removals.length, preserved: plan.preserved.length } }
    if (body.action === "preview") return NextResponse.json({ ...response, ...canonicalResponse(payload) }, { headers: { "Cache-Control": "private, no-store" } })
    if (!/^[a-f0-9]{64}$/.test(String(body.expectedStoreVersion || "")) || body.revision !== reference.revision) {
      throw new EventCalendarValidationError("Preview the current holiday changes before applying them.")
    }
    if (body.expectedStoreVersion !== getEventCalendarStoreVersion(payload)) throw new EventCalendarConflictError("The calendar changed after the preview. Review a fresh preview; no holiday changes were saved.", payload)
    const versions = getEventCalendarEventVersions(payload)
    const mutations: CalendarMutation[] = []
    if (plan.updates.length) mutations.push({ operation: "update", events: plan.updates, expectedEventVersions: versions })
    if (plan.removals.length) mutations.push({ operation: "delete", eventIds: plan.removals, expectedEventVersions: versions })
    if (plan.additions.length) mutations.push({ operation: "insert", events: plan.additions })
    const saved = mutations.length ? await mutateEventCalendarStoreBatch(supabase, mutations, body.expectedStoreVersion) : payload
    return NextResponse.json({ success: true, ...response, ...canonicalResponse(saved) }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) { return errorResponse(error) }
}
