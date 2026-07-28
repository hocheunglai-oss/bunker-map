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
  getDatabaseAdminUserByIdStrict,
  validateDatabaseAdminUser,
  validateDatabaseAdminUserStrict,
} from "@/lib/adminUsers"
import {
  ADMIN_SESSION_DURATION_SECONDS,
  OUTLOOK_ADDIN_SESSION_DURATION_SECONDS,
  createDatabaseAdminSession,
  getDatabaseAdminSession,
  revokeDatabaseAdminSession,
} from "@/lib/adminSessions"

export const ADMIN_COOKIE_NAME = "bunker_admin_auth"
export const ADMIN_USER_COOKIE_NAME = "bunker_admin_user"

export type AdminSession = {
  authenticated: boolean
  resetRequired: boolean
  username: string | null
  displayName: string | null
  role: string | null
  permissions: AdminPagePermissionMap
  pages: AdminPageDefinition[]
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

export async function validateOutlookAddinCredentials(
  username: string,
  password: string,
) {
  const normalisedUsername = normaliseUsername(username)
  const pages = await getDiscoveredAdminPages()
  const databaseUser = await validateDatabaseAdminUserStrict(
    normalisedUsername,
    password,
    pages,
  )
  return databaseUser ? { ...databaseUser, pages } : null
}

function cookieOptions(expiresAt?: string) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ADMIN_SESSION_DURATION_SECONDS,
    ...(expiresAt ? { expires: new Date(expiresAt) } : {}),
  }
}

function expiredCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  }
}

async function clearAdminCookies() {
  const cookieStore = await cookies()
  const options = expiredCookieOptions()
  cookieStore.set(ADMIN_COOKIE_NAME, "", options)
  cookieStore.set(ADMIN_USER_COOKIE_NAME, "", options)
}

export async function setAdminSession(user: {
  id: string
  credentialUpdatedAt: string
}) {
  const session = await createDatabaseAdminSession(
    user.id,
    user.credentialUpdatedAt,
  )
  const cookieStore = await cookies()
  cookieStore.set(
    ADMIN_COOKIE_NAME,
    session.token,
    cookieOptions(session.expiresAt),
  )
  cookieStore.set(ADMIN_USER_COOKIE_NAME, "", expiredCookieOptions())
}

export async function clearAdminSession() {
  const cookieStore = await cookies()
  const token = cookieStore.get(ADMIN_COOKIE_NAME)?.value

  if (token) await revokeDatabaseAdminSession(token)
  await clearAdminCookies()
}

function unauthenticatedSession(
  pages: AdminPageDefinition[],
): AdminSession {
  return {
    authenticated: false,
    resetRequired: false,
    username: null,
    displayName: null,
    role: null,
    permissions: normaliseAdminPagePermissions(null, "none", pages),
    pages,
  }
}

type ResolvedAdminSession = {
  publicSession: AdminSession
  adminUserId: string | null
  sessionId: string | null
  expiresAt: string | null
}

function unresolvedAdminSession(
  pages: AdminPageDefinition[],
): ResolvedAdminSession {
  return {
    publicSession: unauthenticatedSession(pages),
    adminUserId: null,
    sessionId: null,
    expiresAt: null,
  }
}

async function resolveAdminSessionToken(
  token: string,
  pages: AdminPageDefinition[],
): Promise<ResolvedAdminSession> {
  const databaseSession = await getDatabaseAdminSession(token)
  if (!databaseSession) {
    return unresolvedAdminSession(pages)
  }

  const databaseUser = await getDatabaseAdminUserByIdStrict(
    databaseSession.adminUserId,
    pages,
  )
  if (!databaseUser) {
    await revokeDatabaseAdminSession(token)
    return unresolvedAdminSession(pages)
  }

  return {
    publicSession: {
      authenticated: true,
      resetRequired: databaseUser.passwordResetRequired,
      username: databaseUser.username,
      displayName: databaseUser.displayName,
      role: databaseUser.role,
      permissions: databaseUser.permissions,
      pages,
    },
    adminUserId: databaseUser.id,
    sessionId: databaseSession.id,
    expiresAt: databaseSession.expiresAt,
  }
}

