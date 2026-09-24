import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { fcunoConnectionPolicy } from "@/config/fcunoConnections"
import vercelConfiguration from "@/vercel.json"

export const dynamic = "force-dynamic"

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
  "GEMINI_ADMIN_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_ADMIN_MODEL",
  "OPENAI_PARSER_MODEL",
  "OPENAI_IMO_LOOKUP_MODEL",
  "AI_PROVIDER",
  "EMAIL_NOTICE_FROM",
  "EXCHANGE_SMTP_HOST",
  "EXCHANGE_SMTP_PORT",
  "EXCHANGE_SMTP_USER",
  "EXCHANGE_SMTP_PASSWORD",
  "EVENT_CALENDAR_EMAIL_RECIPIENTS",
  "SYSTEM_HEALTH_EMAIL_RECIPIENTS",
  "CRON_SECRET",
  "DINGTALK_CLIENT_ID",
  "DINGTALK_CLIENT_SECRET",
  "FCUNO_OIDC_ENABLED",
  "FCUNO_FCOS_IDENTITY_SYNC_ENABLED",
  "FCUNO_OIDC_ISSUER",
  "FCUNO_OIDC_CLIENTS_JSON",
  "FCUNO_OIDC_ES256_CURRENT_PRIVATE_KEY",
  "FCUNO_OIDC_ES256_CURRENT_KID",
  "FCUNO_OIDC_ES256_NEXT_PRIVATE_KEY",
  "FCUNO_OIDC_ES256_NEXT_KID",
  "FCOS_IDENTITY_SYNC_URL",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_GRAPH_API_VERSION",
  "WHATSAPP_VERIFY_TOKEN",
  "SPC_WHATSAPP_LOGIN_MFA_ALL_ENABLED",
  "SPC_WHATSAPP_LOGIN_MFA_SECRET",
  "SPC_WHATSAPP_LOGIN_MFA_PHONE_NUMBER_ID",
  "SPC_WHATSAPP_LOGIN_MFA_DISALLOWED_PHONE_NUMBER_ID",
  "SPC_MOBILE_MODE_TEMPLATE_NAME",
  "SPC_MOBILE_ENQUIRY_TEMPLATE_LANGUAGE",
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
  "EXCHANGE_ADDRESSBOOK_DOMAIN",
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
    const explicitValue = process.env[name]?.trim() || ""
    const hasExplicitValue = Boolean(explicitValue)
    const isPlaceholder = /^(?:\[?redacted\]?|masked|\*+|<[^>]+>|(?:your|replace)[_-].*)$/i.test(explicitValue)
    const hasDefaultValue = Boolean(DEFAULTED_VERCEL_KEYS[name])

    return {
      name,
      configured: !isPlaceholder && (hasExplicitValue || hasDefaultValue),
      status: isPlaceholder ? "PLACEHOLDER — NOT VALIDATED"
        : hasExplicitValue ? "PRESENT — NOT VALIDATED"
          : hasDefaultValue ? "APP DEFAULT — NOT VALIDATED" : "NOT PRESENT",
      storage: hasExplicitValue ? "VERCEL ENVIRONMENT VARIABLES" : hasDefaultValue ? "APP DEFAULT" : "VERCEL ENVIRONMENT VARIABLES",
      value: "MASKED",
    }
  })

  const azure = AZURE_AUTOMATION_KEYS.map((name) => ({
    name,
    configured: null,
    status: "VERIFY IN AZURE",
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
    checkedAt: new Date().toISOString(),
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
        project: fcunoConnectionPolicy.vercel.project,
        productionUrl: fcunoConnectionPolicy.vercel.productionOrigins[0],
        gitRepository: fcunoConnectionPolicy.github.repository,
        environment: process.env.VERCEL_ENV || "unknown",
        branch: process.env.VERCEL_GIT_COMMIT_REF || "unknown",
        commit: process.env.VERCEL_GIT_COMMIT_SHA || "unknown",
        functionRegion: process.env.VERCEL_REGION || "unknown",
        configuredRegions: vercelConfiguration.regions,
      },
      verification: {
        responseTimeOnly: true,
        externalServices: "Not checked by this endpoint; dated audit records are shown separately.",
        environmentValues: "Presence only; credentials are not validated. Optional settings may be absent.",
      },
      schedules: vercelConfiguration.crons,
      databaseInventory,
      secrets: secretInventory(),
    }, { headers: { "Cache-Control": "private, no-store, max-age=0" } })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Could not load tech stack." },
      { status: 500 }
    )
  }
}
