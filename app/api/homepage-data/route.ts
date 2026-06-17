import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { FALLBACK_REMARK_ID, type FallbackMap } from "@/lib/reportFallbackKeys"

export const dynamic = "force-dynamic"

const SUPABASE_TIMEOUT_MS = 8000

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS)

  return fetch(input, {
    ...(init || {}),
    cache: "no-store",
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout))
}

function getSupabaseClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      auth: {
        persistSession: false,
      },
      global: {
        fetch: fetchWithTimeout,
      },
    }
  )
}

function parseFallbackMap(content: string | null | undefined): FallbackMap {
  if (!content) return {}

  try {
    const parsed = JSON.parse(content) as FallbackMap
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

export async function GET() {
  try {
    const supabase = getSupabaseClient()

    const [portsResult, fallbackResult] = await Promise.all([
      supabase.from("ports").select("*"),
      supabase
        .from("remarks")
        .select("content")
        .eq("id", FALLBACK_REMARK_ID)
        .maybeSingle(),
    ])

    if (portsResult.error) {
      throw portsResult.error
    }

    return NextResponse.json(
      {
        ports: portsResult.data || [],
        fallbacks: fallbackResult.error
          ? {}
          : parseFallbackMap(fallbackResult.data?.content),
      },
      {
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      }
    )
  } catch (error) {
    console.error("Homepage data load failed", error)
    return NextResponse.json({ message: "Unable to load homepage data." }, { status: 502 })
  }
}
