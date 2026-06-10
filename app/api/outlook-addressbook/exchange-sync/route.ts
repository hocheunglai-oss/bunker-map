import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getAdminSession } from "@/lib/adminAuth"

const STORE_KEY = "outlook-addressbook-exchange-sync"
const ACTIVE_SYNC_WINDOW_MS = 30 * 60 * 1000

type ExchangeSyncStatus = {
  status: "not_configured" | "queued" | "running" | "completed" | "failed"
  message: string
  requestedAt: string | null
  response?: unknown
}

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

async function requireAdminAccess() {
  const session = await getAdminSession()
  if (!session.authenticated) {
    throw new Error("Unauthorized")
  }
  return session
}

async function loadStatus(): Promise<ExchangeSyncStatus | null> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from("office_calendar_store")
    .select("payload")
    .eq("key", STORE_KEY)
    .maybeSingle()

  if (error) throw error
  return (data?.payload as ExchangeSyncStatus | null) || null
}

function isActiveSync(status: ExchangeSyncStatus | null) {
  if (!status || !["queued", "running"].includes(status.status)) return false
  const requestedAtMs = status.requestedAt ? Date.parse(status.requestedAt) : NaN
  return Number.isFinite(requestedAtMs) && Date.now() - requestedAtMs < ACTIVE_SYNC_WINDOW_MS
}

async function saveStatus(payload: ExchangeSyncStatus) {
  const supabase = getSupabaseClient()
  const { error } = await supabase.from("office_calendar_store").upsert({
    key: STORE_KEY,
    payload,
    updated_at: new Date().toISOString(),
  })
  if (error) throw error
}

export async function GET() {
  try {
    await requireAdminAccess()
    const webhookConfigured = Boolean(process.env.EXCHANGE_SYNC_WEBHOOK_URL)
    const status = await loadStatus()

    return NextResponse.json({
      webhookConfigured,
      status: status || {
        status: webhookConfigured ? "queued" : "not_configured",
        message: webhookConfigured ? "Exchange sync worker is configured." : "Exchange sync webhook is not configured.",
        requestedAt: null,
      },
    })
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
    }
    return NextResponse.json({ message: error instanceof Error ? error.message : "Could not load Exchange sync status." }, { status: 500 })
  }
}

export async function POST() {
  try {
    const session = await requireAdminAccess()
    const webhookUrl = process.env.EXCHANGE_SYNC_WEBHOOK_URL
    if (!webhookUrl) {
      return NextResponse.json({ message: "EXCHANGE_SYNC_WEBHOOK_URL is not configured." }, { status: 400 })
    }

    const currentStatus = await loadStatus()
    if (isActiveSync(currentStatus)) {
      return NextResponse.json({
        ...currentStatus,
        message: "Exchange sync is already queued or running. Wait for the current Azure Automation job to finish before starting another sync.",
      }, { status: 202 })
    }

    const requestedAt = new Date().toISOString()
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "fcuno-outlook-addressbook",
        syncMode: "incremental",
        requestedAt,
        requestedBy: session.displayName || session.username || "Admin",
        requestedByEmail: session.username?.includes("@") ? session.username : null,
      }),
    })
    const text = await response.text()
    let responseBody: unknown = text
    try {
      responseBody = text ? JSON.parse(text) : null
    } catch {
      responseBody = text
    }

    if (!response.ok) {
      const failedStatus: ExchangeSyncStatus = {
        status: "failed",
        message: `Exchange sync worker returned HTTP ${response.status}.`,
        requestedAt,
        response: responseBody,
      }
      await saveStatus(failedStatus)
      return NextResponse.json(failedStatus, { status: 502 })
    }

    const queuedStatus: ExchangeSyncStatus = {
      status: "queued",
      message: "Exchange sync has been queued. Azure Automation will update Exchange in the background.",
      requestedAt,
      response: responseBody,
    }
    await saveStatus(queuedStatus)
    return NextResponse.json(queuedStatus)
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
    }
    return NextResponse.json({ message: error instanceof Error ? error.message : "Could not trigger Exchange sync." }, { status: 500 })
  }
}
