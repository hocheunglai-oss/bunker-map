import { cookies } from "next/headers"
import {
  getDatabaseSpcUserById,
  type AuthenticatedSpcUser,
  validateDatabaseSpcUser,
} from "@/lib/spcUsers"
import {
  SPC_SESSION_DURATION_SECONDS,
  createDatabaseSpcSession,
  createDatabaseSpcSessionFromAssuredSession,
  getDatabaseSpcSession,
  isPlausibleSpcSessionToken,
  revokeDatabaseSpcSession,
} from "@/lib/spcSessions"
import {
  canAccessSpcPage,
  normaliseSpcRole,
  type SpcPagePermissionMap,
  type SpcRoleId,
} from "@/lib/spcPages"
import { requiresSpcWhatsappLoginMfa } from "@/lib/spcWhatsappLoginMfa"

export const SPC_COOKIE_NAME = "spc_auth"
// Retained only so legacy forgeable username cookies can be expired.
export const SPC_USER_COOKIE_NAME = "spc_user"

export type SpcSession = {
  authenticated: boolean
  userId: string | null
  username: string | null
  displayName: string | null
  role: SpcRoleId | null
  office: string | null
  mustChangePassword: boolean
  mfaVerifiedAt: string | null
  permissions: SpcPagePermissionMap
}

function normaliseUsername(username: string) {
  return username.trim()
}

export async function validateSpcCredentials(
  username: string,
  password: string,
): Promise<AuthenticatedSpcUser | null> {
  return validateDatabaseSpcUser(normaliseUsername(username), password)
}

function cookieOptions(expiresAt: string) {
  const expires = new Date(expiresAt)
  const remainingSeconds = Math.max(
    0,
    Math.ceil((expires.getTime() - Date.now()) / 1000),
  )
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.min(SPC_SESSION_DURATION_SECONDS, remainingSeconds),
    expires,
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

function clearSpcCookies(cookieStore: Awaited<ReturnType<typeof cookies>>) {
  const options = expiredCookieOptions()

  cookieStore.set(SPC_COOKIE_NAME, "", options)
  cookieStore.set(SPC_USER_COOKIE_NAME, "", options)
}

export async function setSpcSession(user: {
  id: string
  credentialUpdatedAt: string
}, options: { preserveMfaFromCurrentSession?: boolean } = {}) {
  const cookieStore = await cookies()
  const previousToken = cookieStore.get(SPC_COOKIE_NAME)?.value
  const session = options.preserveMfaFromCurrentSession
    ? await createDatabaseSpcSessionFromAssuredSession(
        user.id,
        user.credentialUpdatedAt,
        previousToken || "",
      )
    : await createDatabaseSpcSession(
        user.id,
        user.credentialUpdatedAt,
      )

  cookieStore.set(
    SPC_COOKIE_NAME,
    session.token,
    cookieOptions(session.expiresAt),
  )
  cookieStore.set(SPC_USER_COOKIE_NAME, "", expiredCookieOptions())

  if (previousToken && previousToken !== session.token) {
    await revokeDatabaseSpcSession(previousToken)
  }
}

export async function setSpcVerifiedSession(input: {
  token: string
  expiresAt: string
  mfaVerifiedAt: string
}) {
  const now = Date.now()
  const expiresAt = Date.parse(input.expiresAt)
  const mfaVerifiedAt = Date.parse(input.mfaVerifiedAt)
  if (
    !isPlausibleSpcSessionToken(input.token) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(mfaVerifiedAt) ||
    expiresAt <= now ||
    expiresAt > now + (SPC_SESSION_DURATION_SECONDS + 60) * 1000 ||
    mfaVerifiedAt > now + 60_000 ||
    mfaVerifiedAt < now - 10 * 60_000
  ) {
    throw new Error("The verified SPC session is invalid.")
  }

  const cookieStore = await cookies()
  const previousToken = cookieStore.get(SPC_COOKIE_NAME)?.value
  cookieStore.set(SPC_COOKIE_NAME, input.token, cookieOptions(input.expiresAt))
  cookieStore.set(SPC_USER_COOKIE_NAME, "", expiredCookieOptions())

  if (previousToken && previousToken !== input.token) {
    await revokeDatabaseSpcSession(previousToken)
  }
}

export async function clearSpcSession() {
  const cookieStore = await cookies()
  const token = cookieStore.get(SPC_COOKIE_NAME)?.value

  try {
    if (token) await revokeDatabaseSpcSession(token)
  } finally {
    clearSpcCookies(cookieStore)
  }
}

function unauthenticatedSession(): SpcSession {
  return {
    authenticated: false,
    userId: null,
    username: null,
    displayName: null,
    role: null,
    office: null,
    mustChangePassword: false,
    mfaVerifiedAt: null,
    permissions: {},
  }
}

export async function getSpcSession(): Promise<SpcSession> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SPC_COOKIE_NAME)?.value
  if (!token) {
    if (cookieStore.get(SPC_USER_COOKIE_NAME)?.value) clearSpcCookies(cookieStore)
    return unauthenticatedSession()
  }

  try {
    const databaseSession = await getDatabaseSpcSession(token)
    if (!databaseSession) {
      clearSpcCookies(cookieStore)
      return unauthenticatedSession()
    }

    const databaseUser = await getDatabaseSpcUserById(databaseSession.spcUserId)

    if (
      !databaseUser ||
      databaseUser.credentialUpdatedAt !== databaseSession.userUpdatedAt
    ) {
      await revokeDatabaseSpcSession(token)
      clearSpcCookies(cookieStore)
      return unauthenticatedSession()
    }

    if (
      requiresSpcWhatsappLoginMfa(databaseUser.username) &&
      !databaseSession.mfaVerifiedAt
    ) {
      await revokeDatabaseSpcSession(token)
      clearSpcCookies(cookieStore)
      return unauthenticatedSession()
    }

    return {
      authenticated: true,
      userId: databaseUser.id,
      username: databaseUser.username,
      displayName: databaseUser.displayName,
      role: normaliseSpcRole(databaseUser.role),
      office: databaseUser.office,
      mustChangePassword: databaseUser.mustChangePassword,
      mfaVerifiedAt: databaseSession.mfaVerifiedAt,
      permissions: databaseUser.permissions,
    }
  } catch {
    clearSpcCookies(cookieStore)
    return unauthenticatedSession()
  }
}

