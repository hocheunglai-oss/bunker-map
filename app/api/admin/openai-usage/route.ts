import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { requireAdminPagePermission } from "@/lib/adminAuth"

export const dynamic = "force-dynamic"

type UsageRow = {
  occurred_at: string
  page_id: string
  page_path: string
  feature: string
  model: string
  status: string
  input_tokens: number
  cached_input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  total_tokens: number
  web_search_calls: number
  duration_ms: number
}

function safeNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

export async function GET(request: Request) {
  try {
    await requireAdminPagePermission("openai-usage", "view")
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unauthorized"
    return NextResponse.json({ message }, { status: message === "Unauthorized" ? 401 : 403 })
  }

  const daysParam = Number(new URL(request.url).searchParams.get("days"))
  const days = [7, 30, 90].includes(daysParam) ? daysParam : 30
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ message: "Supabase service configuration is incomplete." }, { status: 503 })
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await supabase
    .from("openai_usage_events")
    .select("occurred_at,page_id,page_path,feature,model,status,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,total_tokens,web_search_calls,duration_ms")
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(10000)

  if (error) {
    return NextResponse.json({ message: `Could not load OpenAI usage: ${error.message}` }, { status: 500 })
  }

  const rows = (data || []) as UsageRow[]
  const totalTokens = rows.reduce((sum, row) => sum + safeNumber(row.total_tokens), 0)
  const groups = new Map<string, {
    pageId: string
    pagePath: string
    requests: number
    errors: number
    inputTokens: number
    cachedInputTokens: number
    outputTokens: number
    reasoningTokens: number
    totalTokens: number
    webSearchCalls: number
    durationMs: number
    features: Set<string>
    models: Set<string>
  }>()

  for (const row of rows) {
    const group = groups.get(row.page_id) || {
      pageId: row.page_id,
      pagePath: row.page_path,
      requests: 0,
      errors: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      webSearchCalls: 0,
      durationMs: 0,
      features: new Set<string>(),
      models: new Set<string>(),
    }
    group.requests += 1
    group.errors += row.status === "error" ? 1 : 0
    group.inputTokens += safeNumber(row.input_tokens)
    group.cachedInputTokens += safeNumber(row.cached_input_tokens)
    group.outputTokens += safeNumber(row.output_tokens)
    group.reasoningTokens += safeNumber(row.reasoning_tokens)
    group.totalTokens += safeNumber(row.total_tokens)
    group.webSearchCalls += safeNumber(row.web_search_calls)
    group.durationMs += safeNumber(row.duration_ms)
    if (row.feature) group.features.add(row.feature)
    if (row.model) group.models.add(row.model)
    groups.set(row.page_id, group)
  }

  const pages = [...groups.values()]
    .map((group) => ({
      ...group,
      tokenPercentage: totalTokens ? group.totalTokens / totalTokens * 100 : 0,
      requestPercentage: rows.length ? group.requests / rows.length * 100 : 0,
      averageDurationMs: group.requests ? Math.round(group.durationMs / group.requests) : 0,
      features: [...group.features].sort(),
      models: [...group.models].sort(),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens)

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    since,
    days,
    totals: {
      requests: rows.length,
      errors: rows.filter((row) => row.status === "error").length,
      inputTokens: rows.reduce((sum, row) => sum + safeNumber(row.input_tokens), 0),
      cachedInputTokens: rows.reduce((sum, row) => sum + safeNumber(row.cached_input_tokens), 0),
      outputTokens: rows.reduce((sum, row) => sum + safeNumber(row.output_tokens), 0),
      reasoningTokens: rows.reduce((sum, row) => sum + safeNumber(row.reasoning_tokens), 0),
      totalTokens,
      webSearchCalls: rows.reduce((sum, row) => sum + safeNumber(row.web_search_calls), 0),
    },
    pages,
    recent: rows.slice(0, 20),
  })
}
