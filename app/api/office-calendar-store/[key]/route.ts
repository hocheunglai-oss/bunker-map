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

function eventId(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ""
  const id = (value as { id?: unknown }).id
  return typeof id === "string" ? id.trim() : ""
}

function mergeEventCalendarPayload(currentPayload: unknown, incomingPayload: unknown) {
  const current = asRecord(currentPayload)
  const incoming = asRecord(incomingPayload)
  const deletedEventIds = new Set([
    ...normalizeStringList(current.deletedEventIds),
    ...normalizeStringList(incoming.deletedEventIds),
  ])
  const deletedRequiredSeedIds = new Set([
    ...normalizeStringList(current.deletedRequiredSeedIds),
    ...normalizeStringList(incoming.deletedRequiredSeedIds),
  ])
  const eventsById = new Map<string, unknown>()

  for (const event of Array.isArray(current.events) ? current.events : []) {
    const id = eventId(event)
    if (!id || deletedEventIds.has(id)) continue
    eventsById.set(id, event)
  }

  for (const event of Array.isArray(incoming.events) ? incoming.events : []) {
    const id = eventId(event)
    if (!id || deletedEventIds.has(id)) continue
    eventsById.set(id, event)
  }

  return {
    ...current,
    ...incoming,
    events: Array.from(eventsById.values()),
    deletedEventIds: Array.from(deletedEventIds),
    deletedRequiredSeedIds: Array.from(deletedRequiredSeedIds),
  }
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
    return NextResponse.json({ payload: data?.payload || null, updatedAt: data?.updated_at || null })
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
    let nextPayload = payload

    if (storeKey === "event-calendar") {
      const { data: currentRow, error: currentError } = await supabase
        .from("office_calendar_store")
        .select("payload")
        .eq("key", storeKey)
        .maybeSingle()

      if (currentError) throw currentError
      nextPayload = mergeEventCalendarPayload(currentRow?.payload || null, payload)
    }

    const { error } = await supabase.from("office_calendar_store").upsert({
      key: storeKey,
      payload: nextPayload,
      updated_at: new Date().toISOString(),
    })

    if (error) throw error
    return NextResponse.json({ success: true, payload: nextPayload })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Could not save shared calendar data." },
      { status: 500 }
    )
  }
}
