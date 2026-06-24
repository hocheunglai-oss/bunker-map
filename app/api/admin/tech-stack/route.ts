import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"

const VERCEL_KEYS = [
  "ADMIN_USERNAME",
  "ADMIN_PASSWORD",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_MAPTILER_KEY",
  "NEXT_PUBLIC_MAPTILER_STYLE",
  "NEXT_PUBLIC_SITE_URL",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REDIRECT_URI",
  "GOOGLE_DRIVE_REFRESH_TOKEN",
  "GOOGLE_DRIVE_COMPANY_FOLDER_ID",
  "GOOGLE_DRIVE_BACKUP_FOLDER_ID",
  "GOOGLE_DRIVE_SHARED_DRIVE_ID",
  "GOOGLE_OAUTH_REFRESH_TOKEN",
  "GOOGLE_CALENDAR_REFRESH_TOKEN",
  "GOOGLE_CALENDAR_ID",
  "CARDDAV_ADDRESSBOOK_URL",
  "CARDDAV_USERNAME",
  "CARDDAV_PASSWORD",
  "EXCHANGE_SYNC_WEBHOOK_URL",
  "EXCHANGE_APP_ID",
  "EXCHANGE_TENANT_ID",
  "EXCHANGE_ORGANIZATION",
  "EXCHANGE_CERT_PFX_BASE64",
  "EXCHANGE_CERT_PASSWORD",
  "MICROSOFT_GRAPH_CLIENT_ID",
  "MICROSOFT_GRAPH_CLIENT_SECRET",
  "MICROSOFT_GRAPH_TENANT_ID",
  "MICROSOFT_GRAPH_REDIRECT_BASE_URL",
  "MICROSOFT_GRAPH_CONSENT_STATE",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_BUSINESS_ACCOUNT_ID",
  "WHATSAPP_TEMPLATE_BUSINESS_ACCOUNT_ID",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_GRAPH_API_VERSION",
  "GEMINI_API_KEY",
  "RESEND_API_KEY",
  "EVENT_CALENDAR_EMAIL_FROM",
  "EVENT_CALENDAR_EMAIL_RECIPIENTS",
  "SYSTEM_HEALTH_EMAIL_RECIPIENTS",
  "CRON_SECRET",
] as const

function secretInventory() {
  return VERCEL_KEYS.map((name) => ({
    name,
    configured: Boolean(process.env[name]),
    storage: "VERCEL ENVIRONMENT VARIABLES",
    value: "MASKED",
  }))
}

export async function GET() {
  try {
    await requireAdminPagePermission("tech-stack", "view")

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      deployment: {
        platform: "VERCEL",
        project: "bunker-map-c2ks",
        productionUrl: "https://fcuno.com",
        gitRepository: "hocheunglai-oss/bunker-map",
        branch: process.env.VERCEL_GIT_COMMIT_REF || "main",
        commit: process.env.VERCEL_GIT_COMMIT_SHA || "unknown",
      },
      secrets: secretInventory(),
    })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Could not load tech stack." },
      { status: 403 }
    )
  }
}
