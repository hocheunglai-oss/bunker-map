import { createClient } from "@supabase/supabase-js"

type OpenAiUsagePayload = {
  id?: unknown
  usage?: unknown
  output?: unknown
}

export type OpenAiUsageEvent = {
  pageId: string
  pagePath: string
  feature: string
  model: string
  httpStatus: number
  durationMs: number
  payload?: unknown
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export async function recordOpenAiUsage(event: OpenAiUsageEvent) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) return

  try {
    const payload = asRecord(event.payload) as OpenAiUsagePayload
    const usage = asRecord(payload.usage)
    const inputDetails = asRecord(usage.input_tokens_details)
    const outputDetails = asRecord(usage.output_tokens_details)
    const output = Array.isArray(payload.output) ? payload.output : []
    const webSearchCalls = output.filter((item) => asRecord(item).type === "web_search_call").length

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { error } = await supabase.from("openai_usage_events").insert({
      page_id: event.pageId,
      page_path: event.pagePath,
      feature: event.feature,
      api_endpoint: "responses",
      model: event.model,
      request_id: typeof payload.id === "string" ? payload.id : "",
      status: event.httpStatus >= 200 && event.httpStatus < 300 ? "success" : "error",
      http_status: event.httpStatus,
      input_tokens: nonNegativeInteger(usage.input_tokens),
      cached_input_tokens: nonNegativeInteger(inputDetails.cached_tokens),
      output_tokens: nonNegativeInteger(usage.output_tokens),
      reasoning_tokens: nonNegativeInteger(outputDetails.reasoning_tokens),
      total_tokens: nonNegativeInteger(usage.total_tokens),
      web_search_calls: webSearchCalls,
      duration_ms: nonNegativeInteger(event.durationMs),
      app_commit: process.env.VERCEL_GIT_COMMIT_SHA || "",
    })
    if (error) console.error("OpenAI usage tracking failed:", error.message)
  } catch (error) {
    console.error("OpenAI usage tracking failed:", error instanceof Error ? error.message : error)
  }
}
