import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
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
  "GOOGLE_MEETING_CALENDAR_ID",
  "CARDDAV_ADDRESSBOOK_URL",
  "CARDDAV_USERNAME",
  "CARDDAV_PASSWORD",
  "EXCHANGE_SYNC_WEBHOOK_URL",
  "MICROSOFT_GRAPH_CLIENT_ID",
  "MICROSOFT_GRAPH_CLIENT_SECRET",
  "MICROSOFT_GRAPH_TENANT_ID",
  "MICROSOFT_GRAPH_REDIRECT_BASE_URL",
  "MICROSOFT_GRAPH_CONSENT_STATE",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_ADMIN_MODEL",
  "OPENAI_PARSER_MODEL",
  "AI_PROVIDER",
  "EMAIL_NOTICE_FROM",
  "EXCHANGE_SMTP_HOST",
  "EXCHANGE_SMTP_PORT",
  "EXCHANGE_SMTP_USER",
  "EXCHANGE_SMTP_PASSWORD",
  "EVENT_CALENDAR_EMAIL_RECIPIENTS",
  "SYSTEM_HEALTH_EMAIL_RECIPIENTS",
  "CRON_SECRET",
] as const

const DEFAULTED_VERCEL_KEYS: Partial<Record<(typeof VERCEL_KEYS)[number], string>> = {
  EMAIL_NOTICE_FROM: "FC Uno <info@cosulich.com.hk>",
  EXCHANGE_SMTP_HOST: "smtp.office365.com",
  EXCHANGE_SMTP_PORT: "587",
  EXCHANGE_SMTP_USER: "info@cosulich.com.hk",
}

const AZURE_AUTOMATION_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "EXCHANGE_APP_ID",
  "EXCHANGE_TENANT_ID",
  "EXCHANGE_ORGANIZATION",
  "EXCHANGE_CERT_PFX_BASE64",
  "EXCHANGE_CERT_PASSWORD",
  "EXCHANGE_ONLINE_MANAGEMENT_VERSION",
  "EXCHANGE_SYNC_NOTIFY_EMAILS",
  "EMAIL_NOTICE_FROM",
  "EXCHANGE_SMTP_HOST",
  "EXCHANGE_SMTP_PORT",
  "EXCHANGE_SMTP_USER",
  "EXCHANGE_SMTP_PASSWORD",
] as const

function secretInventory() {
  const vercel = VERCEL_KEYS.map((name) => {
    const hasExplicitValue = Boolean(process.env[name])
    const hasDefaultValue = Boolean(DEFAULTED_VERCEL_KEYS[name])

    return {
      name,
      configured: hasExplicitValue || hasDefaultValue,
      storage: hasExplicitValue ? "VERCEL ENVIRONMENT VARIABLES" : hasDefaultValue ? "APP DEFAULT" : "VERCEL ENVIRONMENT VARIABLES",
      value: "MASKED",
    }
  })

  const azure = AZURE_AUTOMATION_KEYS.map((name) => ({
    name,
    configured: null,
    storage: "AZURE AUTOMATION - VERIFY IN AZURE",
    value: "MASKED",
  }))

  return [...vercel, ...azure]
}

async function getDatabaseInventory() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase service configuration is incomplete.")
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await supabase.rpc("get_bunker_map_backup_inventory")
  if (error) throw new Error(`Could not load live database inventory: ${error.message}`)
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Live database inventory returned an invalid response.")
  }

  const inventory = data as {
    schema?: unknown
    migrationHead?: unknown
    tables?: unknown
  }
  if (
    inventory.schema !== "bunker-map.backup-inventory/v1" ||
    typeof inventory.migrationHead !== "string" ||
    !Array.isArray(inventory.tables) ||
    inventory.tables.some((table) => typeof table !== "string")
  ) {
    throw new Error("Live database inventory failed its schema contract.")
  }

  return {
    schema: inventory.schema,
    migrationHead: inventory.migrationHead,
    tables: [...inventory.tables].sort(),
  }
}

export async function GET() {
  try {
    await requireAdminPagePermission("tech-stack", "view")
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Could not load tech stack." },
      { status: 403 }
    )
  }

  try {
    const databaseInventory = await getDatabaseInventory()
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      deployment: {
        platform: "VERCEL",
        project: "bunker-map-c2ks",
        productionUrl: "https://fcuno.com",
        gitRepository: "hocheunglai-oss/bunker-map",
        branch: process.env.VERCEL_GIT_COMMIT_REF || "main",
        commit: process.env.VERCEL_GIT_COMMIT_SHA || "unknown",
        functionRegion: process.env.VERCEL_REGION || "bom1",
      },
      databaseInventory,
      secrets: secretInventory(),
    })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Could not load tech stack." },
      { status: 500 }
    )
  }
}
