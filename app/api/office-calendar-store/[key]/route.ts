import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import {
  getAdminSession,
  hasAdminPagePermission,
  type AdminSession,
} from "@/lib/adminAuth"
import {
  createAdminAuditContext,
  createAdminAuditedSupabaseClient,
} from "@/lib/adminAudit"
import {
  EventCalendarConflictError,
  EventCalendarValidationError,
  getEventCalendarEventVersions,
  getEventCalendarSettingVersions,
  getEventCalendarStoreVersion,
  mutateEventCalendarStore,
} from "@/lib/eventCalendarStore"
import { EVENT_CALENDAR_PROTOCOL_VERSION } from "@/lib/eventCalendarProtocol"
import { TASK_CALENDAR_PROTOCOL_VERSION, TaskCalendarValidationError, validateTaskCalendarTask } from "@/data/taskCalendar"
import { getTaskCalendarVersions, mutateTaskCalendarStore, TaskCalendarConflictError } from "@/lib/taskCalendarStore"
import { loadCalendarStaffDirectory, resolveCalendarStaffRecipients } from "@/lib/calendarStaff"

const allowedKeys = new Set(["event-calendar", "task-calendar", "enquiry-worksheet"])

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function getSupabaseClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
  )
}

async function getAccessSession(request: Request): Promise<AdminSession | null | false> {
  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get("authorization") === `Bearer ${secret}`) return null

  const session = await getAdminSession()
  return session.authenticated ? session : false
}

function normalizeKey(key: string) {
  if (!allowedKeys.has(key)) return null
  return key
}

function getPageId(storeKey: string) {
  if (storeKey === "event-calendar") return "event-calendar"
  if (storeKey === "task-calendar") return "task-calendar"
  return "enquiry-worksheet"
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map((item) => String(item || "").trim()).filter(Boolean)))
}

export async function GET(request: Request, context: { params: Promise<{ key: string }> }) {
  const session = await getAccessSession(request)
  if (session === false) {
    return NextResponse.json({ message: "Not authorized." }, { status: 401 })
  }

  const { key } = await context.params
  const storeKey = normalizeKey(key)
  if (!storeKey) return NextResponse.json({ message: "Unknown store key." }, { status: 404 })
  if (session && !hasAdminPagePermission(session, getPageId(storeKey), "view")) {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 })
  }

  try {
    const supabase = getSupabaseClient()
    const { data, error } = await supabase
      .from("office_calendar_store")
      .select("payload, updated_at")
      .eq("key", storeKey)
      .maybeSingle()

    if (error) throw error
    const payload = data?.payload || null
    return NextResponse.json({
      payload,
      updatedAt: data?.updated_at || null,
      ...(storeKey === "event-calendar" ? {
        protocolVersion: EVENT_CALENDAR_PROTOCOL_VERSION,
        eventVersions: getEventCalendarEventVersions(payload),
        settingVersions: getEventCalendarSettingVersions(payload),
        storeVersion: getEventCalendarStoreVersion(payload),
      } : {}),
      ...(storeKey === "task-calendar" ? {
        protocolVersion: TASK_CALENDAR_PROTOCOL_VERSION,
        taskVersions: getTaskCalendarVersions(payload),
        staff: await loadCalendarStaffDirectory(supabase),
      } : {}),
    })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Could not load shared calendar data." },
      { status: 500 }
    )
  }
}

