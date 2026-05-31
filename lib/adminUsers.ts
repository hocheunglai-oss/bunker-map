import { createClient } from "@supabase/supabase-js"
import { promisify } from "node:util"
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto"
import {
  getFullAdminPagePermissions,
  isAdminRole,
  normaliseAdminPagePermissions,
  type AdminPagePermissionMap,
} from "@/lib/adminPages"

const scryptAsync = promisify(scrypt)

type AdminUserRow = {
  id: string
  username: string
  display_name: string | null
  role: string
  password_hash: string
  permissions: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

type AdminActor = {
  username: string | null
  displayName: string | null
}

export type ManagedAdminUser = {
  id: string
  username: string
  displayName: string
  role: string
  permissions: AdminPagePermissionMap
  createdAt: string
  updatedAt: string
}

export type AuthenticatedAdminUser = {
  username: string
  displayName: string
  role: string
  permissions: AdminPagePermissionMap
  source: "database"
}

export type SaveAdminUserInput = {
  id?: string
  username: string
  displayName?: string
  role?: string
  password?: string
  permissions?: AdminPagePermissionMap
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function getServiceClient(actor?: AdminActor) {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for user management.")
  }

  return createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), serviceRoleKey, {
    global: actor?.username
      ? {
          headers: {
            "x-bunker-admin-user": actor.username,
            "x-bunker-admin-display-name": actor.displayName || actor.username,
          },
        }
      : undefined,
  })
}

function normaliseUsername(username: string) {
  return username.trim()
}

function normaliseRole(role?: string) {
  return role?.trim() || "user"
}

function mapAdminUser(row: AdminUserRow): ManagedAdminUser {
  const role = normaliseRole(row.role)
  const permissions =
    isAdminRole(role)
      ? getFullAdminPagePermissions()
      : normaliseAdminPagePermissions(row.permissions, "view")

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    role,
    permissions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex")
  const key = (await scryptAsync(password, salt, 64)) as Buffer
  return `scrypt:${salt}:${key.toString("hex")}`
}

async function verifyPassword(password: string, passwordHash: string) {
  const [scheme, salt, storedHex] = passwordHash.split(":")
  if (scheme !== "scrypt" || !salt || !storedHex) return false

  const stored = Buffer.from(storedHex, "hex")
  const key = (await scryptAsync(password, salt, stored.length)) as Buffer

  if (stored.length !== key.length) return false
  return timingSafeEqual(stored, key)
}

function getFriendlyUserManagementError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)

  if (
    message.includes("admin_users") ||
    message.includes("Could not find the table") ||
    message.includes("schema cache")
  ) {
    return new Error("Admin users table is not set up. Run supabase/admin_users.sql.")
  }

  return error
}

export async function validateDatabaseAdminUser(username: string, password: string) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null

  try {
    const supabase = getServiceClient()
    const { data, error } = await supabase
      .from("admin_users")
      .select("*")
      .eq("username", normaliseUsername(username))
      .maybeSingle()

    if (error || !data) return null

    const row = data as AdminUserRow
    const passwordMatches = await verifyPassword(password, row.password_hash)
    if (!passwordMatches) return null

    const user = mapAdminUser(row)
    return {
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      permissions: user.permissions,
      source: "database" as const,
    }
  } catch {
    return null
  }
}

export async function getDatabaseAdminUserByUsername(username: string) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null

  try {
    const supabase = getServiceClient()
    const { data, error } = await supabase
      .from("admin_users")
      .select("*")
      .eq("username", normaliseUsername(username))
      .maybeSingle()

    if (error || !data) return null

    const user = mapAdminUser(data as AdminUserRow)
    return {
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      permissions: user.permissions,
      source: "database" as const,
    }
  } catch {
    return null
  }
}

export async function listManagedAdminUsers() {
  try {
    const supabase = getServiceClient()
    const { data, error } = await supabase
      .from("admin_users")
      .select("*")
      .order("username", { ascending: true })

    if (error) throw error

    return ((data || []) as unknown as AdminUserRow[]).map(mapAdminUser)
  } catch (error) {
    throw getFriendlyUserManagementError(error)
  }
}

export async function saveManagedAdminUser(input: SaveAdminUserInput, actor?: AdminActor) {
  const username = normaliseUsername(input.username)
  if (!username) throw new Error("Username is required.")

  const role = normaliseRole(input.role)
  const permissions =
    isAdminRole(role)
      ? getFullAdminPagePermissions()
      : normaliseAdminPagePermissions(input.permissions, "view")

  try {
    const supabase = getServiceClient(actor)
    const payload: Record<string, unknown> = {
      username,
      display_name: input.displayName?.trim() || username,
      role,
      permissions,
      updated_at: new Date().toISOString(),
    }

    if (input.password?.trim()) {
      payload.password_hash = await hashPassword(input.password)
    } else if (!input.id) {
      throw new Error("Password is required for a new user.")
    }

    const query = input.id
      ? supabase.from("admin_users").update(payload).eq("id", input.id)
      : supabase.from("admin_users").insert(payload)

    const { data, error } = await query.select("*").single()
    if (error) throw error

    return mapAdminUser(data as AdminUserRow)
  } catch (error) {
    throw getFriendlyUserManagementError(error)
  }
}

export async function deleteManagedAdminUser(id: string, actor?: AdminActor) {
  if (!id) throw new Error("Missing user id.")

  try {
    const supabase = getServiceClient(actor)
    const { error } = await supabase.from("admin_users").delete().eq("id", id)
    if (error) throw error
  } catch (error) {
    throw getFriendlyUserManagementError(error)
  }
}
