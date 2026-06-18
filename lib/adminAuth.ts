import { cookies } from "next/headers"
import {
  canAccessAdminPage,
  isAdminRole,
  normaliseAdminPagePermissions,
  type AdminPagePermissionMap,
  type AdminPageDefinition,
} from "@/lib/adminPages"
import { getDiscoveredAdminPages } from "@/lib/adminPageDiscovery"
import {
  getDatabaseAdminUserByUsername,
  validateDatabaseAdminUser,
} from "@/lib/adminUsers"

export const ADMIN_COOKIE_NAME = "bunker_admin_auth"
export const ADMIN_USER_COOKIE_NAME = "bunker_admin_user"

const ADMIN_COOKIE_MAX_AGE = 60 * 60 * 24 * 365
const ADMIN_USER_LOOKUP_CACHE_MS = 3000

export type AdminSession = {
  authenticated: boolean
  username: string | null
  displayName: string | null
  role: string | null
  permissions: AdminPagePermissionMap
  pages: AdminPageDefinition[]
}

type DatabaseAdminUser = Awaited<ReturnType<typeof getDatabaseAdminUserByUsername>>

const adminUserLookupCache = new Map<
  string,
  { user: DatabaseAdminUser; expiresAt: number }
>()
const adminUserLookupPromises = new Map<string, Promise<DatabaseAdminUser>>()

async function getCachedDatabaseAdminUser(
  username: string,
  pages: AdminPageDefinition[],
) {
  const cached = adminUserLookupCache.get(username)
  if (cached && cached.expiresAt > Date.now()) return cached.user

  const pending = adminUserLookupPromises.get(username)
  if (pending) return pending

  const lookup = getDatabaseAdminUserByUsername(username, pages)
    .then((user) => {
      adminUserLookupCache.set(username, {
        user,
        expiresAt: Date.now() + ADMIN_USER_LOOKUP_CACHE_MS,
      })
      return user
    })
    .finally(() => {
      adminUserLookupPromises.delete(username)
    })

  adminUserLookupPromises.set(username, lookup)
  return lookup
}

function normaliseUsername(username: string) {
  return username.trim()
}

export async function validateAdminCredentials(username: string, password: string) {
  const normalisedUsername = normaliseUsername(username)
  const pages = await getDiscoveredAdminPages()
  const databaseUser = await validateDatabaseAdminUser(normalisedUsername, password, pages)
  return databaseUser ? { ...databaseUser, pages } : null
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ADMIN_COOKIE_MAX_AGE,
  }
}

export async function setAdminSession(user: { username: string }) {
  const cookieStore = await cookies()
  cookieStore.set(ADMIN_COOKIE_NAME, "1", cookieOptions())
  cookieStore.set(ADMIN_USER_COOKIE_NAME, user.username, cookieOptions())
}

export async function refreshAdminSession() {
  const cookieStore = await cookies()
  const authenticated = cookieStore.get(ADMIN_COOKIE_NAME)?.value === "1"
  if (!authenticated) return

  const username = cookieStore.get(ADMIN_USER_COOKIE_NAME)?.value
  if (!username) {
    await clearAdminSession()
    return
  }

  cookieStore.set(ADMIN_COOKIE_NAME, "1", cookieOptions())
  cookieStore.set(ADMIN_USER_COOKIE_NAME, username, cookieOptions())
}

export async function clearAdminSession() {
  const cookieStore = await cookies()
  const options = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  }

  cookieStore.set(ADMIN_COOKIE_NAME, "", options)
  cookieStore.set(ADMIN_USER_COOKIE_NAME, "", options)
}

export async function getAdminSession(): Promise<AdminSession> {
  const cookieStore = await cookies()
  const authenticated = cookieStore.get(ADMIN_COOKIE_NAME)?.value === "1"
  const pages = await getDiscoveredAdminPages()

  if (!authenticated) {
    return {
      authenticated: false,
      username: null,
      displayName: null,
      role: null,
      permissions: normaliseAdminPagePermissions(null, "none", pages),
      pages,
    }
  }

  const username = cookieStore.get(ADMIN_USER_COOKIE_NAME)?.value
  if (!username) {
    await clearAdminSession()
    return {
      authenticated: false,
      username: null,
      displayName: null,
      role: null,
      permissions: normaliseAdminPagePermissions(null, "none", pages),
      pages,
    }
  }

  const databaseUser = await getCachedDatabaseAdminUser(username, pages)

  if (databaseUser) {
    return {
      authenticated: true,
      username: databaseUser.username,
      displayName: databaseUser.displayName,
      role: databaseUser.role,
      permissions: databaseUser.permissions,
      pages,
    }
  }

  await clearAdminSession()
  return {
    authenticated: false,
    username: null,
    displayName: null,
    role: null,
    permissions: normaliseAdminPagePermissions(null, "none", pages),
    pages,
  }
}

export async function requireAdminSession() {
  const session = await getAdminSession()

  if (!session.authenticated) {
    throw new Error("Unauthorized")
  }

  return session
}

export function hasAdminPagePermission(
  session: AdminSession,
  pageId: string,
  access: "view" | "edit" = "view"
) {
  if (!session.authenticated) return false
  if (isAdminRole(session.role)) return true

  return canAccessAdminPage(session.permissions, pageId, access)
}

export async function requireAdminPagePermission(
  pageId: string,
  access: "view" | "edit" = "view"
) {
  const session = await requireAdminSession()

  if (!hasAdminPagePermission(session, pageId, access)) {
    throw new Error("Forbidden")
  }

  return session
}