export async function PUT(request: Request, context: { params: Promise<{ key: string }> }) {
  const session = await getAccessSession(request)
  if (session === false) {
    return NextResponse.json({ message: "Not authorized." }, { status: 401 })
  }

  const { key } = await context.params
  const storeKey = normalizeKey(key)
  if (!storeKey) return NextResponse.json({ message: "Unknown store key." }, { status: 404 })
  if (session && !hasAdminPagePermission(session, getPageId(storeKey), "edit")) {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 })
  }

  try {
    const payload = await request.json()
    const supabase = session
      ? createAdminAuditedSupabaseClient(
          createAdminAuditContext(session, request, storeKey),
          { useServiceRole: true }
        )
      : getSupabaseClient()

    // Every legacy Event Calendar PUT lacks per-record and per-setting base
    // versions. It cannot be merged safely, even when it appears to contain
    // settings only. Fail closed so an old tab never overwrites newer work or
    // reports success for a change that was intentionally discarded.
    if (storeKey === "event-calendar") {
      return NextResponse.json({
        code: "EVENT_CALENDAR_CLIENT_OUTDATED",
        message: "This Event Calendar tab is outdated. Nothing was saved. Refresh the page, then make the change again.",
        reloadRequired: true,
        protocolVersion: EVENT_CALENDAR_PROTOCOL_VERSION,
      }, { status: 409 })
    }

    if (storeKey === "task-calendar") {
      return NextResponse.json({
        code: "TASK_CALENDAR_CLIENT_OUTDATED",
        message: "This Task Calendar tab is outdated. Nothing was saved. Refresh the page, then make the change again.",
        reloadRequired: true,
        protocolVersion: TASK_CALENDAR_PROTOCOL_VERSION,
      }, { status: 409 })
    }

    const { error } = await supabase.from("office_calendar_store").upsert({
      key: storeKey,
      payload,
      updated_at: new Date().toISOString(),
    })

    if (error) throw error
    return NextResponse.json({ success: true, payload })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Could not save shared calendar data." },
      { status: 500 }
    )
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ key: string }> }) {
  const session = await getAccessSession(request)
  if (session === false) return NextResponse.json({ message: "Not authorized." }, { status: 401 })

  const { key } = await context.params
  const storeKey = normalizeKey(key)
  if (storeKey === "task-calendar") return patchTaskCalendar(request, session)
  if (storeKey !== "event-calendar") {
    return NextResponse.json({ message: "Atomic mutations are only available for Event Calendar." }, { status: 405 })
  }
  if (session && !hasAdminPagePermission(session, "event-calendar", "edit")) {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 })
  }

  try {
    const body = asRecord(await request.json())
    if (body.protocolVersion !== EVENT_CALENDAR_PROTOCOL_VERSION) {
      return NextResponse.json({
        code: "EVENT_CALENDAR_CLIENT_OUTDATED",
        message: "This Event Calendar tab is outdated. Nothing was saved. Refresh the page before making calendar changes.",
        reloadRequired: true,
        protocolVersion: EVENT_CALENDAR_PROTOCOL_VERSION,
      }, { status: 409 })
    }
    const operation = typeof body.operation === "string" ? body.operation : ""
    if (!['create', 'update', 'upsert', 'insert', 'delete', 'people', 'settings'].includes(operation)) {
      return NextResponse.json({ message: "Unknown Event Calendar mutation." }, { status: 400 })
    }

    const supabase = session
      ? createAdminAuditedSupabaseClient(
          createAdminAuditContext(session, request, storeKey),
          { useServiceRole: true },
        )
      : getSupabaseClient()
    const data = await mutateEventCalendarStore(supabase, {
      operation: operation as "create" | "update" | "upsert" | "insert" | "delete" | "people" | "settings",
      events: Array.isArray(body.events) ? body.events : [],
      eventIds: normalizeStringList(body.eventIds),
      expectedEventVersions: asRecord(body.expectedEventVersions),
      expectedSettingVersions: asRecord(body.expectedSettingVersions),
      settings: asRecord(body.settings),
    })
    return NextResponse.json({
      success: true,
      payload: data,
      protocolVersion: EVENT_CALENDAR_PROTOCOL_VERSION,
      eventVersions: getEventCalendarEventVersions(data),
      settingVersions: getEventCalendarSettingVersions(data),
      storeVersion: getEventCalendarStoreVersion(data),
    })
  } catch (error) {
    if (error instanceof EventCalendarConflictError) {
      return NextResponse.json({
        code: error.code,
        message: error.message,
        payload: error.payload,
        protocolVersion: EVENT_CALENDAR_PROTOCOL_VERSION,
        eventVersions: error.eventVersions,
        settingVersions: error.settingVersions,
        storeVersion: error.storeVersion,
      }, { status: 409 })
    }
    if (error instanceof EventCalendarValidationError) {
      return NextResponse.json({ code: error.code, message: error.message }, { status: 400 })
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Could not mutate Event Calendar." },
      { status: 500 },
    )
  }
}

async function patchTaskCalendar(request: Request, session: AdminSession | null) {
  if (session && !hasAdminPagePermission(session, "task-calendar", "edit")) return NextResponse.json({ message: "Forbidden" }, { status: 403 })
  try {
    const body = asRecord(await request.json())
    if (body.protocolVersion !== TASK_CALENDAR_PROTOCOL_VERSION) {
      return NextResponse.json({ code: "TASK_CALENDAR_CLIENT_OUTDATED", message: "This Task Calendar tab is outdated. Nothing was saved. Refresh the page and try again.", reloadRequired: true, protocolVersion: TASK_CALENDAR_PROTOCOL_VERSION }, { status: 409 })
    }
    const allowed = new Set(["protocolVersion", "operation", "task", "taskId", "expectedTaskVersion"])
    if (Object.keys(body).some((key) => !allowed.has(key)) || !["create", "update", "delete"].includes(String(body.operation))) throw new TaskCalendarValidationError("Unknown Task Calendar change.")
    const supabase = session
      ? createAdminAuditedSupabaseClient(createAdminAuditContext(session, request, "task-calendar"), { useServiceRole: true })
      : getSupabaseClient()
    if (body.operation !== "delete") {
      const task = validateTaskCalendarTask(body.task)
      const staff = await loadCalendarStaffDirectory(supabase)
      const { unresolved } = resolveCalendarStaffRecipients([...task.notify, ...task.cc], staff)
      if (unresolved.length) throw new TaskCalendarValidationError(`No confirmed email address for: ${unresolved.join(", ")}. Ask an administrator to update the staff directory before saving.`)
    }
    const payload = await mutateTaskCalendarStore(supabase, {
      operation: body.operation as "create" | "update" | "delete", task: body.task, taskId: body.taskId, expectedTaskVersion: body.expectedTaskVersion,
    })
    return NextResponse.json({ success: true, payload, protocolVersion: TASK_CALENDAR_PROTOCOL_VERSION, taskVersions: getTaskCalendarVersions(payload) })
  } catch (error) {
    if (error instanceof TaskCalendarConflictError) return NextResponse.json({ code: error.code, message: error.message, payload: error.payload, taskVersions: error.taskVersions, protocolVersion: TASK_CALENDAR_PROTOCOL_VERSION }, { status: 409 })
    if (error instanceof TaskCalendarValidationError || error instanceof SyntaxError) return NextResponse.json({ message: error.message }, { status: 400 })
    return NextResponse.json({ message: error instanceof Error ? error.message : "Could not save the task. Your draft is kept; please try again." }, { status: 500 })
  }
}
