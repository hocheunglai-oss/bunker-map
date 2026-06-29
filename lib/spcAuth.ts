import { cookies } from "next/headers"
import {
  getDatabaseSpcUserByUsername,
  normaliseSpcRole,
  type AuthenticatedSpcUser,
  type SpcRoleId,
  validateDatabaseSpcUser,
} from "@/lib/spcUsers"

export const SPC_COOKIE_NAME = "spc_auth"
export const SPC_USER_COOKIE_NAME = "spc_user"

const SPC_COOKIE_MAX_AGE = 60 * 60 * 24 * 365
const SPC_USER_LOOKUP_CACHE_MS = 3000

export type SpcSession = {
  authenticated: boolean
  username: string | null
  displayName: string | null
  role: SpcRoleId | null
}

type DatabaseSpcUser = Awaited<ReturnType<typeof getDatabaseSpcUserByUsername>>

const spcUserLookupCache = new Map<
  string,
  { user: DatabaseSpcUser; expiresAt: number }
>()
const spcUserLookupPromises = new Map<string, Promise<DatabaseSpcUser>>()

function normaliseUsername(username: string) {
  return username.trim()
}

async function getCachedDatabaseSpcUser(username: string) {
  const cached = spcUserLookupCache.get(username)
  if (cached && cached.expiresAt > Date.now()) return cached.user

  const pending = spcUserLookupPromises.get(username)
  if (pending) return pending

  const lookup = getDatabaseSpcUserByUsername(username)
    .then((user) => {
      spcUserLookupCache.set(username, {
        user,
        expiresAt: Date.now() + SPC_USER_LOOKUP_CACHE_MS,
      })
      return user
    })
    .finally(() => {
      spcUserLookupPromises.delete(username)
    })

  spcUserLookupPromises.set(username, lookup)
  return lookup
}

export async function validateSpcCredentials(
  username: string,
  password: string,
): Promise<AuthenticatedSpcUser | null> {
  return validateDatabaseSpcUser(normaliseUsername(username), password)
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SPC_COOKIE_MAX_AGE,
  }
}

export async function setSpcSession(user: { username: string }) {
  const cookieStore = await cookies()
  cookieStore.set(SPC_COOKIE_NAME, "1", cookieOptions())
  cookieStore.set(SPC_USER_COOKIE_NAME, user.username, cookieOptions())
}

export async function refreshSpcSession() {
  const cookieStore = await cookies()
  const authenticated = cookieStore.get(SPC_COOKIE_NAME)?.value === "1"
  if (!authenticated) return

  const username = cookieStore.get(SPC_USER_COOKIE_NAME)?.value
  if (!username) {
    await clearSpcSession()
    return
  }

  cookieStore.set(SPC_COOKIE_NAME, "1", cookieOptions())
  cookieStore.set(SPC_USER_COOKIE_NAME, username, cookieOptions())
}

export async function clearSpcSession() {
  const cookieStore = await cookies()
  const options = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  }

  cookieStore.set(SPC_COOKIE_NAME, "", options)
  cookieStore.set(SPC_USER_COOKIE_NAME, "", options)
}

function unauthenticatedSession(): SpcSession {
  return {
    authenticated: false,
    username: null,
    displayName: null,
    role: null,
  }
}

export async function getSpcSession(): Promise<SpcSession> {
  const cookieStore = await cookies()
  const authenticated = cookieStore.get(SPC_COOKIE_NAME)?.value === "1"

  if (!authenticated) return unauthenticatedSession()

  const username = cookieStore.get(SPC_USER_COOKIE_NAME)?.value
  if (!username) {
    await clearSpcSession()
    return unauthenticatedSession()
  }

  const databaseUser = await getCachedDatabaseSpcUser(username)

  if (databaseUser) {
    return {
      authenticated: true,
      username: databaseUser.username,
      displayName: databaseUser.displayName,
      role: normaliseSpcRole(databaseUser.role),
    }
  }

  await clearSpcSession()
  return unauthenticatedSession()
}

export async function requireSpcSession() {
  const session = await getSpcSession()
  if (!session.authenticated) throw new Error("Unauthorized")
  return session
}

export function hasSpcRole(session: SpcSession, roles: SpcRoleId | SpcRoleId[]) {
  if (!session.authenticated || !session.role) return false
  const allowedRoles = Array.isArray(roles) ? roles : [roles]
  return allowedRoles.includes(session.role)
}

export async function requireSpcRole(roles: SpcRoleId | SpcRoleId[]) {
  const session = await requireSpcSession()
  if (!hasSpcRole(session, roles)) throw new Error("Forbidden")
  return session
}
