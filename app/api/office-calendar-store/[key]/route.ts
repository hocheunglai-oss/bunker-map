import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const ADMIN_COOKIE_NAME = "bunker_admin_auth"
const allowedKeys = new Set(["event-calendar", "task-calendar"])

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

async function hasAdminAccess(request: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get("authorization") === `Bearer ${secret}`) return true

  const cookieStore = await cookies()
  return cookieStore.get(ADMIN_COOKIE_NAME)?.value === "1"
}

function normalizeKey(key: string) {
  if (!allowedKeys.has(key)) return null
  return key
}

export async function GET(request: Request, context: { params: Promise<{ key: string }> }) {
  if (!(await hasAdminAccess(request))) {
    return NextResponse.json({ message: "Not authorized." }, { status: 401 })
  }

  const { key } = await context.params
  const storeKey = normalizeKey(key)
  if (!storeKey) return NextResponse.json({ message: "Unknown store key." }, { status: 404 })

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
  if (!(await hasAdminAccess(request))) {
    return NextResponse.json({ message: "Not authorized." }, { status: 401 })
  }

  const { key } = await context.params
  const storeKey = normalizeKey(key)
  if (!storeKey) return NextResponse.json({ message: "Unknown store key." }, { status: 404 })

  try {
    const payload = await request.json()
    const supabase = getSupabaseClient()
    const { error } = await supabase.from("office_calendar_store").upsert({
      key: storeKey,
      payload,
      updated_at: new Date().toISOString(),
    })

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Could not save shared calendar data." },
      { status: 500 }
    )
  }
}