async function resolveAdminSession(): Promise<ResolvedAdminSession> {
  const pages = await getDiscoveredAdminPages()
  const cookieStore = await cookies()
  const token = cookieStore.get(ADMIN_COOKIE_NAME)?.value

  if (!token) return unresolvedAdminSession(pages)

  const resolved = await resolveAdminSessionToken(token, pages)
  if (!resolved.publicSession.authenticated) {
    await clearAdminCookies()
  }
  return resolved
}

export function getAdminRequestBearerToken(request: Request) {
  const authorization = request.headers.get("authorization")
  if (authorization === null) return null

  const match = /^Bearer ([A-Za-z0-9_-]{40,256})$/i.exec(
    authorization.trim(),
  )
  if (!match) throw new Error("Unauthorized")

  return match[1]
}

async function resolveAdminRequestSession(
  request: Request,
): Promise<ResolvedAdminSession> {
  const authorization = request.headers.get("authorization")
  if (authorization === null) return resolveAdminSession()

  const pages = await getDiscoveredAdminPages()
  const token = getAdminRequestBearerToken(request)
  if (!token) return unresolvedAdminSession(pages)

  return resolveAdminSessionToken(token, pages)
}

function requireAuthenticatedResolvedSession(
  resolved: ResolvedAdminSession,
) {
  if (
    !resolved.publicSession.authenticated ||
    resolved.publicSession.resetRequired
  ) {
    throw new Error("Unauthorized")
  }

  return resolved
}

export async function getAdminSession(): Promise<AdminSession> {
  return (await resolveAdminSession()).publicSession
}

export async function getRefreshedAdminSession(): Promise<AdminSession> {
  const resolved = await resolveAdminSession()

  if (resolved.publicSession.authenticated && resolved.expiresAt) {
    const cookieStore = await cookies()
    const token = cookieStore.get(ADMIN_COOKIE_NAME)?.value
    if (token) {
      cookieStore.set(
        ADMIN_COOKIE_NAME,
        token,
        cookieOptions(resolved.expiresAt),
      )
    }
  }

  return resolved.publicSession
}

export async function requireAdminSession() {
  return requireAuthenticatedResolvedSession(
    await resolveAdminSession(),
  ).publicSession
}

export async function requireAdminSessionForRequest(request: Request) {
  return requireAuthenticatedResolvedSession(
    await resolveAdminRequestSession(request),
  ).publicSession
}

export async function requireAdminPasswordResetSession() {
  const resolved = await resolveAdminSession()

  if (
    !resolved.publicSession.authenticated ||
    !resolved.publicSession.resetRequired ||
    !resolved.adminUserId ||
    !resolved.sessionId
  ) {
    throw new Error("Unauthorized")
  }

  return {
    ...resolved.publicSession,
    adminUserId: resolved.adminUserId,
    sessionId: resolved.sessionId,
    expiresAt: resolved.expiresAt,
  }
}

export async function requireAdminPasswordResetSessionForRequest(
  request: Request,
) {
  const resolved = await resolveAdminRequestSession(request)

  if (
    !resolved.publicSession.authenticated ||
    !resolved.publicSession.resetRequired ||
    !resolved.adminUserId ||
    !resolved.sessionId ||
    !resolved.expiresAt
  ) {
    throw new Error("Unauthorized")
  }

  return {
    ...resolved.publicSession,
    adminUserId: resolved.adminUserId,
    sessionId: resolved.sessionId,
    expiresAt: resolved.expiresAt,
  }
}

export function hasAdminPagePermission(
  session: AdminSession,
  pageId: string,
  access: "view" | "edit" = "view"
) {
  if (!session.authenticated || session.resetRequired) return false
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

export async function requireAdminPagePermissionForRequest(
  request: Request,
  pageId: string,
  access: "view" | "edit" = "view",
) {
  const session = await requireAdminSessionForRequest(request)

  if (!hasAdminPagePermission(session, pageId, access)) {
    throw new Error("Forbidden")
  }

  return session
}

export async function createOutlookAddinAdminSession(user: {
  id: string
  credentialUpdatedAt: string
}) {
  return createDatabaseAdminSession(
    user.id,
    user.credentialUpdatedAt,
    OUTLOOK_ADDIN_SESSION_DURATION_SECONDS,
  )
}
