import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { requireAdminPagePermission } from "@/lib/adminAuth"

const STORE_KEY = "outlook-addressbook-exchange-sync"
type ExchangeSyncStatus = {
  status: "not_configured" | "queued" | "running" | "completed" | "failed"
  message: string
  requestedAt: string | null
  response?: unknown
  lock?: {
    active: true
    syncMode: string
    heartbeatAt: string
    expiresAt: string
  }
}

type ExchangeSyncLock = {
  run_id: string
  sync_mode: string
  heartbeat_at: string
  expires_at: string
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function getSupabaseClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY")
  )
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

async function loadActiveSyncLock(): Promise<ExchangeSyncLock | null> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.rpc("get_active_outlook_exchange_sync_lock")

  if (error) throw error
  const rows = Array.isArray(data) ? data : []
  return (rows[0] as ExchangeSyncLock | undefined) || null
}

async function acquireSyncReservation(runId: string) {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.rpc("acquire_outlook_exchange_sync_lock", {
    p_run_id: runId,
    p_sync_mode: "incremental",
    p_lease_minutes: 30,
  })
  if (error) throw error
  return data === true
}

async function releaseSyncReservation(runId: string) {
  const supabase = getSupabaseClient()
  const { error } = await supabase.rpc("release_outlook_exchange_sync_lock", { p_run_id: runId })
  if (error) throw error
}

function getLockedSyncStatus(status: ExchangeSyncStatus | null, lock: ExchangeSyncLock): ExchangeSyncStatus {
  const syncMode = lock.sync_mode === "full" ? "full reconciliation" : "incremental sync"
  return {
    status: "running",
    message: `Exchange ${syncMode} is already running and holds the mutation lease. New FCUNO changes remain queued for the next incremental run.`,
    requestedAt: status?.requestedAt || null,
    response: {
      syncMode: lock.sync_mode,
      heartbeatAt: lock.heartbeat_at,
      leaseExpiresAt: lock.expires_at,
    },
    lock: {
      active: true,
      syncMode: lock.sync_mode,
      heartbeatAt: lock.heartbeat_at,
      expiresAt: lock.expires_at,
    },
  }
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
    await requireAdminPagePermission("outlook-addressbook", "view")
    const webhookConfigured = Boolean(process.env.EXCHANGE_SYNC_WEBHOOK_URL)
    const [status, activeLock] = await Promise.all([loadStatus(), loadActiveSyncLock()])

    return NextResponse.json({
      webhookConfigured,
      status: activeLock ? getLockedSyncStatus(status, activeLock) : status || {
        status: webhookConfigured ? "queued" : "not_configured",
        message: webhookConfigured ? "Exchange sync worker is configured." : "Exchange sync webhook is not configured.",
        requestedAt: null,
      },
    })
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 }
      )
    }
    return NextResponse.json({ message: error instanceof Error ? error.message : "Could not load Exchange sync status." }, { status: 500 })
  }
}

export async function POST() {
  let reservationId: string | null = null
  let reservationHeld = false
  try {
    const session = await requireAdminPagePermission("outlook-addressbook", "edit")
    const webhookUrl = process.env.EXCHANGE_SYNC_WEBHOOK_URL
    if (!webhookUrl) {
      return NextResponse.json({ message: "EXCHANGE_SYNC_WEBHOOK_URL is not configured." }, { status: 400 })
    }

    const currentStatus = await loadStatus()
    reservationId = crypto.randomUUID()
    reservationHeld = await acquireSyncReservation(reservationId)
    if (!reservationHeld) {
      const activeLock = await loadActiveSyncLock()
      if (activeLock) {
        return NextResponse.json(getLockedSyncStatus(currentStatus, activeLock), { status: 202 })
      }
      return NextResponse.json({
        status: "running",
        message: "Exchange sync is already acquiring or holding the mutation lease. New FCUNO changes remain queued for the next incremental run.",
        requestedAt: currentStatus?.requestedAt || null,
      }, { status: 202 })
    }

    const requestedAt = new Date().toISOString()
    const reservationLock = await loadActiveSyncLock()
    if (!reservationLock || reservationLock.run_id !== reservationId) {
      throw new Error("Exchange sync trigger reservation could not be verified.")
    }
    const queuedStatus: ExchangeSyncStatus = {
      status: "queued",
      message: "Exchange sync has been queued. Azure Automation will update Exchange in the background.",
      requestedAt,
      lock: {
        active: true,
        syncMode: "incremental",
        heartbeatAt: reservationLock.heartbeat_at,
        expiresAt: reservationLock.expires_at,
      },
    }
    await saveStatus(queuedStatus)

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "fcuno-outlook-addressbook",
        syncMode: "incremental",
        requestedAt,
        requestedBy: session.displayName || session.username || "Admin",
        requestedByEmail: session.username?.includes("@") ? session.username : null,
        reservationId,
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
      const helpText =
        response.status === 405
          ? "Azure Automation webhook returned HTTP 405 Method Not Allowed. EXCHANGE_SYNC_WEBHOOK_URL is not pointing to a valid Azure Automation webhook URL that accepts POST requests. Create a new Azure Automation webhook for the Exchange sync runbook, copy the webhook URL exactly, update EXCHANGE_SYNC_WEBHOOK_URL in Vercel, then redeploy."
          : response.status === 404
            ? "Azure Automation webhook returned HTTP 404. The webhook URL in Vercel is no longer valid, points to a missing webhook/runbook/account, or was copied incorrectly. Create a new Azure webhook, update EXCHANGE_SYNC_WEBHOOK_URL in Vercel, then redeploy."
            : response.status === 400
              ? "Azure Automation webhook returned HTTP 400. The webhook may be disabled, expired, or using an invalid token. Create a new Azure webhook, update EXCHANGE_SYNC_WEBHOOK_URL in Vercel, then redeploy."
              : `Exchange sync worker returned HTTP ${response.status}.`
      const failedStatus: ExchangeSyncStatus = {
        status: "failed",
        message: helpText,
        requestedAt,
        response: responseBody,
      }
      await releaseSyncReservation(reservationId)
      reservationHeld = false
      await saveStatus(failedStatus)
      return NextResponse.json(failedStatus, { status: 502 })
    }

    reservationHeld = false
    return NextResponse.json({ ...queuedStatus, response: responseBody })
  } catch (error) {
    if (reservationHeld && reservationId) {
      try {
        await releaseSyncReservation(reservationId)
      } catch (releaseError) {
        console.error("Could not release the failed Exchange sync trigger reservation", releaseError)
      }
    }
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 }
      )
    }
    return NextResponse.json({ message: error instanceof Error ? error.message : "Could not trigger Exchange sync." }, { status: 500 })
  }
}
