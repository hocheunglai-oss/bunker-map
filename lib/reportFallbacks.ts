import { supabase } from "@/lib/supabase"

export type FuelKey = "hsfo" | "vlsfo" | "mgo"
export type FallbackValue = "-" | "NA" | "SE"
export type FallbackMap = Record<string, FallbackValue>

const FALLBACK_REMARK_ID = 105

export function buildFallbackKey(port: string, fuel: FuelKey) {
  return `${port.toLowerCase()}::${fuel}`
}

export async function loadReportFallbacks(): Promise<FallbackMap> {
  const { data, error } = await supabase
    .from("remarks")
    .select("content")
    .eq("id", FALLBACK_REMARK_ID)
    .maybeSingle()

  if (error || !data?.content) return {}

  try {
    const parsed = JSON.parse(data.content) as FallbackMap
    if (!parsed || typeof parsed !== "object") return {}
    return parsed
  } catch {
    return {}
  }
}

export async function saveReportFallbacks(fallbacks: FallbackMap) {
  return supabase.from("remarks").upsert({
    id: FALLBACK_REMARK_ID,
    content: JSON.stringify(fallbacks),
  })
}