export async function requireSpcSession() {
  const session = await getSpcSession()
  if (!session.authenticated) throw new Error("Unauthorized")
  return session
}

export function hasSpcRole(session: SpcSession, roles: SpcRoleId | SpcRoleId[]) {
  if (!session.authenticated || session.mustChangePassword || !session.role) return false
  const allowedRoles = Array.isArray(roles) ? roles : [roles]
  return allowedRoles.map(normaliseSpcRole).includes(normaliseSpcRole(session.role))
}

export async function requireSpcRole(roles: SpcRoleId | SpcRoleId[]) {
  const session = await requireSpcSession()
  if (!hasSpcRole(session, roles)) throw new Error("Forbidden")
  return session
}

export function hasSpcPagePermission(
  session: SpcSession,
  pageId: string,
  access: "view" | "edit" = "view",
) {
  if (!session.authenticated || session.mustChangePassword) return false
  return canAccessSpcPage(session.permissions, pageId, access)
}

export function hasSpcAdminPagePermission(
  session: SpcSession,
  access: "view" | "edit" = "view",
  pageId: "spc-user-management" | "spc-mfa-test" = "spc-user-management",
) {
  return (
    hasSpcRole(session, "ADMIN") &&
    hasSpcPagePermission(session, pageId, access)
  )
}

export async function requireSpcPagePermission(
  pageId: string,
  access: "view" | "edit" = "view",
) {
  const session = await requireSpcSession()
  if (!hasSpcPagePermission(session, pageId, access)) throw new Error("Forbidden")
  return session
}

export async function requireSpcAdminPagePermission(
  pageId: "spc-user-management" | "spc-mfa-test",
  access: "view" | "edit" = "view",
) {
  const session = await requireSpcSession()
  if (
    !hasSpcAdminPagePermission(session, access, pageId)
  ) {
    throw new Error("Forbidden")
  }
  return session
}
