import { createClient } from "@supabase/supabase-js";
import {
  canAccessAdminPage,
  getAdminPageByPath,
  isAdminRole,
  normaliseAdminPagePermissions,
  type AdminPagePermissionMap,
} from "@/lib/adminPages"

type StoredAuditActor = {
  username: string
  displayName?: string
  role?: string | null
  permissions?: AdminPagePermissionMap
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

  const page = getAdminPageByPath(window.location.pathname)
  if (!page) return true

  return canAccessAdminPage(actor.permissions, page.id, "edit")
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
