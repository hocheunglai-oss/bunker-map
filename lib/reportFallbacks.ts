import { supabase } from "@/lib/supabase"
import { FALLBACK_REMARK_ID, type FallbackMap } from "@/lib/reportFallbackKeys"
import { parsePriceSetterFallbacks } from "@/lib/priceSetterSettings"

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

  if (error || data !== null && (!data || typeof data !== "object" || Array.isArray(data)
    || !Object.hasOwn(data, "content"))) throw new Error("Report settings could not be read.")
  return parsePriceSetterFallbacks(data === null ? null : data.content)
}
