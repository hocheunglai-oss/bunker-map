import { supabase } from "@/lib/supabase"
import { FALLBACK_REMARK_ID, type FallbackMap } from "@/lib/reportFallbackKeys"

export {
  buildFallbackKey,
  type FallbackMap,
  type FallbackValue,
  type FuelKey,
} from "@/lib/reportFallbackKeys"

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
