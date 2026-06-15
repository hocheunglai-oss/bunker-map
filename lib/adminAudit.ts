import { createClient } from "@supabase/supabase-js"
import type { AdminSession } from "@/lib/adminAuth"
import {
  ADMIN_PAGE_DEFINITIONS,
  getAdminPageByPath,
} from "@/lib/adminPages"

export type AdminAuditContext = {
  username: string
  displayName: string
  role: string | null
  pageId: string
  pageLabel: string
  pagePath: string
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function titleFromSegment(segment: string) {
  return segment
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
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

  const knownPage =
    (pathname ? getAdminPageByPath(pathname) : null) ||
    ADMIN_PAGE_DEFINITIONS.find((page) => page.id === fallbackPageId)

  if (knownPage) {
    return {
      pageId: knownPage.id,
      pageLabel: knownPage.label,
      pagePath: pathname || knownPage.path,
    }
  }

  const segment =
    pathname.split("/").filter(Boolean)[1] ||
    fallbackPageId ||
    "other-admin-activity"

  return {
    pageId: segment.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase(),
    pageLabel: titleFromSegment(segment),
    pagePath: pathname || `/admin/${segment}`,
  }
}

export function createAdminAuditContext(
  session: AdminSession,
  request: Request | undefined,
  fallbackPageId: string
): AdminAuditContext {
  if (!session.username) throw new Error("Authenticated username is required.")

  return {
    username: session.username,
    displayName: session.displayName || session.username,
    role: session.role,
    ...pageFromRequest(request, fallbackPageId),
  }
}

export function createAdminAuditedSupabaseClient(
  context: AdminAuditContext,
  options: { useServiceRole?: boolean } = {}
) {
  const key =
    options.useServiceRole && process.env.SUPABASE_SERVICE_ROLE_KEY
      ? process.env.SUPABASE_SERVICE_ROLE_KEY
      : requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY")

  return createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), key, {
    global: {
      headers: {
        "x-bunker-admin-user": context.username,
        "x-bunker-admin-display-name": context.displayName,
        "x-bunker-admin-role": context.role || "",
        "x-bunker-admin-page-id": context.pageId,
        "x-bunker-admin-page-label": context.pageLabel,
        "x-bunker-admin-page-path": context.pagePath,
      },
    },
  })
}
