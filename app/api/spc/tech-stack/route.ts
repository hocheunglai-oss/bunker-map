import { requireSpcPagePermission } from "@/lib/spcAuth"
import { spcPrivateJson } from "@/lib/spcResponse"
import { fcunoConnectionPolicy } from "@/config/fcunoConnections"

export const dynamic = "force-dynamic"

const SPC_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SPC_WHATSAPP_LOGIN_MFA_ALL_ENABLED",
  "SPC_WHATSAPP_LOGIN_MFA_SECRET",
  "SPC_WHATSAPP_LOGIN_MFA_PHONE_NUMBER_ID",
  "SPC_WHATSAPP_LOGIN_MFA_DISALLOWED_PHONE_NUMBER_ID",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_GRAPH_API_VERSION",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_DRIVE_REFRESH_TOKEN",
  "EMAIL_NOTICE_FROM",
  "EXCHANGE_SMTP_HOST",
  "EXCHANGE_SMTP_PORT",
  "EXCHANGE_SMTP_USER",
  "EXCHANGE_SMTP_PASSWORD",
] as const

function secretInventory() {
  return SPC_KEYS.map((name) => {
    const value = process.env[name]?.trim() || ""
    const placeholder = /^(?:\[?redacted\]?|masked|\*+|<[^>]+>|(?:your|replace)[_-].*)$/i.test(value)
    return {
      name, configured: Boolean(value) && !placeholder,
      status: placeholder ? "PLACEHOLDER — NOT VALIDATED" : value ? "PRESENT — NOT VALIDATED" : "NOT PRESENT",
      storage: "VERCEL ENVIRONMENT VARIABLES", value: "MASKED",
    }
  })
}

export async function GET() {
  try {
    await requireSpcPagePermission("spc-tech-stack", "view")

    return spcPrivateJson({
      generatedAt: new Date().toISOString(),
      deployment: {
        platform: "VERCEL",
        project: fcunoConnectionPolicy.vercel.project,
        productionUrl: fcunoConnectionPolicy.vercel.productionOrigins[1],
        gitRepository: fcunoConnectionPolicy.github.repository,
        branch: process.env.VERCEL_GIT_COMMIT_REF || "unknown",
        commit: process.env.VERCEL_GIT_COMMIT_SHA || "unknown",
      },
      secrets: secretInventory(),
      verification: { environmentValues: "Presence only; credentials and external services are not checked." },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load SPC tech stack."
    return spcPrivateJson(
      { message },
      { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500 },
    )
  }
}
