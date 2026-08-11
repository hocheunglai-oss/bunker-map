import { randomBytes, scrypt, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"
import { createClient } from "@supabase/supabase-js"
import {
  createSpcAuditHeaders,
  type SpcAuditActionContext,
  type SpcAuditContext,
} from "@/lib/spcAudit"
import {
  SPC_BUILT_IN_ROLE_IDS,
  SPC_PAGE_DEFINITIONS,
  canAccessSpcPage,
  constrainSpcPermissionForRole,
  getDefaultSpcPermissionsForRole,
  getSpcRoleLabel,
  normaliseSpcPagePermissions,
  normaliseSpcRole,
  type SpcPageDefinition,
  type SpcPagePermission,
  type SpcPagePermissionMap,
  type SpcRoleId,
} from "@/lib/spcPages"
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/passwordPolicy"

const scryptAsync = promisify(scrypt)
const SPC_PERMISSION_GROUPS_STORE_KEY = "spc-permission-groups"
export const SPC_PASSWORD_MIN_LENGTH = PASSWORD_MIN_LENGTH
export const SPC_PASSWORD_MAX_LENGTH = PASSWORD_MAX_LENGTH
export const SPC_DEFAULT_OFFICES = [
  "ITALY",
  "HONG KONG",
  "SINGAPORE",
  "MONACO",
  "FRANCE",
  "USA",
  "KOREA",
  "JAPAN",
  "VIETNAM",
] as const

type SpcUserRow = {
  id: string
  username: string
  display_name: string | null
  whatsapp_phone: string | null
  role: string
  password_hash: string
  is_active: boolean
  created_at: string
  updated_at: string
}

type SpcRoleDefaultRow = {
  role: string
  permissions: Record<string, unknown> | null
  updated_at: string | null
}

type SpcStoreRow = {
  key: string
  payload: Record<string, unknown>
  updated_at: string
}

type SpcPermissionGroupStorePayload = {
  groups?: Array<{
    role?: unknown
    permissions?: unknown
    updatedAt?: unknown
  }>
  userRoles?: Array<{
    userId?: unknown
    username?: unknown
    role?: unknown
    updatedAt?: unknown
  }>
  userProfiles?: Array<{
    userId?: unknown
    username?: unknown
    office?: unknown
    mustChangePassword?: unknown
    isSupplierTrader?: unknown
    updatedAt?: unknown
  }>
  offices?: unknown
}

type SpcUserRoleAssignment = {
  userId: string
  username: string
  role: string
  updatedAt: string | null
}

type SpcUserProfileAssignment = {
  userId: string
  username: string
  office: string
  mustChangePassword: boolean
  isSupplierTrader: boolean
  updatedAt: string | null
}

export type ManagedSpcUser = {
  id: string
  username: string
  displayName: string
  whatsappPhone: string
  role: SpcRoleId
  roleLabel: string
  office: string
  mustChangePassword: boolean
  isSupplierTrader: boolean
  permissions: SpcPagePermissionMap
  isActive: boolean
  createdAt: string
  updatedAt: string
  credentialUpdatedAt: string
}

export type SpcUserOption = {
  id: string
  username: string
  displayName: string
  role: SpcRoleId
  office: string
  isActive?: boolean
}

export type SpcAuditUserOption = {
  username: string
  displayName: string
}

export type ManagedSpcRoleDefault = {
  role: SpcRoleId
  label: string
  permissions: SpcPagePermissionMap
  updatedAt: string | null
  memberCount: number
  persisted: boolean
  isBuiltIn: boolean
}

export type AuthenticatedSpcUser = {
  id: string
  username: string
  displayName: string
  role: SpcRoleId
  office: string
  mustChangePassword: boolean
  permissions: SpcPagePermissionMap
  credentialUpdatedAt: string
  source: "database"
}

export type SpcAdminGuardUser = {
  id: string
  role: string
  isActive: boolean
}

export type SaveSpcUserInput = {
  id?: string
  username: string
  displayName?: string
  whatsappPhone?: string
  role?: string
  office?: string
  mustChangePassword?: boolean
  isSupplierTrader?: boolean
  password?: string
  isActive?: boolean
}

export type SaveSpcRoleDefaultInput = {
  role: string
  permissions?: SpcPagePermissionMap
}

type SpcActor = {
  username: string | null
  displayName: string | null
  role?: string | null
  pageId?: string
  pageLabel?: string
  pagePath?: string
}

function isSpcAuditContext(
  actor: SpcActor | undefined,
): actor is SpcAuditContext {
  if (!actor?.username) return false
  const candidate = actor as Partial<SpcAuditContext>
  return (
    typeof candidate.correlationId === "string" &&
    typeof candidate.requestId === "string" &&
    typeof candidate.action === "string" &&
    typeof candidate.outcome === "string"
  )
}

function withSpcAuditAction(
  actor: SpcActor | undefined,
  action: SpcAuditActionContext,
): SpcActor | undefined {
  if (!isSpcAuditContext(actor)) return actor
  return {
    ...actor,
    ...action,
  }
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function getServiceClient(actor?: SpcActor) {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for SPC user management.")
  }

  const headers = !actor?.username
    ? undefined
    : isSpcAuditContext(actor)
      ? createSpcAuditHeaders(actor)
      : {
          "x-bunker-admin-user": `spc:${actor.username}`,
          "x-bunker-admin-display-name": actor.displayName || actor.username,
          "x-bunker-admin-role": actor.role || "",
          "x-bunker-admin-page-id": actor.pageId || "spc-user-management",
          "x-bunker-admin-page-label": actor.pageLabel || "SPC USER MANAGEMENT",
          "x-bunker-admin-page-path": actor.pagePath || "/spc/usermanagement",
        }

  return createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), serviceRoleKey, {
    global: headers ? { headers } : undefined,
  })
}

