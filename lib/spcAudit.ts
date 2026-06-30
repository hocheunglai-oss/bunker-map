import { createClient } from "@supabase/supabase-js"
import type { SpcSession } from "@/lib/spcAuth"

export type SpcAuditContext = {
  username: string
  displayName: string
  role: string | null
  pageId: string
  pageLabel: string
  pagePath: string
}

const SPC_PAGE_LABELS: Record<string, string> = {
  "spc-buyer-enquiries": "SPC ENQUIRIES",
  "spc-fixtures": "SPC FIXTURES",
  "spc-lost-record": "SPC LOST RECORD",
  "spc-user-management": "SPC USER MANAGEMENT",
  "spc-audit-log": "SPC AUDIT LOG",
  "spc-system-health": "SPC SYSTEM HEALTH",
  "spc-tech-stack": "SPC TECH STACK",
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function pageFromRequest(request: Request | undefined, fallbackPageId: string) {
  const referer = request?.headers.get("referer")
  let pathname = ""

  if (referer) {
    try {
      pathname = new URL(referer).pathname
    } catch {
      pathname = ""
    }
  }

  return {
    pageId: fallbackPageId,
    pageLabel: SPC_PAGE_LABELS[fallbackPageId] || fallbackPageId.replace(/[-_]+/g, " ").toUpperCase(),
    pagePath: pathname || `/spc/${fallbackPageId.replace(/^spc-/, "")}`,
  }
}

export function createSpcAuditContext(
  session: SpcSession,
  request: Request | undefined,
  fallbackPageId: string,
): SpcAuditContext {
  if (!session.username) throw new Error("Authenticated username is required.")

  return {
    username: session.username,
    displayName: session.displayName || session.username,
    role: session.role,
    ...pageFromRequest(request, fallbackPageId),
  }
}

export function createSpcAuditedSupabaseClient(context: SpcAuditContext) {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for SPC actions.")
  }

  return createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), serviceRoleKey, {
    global: {
      headers: {
        "x-bunker-admin-user": `spc:${context.username}`,
        "x-bunker-admin-display-name": context.displayName,
        "x-bunker-admin-role": context.role || "",
        "x-bunker-admin-page-id": context.pageId,
        "x-bunker-admin-page-label": context.pageLabel,
        "x-bunker-admin-page-path": context.pagePath,
      },
    },
  })
}
