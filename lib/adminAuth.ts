import { cookies } from "next/headers"
import {
  canAccessAdminPage,
  getFullAdminPagePermissions,
  isAdminRole,
  normaliseAdminRole,
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

type ConfiguredAdminUser = {
  username: string
  password: string
  displayName?: string
  role?: string
  permissions?: AdminPagePermissionMap
}

export type AdminSession = {
  authenticated: boolean
  username: string | null
  displayName: string | null
  role: string | null
  permissions: AdminPagePermissionMap
  pages: AdminPageDefinition[]
}

function normaliseUsername(username: string) {
  return username.trim()
}

function isConfiguredAdminUser(value: unknown): value is ConfiguredAdminUser {
  if (!value || typeof value !== "object") return false

  const record = value as Record<string, unknown>
  return typeof record.username === "string" && typeof record.password === "string"
}

function parseAdminUsersFromJson(raw: string): ConfiguredAdminUser[] {
  const parsed = JSON.parse(raw) as unknown

  if (Array.isArray(parsed)) {
    return parsed.filter(isConfiguredAdminUser).map((user) => {
      const role = normaliseAdminRole(user.role)
      return {
        ...user,
        username: normaliseUsername(user.username),
        role,
        permissions:
          isAdminRole(role)
            ? getFullAdminPagePermissions()
            : normaliseAdminPagePermissions(user.permissions, "view"),
      }
    })
  }

  if (parsed && typeof parsed === "object") {
    const users: ConfiguredAdminUser[] = []

    Object.entries(parsed as Record<string, unknown>).forEach(([username, config]) => {
      if (typeof config === "string") {
        users.push({
          username: normaliseUsername(username),
          password: config,
          role: "ADMIN",
          permissions: getFullAdminPagePermissions(),
        })
        return
      }

      if (!config || typeof config !== "object") return

      const record = config as Record<string, unknown>
      if (typeof record.password !== "string") return

      const role = normaliseAdminRole(typeof record.role === "string" ? record.role : undefined)
      users.push({
        username: normaliseUsername(username),
        password: record.password,
        displayName:
          typeof record.displayName === "string" ? record.displayName : undefined,
        role,
        permissions:
          isAdminRole(role)
            ? getFullAdminPagePermissions()
            : normaliseAdminPagePermissions(record.permissions, "view"),
      })
    })

    return users.filter((user) => Boolean(user.username && user.password))
  }

  return []
}

function parseAdminUsersFromPairs(raw: string): ConfiguredAdminUser[] {
  const users: ConfiguredAdminUser[] = []

  raw
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const separatorIndex = pair.indexOf(":")
      if (separatorIndex === -1) return

      const username = normaliseUsername(pair.slice(0, separatorIndex))
      const password = pair.slice(separatorIndex + 1)
      if (!username || !password) return

      users.push({
        username,
        password,
        role: "ADMIN",
        permissions: getFullAdminPagePermissions(),
      })
    })

  return users
}

export function getConfiguredAdminUsers(): ConfiguredAdminUser[] {
  const configuredUsers = process.env.ADMIN_USERS?.trim()
  const users = configuredUsers
    ? configuredUsers.startsWith("[") || configuredUsers.startsWith("{")
      ? parseAdminUsersFromJson(configuredUsers)
      : parseAdminUsersFromPairs(configuredUsers)
    : []

  const legacyPassword = process.env.ADMIN_PASSWORD
  if (legacyPassword) {
    const legacyUsername = normaliseUsername(process.env.ADMIN_USERNAME || "admin")
    const alreadyConfigured = users.some((user) => user.username === legacyUsername)

    if (!alreadyConfigured) {
      users.push({
        username: legacyUsername,
        password: legacyPassword,
        displayName: legacyUsername,
        role: "ADMIN",
        permissions: getFullAdminPagePermissions(),
      })
    }
  }

  return users
}

function normaliseConfiguredAdminUser(
  user: ConfiguredAdminUser,
  pages: AdminPageDefinition[]
) {
  const role = normaliseAdminRole(user.role)

  return {
    username: user.username,
    displayName: user.displayName || user.username,
    role,
    permissions:
      isAdminRole(role)
        ? getFullAdminPagePermissions(pages)
        : normaliseAdminPagePermissions(user.permissions, "view", pages),
  }
}

export async function validateAdminCredentials(username: string, password: string) {
  const normalisedUsername = normaliseUsername(username)
  const pages = await getDiscoveredAdminPages()
  const databaseUser = await validateDatabaseAdminUser(
    normalisedUsername,
    password,
    pages
  )
  if (databaseUser) return { ...databaseUser, pages }

  const users = getConfiguredAdminUsers()

  if (users.length === 0) {
    throw new Error("Admin password is not configured.")
  }

  const configuredUser =
    users.find(
      (user) => user.username === normalisedUsername && user.password === password
    ) || null

  return configuredUser
    ? { ...normaliseConfiguredAdminUser(configuredUser, pages), pages }
    : null
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

  const username = cookieStore.get(ADMIN_USER_COOKIE_NAME)?.value || "admin"
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

  const username = cookieStore.get(ADMIN_USER_COOKIE_NAME)?.value || "admin"
  const databaseUser = await getDatabaseAdminUserByUsername(username, pages)

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

  const configuredUser = getConfiguredAdminUsers().find((user) => user.username === username)
  if (!configuredUser) {
    return {
      authenticated: false,
      username: null,
      displayName: null,
      role: null,
      permissions: normaliseAdminPagePermissions(null, "none", pages),
      pages,
    }
  }

  const normalisedUser = normaliseConfiguredAdminUser(configuredUser, pages)

  return {
    authenticated: true,
    username: normalisedUser.username,
    displayName: normalisedUser.displayName,
    role: normalisedUser.role,
    permissions: normalisedUser.permissions,
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
