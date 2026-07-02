import { unstable_cache } from "next/cache"
import { createClient } from "@supabase/supabase-js"
import { FALLBACK_REMARK_ID, type FallbackMap } from "@/lib/reportFallbackKeys"
import type { HongKongReportRow } from "@/lib/hongKongReport"
import type { TaiwanReportRow } from "@/lib/taiwanReport"
import type { ChinaReportSection } from "@/lib/chinaReport"

export const PUBLIC_MARKET_DATA_REVALIDATE_SECONDS = 120
export const PUBLIC_MARKET_DATA_STALE_SECONDS = 600

const SUPABASE_TIMEOUT_MS = 8000

const HOMEPAGE_PORT_COLUMNS = [
  "id",
  "name",
  "type",
  "lat",
  "lng",
  "hsfo",
  "vlsfo",
  "mgo",
  "hsfo_formula",
  "vlsfo_formula",
  "mgo_formula",
  "updated_at",
].join(",")

export type PublicPort = {
  id: number
  name: string
  type?: string | null
  lat: number | null
  lng: number | null
  hsfo: number | null
  vlsfo: number | null
  mgo: number | null
  hsfo_formula?: string | null
  vlsfo_formula?: string | null
  mgo_formula?: string | null
  recorded_at?: string | null
  updated_at?: string | null
  date?: string | null
}

export type ReportSnapshotKey = "taiwan" | "hongkong" | "china" | "compact"

export type TaiwanReportSnapshot = {
  reportDate: string
  rows: TaiwanReportRow[]
  remark: string
}

export type HongKongReportSnapshot = {
  reportDate: string
  rows: HongKongReportRow[]
}

export type SectionReportSnapshot = {
  reportDate: string
  sections: ChinaReportSection[]
}

export type PublicReportPayload =
  | {
      key: "taiwan"
      snapshot: TaiwanReportSnapshot | null
      fallbacks: FallbackMap
      specialNotice: string
    }
  | {
      key: "hongkong"
      snapshot: HongKongReportSnapshot | null
      fallbacks: FallbackMap
    }
  | {
      key: "china"
      snapshot: SectionReportSnapshot | null
      fallbacks: FallbackMap
    }
  | {
      key: "compact"
      snapshot: SectionReportSnapshot | null
      fallbacks: FallbackMap
    }

export type PublicReportPayloadByKey = {
  taiwan: Extract<PublicReportPayload, { key: "taiwan" }>
  hongkong: Extract<PublicReportPayload, { key: "hongkong" }>
  china: Extract<PublicReportPayload, { key: "china" }>
  compact: Extract<PublicReportPayload, { key: "compact" }>
}

export type HomepageMarketData = {
  ports: PublicPort[]
  fallbacks: FallbackMap
}

const REPORT_SNAPSHOT_IDS: Record<ReportSnapshotKey, number> = {
  taiwan: 101,
  hongkong: 102,
  china: 103,
  compact: 104,
}

export const REPORT_KEYS = Object.keys(REPORT_SNAPSHOT_IDS) as ReportSnapshotKey[]

type PublicSupabaseClient = ReturnType<typeof createClient<any>>

let cachedSupabaseClient: PublicSupabaseClient | null = null

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
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout))
}

function getSupabaseClient() {
  if (!cachedSupabaseClient) {
    cachedSupabaseClient = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
      {
        auth: {
          persistSession: false,
        },
        global: {
          fetch: fetchWithTimeout,
        },
      },
    )
  }

  return cachedSupabaseClient
}

function parseJson<T>(content: string | null | undefined): T | null {
  if (!content) return null

  try {
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

function parseFallbackMap(content: string | null | undefined): FallbackMap {
  const parsed = parseJson<FallbackMap>(content)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  return parsed
}

export function isReportSnapshotKey(key: string): key is ReportSnapshotKey {
  return Object.prototype.hasOwnProperty.call(REPORT_SNAPSHOT_IDS, key)
}

async function loadHomepageMarketData(): Promise<HomepageMarketData> {
  const supabase = getSupabaseClient()
  const [portsResult, fallbackResult] = await Promise.all([
    supabase.from("ports").select(HOMEPAGE_PORT_COLUMNS).order("id", { ascending: true }),
    supabase
      .from("remarks")
      .select("content")
      .eq("id", FALLBACK_REMARK_ID)
      .maybeSingle(),
  ])

  if (portsResult.error) throw portsResult.error

  return {
    ports: (portsResult.data || []) as unknown as PublicPort[],
    fallbacks: fallbackResult.error ? {} : parseFallbackMap(fallbackResult.data?.content),
  }
}

async function loadReportData(key: ReportSnapshotKey): Promise<PublicReportPayload> {
  const supabase = getSupabaseClient()
  const ids = key === "taiwan"
    ? [REPORT_SNAPSHOT_IDS[key], FALLBACK_REMARK_ID, 2]
    : [REPORT_SNAPSHOT_IDS[key], FALLBACK_REMARK_ID]

  const { data, error } = await supabase
    .from("remarks")
    .select("id,content")
    .in("id", ids)

  if (error) throw error

  const contentById = new Map(
    (data || []).map((row) => [Number(row.id), typeof row.content === "string" ? row.content : ""] as const),
  )
  const fallbacks = parseFallbackMap(contentById.get(FALLBACK_REMARK_ID))

  if (key === "taiwan") {
    return {
      key,
      snapshot: parseJson<TaiwanReportSnapshot>(contentById.get(REPORT_SNAPSHOT_IDS[key])),
      fallbacks,
      specialNotice: contentById.get(2) || "",
    }
  }

  if (key === "hongkong") {
    return {
      key,
      snapshot: parseJson<HongKongReportSnapshot>(contentById.get(REPORT_SNAPSHOT_IDS[key])),
      fallbacks,
    }
  }

  if (key === "china") {
    return {
      key,
      snapshot: parseJson<SectionReportSnapshot>(contentById.get(REPORT_SNAPSHOT_IDS[key])),
      fallbacks,
    }
  }

  return {
    key,
    snapshot: parseJson<SectionReportSnapshot>(contentById.get(REPORT_SNAPSHOT_IDS[key])),
    fallbacks,
  }
}

const getCachedHomepageMarketData = unstable_cache(
  loadHomepageMarketData,
  ["public-homepage-market-data-v1"],
  { revalidate: PUBLIC_MARKET_DATA_REVALIDATE_SECONDS },
)

const getCachedReportData = unstable_cache(
  async (key: ReportSnapshotKey) => loadReportData(key),
  ["public-report-data-v1"],
  { revalidate: PUBLIC_MARKET_DATA_REVALIDATE_SECONDS },
)

export function getHomepageMarketData() {
  return getCachedHomepageMarketData()
}

export function getPublicReportData<Key extends ReportSnapshotKey>(key: Key) {
  return getCachedReportData(key) as Promise<PublicReportPayloadByKey[Key]>
}

export function publicMarketCacheHeaders() {
  const sharedCacheControl = `public, s-maxage=${PUBLIC_MARKET_DATA_REVALIDATE_SECONDS}, stale-while-revalidate=${PUBLIC_MARKET_DATA_STALE_SECONDS}`

  return {
    "Cache-Control": `public, max-age=0, s-maxage=${PUBLIC_MARKET_DATA_REVALIDATE_SECONDS}, stale-while-revalidate=${PUBLIC_MARKET_DATA_STALE_SECONDS}`,
    "CDN-Cache-Control": sharedCacheControl,
    "Vercel-CDN-Cache-Control": sharedCacheControl,
  }
}
