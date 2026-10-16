import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { OPENAI_USAGE_DAYS, parseOpenAiUsageReport } from "@/lib/openAiUsageReport"

export const dynamic = "force-dynamic"
const headers = { "Cache-Control": "private, no-store" }

export async function GET(request: Request) {
  try {
    await requireAdminPagePermission("openai-usage", "view")
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unauthorized"
    return NextResponse.json({ message }, { status: message === "Unauthorized" ? 401 : 403, headers })
  }
  const daysParam = Number(new URL(request.url).searchParams.get("days"))
  const days = OPENAI_USAGE_DAYS.find(value => value === daysParam) ?? 30
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ message: "OpenAI usage is temporarily unavailable." }, { status: 503, headers })
  }
  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data, error } = await supabase.rpc("get_openai_usage_report", { p_days: days })
    if (error) throw new Error("Usage report unavailable")
    return NextResponse.json(parseOpenAiUsageReport(data, days), { headers })
  } catch {
    return NextResponse.json({ message: "OpenAI usage could not be verified. Please refresh." }, { status: 503, headers })
  }
}
