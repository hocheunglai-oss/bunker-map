import { createClient } from "@supabase/supabase-js";
import {
  canAccessAdminPage,
  isAdminRole,
  normaliseAdminPagePermissions,
  type AdminPageDefinition,
  type AdminPagePermissionMap,
} from "@/lib/adminPages"
import {
  getAdminPageByPathFromPages,
  normaliseAdminPageDefinitions,
} from "@/lib/adminPageRegistry"

type StoredAuditActor = {
  username: string
  displayName?: string
  role?: string | null
  permissions?: AdminPagePermissionMap
  pages?: AdminPageDefinition[]
}

function getStoredAuditActor(): StoredAuditActor | null {
  if (typeof window === "undefined") return null

  try {
    const rawActor = window.localStorage.getItem("bunker_admin_actor")
    if (!rawActor) return null

    const actor = JSON.parse(rawActor) as Partial<StoredAuditActor>
    if (!actor.username) return null

    return {
      username: actor.username,
      displayName: actor.displayName || actor.username,
      role: actor.role || null,
      permissions: normaliseAdminPagePermissions(actor.permissions),
      pages: normaliseAdminPageDefinitions(actor.pages),
    }
  } catch {
    return null
  }
}

function getRequestMethod(input: RequestInfo | URL, init?: RequestInit) {
  if (init?.method) return init.method.toUpperCase()
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.method.toUpperCase()
  }

  return "GET"
}

function canEditCurrentAdminPage(actor: StoredAuditActor) {
  if (typeof window === "undefined") return true
  if (isAdminRole(actor.role)) return true

  const page = getAdminPageByPathFromPages(
    window.location.pathname,
    actor.pages
  )
  if (!page) return true

  return canAccessAdminPage(actor.permissions, page.id, "edit")
}

function getCurrentAuditPage(actor: StoredAuditActor) {
  if (typeof window === "undefined") return null

  const pathname = window.location.pathname
  if (!pathname.startsWith("/admin/")) return null

  const knownPage = getAdminPageByPathFromPages(pathname, actor.pages)
  if (knownPage) {
    return {
      id: knownPage.id,
      label: knownPage.label,
      path: pathname,
    }
  }

  const segment = pathname.split("/").filter(Boolean)[1]
  if (!segment) return null

  return {
    id: segment.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase(),
    label: segment
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[-_]+/g, " ")
      .trim()
      .toUpperCase(),
    path: pathname,
  }
}

function fetchWithAuditActor(input: RequestInfo | URL, init?: RequestInit) {
  const actor = getStoredAuditActor()

  if (!actor) {
    return fetch(input, init)
  }

  const method = getRequestMethod(input, init)
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !canEditCurrentAdminPage(actor)) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          message: "You have view-only access to this admin page.",
        }),
        {
          status: 403,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )
    )
  }

  const headers = new Headers(init?.headers)
  headers.set("x-bunker-admin-user", actor.username)
  headers.set("x-bunker-admin-display-name", actor.displayName || actor.username)

  if (actor.role) {
    headers.set("x-bunker-admin-role", actor.role)
  }

  const page = getCurrentAuditPage(actor)
  if (page) {
    headers.set("x-bunker-admin-page-id", page.id)
    headers.set("x-bunker-admin-page-label", page.label)
    headers.set("x-bunker-admin-page-path", page.path)
  }

  return fetch(input, {
    ...(init || {}),
    headers,
  })
}

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  {
    global: {
      fetch: fetchWithAuditActor,
    },
  }
);