function normaliseUsername(username: string) {
  return username.trim()
}

export function normaliseSpcWhatsappPhone(value: string | null | undefined) {
  const raw = String(value || "").trim()
  if (!raw) return ""

  let digits = raw.replace(/\D/g, "")
  if (raw.startsWith("00")) digits = digits.slice(2)
  if (!/^[1-9]\d{7,14}$/.test(digits)) {
    throw new Error("WhatsApp phone must include the country code, for example +65 9145 6766.")
  }
  return digits
}

export function normaliseSpcWhatsappPhoneInput(value: string | null | undefined) {
  const raw = String(value || "").trim()
  if (!raw) return ""
  if (!raw.startsWith("+") && !raw.startsWith("00")) {
    throw new Error("WhatsApp phone must include the country code, for example +65 9145 6766.")
  }
  return normaliseSpcWhatsappPhone(raw)
}

export function normaliseSpcWhatsappPhoneForAccount(
  value: string | null | undefined,
  isActive: boolean,
) {
  const phone = normaliseSpcWhatsappPhoneInput(value)
  if (isActive && !phone) {
    throw new Error("WhatsApp phone is required for an active SPC account.")
  }
  return phone
}

function normaliseOffice(value: string | null | undefined) {
  return (value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase()
}

function normaliseOfficeList(values: unknown) {
  const source = Array.isArray(values) ? values : [...SPC_DEFAULT_OFFICES]
  const seen = new Set<string>()
  const offices = source.flatMap((value) => {
    const office = typeof value === "string" ? normaliseOffice(value) : ""
    if (!office || seen.has(office)) return []
    seen.add(office)
    return [office]
  })

  return offices.length ? offices : [...SPC_DEFAULT_OFFICES]
}

function friendlySpcUserError(error: unknown) {
  if (error instanceof Error) return error
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") return new Error(message)
  }
  return new Error(String(error))
}

