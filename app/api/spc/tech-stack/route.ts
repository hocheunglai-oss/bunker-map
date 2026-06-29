import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"

const SPC_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_BUSINESS_ACCOUNT_ID",
  "WHATSAPP_TEMPLATE_BUSINESS_ACCOUNT_ID",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_GRAPH_API_VERSION",
] as const

function secretInventory() {
  return SPC_KEYS.map((name) => ({
    name,
    configured: Boolean(process.env[name]),
    storage: "VERCEL ENVIRONMENT VARIABLES",
    value: "MASKED",
  }))
}

export async function GET() {
  try {
    await requireSpcPagePermission("spc-tech-stack", "view")

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      deployment: {
        platform: "VERCEL",
        project: "bunker-map-c2ks",
        productionUrl: "https://spc.fcuno.com",
        gitRepository: "hocheunglai-oss/bunker-map",
        branch: process.env.VERCEL_GIT_COMMIT_REF || "main",
        commit: process.env.VERCEL_GIT_COMMIT_SHA || "unknown",
      },
      secrets: secretInventory(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load SPC tech stack."
    return NextResponse.json(
      { message },
      { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500 },
    )
  }
}
