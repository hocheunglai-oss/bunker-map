import { createClient } from "@supabase/supabase-js"
import { promisify } from "node:util"
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto"
import {
  ADMIN_ROLE_IDS,
  type AdminPageDefinition,
  type AdminRoleId,
  getFullAdminPagePermissions,
  isAdminRole,
  normaliseAdminRole,
  normaliseAdminPagePermissions,
  type AdminPagePermissionMap,
} from "@/lib/adminPages"

const scryptAsync = promisify(scrypt)
const ADMIN_ROLE_METADATA_KEY = "__adminRole"

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

type AdminRoleDefaultRow = {
  role: string
  permissions: Record<string, unknown> | null
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

export type ManagedAdminRoleDefault = {
  role: AdminRoleId
  permissions: AdminPagePermissionMap
  updatedAt: string | null
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

export type SaveAdminRoleDefaultInput = {
  role: string
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

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") return message
  }

  return String(error)
}

function isMissingRoleDefaultsTable(error: unknown) {
  const message = getErrorMessage(error)
  return (
    message.includes("admin_role_defaults") ||
    message.includes("Could not find the table") ||
    message.includes("schema cache")
  )
}

function getDefaultPermissionsForRole(
  role: string | null | undefined,
  pages?: AdminPageDefinition[]
) {
  return isAdminRole(role)
    ? getFullAdminPagePermissions(pages)
    : normaliseAdminPagePermissions(null, "view", pages)
}

function mapRoleDefault(
  role: string,
  row: AdminRoleDefaultRow | null | undefined,
  pages?: AdminPageDefinition[]
): ManagedAdminRoleDefault {
  const roleId = normaliseAdminRole(role)
  const permissions = row?.permissions
    ? normaliseAdminPagePermissions(
        row.permissions,
        isAdminRole(roleId) ? "edit" : "view",
        pages
      )
    : getDefaultPermissionsForRole(roleId, pages)

  return {
    role: roleId,
    permissions: isAdminRole(roleId) ? getFullAdminPagePermissions(pages) : permissions,
    updatedAt: row?.updated_at || null,
  }
}

function getRoleDefaultMap(roleDefaults: ManagedAdminRoleDefault[]) {
  return roleDefaults.reduce<Record<string, AdminPagePermissionMap>>((defaults, roleDefault) => {
    defaults[roleDefault.role] = roleDefault.permissions
    return defaults
  }, {})
}

function getGeneratedRoleDefaults(pages?: AdminPageDefinition[]) {
  return ADMIN_ROLE_IDS.map((roleId) => mapRoleDefault(roleId, null, pages))
}

function getExplicitPermissions(permissions: unknown) {
  if (!permissions || typeof permissions !== "object") return {}

  return Object.entries(permissions as Record<string, unknown>).reduce<AdminPagePermissionMap>(
    (next, [pageId, permission]) => {
      if (permission === "edit" || permission === "view" || permission === "none") {
        next[pageId] = permission
      }
      return next
    },
    {}
  )
}

function getStoredAdminRole(row: AdminUserRow) {
  const metadataRole = row.permissions?.[ADMIN_ROLE_METADATA_KEY]
  return normaliseAdminRole(
    typeof metadataRole === "string" ? metadataRole : row.role
  )
}

function mapAdminUser(
  row: AdminUserRow,
  roleDefaults: ManagedAdminRoleDefault[] = [],
  pages?: AdminPageDefinition[]
): ManagedAdminUser {
  const role = getStoredAdminRole(row)
  const defaultPermissions =
    getRoleDefaultMap(roleDefaults)[role] || getDefaultPermissionsForRole(role, pages)
  const overridePermissions = getExplicitPermissions(row.permissions)
  const permissions = isAdminRole(role)
    ? getFullAdminPagePermissions(pages)
    : normaliseAdminPagePermissions(
        {
          ...defaultPermissions,
          ...overridePermissions,
        },
        "view",
        pages
      )

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
  const message = getErrorMessage(error)

  if (
    message.includes("Could not find the table") ||
    message.includes("schema cache") ||
    message.includes("does not exist")
  ) {
    return new Error("Admin users tables are not set up. Run supabase/admin_users.sql.")
  }

  return error instanceof Error ? error : new Error(message)
}

async function usesLegacyAdminRoleValues(
  supabase: ReturnType<typeof getServiceClient>
) {
  const { data, error } = await supabase
    .from("admin_users")
    .select("role")
    .limit(50)

  if (error) throw error

  const roles = (data || [])
    .map((row) => (typeof row.role === "string" ? row.role.trim() : ""))
    .filter(Boolean)

  return (
    roles.length > 0 &&
    roles.every((role) => role === "admin" || role === "user")
  )
}

export async function validateDatabaseAdminUser(
  username: string,
  password: string,
  pages?: AdminPageDefinition[]
) {
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

    const roleDefaults = await listManagedAdminRoleDefaults(pages)
    const user = mapAdminUser(row, roleDefaults, pages)
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

export async function getDatabaseAdminUserByUsername(
  username: string,
  pages?: AdminPageDefinition[]
) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null

  try {
    const supabase = getServiceClient()
    const { data, error } = await supabase
      .from("admin_users")
      .select("*")
      .eq("username", normaliseUsername(username))
      .maybeSingle()

    if (error || !data) return null

    const roleDefaults = await listManagedAdminRoleDefaults(pages)
    const user = mapAdminUser(data as AdminUserRow, roleDefaults, pages)
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

export async function listManagedAdminRoleDefaults(pages?: AdminPageDefinition[]) {
  const result = await loadManagedAdminRoleDefaults(pages)
  return result.roleDefaults
}

export async function loadManagedAdminRoleDefaults(pages?: AdminPageDefinition[]) {
  try {
    const supabase = getServiceClient()
    const { data, error } = await supabase
      .from("admin_role_defaults")
      .select("*")
      .in("role", ADMIN_ROLE_IDS)
      .order("role", { ascending: true })

    if (error) throw error

    const rowsByRole = new Map(
      ((data || []) as unknown as AdminRoleDefaultRow[]).map((row) => [
        normaliseAdminRole(row.role),
        row,
      ])
    )

    return {
      roleDefaults: ADMIN_ROLE_IDS.map((roleId) =>
        mapRoleDefault(roleId, rowsByRole.get(roleId), pages)
      ),
      persisted: true,
    }
  } catch (error) {
    if (isMissingRoleDefaultsTable(error)) {
      return {
        roleDefaults: getGeneratedRoleDefaults(pages),
        persisted: false,
      }
    }

    throw getFriendlyUserManagementError(error)
  }
}

export async function saveManagedAdminRoleDefault(
  input: SaveAdminRoleDefaultInput,
  actor?: AdminActor,
  pages?: AdminPageDefinition[]
) {
  const role = normaliseAdminRole(input.role)
  const permissions = isAdminRole(role)
    ? getFullAdminPagePermissions(pages)
    : normaliseAdminPagePermissions(input.permissions, "view", pages)

  try {
    const supabase = getServiceClient(actor)
    const { data, error } = await supabase
      .from("admin_role_defaults")
      .upsert(
        {
          role,
          permissions,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "role" }
      )
      .select("*")
      .single()

    if (error) throw error
    return mapRoleDefault(role, data as AdminRoleDefaultRow, pages)
  } catch (error) {
    throw getFriendlyUserManagementError(error)
  }
}

export async function listManagedAdminUsers(
  roleDefaults?: ManagedAdminRoleDefault[],
  pages?: AdminPageDefinition[]
) {
  try {
    const supabase = getServiceClient()
    const { data, error } = await supabase
      .from("admin_users")
      .select("*")
      .order("username", { ascending: true })

    if (error) throw error

    return ((data || []) as unknown as AdminUserRow[]).map((row) =>
      mapAdminUser(row, roleDefaults, pages)
    )
  } catch (error) {
    throw getFriendlyUserManagementError(error)
  }
}

export async function saveManagedAdminUser(
  input: SaveAdminUserInput,
  actor?: AdminActor,
  pages?: AdminPageDefinition[],
  roleDefaults: ManagedAdminRoleDefault[] = []
) {
  const username = normaliseUsername(input.username)
  if (!username) throw new Error("Username is required.")

  const role = normaliseAdminRole(input.role)
  const permissions = isAdminRole(role)
    ? getFullAdminPagePermissions(pages)
    : input.permissions
      ? normaliseAdminPagePermissions(input.permissions, "view", pages)
      : {}

  try {
    const supabase = getServiceClient(actor)
    const useLegacyRole = await usesLegacyAdminRoleValues(supabase)
    const storedPermissions: Record<string, unknown> = {
      ...permissions,
    }

    if (useLegacyRole) {
      storedPermissions[ADMIN_ROLE_METADATA_KEY] = role
    }

    const payload: Record<string, unknown> = {
      username,
      display_name: input.displayName?.trim() || username,
      role: useLegacyRole ? (isAdminRole(role) ? "admin" : "user") : role,
      permissions: storedPermissions,
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

    return mapAdminUser(data as AdminUserRow, roleDefaults, pages)
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