export function getSpcPasswordValidationError(password: string) {
  if (!password) return "Password is required."
  if (password.length < SPC_PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${SPC_PASSWORD_MIN_LENGTH} characters.`
  }
  if (password.length > SPC_PASSWORD_MAX_LENGTH) {
    return `Password must contain no more than ${SPC_PASSWORD_MAX_LENGTH} characters.`
  }
  return null
}

function requireValidSpcPassword(password: string) {
  const validationError = getSpcPasswordValidationError(password)
  if (validationError) throw new Error(validationError)
}

export function wouldRemoveFinalActiveSpcAdmin(
  users: SpcAdminGuardUser[],
  targetUserId: string,
  nextRole: string | null,
  nextIsActive: boolean,
) {
  const target = users.find((user) => user.id === targetUserId)
  if (
    !target?.isActive ||
    normaliseSpcRole(target.role) !== "ADMIN" ||
    (nextIsActive && normaliseSpcRole(nextRole) === "ADMIN")
  ) {
    return false
  }

  return !users.some(
    (user) =>
      user.id !== targetUserId &&
      user.isActive &&
      normaliseSpcRole(user.role) === "ADMIN",
  )
}

function orderRoles(roles: Iterable<string>) {
  const roleSet = new Set(Array.from(roles, normaliseSpcRole))
  const builtIns = SPC_BUILT_IN_ROLE_IDS.filter((role) => roleSet.delete(role))
  return [...builtIns, ...Array.from(roleSet).sort((a, b) => a.localeCompare(b))]
}

function getRoleDefaultMap(roleDefaults: ManagedSpcRoleDefault[]) {
  return roleDefaults.reduce<Record<string, ManagedSpcRoleDefault>>((defaults, roleDefault) => {
    defaults[roleDefault.role] = roleDefault
    return defaults
  }, {})
}

function parsePermissionGroupStore(payload: unknown): SpcRoleDefaultRow[] {
  if (!payload || typeof payload !== "object") return []
  const groups = (payload as SpcPermissionGroupStorePayload).groups
  if (!Array.isArray(groups)) return []

  return groups.flatMap((group) => {
    if (!group || typeof group !== "object" || typeof group.role !== "string") return []
    return [
      {
        role: normaliseSpcRole(group.role),
        permissions:
          group.permissions && typeof group.permissions === "object"
            ? (group.permissions as Record<string, unknown>)
            : {},
        updated_at: typeof group.updatedAt === "string" ? group.updatedAt : null,
      },
    ]
  })
}

function parseUserRoleStore(payload: unknown): SpcUserRoleAssignment[] {
  if (!payload || typeof payload !== "object") return []
  const userRoles = (payload as SpcPermissionGroupStorePayload).userRoles
  if (!Array.isArray(userRoles)) return []

  return userRoles.flatMap((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.userId !== "string" ||
      typeof item.username !== "string" ||
      typeof item.role !== "string"
    ) {
      return []
    }
    return [
      {
        userId: item.userId,
        username: item.username,
        role: normaliseSpcRole(item.role),
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null,
      },
    ]
  })
}

function parseUserProfileStore(payload: unknown): SpcUserProfileAssignment[] {
  if (!payload || typeof payload !== "object") return []
  const userProfiles = (payload as SpcPermissionGroupStorePayload).userProfiles
  if (!Array.isArray(userProfiles)) return []

  return userProfiles.flatMap((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.userId !== "string" ||
      typeof item.username !== "string"
    ) {
      return []
    }
    return [
      {
        userId: item.userId,
        username: item.username,
        office: normaliseOffice(typeof item.office === "string" ? item.office : "") || SPC_DEFAULT_OFFICES[0],
        mustChangePassword: item.mustChangePassword === true,
        isSupplierTrader: item.isSupplierTrader === true,
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null,
      },
    ]
  })
}

function buildStorePayload(
  rows: SpcRoleDefaultRow[],
  userRoles: SpcUserRoleAssignment[] = [],
  userProfiles: SpcUserProfileAssignment[] = [],
  offices: string[] = normaliseOfficeList(null),
) {
  return {
    groups: rows.map((row) => ({
      role: row.role,
      permissions: row.permissions || {},
      updatedAt: row.updated_at,
    })),
    userRoles: userRoles.map((assignment) => ({
      userId: assignment.userId,
      username: assignment.username,
      role: assignment.role,
      updatedAt: assignment.updatedAt,
    })),
    userProfiles: userProfiles.map((profile) => ({
      userId: profile.userId,
      username: profile.username,
      office: profile.office,
      mustChangePassword: profile.mustChangePassword,
      isSupplierTrader: profile.isSupplierTrader,
      updatedAt: profile.updatedAt,
    })),
    offices,
  }
}

function getUserRoleMap(userRoles: SpcUserRoleAssignment[]) {
  return userRoles.reduce<Record<string, string>>((map, assignment) => {
    map[assignment.userId] = normaliseSpcRole(assignment.role)
    map[`username:${assignment.username.toLowerCase()}`] = normaliseSpcRole(assignment.role)
    return map
  }, {})
}

function getUserProfileMap(userProfiles: SpcUserProfileAssignment[]) {
  return userProfiles.reduce<Record<string, SpcUserProfileAssignment>>((map, assignment) => {
    map[assignment.userId] = assignment
    map[`username:${assignment.username.toLowerCase()}`] = assignment
    return map
  }, {})
}

function getStoredSpcRole(row: SpcUserRow, userRoleMap: Record<string, string> = {}) {
  return normaliseSpcRole(userRoleMap[row.id] || userRoleMap[`username:${row.username.toLowerCase()}`] || row.role)
}

function getDatabaseRole(role: string) {
  return normaliseSpcRole(role) === "SUPPLIER TRADER" ? "supplier_trader" : "buyer_trader"
}

function mergeStoredPermissionsWithRoleDefaults(
  role: string,
  storedPermissions: Record<string, unknown> | null | undefined,
  pages: SpcPageDefinition[],
) {
  const defaults = getDefaultSpcPermissionsForRole(role, pages)
  const source =
    storedPermissions && typeof storedPermissions === "object" ? storedPermissions : {}

  return pages.reduce<SpcPagePermissionMap>((permissions, page) => {
    const value = source[page.id]
    const permission =
      value === "edit" || value === "view" || value === "none"
        ? value
        : defaults[page.id] || "none"
    permissions[page.id] = constrainSpcPermissionForRole(
      role,
      page.id,
      permission,
    )
    return permissions
  }, {})
}

function buildManagedRoleDefaults(
  storedRows: SpcRoleDefaultRow[],
  userRows: SpcUserRow[],
  pages: SpcPageDefinition[],
  userRoleMap: Record<string, string> = {},
) {
  const storedByRole = new Map(storedRows.map((row) => [normaliseSpcRole(row.role), row]))
  const usersByRole = new Map<string, SpcUserRow[]>()

  userRows.forEach((row) => {
    const role = getStoredSpcRole(row, userRoleMap)
    const existing = usersByRole.get(role)
    if (existing) existing.push(row)
    else usersByRole.set(role, [row])
  })

  const roles = orderRoles([
    ...SPC_BUILT_IN_ROLE_IDS,
    ...storedByRole.keys(),
    ...usersByRole.keys(),
  ])

  return roles.map<ManagedSpcRoleDefault>((role) => {
    const stored = storedByRole.get(role)
    const permissions = stored
      ? mergeStoredPermissionsWithRoleDefaults(role, stored.permissions, pages)
      : getDefaultSpcPermissionsForRole(role, pages)

    return {
      role,
      label: getSpcRoleLabel(role),
      permissions,
      updatedAt: stored?.updated_at || null,
      memberCount: usersByRole.get(role)?.length || 0,
      persisted: Boolean(stored),
      isBuiltIn: SPC_BUILT_IN_ROLE_IDS.includes(role as (typeof SPC_BUILT_IN_ROLE_IDS)[number]),
    }
  })
}

async function loadStoredRoleDefaults(supabase: ReturnType<typeof getServiceClient>) {
  const { data, error } = await supabase
    .from("office_calendar_store")
    .select("key,payload,updated_at")
    .eq("key", SPC_PERMISSION_GROUPS_STORE_KEY)
    .maybeSingle()

  if (error) throw error
  return {
    storeRow: (data as unknown as SpcStoreRow | null) || null,
    rows: parsePermissionGroupStore(data?.payload),
    userRoles: parseUserRoleStore(data?.payload),
    userProfiles: parseUserProfileStore(data?.payload),
    offices: normaliseOfficeList(data?.payload?.offices),
  }
}

async function saveStoredRoleDefault(
  supabase: ReturnType<typeof getServiceClient>,
  role: string,
  permissions: SpcPagePermissionMap,
) {
  const updatedAt = new Date().toISOString()
  const existing = await loadStoredRoleDefaults(supabase)
  const nextRow: SpcRoleDefaultRow = {
    role,
    permissions,
    updated_at: updatedAt,
  }
  const nextRows = existing.rows.some((row) => normaliseSpcRole(row.role) === role)
    ? existing.rows.map((row) => (normaliseSpcRole(row.role) === role ? nextRow : row))
    : [...existing.rows, nextRow]
  const payload = buildStorePayload(nextRows, existing.userRoles, existing.userProfiles, existing.offices)
  const afterRow: SpcStoreRow = {
    key: SPC_PERMISSION_GROUPS_STORE_KEY,
    payload,
    updated_at: updatedAt,
  }

  const { error } = await supabase.from("office_calendar_store").upsert(afterRow)
  if (error) throw error
  return nextRow
}

async function deleteStoredRoleDefault(
  supabase: ReturnType<typeof getServiceClient>,
  role: string,
) {
  const existing = await loadStoredRoleDefaults(supabase)
  const nextRows = existing.rows.filter((row) => normaliseSpcRole(row.role) !== role)
  const updatedAt = new Date().toISOString()
  const afterRow: SpcStoreRow = {
    key: SPC_PERMISSION_GROUPS_STORE_KEY,
    payload: buildStorePayload(nextRows, existing.userRoles, existing.userProfiles, existing.offices),
    updated_at: updatedAt,
  }

  const { error } = await supabase.from("office_calendar_store").upsert(afterRow)
  if (error) throw error
}

async function saveStoredUserMetadata(
  supabase: ReturnType<typeof getServiceClient>,
  row: SpcUserRow,
  role: string,
  profile: {
    office?: string
    mustChangePassword?: boolean
    isSupplierTrader?: boolean
  },
) {
  const existing = await loadStoredRoleDefaults(supabase)
  const updatedAt = new Date().toISOString()
  const roleId = normaliseSpcRole(role)
  const profileByUser = getUserProfileMap(existing.userProfiles)
  const previousProfile = profileByUser[row.id] || profileByUser[`username:${row.username.toLowerCase()}`]
  const nextUserRoles = existing.userRoles
    .filter(
      (assignment) =>
        assignment.userId !== row.id &&
        assignment.username.toLowerCase() !== row.username.toLowerCase(),
    )

  if (roleId !== normaliseSpcRole(row.role)) {
    nextUserRoles.push({
      userId: row.id,
      username: row.username,
      role: roleId,
      updatedAt,
    })
  }

  const nextOffice =
    normaliseOffice(profile.office) ||
    previousProfile?.office ||
    existing.offices[0] ||
    SPC_DEFAULT_OFFICES[0]
  const nextUserProfiles = existing.userProfiles
    .filter(
      (assignment) =>
        assignment.userId !== row.id &&
        assignment.username.toLowerCase() !== row.username.toLowerCase(),
    )

  nextUserProfiles.push({
    userId: row.id,
    username: row.username,
    office: nextOffice,
    mustChangePassword:
      typeof profile.mustChangePassword === "boolean"
        ? profile.mustChangePassword
        : previousProfile?.mustChangePassword === true,
    isSupplierTrader:
      typeof profile.isSupplierTrader === "boolean"
        ? profile.isSupplierTrader
        : previousProfile?.isSupplierTrader === true,
    updatedAt,
  })

  const nextOffices = normaliseOfficeList([...existing.offices, nextOffice])
  const afterRow: SpcStoreRow = {
    key: SPC_PERMISSION_GROUPS_STORE_KEY,
    payload: buildStorePayload(existing.rows, nextUserRoles, nextUserProfiles, nextOffices),
    updated_at: updatedAt,
  }
  const { error } = await supabase.from("office_calendar_store").upsert(afterRow)
  if (error) throw error
}

function mapSpcUser(
  row: SpcUserRow,
  roleDefaults: ManagedSpcRoleDefault[] = [],
  pages: SpcPageDefinition[] = SPC_PAGE_DEFINITIONS,
  userRoleMap: Record<string, string> = {},
  userProfileMap: Record<string, SpcUserProfileAssignment> = {},
): ManagedSpcUser {
  const role = getStoredSpcRole(row, userRoleMap)
  const profile = userProfileMap[row.id] || userProfileMap[`username:${row.username.toLowerCase()}`]
  const roleDefault = getRoleDefaultMap(roleDefaults)[role]
  const permissions = roleDefault?.permissions || getDefaultSpcPermissionsForRole(role, pages)

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    whatsappPhone: row.whatsapp_phone ? `+${normaliseSpcWhatsappPhone(row.whatsapp_phone)}` : "",
    role,
    roleLabel: getSpcRoleLabel(role),
    office: profile?.office || SPC_DEFAULT_OFFICES[0],
    mustChangePassword: profile?.mustChangePassword === true,
    isSupplierTrader: role === "SUPPLIER TRADER" || profile?.isSupplierTrader === true,
    permissions,
    isActive: row.is_active !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    credentialUpdatedAt: row.updated_at,
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

export async function loadManagedSpcRoleDefaults(
  pages: SpcPageDefinition[] = SPC_PAGE_DEFINITIONS,
) {
  try {
    const supabase = getServiceClient()
    const [stored, usersResult] = await Promise.all([
      loadStoredRoleDefaults(supabase),
      supabase.from("spc_users").select("*").order("username", { ascending: true }),
    ])

    if (usersResult.error) throw usersResult.error
    const userRoleMap = getUserRoleMap(stored.userRoles)

    return {
      roleDefaults: buildManagedRoleDefaults(
        stored.rows,
        (usersResult.data || []) as unknown as SpcUserRow[],
        pages,
        userRoleMap,
      ),
      storage: "shared-store" as const,
    }
  } catch (error) {
    throw friendlySpcUserError(error)
  }
}

export async function listManagedSpcRoleDefaults(
  pages: SpcPageDefinition[] = SPC_PAGE_DEFINITIONS,
) {
  return (await loadManagedSpcRoleDefaults(pages)).roleDefaults
}

export async function validateDatabaseSpcUser(
  username: string,
  password: string,
  pages: SpcPageDefinition[] = SPC_PAGE_DEFINITIONS,
) {
  const supabase = getServiceClient()
  const { data, error } = await supabase
    .from("spc_users")
    .select("*")
    .eq("username", normaliseUsername(username))
    .eq("is_active", true)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as SpcUserRow
  const passwordMatches = await verifyPassword(password, row.password_hash)
  if (!passwordMatches) return null

  const stored = await loadStoredRoleDefaults(supabase)
  const userRoleMap = getUserRoleMap(stored.userRoles)
  const userProfileMap = getUserProfileMap(stored.userProfiles)
  const roleDefaults = buildManagedRoleDefaults(stored.rows, [row], pages, userRoleMap)
  const user = mapSpcUser(row, roleDefaults, pages, userRoleMap, userProfileMap)
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    office: user.office,
    mustChangePassword: user.mustChangePassword,
    permissions: user.permissions,
    credentialUpdatedAt: user.credentialUpdatedAt,
    source: "database" as const,
  }
}

export async function getDatabaseSpcUserByUsername(
  username: string,
  pages: SpcPageDefinition[] = SPC_PAGE_DEFINITIONS,
) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null

  try {
    const supabase = getServiceClient()
    const { data, error } = await supabase
      .from("spc_users")
      .select("*")
      .eq("username", normaliseUsername(username))
      .eq("is_active", true)
      .maybeSingle()

    if (error || !data) return null

    const row = data as SpcUserRow
    const stored = await loadStoredRoleDefaults(supabase)
    const userRoleMap = getUserRoleMap(stored.userRoles)
    const userProfileMap = getUserProfileMap(stored.userProfiles)
    const roleDefaults = buildManagedRoleDefaults(stored.rows, [row], pages, userRoleMap)
    const user = mapSpcUser(row, roleDefaults, pages, userRoleMap, userProfileMap)
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      office: user.office,
      mustChangePassword: user.mustChangePassword,
      permissions: user.permissions,
      credentialUpdatedAt: user.credentialUpdatedAt,
      source: "database" as const,
    }
  } catch {
    return null
  }
}

export async function getDatabaseSpcUserById(
  id: string,
  pages: SpcPageDefinition[] = SPC_PAGE_DEFINITIONS,
) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null

  try {
    const supabase = getServiceClient()
    const { data, error } = await supabase
      .from("spc_users")
      .select("*")
      .eq("id", id)
      .eq("is_active", true)
      .maybeSingle()

    if (error || !data) return null

    const row = data as SpcUserRow
    const stored = await loadStoredRoleDefaults(supabase)
    const userRoleMap = getUserRoleMap(stored.userRoles)
    const userProfileMap = getUserProfileMap(stored.userProfiles)
    const roleDefaults = buildManagedRoleDefaults(stored.rows, [row], pages, userRoleMap)
    const user = mapSpcUser(row, roleDefaults, pages, userRoleMap, userProfileMap)
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      office: user.office,
      mustChangePassword: user.mustChangePassword,
      permissions: user.permissions,
      credentialUpdatedAt: user.credentialUpdatedAt,
      source: "database" as const,
    }
  } catch {
    return null
  }
}

export async function listManagedSpcUsers(
  roleDefaults?: ManagedSpcRoleDefault[],
  pages: SpcPageDefinition[] = SPC_PAGE_DEFINITIONS,
) {
  try {
    const supabase = getServiceClient()
    const defaults = roleDefaults || (await listManagedSpcRoleDefaults(pages))
    const stored = await loadStoredRoleDefaults(supabase)
    const userRoleMap = getUserRoleMap(stored.userRoles)
    const userProfileMap = getUserProfileMap(stored.userProfiles)
    const { data, error } = await supabase
      .from("spc_users")
      .select("*")
      .order("role", { ascending: true })
      .order("username", { ascending: true })

    if (error) throw error
    return ((data || []) as unknown as SpcUserRow[]).map((row) =>
      mapSpcUser(row, defaults, pages, userRoleMap, userProfileMap),
    )
  } catch (error) {
    throw friendlySpcUserError(error)
  }
}

export async function listSpcAuditUserOptions(): Promise<SpcAuditUserOption[]> {
  try {
    const supabase = getServiceClient()
    const { data, error } = await supabase
      .from("spc_users")
      .select("username,display_name")
      .order("display_name", { ascending: true })
      .order("username", { ascending: true })

    if (error) throw error
    return ((data || []) as Array<{ username: string; display_name: string | null }>)
      .map((user) => ({
        username: user.username,
        displayName: user.display_name?.trim() || user.username,
      }))
      .filter((user) => user.username.trim())
  } catch (error) {
    throw friendlySpcUserError(error)
  }
}

export function isActiveSupplierTraderOption(
  user: Pick<ManagedSpcUser, "isActive" | "isSupplierTrader">,
) {
  return user.isActive && user.isSupplierTrader
}

export async function listSupplierTraderOptions(
  roleDefaults?: ManagedSpcRoleDefault[],
  pages: SpcPageDefinition[] = SPC_PAGE_DEFINITIONS,
) {
  const users = await listManagedSpcUsers(roleDefaults, pages)
  return users
    .filter(isActiveSupplierTraderOption)
    .map((user) => ({
      username: user.username,
      displayName: user.displayName || user.username,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
}

export async function listActiveSpcUserOptions(
  roleDefaults?: ManagedSpcRoleDefault[],
  pages: SpcPageDefinition[] = SPC_PAGE_DEFINITIONS,
): Promise<SpcUserOption[]> {
  const users = await listManagedSpcUsers(roleDefaults, pages)
  return users
    .filter((user) => user.isActive)
    .map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName || user.username,
      role: user.role,
      office: user.office,
      isActive: true,
    }))
    .sort((a, b) => {
      const roleOrder = a.role.localeCompare(b.role)
      if (roleOrder !== 0) return roleOrder
      return a.displayName.localeCompare(b.displayName)
    })
}

export async function listSpcUserReferenceOptions(
  roleDefaults?: ManagedSpcRoleDefault[],
  pages: SpcPageDefinition[] = SPC_PAGE_DEFINITIONS,
): Promise<SpcUserOption[]> {
  const users = await listManagedSpcUsers(roleDefaults, pages)
  return users
    .map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName || user.username,
      role: user.role,
      office: user.office,
      isActive: user.isActive,
    }))
    .sort((a, b) => {
      const activeOrder = Number(b.isActive) - Number(a.isActive)
      if (activeOrder !== 0) return activeOrder
      const roleOrder = a.role.localeCompare(b.role)
      if (roleOrder !== 0) return roleOrder
      return a.displayName.localeCompare(b.displayName)
    })
}

export async function listManagedSpcOffices() {
  try {
    const supabase = getServiceClient()
    const stored = await loadStoredRoleDefaults(supabase)
    return stored.offices
  } catch (error) {
    throw friendlySpcUserError(error)
  }
}

async function writeOfficeStore(
  supabase: ReturnType<typeof getServiceClient>,
  offices: string[],
) {
  const existing = await loadStoredRoleDefaults(supabase)
  const updatedAt = new Date().toISOString()
  const afterRow: SpcStoreRow = {
    key: SPC_PERMISSION_GROUPS_STORE_KEY,
    payload: buildStorePayload(
      existing.rows,
      existing.userRoles,
      existing.userProfiles,
      normaliseOfficeList(offices),
    ),
    updated_at: updatedAt,
  }
  const { error } = await supabase.from("office_calendar_store").upsert(afterRow)
  if (error) throw error
  return normaliseOfficeList(offices)
}

export async function saveManagedSpcOffice(officeInput: string, actor?: SpcActor) {
  const office = normaliseOffice(officeInput)
  if (!office) throw new Error("Office is required.")

  try {
    const supabase = getServiceClient(withSpcAuditAction(actor, {
      action: "save-office",
      targetType: "spc-office",
      targetId: office,
    }))
    const stored = await loadStoredRoleDefaults(supabase)
    return await writeOfficeStore(supabase, [...stored.offices, office])
  } catch (error) {
    throw friendlySpcUserError(error)
  }
}

export async function deleteManagedSpcOffice(officeInput: string, actor?: SpcActor) {
  const office = normaliseOffice(officeInput)
  if (!office) throw new Error("Office is required.")

  try {
    const supabase = getServiceClient(withSpcAuditAction(actor, {
      action: "delete-office",
      targetType: "spc-office",
      targetId: office,
    }))
    const stored = await loadStoredRoleDefaults(supabase)
    const updatedAt = new Date().toISOString()
    const nextOffices = normaliseOfficeList(stored.offices.filter((item) => item !== office))
    const fallbackOffice =
      nextOffices.find((item) => item !== office) ||
      SPC_DEFAULT_OFFICES.find((item) => item !== office) ||
      SPC_DEFAULT_OFFICES[0]
    const nextProfiles = stored.userProfiles.map((profile) =>
      profile.office === office
        ? {
            ...profile,
            office: fallbackOffice,
            updatedAt,
          }
        : profile,
    )
    const afterRow: SpcStoreRow = {
      key: SPC_PERMISSION_GROUPS_STORE_KEY,
      payload: buildStorePayload(stored.rows, stored.userRoles, nextProfiles, nextOffices),
      updated_at: updatedAt,
    }

    const { error } = await supabase.from("office_calendar_store").upsert(afterRow)
    if (error) throw error

    return nextOffices
  } catch (error) {
    throw friendlySpcUserError(error)
  }
}

export async function changeManagedSpcUserPassword(
  usernameInput: string,
  passwordInput: string,
  actor?: SpcActor,
) {
  const username = normaliseUsername(usernameInput)
  const password = passwordInput
  if (!username) throw new Error("Username is required.")
  requireValidSpcPassword(password)

  try {
    const lookupClient = getServiceClient(actor)
    const { data, error } = await lookupClient
      .from("spc_users")
      .select("*")
      .eq("username", username)
      .eq("is_active", true)
      .maybeSingle()
    if (error) throw error
    if (!data) throw new Error("User not found.")

    const row = data as SpcUserRow
    const supabase = getServiceClient(withSpcAuditAction(actor, {
      action: "change-password",
      targetType: "spc-user",
      targetId: row.id,
      targetUsername: row.username,
      passwordChanged: true,
    }))
    const stored = await loadStoredRoleDefaults(supabase)
    const userRoleMap = getUserRoleMap(stored.userRoles)
    const userProfileMap = getUserProfileMap(stored.userProfiles)
    const currentProfile = userProfileMap[row.id] || userProfileMap[`username:${row.username.toLowerCase()}`]
    const role = getStoredSpcRole(row, userRoleMap)
    const { data: updated, error: updateError } = await supabase
      .from("spc_users")
      .update({
        password_hash: await hashPassword(password),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .select("*")
      .single()
    if (updateError) throw updateError

    await saveStoredUserMetadata(
      supabase,
      updated as SpcUserRow,
      role,
      {
        office: currentProfile?.office || stored.offices[0] || SPC_DEFAULT_OFFICES[0],
        mustChangePassword: false,
      },
    )

    const nextStored = await loadStoredRoleDefaults(supabase)
    const roleDefaults = buildManagedRoleDefaults(
      nextStored.rows,
      [updated as SpcUserRow],
      SPC_PAGE_DEFINITIONS,
      getUserRoleMap(nextStored.userRoles),
    )
    return mapSpcUser(
      updated as SpcUserRow,
      roleDefaults,
      SPC_PAGE_DEFINITIONS,
      getUserRoleMap(nextStored.userRoles),
      getUserProfileMap(nextStored.userProfiles),
    )
  } catch (error) {
    throw friendlySpcUserError(error)
  }
}

export async function saveManagedSpcUser(
  input: SaveSpcUserInput,
  actor?: SpcActor,
  pages: SpcPageDefinition[] = SPC_PAGE_DEFINITIONS,
  roleDefaults: ManagedSpcRoleDefault[] = [],
) {
  const username = normaliseUsername(input.username)
  if (!username) throw new Error("Username is required.")

  const role = normaliseSpcRole(input.role)
  const roleDefault = getRoleDefaultMap(roleDefaults)[role]
  if (!roleDefault) throw new Error("Select a valid permission group.")
  const isActive = input.isActive !== false
  const whatsappPhone = normaliseSpcWhatsappPhoneForAccount(
    input.whatsappPhone,
    isActive,
  )
  const passwordInput = input.password || ""
  const auditActor = withSpcAuditAction(actor, {
    action: input.id ? "update-user" : "create-user",
    targetType: "spc-user",
    targetId: input.id || null,
    targetUsername: username,
    passwordChanged: Boolean(passwordInput),
  })

  try {
    const supabase = getServiceClient(auditActor)
    let passwordHash: string | null = null
    if (passwordInput) {
      requireValidSpcPassword(passwordInput)
      passwordHash = await hashPassword(passwordInput)
    } else if (!input.id) {
      throw new Error("Password is required for a new user.")
    }

    const { data, error } = await supabase
      .rpc("save_spc_user_with_admin_continuity", {
        p_user_id: input.id || null,
        p_username: username,
        p_display_name: input.displayName?.trim() || username,
        p_whatsapp_phone: whatsappPhone || null,
        p_database_role: getDatabaseRole(role),
        p_effective_role: role,
        p_office: normaliseOffice(input.office) || null,
        p_must_change_password:
          typeof input.mustChangePassword === "boolean"
            ? input.mustChangePassword
            : null,
        p_is_supplier_trader:
          typeof input.isSupplierTrader === "boolean"
            ? input.isSupplierTrader
            : null,
        p_password_hash: passwordHash,
        p_is_active: isActive,
      })
      .single()
    if (error) throw error
    const row = data as SpcUserRow
    const stored = await loadStoredRoleDefaults(supabase)
    return mapSpcUser(
      row,
      roleDefaults,
      pages,
      getUserRoleMap(stored.userRoles),
      getUserProfileMap(stored.userProfiles),
    )
  } catch (error) {
    throw friendlySpcUserError(error)
  }
}

export async function saveManagedSpcRoleDefault(
  input: SaveSpcRoleDefaultInput,
  actor?: SpcActor,
  pages: SpcPageDefinition[] = SPC_PAGE_DEFINITIONS,
) {
  if (!input.role.trim()) throw new Error("Group name is required.")
  const role = normaliseSpcRole(input.role)
  const requestedPermissions = normaliseSpcPagePermissions(
    input.permissions || getDefaultSpcPermissionsForRole(role, pages),
    "view",
    pages,
  )
  const permissions = pages.reduce<SpcPagePermissionMap>((result, page) => {
    result[page.id] = constrainSpcPermissionForRole(
      role,
      page.id,
      requestedPermissions[page.id],
    )
    return result
  }, {})

  try {
    const supabase = getServiceClient(withSpcAuditAction(actor, {
      action: "save-role-default",
      targetType: "spc-role",
      targetId: role,
    }))
    const [savedRow, usersResult, stored] = await Promise.all([
      saveStoredRoleDefault(supabase, role, permissions),
      supabase.from("spc_users").select("*").order("username", { ascending: true }),
      loadStoredRoleDefaults(supabase),
    ])

    if (usersResult.error) throw usersResult.error
    const userRoleMap = getUserRoleMap(stored.userRoles)
    const memberCount = ((usersResult.data || []) as unknown as SpcUserRow[]).filter(
      (row) => getStoredSpcRole(row, userRoleMap) === role,
    ).length

    return {
      role,
      label: getSpcRoleLabel(role),
      permissions,
      updatedAt: savedRow.updated_at,
      memberCount,
      persisted: true,
      isBuiltIn: SPC_BUILT_IN_ROLE_IDS.includes(role as (typeof SPC_BUILT_IN_ROLE_IDS)[number]),
    } satisfies ManagedSpcRoleDefault
  } catch (error) {
    throw friendlySpcUserError(error)
  }
}

export async function deleteManagedSpcRoleDefault(roleInput: string, actor?: SpcActor) {
  if (!roleInput.trim()) throw new Error("Group name is required.")
  const role = normaliseSpcRole(roleInput)

  if (SPC_BUILT_IN_ROLE_IDS.includes(role as (typeof SPC_BUILT_IN_ROLE_IDS)[number])) {
    throw new Error("Built-in permission groups cannot be deleted.")
  }

  try {
    const supabase = getServiceClient(withSpcAuditAction(actor, {
      action: "delete-role-default",
      targetType: "spc-role",
      targetId: role,
    }))
    const [usersResult, stored] = await Promise.all([
      supabase.from("spc_users").select("*").order("username", { ascending: true }),
      loadStoredRoleDefaults(supabase),
    ])
    const { data, error } = usersResult
    if (error) throw error
    const userRoleMap = getUserRoleMap(stored.userRoles)

    const memberCount = ((data || []) as unknown as SpcUserRow[]).filter(
      (row) => getStoredSpcRole(row, userRoleMap) === role,
    ).length

    if (memberCount > 0) {
      throw new Error("Move all users out of this group before deleting it.")
    }

    await deleteStoredRoleDefault(supabase, role)
  } catch (error) {
    throw friendlySpcUserError(error)
  }
}

export async function deleteManagedSpcUser(id: string, actor?: SpcActor) {
  if (!id) throw new Error("Missing user id.")

  try {
    const lookupClient = getServiceClient(actor)
    const { data: existingUser, error: lookupError } = await lookupClient
      .from("spc_users")
      .select("*")
      .eq("id", id)
      .maybeSingle()
    if (lookupError) throw lookupError
    const existingRow = existingUser as unknown as SpcUserRow | null
    const supabase = getServiceClient(withSpcAuditAction(actor, {
      action: "delete-user",
      targetType: "spc-user",
      targetId: id,
      targetUsername: existingRow?.username || null,
    }))
    const { error } = await supabase.rpc(
      "delete_spc_user_with_admin_continuity",
      { p_user_id: id },
    )
    if (error) throw error
  } catch (error) {
    throw friendlySpcUserError(error)
  }
}

export function spcUserCanManageUsers(user: ManagedSpcUser) {
  return user.isActive && canAccessSpcPage(user.permissions, "spc-user-management", "edit")
}

export {
  SPC_PAGE_DEFINITIONS,
  canAccessSpcPage,
  getDefaultSpcPermissionsForRole,
  getSpcRoleLabel,
  normaliseSpcPagePermissions,
  normaliseSpcRole,
}

export type { SpcPageDefinition, SpcPagePermission, SpcPagePermissionMap, SpcRoleId }
