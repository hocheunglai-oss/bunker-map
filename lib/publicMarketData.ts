import { unstable_cache } from "next/cache"
import { createClient } from "@supabase/supabase-js"
import { FALLBACK_REMARK_ID, type FallbackMap } from "@/lib/reportFallbackKeys"
import {
  emptyTaiwanOperationalNotice,
  TAIWAN_OPERATIONAL_NOTICE_REMARK_ID,
  type TaiwanOperationalNotice,
} from "@/lib/taiwanOperationalNotice"
import type { HongKongReportRow } from "@/lib/hongKongReport"
import type { TaiwanReportRow } from "@/lib/taiwanReport"
import type { ChinaReportSection } from "@/lib/chinaReport"
import { parsePublicReportJson, readPublicOperationalNotice, validatePublicFallbacks, validatePublicReportSnapshot } from "@/lib/publicReportValidation"

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

export type PublicReportPayload = (
  | {
      key: "taiwan"
      snapshot: TaiwanReportSnapshot | null
      fallbacks: FallbackMap
      specialNotice: string
      operationalNotice: TaiwanOperationalNotice
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
  ) & { unavailable?: boolean }

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
  if (fallbackResult.error) throw fallbackResult.error
  if (!Array.isArray(portsResult.data)
    || fallbackResult.data !== null && (typeof fallbackResult.data !== "object" || Array.isArray(fallbackResult.data)
      || !Object.hasOwn(fallbackResult.data, "content")
      || fallbackResult.data.content !== null && typeof fallbackResult.data.content !== "string")) {
    throw Error("Public homepage read was incomplete")
  }
  // A confirmed absent/empty setting remains empty. An unreadable or damaged
  // setting must not become a cacheable success with different price markers.
  const fallbackValue = parsePublicReportJson(fallbackResult.data?.content)
  const fallbacks = fallbackValue === null ? {} : validatePublicFallbacks(fallbackValue)

  return {
    ports: portsResult.data as unknown as PublicPort[],
    fallbacks,
  }
}

async function loadReportData(key: ReportSnapshotKey): Promise<PublicReportPayload> {
  const supabase = getSupabaseClient()
  const ids = key === "taiwan"
    ? [REPORT_SNAPSHOT_IDS[key], FALLBACK_REMARK_ID, 2, TAIWAN_OPERATIONAL_NOTICE_REMARK_ID]
    : [REPORT_SNAPSHOT_IDS[key], FALLBACK_REMARK_ID]

  const { data, error } = await supabase
    .from("remarks")
    .select("id,content")
    .in("id", ids)

  if (error) throw error

  if (!Array.isArray(data)) throw Error("Public report read was incomplete")
  const contentById = new Map<number, string | null>()
  for (const row of data) {
    if (!row || !Number.isInteger(row.id) || !ids.includes(row.id) || contentById.has(row.id)
      || row.content !== null && typeof row.content !== "string") throw Error("Public report read was incomplete")
    contentById.set(row.id, row.content)
  }
  const fallbackValue = parsePublicReportJson(contentById.get(FALLBACK_REMARK_ID))
  const fallbacks = fallbackValue === null ? {} : validatePublicFallbacks(fallbackValue)
  const value = parsePublicReportJson(contentById.get(REPORT_SNAPSHOT_IDS[key]))
  const snapshot = value === null ? null : validatePublicReportSnapshot(value, key)

  if (key === "taiwan") {
    return {
      key,
      snapshot: snapshot as TaiwanReportSnapshot | null,
      fallbacks,
      specialNotice: contentById.get(2) || "",
      operationalNotice: readPublicOperationalNotice(contentById.get(TAIWAN_OPERATIONAL_NOTICE_REMARK_ID)),
    }
  }

  if (key === "hongkong") {
    return {
      key,
      snapshot: snapshot as HongKongReportSnapshot | null,
      fallbacks,
    }
  }

  if (key === "china") {
    return {
      key,
      snapshot: snapshot as SectionReportSnapshot | null,
      fallbacks,
    }
  }

  return {
    key,
    snapshot: snapshot as SectionReportSnapshot | null,
    fallbacks,
  }
}

const getCachedHomepageMarketData = unstable_cache(
  loadHomepageMarketData,
  ["public-homepage-market-data-v1"],
  { revalidate: PUBLIC_MARKET_DATA_REVALIDATE_SECONDS },
)

export function getHomepageMarketData() {
  return getCachedHomepageMarketData()
}

export function getPublicReportData<Key extends ReportSnapshotKey>(key: Key) {
  // Reports are small, already-computed publication records. Read all reports
  // authoritatively, as HK/Taiwan already did: a second TTL/SWR cache could
  // return an older publication even after publishing has been confirmed.
  // Keep the independent, larger homepage dataset cached separately.
  return loadReportData(key) as Promise<PublicReportPayloadByKey[Key]>
}

export function getEmptyPublicReportData<Key extends ReportSnapshotKey>(
  key: Key,
): PublicReportPayloadByKey[Key] {
  if (key === "taiwan") {
    return {
      key,
      snapshot: null,
      fallbacks: {},
      specialNotice: "",
      operationalNotice: emptyTaiwanOperationalNotice,
      unavailable: true,
    } as PublicReportPayloadByKey[Key]
  }

  return {
    key,
    snapshot: null,
    fallbacks: {},
    unavailable: true,
  } as PublicReportPayloadByKey[Key]
}

export function publicMarketCacheHeaders() {
  const sharedCacheControl = `public, s-maxage=${PUBLIC_MARKET_DATA_REVALIDATE_SECONDS}, stale-while-revalidate=${PUBLIC_MARKET_DATA_STALE_SECONDS}`

  return {
    "Cache-Control": `public, max-age=0, s-maxage=${PUBLIC_MARKET_DATA_REVALIDATE_SECONDS}, stale-while-revalidate=${PUBLIC_MARKET_DATA_STALE_SECONDS}`,
    "CDN-Cache-Control": sharedCacheControl,
    "Vercel-CDN-Cache-Control": sharedCacheControl,
  }
}
