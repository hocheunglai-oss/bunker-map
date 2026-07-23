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
  type AdminPagePermission,
  type AdminPagePermissionMap,
} from "@/lib/adminPages"

const scryptAsync = promisify(scrypt)
const ADMIN_ROLE_METADATA_KEY = "__adminRole"
const ADMIN_PERMISSION_GROUPS_STORE_KEY = "admin-permission-groups"

type AdminUserRow = {
  id: string
  username: string
  display_name: string | null
  role: string
  password_hash: string
  is_active: boolean
  password_reset_required: boolean
  permissions: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

type AdminRoleDefaultRow = {
  role: string
  permissions: Record<string, unknown> | null
  updated_at: string | null
}

type AdminActor = {
  username: string | null
  displayName: string | null
}

type PermissionGroupStorePayload = {
  groups?: Array<{
    role?: unknown
    permissions?: unknown
    updatedAt?: unknown
  }>
}

export type ManagedAdminUser = {
  id: string
  username: string
  displayName: string
  role: string
  isActive: boolean
  passwordResetRequired: boolean
  permissions: AdminPagePermissionMap
  createdAt: string
  updatedAt: string
}

export type ManagedAdminRoleDefault = {
  role: AdminRoleId
  permissions: AdminPagePermissionMap
  updatedAt: string | null
  memberCount: number
  hasMixedPermissions: boolean
  persisted: boolean
  isBuiltIn: boolean
}

export type AuthenticatedAdminUser = {
  id: string
  username: string
  displayName: string
  role: string
  passwordResetRequired: boolean
  credentialUpdatedAt: string
  permissions: AdminPagePermissionMap
  source: "database"
}

export type SaveAdminUserInput = {
  id?: string
  username: string
  displayName?: string
  role?: string
  password?: string
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

function isMissingTableError(error: unknown, tableName: string) {
  const message = getErrorMessage(error)
  return (
    message.includes(tableName) &&
    (message.includes("Could not find the table") ||
      message.includes("schema cache") ||
      message.includes("does not exist"))
  )
}

function getFriendlyUserManagementError(error: unknown) {
  const message = getErrorMessage(error)

  if (isMissingTableError(error, "admin_users")) {
    return new Error("Admin users table is not set up. Run supabase/admin_users.sql.")
  }

  return error instanceof Error ? error : new Error(message)
}

function getDefaultPermissionsForRole(
  role: string | null | undefined,
  pages?: AdminPageDefinition[]
) {
  return isAdminRole(role)
    ? getFullAdminPagePermissions(pages)
    : normaliseAdminPagePermissions(null, "view", pages)
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

function getPermissionMetadata(permissions: unknown) {
  if (!permissions || typeof permissions !== "object") return {}

  return Object.entries(permissions as Record<string, unknown>).reduce<Record<string, unknown>>(
    (next, [key, value]) => {
      if (key.startsWith("__")) next[key] = value
      return next
    },
    {}
  )
}

function getStoredAdminRole(row: Pick<AdminUserRow, "role" | "permissions">) {
  const metadataRole = row.permissions?.[ADMIN_ROLE_METADATA_KEY]
  return normaliseAdminRole(
    typeof metadataRole === "string" ? metadataRole : row.role
  )
}

function getRoleDefaultMap(roleDefaults: ManagedAdminRoleDefault[]) {
  return roleDefaults.reduce<Record<string, ManagedAdminRoleDefault>>(
    (defaults, roleDefault) => {
      defaults[roleDefault.role] = roleDefault
      return defaults
    },
    {}
  )
}

function getPermissionSignature(
  permissions: AdminPagePermissionMap,
  pages: AdminPageDefinition[]
) {
  return pages.map((page) => `${page.id}:${permissions[page.id] || "none"}`).join("|")
}

function deriveGroupPermissions(
  rows: AdminUserRow[],
  pages: AdminPageDefinition[]
) {
  if (rows.length === 0) return normaliseAdminPagePermissions(null, "view", pages)

  const memberPermissions = rows.map((row) =>
    normaliseAdminPagePermissions(getExplicitPermissions(row.permissions), "view", pages)
  )
  const permissionOrder: AdminPagePermission[] = ["none", "view", "edit"]

  return pages.reduce<AdminPagePermissionMap>((permissions, page) => {
    const counts: Record<AdminPagePermission, number> = {
      none: 0,
      view: 0,
      edit: 0,
    }

    memberPermissions.forEach((memberPermission) => {
      counts[memberPermission[page.id] || "view"] += 1
    })

    permissions[page.id] = permissionOrder.reduce((selected, option) =>
      counts[option] > counts[selected] ? option : selected
    )
    return permissions
  }, {})
}

function orderRoles(roles: Iterable<string>) {
  const roleSet = new Set(Array.from(roles, normaliseAdminRole))
  const builtIns = ADMIN_ROLE_IDS.filter((role) => roleSet.delete(role))
  return [...builtIns, ...Array.from(roleSet).sort((a, b) => a.localeCompare(b))]
}

function buildManagedRoleDefaults(
  storedRows: AdminRoleDefaultRow[],
  userRows: AdminUserRow[],
  pages: AdminPageDefinition[]
) {
  const storedByRole = new Map(
    storedRows.map((row) => [normaliseAdminRole(row.role), row])
  )
  const usersByRole = new Map<string, AdminUserRow[]>()

  userRows.forEach((row) => {
    const role = getStoredAdminRole(row)
    const existing = usersByRole.get(role)
    if (existing) existing.push(row)
    else usersByRole.set(role, [row])
  })

  const roles = orderRoles([
    ...ADMIN_ROLE_IDS,
    ...storedByRole.keys(),
    ...usersByRole.keys(),
  ])

  return roles.map<ManagedAdminRoleDefault>((role) => {
    const stored = storedByRole.get(role)
    const members = usersByRole.get(role) || []
    const permissions = isAdminRole(role)
      ? getFullAdminPagePermissions(pages)
      : stored
        ? normaliseAdminPagePermissions(stored.permissions, "view", pages)
        : deriveGroupPermissions(members, pages)
    const permissionVariants = new Set(
      members.map((row) =>
        getPermissionSignature(
          normaliseAdminPagePermissions(
            getExplicitPermissions(row.permissions),
            "view",
            pages
          ),
          pages
        )
      )
    )

    return {
      role,
      permissions,
      updatedAt: stored?.updated_at || null,
      memberCount: members.length,
      hasMixedPermissions: permissionVariants.size > 1,
      persisted: Boolean(stored),
      isBuiltIn: ADMIN_ROLE_IDS.includes(role as (typeof ADMIN_ROLE_IDS)[number]),
    }
  })
}

function parsePermissionGroupStore(
  payload: unknown
): AdminRoleDefaultRow[] {
  if (!payload || typeof payload !== "object") return []

  const groups = (payload as PermissionGroupStorePayload).groups
  if (!Array.isArray(groups)) return []

  return groups.flatMap((group) => {
    if (!group || typeof group !== "object" || typeof group.role !== "string") {
      return []
    }

    return [{
      role: normaliseAdminRole(group.role),
      permissions:
        group.permissions && typeof group.permissions === "object"
          ? (group.permissions as Record<string, unknown>)
          : {},
      updated_at: typeof group.updatedAt === "string" ? group.updatedAt : null,
    }]
  })
}

async function loadStoredRoleDefaults(
  supabase: ReturnType<typeof getServiceClient>
) {
  const tableResult = await supabase
    .from("admin_role_defaults")
    .select("*")
    .order("role", { ascending: true })

  if (!tableResult.error) {
    return {
      rows: (tableResult.data || []) as unknown as AdminRoleDefaultRow[],
      storage: "table" as const,
    }
  }

  if (!isMissingTableError(tableResult.error, "admin_role_defaults")) {
    throw tableResult.error
  }

  const storeResult = await supabase
    .from("office_calendar_store")
    .select("payload")
    .eq("key", ADMIN_PERMISSION_GROUPS_STORE_KEY)
    .maybeSingle()

  if (storeResult.error) throw storeResult.error

  return {
    rows: parsePermissionGroupStore(storeResult.data?.payload),
    storage: "shared-store" as const,
  }
}

async function saveStoredRoleDefault(
  supabase: ReturnType<typeof getServiceClient>,
  role: string,
  permissions: AdminPagePermissionMap
) {
  const updatedAt = new Date().toISOString()
  const tableResult = await supabase
    .from("admin_role_defaults")
    .upsert(
      {
        role,
        permissions,
        updated_at: updatedAt,
      },
      { onConflict: "role" }
    )
    .select("*")
    .single()

  if (!tableResult.error) {
    return tableResult.data as unknown as AdminRoleDefaultRow
  }

  if (!isMissingTableError(tableResult.error, "admin_role_defaults")) {
    throw tableResult.error
  }

  const existingResult = await supabase
    .from("office_calendar_store")
    .select("payload")
    .eq("key", ADMIN_PERMISSION_GROUPS_STORE_KEY)
    .maybeSingle()

  if (existingResult.error) throw existingResult.error

  const existingRows = parsePermissionGroupStore(existingResult.data?.payload)
  const nextRow: AdminRoleDefaultRow = {
    role,
    permissions,
    updated_at: updatedAt,
  }
  const nextRows = existingRows.some(
    (row) => normaliseAdminRole(row.role) === role
  )
    ? existingRows.map((row) =>
        normaliseAdminRole(row.role) === role ? nextRow : row
      )
    : [...existingRows, nextRow]

  const storeResult = await supabase
    .from("office_calendar_store")
    .upsert({
      key: ADMIN_PERMISSION_GROUPS_STORE_KEY,
      payload: {
        groups: nextRows.map((row) => ({
          role: row.role,
          permissions: row.permissions,
          updatedAt: row.updated_at,
        })),
      },
      updated_at: updatedAt,
    })

  if (storeResult.error) throw storeResult.error
  return nextRow
}

async function deleteStoredRoleDefault(
  supabase: ReturnType<typeof getServiceClient>,
  role: string
) {
  const tableResult = await supabase
    .from("admin_role_defaults")
    .delete()
    .eq("role", role)

  if (!tableResult.error) return

  if (!isMissingTableError(tableResult.error, "admin_role_defaults")) {
    throw tableResult.error
  }

  const existingResult = await supabase
    .from("office_calendar_store")
    .select("payload")
    .eq("key", ADMIN_PERMISSION_GROUPS_STORE_KEY)
    .maybeSingle()

  if (existingResult.error) throw existingResult.error

  const nextRows = parsePermissionGroupStore(existingResult.data?.payload)
    .filter((row) => normaliseAdminRole(row.role) !== role)
  const updatedAt = new Date().toISOString()
  const storeResult = await supabase
    .from("office_calendar_store")
    .upsert({
      key: ADMIN_PERMISSION_GROUPS_STORE_KEY,
      payload: {
        groups: nextRows.map((row) => ({
          role: row.role,
          permissions: row.permissions,
          updatedAt: row.updated_at,
        })),
      },
      updated_at: updatedAt,
    })

  if (storeResult.error) throw storeResult.error
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

function getDatabaseRole(role: string, useLegacyRoles: boolean) {
  if (useLegacyRoles) return isAdminRole(role) ? "admin" : "user"
  if (ADMIN_ROLE_IDS.includes(role as (typeof ADMIN_ROLE_IDS)[number])) return role
  return "AC"
}

function mapAdminUser(
  row: AdminUserRow,
  roleDefaults: ManagedAdminRoleDefault[] = [],
  pages: AdminPageDefinition[] = []
): ManagedAdminUser {
  const role = getStoredAdminRole(row)
  const roleDefault = getRoleDefaultMap(roleDefaults)[role]
  const explicitPermissions = normaliseAdminPagePermissions(
    getExplicitPermissions(row.permissions),
    "view",
    pages
  )
  const permissions = isAdminRole(role)
    ? getFullAdminPagePermissions(pages)
    : roleDefault?.persisted
      ? roleDefault.permissions
      : normaliseAdminPagePermissions(
          {
            ...(roleDefault?.permissions || {}),
            ...explicitPermissions,
          },
          "view",
          pages
        )

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    role,
    isActive: row.is_active !== false,
    passwordResetRequired: row.password_reset_required === true,
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

export function getAdminPasswordValidationError(password: string) {
  if (password.length < 12) {
    return "Password must be at least 12 characters."
  }
  if (password.length > 256) {
    return "Password must be no more than 256 characters."
  }
  return null
}

function mapAuthenticatedAdminUser(
  row: AdminUserRow,
  roleDefaults: ManagedAdminRoleDefault[],
  pages: AdminPageDefinition[] = [],
): AuthenticatedAdminUser {
  const user = mapAdminUser(row, roleDefaults, pages)
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    passwordResetRequired: user.passwordResetRequired,
    credentialUpdatedAt: row.updated_at,
    permissions: user.permissions,
    source: "database",
  }
}

export async function validateDatabaseAdminUserStrict(
  username: string,
  password: string,
  pages?: AdminPageDefinition[]
) {
  const supabase = getServiceClient()
  const { data, error } = await supabase
    .from("admin_users")
    .select("*")
    .eq("username", normaliseUsername(username))
    .eq("is_active", true)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as AdminUserRow
  const passwordMatches = await verifyPassword(password, row.password_hash)
  if (!passwordMatches) return null

  const roleDefaults = await listManagedAdminRoleDefaults(pages)
  return mapAuthenticatedAdminUser(row, roleDefaults, pages)
}

export async function validateDatabaseAdminUser(
  username: string,
  password: string,
  pages?: AdminPageDefinition[]
) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null

  try {
    return await validateDatabaseAdminUserStrict(username, password, pages)
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
      .eq("is_active", true)
      .maybeSingle()

    if (error || !data) return null

    const roleDefaults = await listManagedAdminRoleDefaults(pages)
    return mapAuthenticatedAdminUser(
      data as AdminUserRow,
      roleDefaults,
      pages,
    )
  } catch {
    return null
  }
}

export async function getDatabaseAdminUserById(
  id: string,
  pages?: AdminPageDefinition[],
) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null

  try {
    const supabase = getServiceClient()
    const { data, error } = await supabase
      .from("admin_users")
      .select("*")
      .eq("id", id)
      .eq("is_active", true)
      .maybeSingle()

    if (error || !data) return null

    const roleDefaults = await listManagedAdminRoleDefaults(pages)
    return mapAuthenticatedAdminUser(
      data as AdminUserRow,
      roleDefaults,
      pages,
    )
  } catch {
    return null
  }
}

export async function getDatabaseAdminUserByIdStrict(
  id: string,
  pages?: AdminPageDefinition[],
) {
  const supabase = getServiceClient()
  const { data, error } = await supabase
    .from("admin_users")
    .select("*")
    .eq("id", id)
    .eq("is_active", true)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const roleDefaults = await listManagedAdminRoleDefaults(pages)
  return mapAuthenticatedAdminUser(
    data as AdminUserRow,
    roleDefaults,
    pages,
  )
}

export async function completeDatabaseAdminPasswordReset(input: {
  adminUserId: string
  sessionId: string
  newPassword: string
}) {
  const validationError = getAdminPasswordValidationError(input.newPassword)
  if (validationError) throw new Error(validationError)

  const supabase = getServiceClient()
  const { data: currentUser, error: currentUserError } = await supabase
    .from("admin_users")
    .select("password_hash,password_reset_required")
    .eq("id", input.adminUserId)
    .eq("is_active", true)
    .maybeSingle()

  if (currentUserError) throw currentUserError
  if (!currentUser || currentUser.password_reset_required !== true) {
    throw new Error("Password reset is not required for this account.")
  }
  if (await verifyPassword(input.newPassword, String(currentUser.password_hash))) {
    throw new Error("Choose a password that is different from your current password.")
  }

  const passwordHash = await hashPassword(input.newPassword)
  const { data, error } = await supabase.rpc("complete_admin_password_reset", {
    p_session_id: input.sessionId,
    p_new_password_hash: passwordHash,
  })

  if (error) throw error
  if (data !== true) throw new Error("Password reset could not be completed.")
}

export async function loadManagedAdminRoleDefaults(
  pages: AdminPageDefinition[] = []
) {
  try {
    const supabase = getServiceClient()
    const [stored, usersResult] = await Promise.all([
      loadStoredRoleDefaults(supabase),
      supabase.from("admin_users").select("*").order("username", { ascending: true }),
    ])

    if (usersResult.error) throw usersResult.error

    return {
      roleDefaults: buildManagedRoleDefaults(
        stored.rows,
        (usersResult.data || []) as unknown as AdminUserRow[],
        pages
      ),
      storage: stored.storage,
    }
  } catch (error) {
    throw getFriendlyUserManagementError(error)
  }
}

export async function listManagedAdminRoleDefaults(
  pages?: AdminPageDefinition[]
) {
  const result = await loadManagedAdminRoleDefaults(pages)
  return result.roleDefaults
}

export async function saveManagedAdminRoleDefault(
  input: SaveAdminRoleDefaultInput,
  actor?: AdminActor,
  pages: AdminPageDefinition[] = []
) {
  if (!input.role.trim()) throw new Error("Group name is required.")
  const role = normaliseAdminRole(input.role)

  const permissions = isAdminRole(role)
    ? getFullAdminPagePermissions(pages)
    : normaliseAdminPagePermissions(input.permissions, "view", pages)

  try {
    const supabase = getServiceClient(actor)
    const [savedRow, usersResult] = await Promise.all([
      saveStoredRoleDefault(supabase, role, permissions),
      supabase.from("admin_users").select("*").order("username", { ascending: true }),
    ])

    if (usersResult.error) throw usersResult.error

    const memberRows = ((usersResult.data || []) as unknown as AdminUserRow[])
      .filter((row) => getStoredAdminRole(row) === role)

    await Promise.all(
      memberRows.map(async (row) => {
        const nextPermissions = {
          ...getPermissionMetadata(row.permissions),
          ...permissions,
          [ADMIN_ROLE_METADATA_KEY]: role,
        }
        const { error } = await supabase
          .from("admin_users")
          .update({
            permissions: nextPermissions,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id)

        if (error) throw error
      })
    )

    return {
      role,
      permissions,
      updatedAt: savedRow.updated_at,
      memberCount: memberRows.length,
      hasMixedPermissions: false,
      persisted: true,
      isBuiltIn: ADMIN_ROLE_IDS.includes(role as (typeof ADMIN_ROLE_IDS)[number]),
    } satisfies ManagedAdminRoleDefault
  } catch (error) {
    throw getFriendlyUserManagementError(error)
  }
}

export async function deleteManagedAdminRoleDefault(
  roleInput: string,
  actor?: AdminActor
) {
  if (!roleInput.trim()) throw new Error("Group name is required.")

  const role = normaliseAdminRole(roleInput)
  if (ADMIN_ROLE_IDS.includes(role as (typeof ADMIN_ROLE_IDS)[number])) {
    throw new Error("Built-in permission groups cannot be deleted.")
  }

  try {
    const supabase = getServiceClient(actor)
    const { data, error } = await supabase
      .from("admin_users")
      .select("*")
      .order("username", { ascending: true })

    if (error) throw error

    const memberCount = ((data || []) as unknown as AdminUserRow[])
      .filter((row) => getStoredAdminRole(row) === role).length

    if (memberCount > 0) {
      throw new Error("Move all users out of this group before deleting it.")
    }

    await deleteStoredRoleDefault(supabase, role)
  } catch (error) {
    throw getFriendlyUserManagementError(error)
  }
}

export async function listManagedAdminUsers(
  roleDefaults?: ManagedAdminRoleDefault[],
  pages: AdminPageDefinition[] = []
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
  pages: AdminPageDefinition[] = [],
  roleDefaults: ManagedAdminRoleDefault[] = []
) {
  const username = normaliseUsername(input.username)
  if (!username) throw new Error("Username is required.")

  const role = normaliseAdminRole(input.role)
  const roleDefault = getRoleDefaultMap(roleDefaults)[role]
  if (!roleDefault) throw new Error("Select a valid permission group.")

  const permissions = isAdminRole(role)
    ? getFullAdminPagePermissions(pages)
    : normaliseAdminPagePermissions(roleDefault.permissions, "view", pages)

  try {
    const supabase = getServiceClient(actor)
    const useLegacyRoles = await usesLegacyAdminRoleValues(supabase)
    const payload: Record<string, unknown> = {
      username,
      display_name: input.displayName?.trim() || username,
      role: getDatabaseRole(role, useLegacyRoles),
      permissions: {
        ...permissions,
        [ADMIN_ROLE_METADATA_KEY]: role,
      },
      updated_at: new Date().toISOString(),
    }

    const passwordInput = input.password?.trim() || ""
    let passwordHash: string | null = null
    if (passwordInput) {
      const validationError = getAdminPasswordValidationError(passwordInput)
      if (validationError) throw new Error(validationError)
      passwordHash = await hashPassword(passwordInput)
      payload.password_hash = passwordHash
      payload.password_reset_required = true
    } else if (!input.id) {
      throw new Error("Password is required for a new user.")
    }

    if (passwordHash && input.id) {
      const { data, error } = await supabase
        .rpc("update_admin_user_with_password_and_revoke_sessions", {
          p_admin_user_id: input.id,
          p_username: payload.username,
          p_display_name: payload.display_name,
          p_role: payload.role,
          p_permissions: payload.permissions,
          p_new_password_hash: passwordHash,
        })
        .select("*")
        .single()

      if (error) throw error
      if (!data) throw new Error("Admin user password update returned no record.")

      return mapAdminUser(data as AdminUserRow, roleDefaults, pages)
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
