import { randomBytes, scrypt, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"
import { createClient } from "@supabase/supabase-js"

const scryptAsync = promisify(scrypt)

export const SPC_ROLE_IDS = ["buyer_trader", "supplier_trader"] as const

export type SpcRoleId = (typeof SPC_ROLE_IDS)[number]

export const SPC_ROLE_DEFINITIONS: Array<{
  id: SpcRoleId
  label: string
  description: string
}> = [
  {
    id: "buyer_trader",
    label: "Buyer Trader",
    description: "Create SPC enquiries, review enquiry history, and manage SPC users.",
  },
  {
    id: "supplier_trader",
    label: "Supplier Trader",
    description: "Use the SPC WhatsApp supplier workspace.",
  },
]

type SpcUserRow = {
  id: string
  username: string
  display_name: string | null
  role: string
  password_hash: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export type ManagedSpcUser = {
  id: string
  username: string
  displayName: string
  role: SpcRoleId
  roleLabel: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export type AuthenticatedSpcUser = {
  username: string
  displayName: string
  role: SpcRoleId
  source: "database"
}

export type SaveSpcUserInput = {
  id?: string
  username: string
  displayName?: string
  role?: string
  password?: string
  isActive?: boolean
}

type SpcActor = {
  username: string | null
  displayName: string | null
  role?: string | null
  pageId?: string
  pageLabel?: string
  pagePath?: string
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

  return createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), serviceRoleKey, {
    global: actor?.username
      ? {
          headers: {
            "x-bunker-admin-user": `spc:${actor.username}`,
            "x-bunker-admin-display-name": actor.displayName || actor.username,
            "x-bunker-admin-role": actor.role || "",
            "x-bunker-admin-page-id": actor.pageId || "spc-user-management",
            "x-bunker-admin-page-label": actor.pageLabel || "SPC USER MANAGEMENT",
            "x-bunker-admin-page-path": actor.pagePath || "/spc/usermanagement",
          },
        }
      : undefined,
  })
}

function normaliseUsername(username: string) {
  return username.trim()
}

export function normaliseSpcRole(role: string | null | undefined): SpcRoleId {
  const normalized = (role || "").trim().toLowerCase().replace(/[\s-]+/g, "_")
  return normalized === "supplier_trader" ? "supplier_trader" : "buyer_trader"
}

export function getSpcRoleLabel(role: string | null | undefined) {
  const roleId = normaliseSpcRole(role)
  return SPC_ROLE_DEFINITIONS.find((item) => item.id === roleId)?.label || "Buyer Trader"
}

function mapSpcUser(row: SpcUserRow): ManagedSpcUser {
  const role = normaliseSpcRole(row.role)
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    role,
    roleLabel: getSpcRoleLabel(role),
    isActive: row.is_active !== false,
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

function friendlySpcUserError(error: unknown) {
  if (error instanceof Error) return error
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") return new Error(message)
  }
  return new Error(String(error))
}

export async function validateDatabaseSpcUser(username: string, password: string) {
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
    const passwordMatches = await verifyPassword(password, row.password_hash)
    if (!passwordMatches) return null

    const user = mapSpcUser(row)
    return {
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      source: "database" as const,
    }
  } catch {
    return null
  }
}

export async function getDatabaseSpcUserByUsername(username: string) {
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

    const user = mapSpcUser(data as SpcUserRow)
    return {
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      source: "database" as const,
    }
  } catch {
    return null
  }
}

export async function listManagedSpcUsers() {
  try {
    const supabase = getServiceClient()
    const { data, error } = await supabase
      .from("spc_users")
      .select("*")
      .order("role", { ascending: true })
      .order("username", { ascending: true })

    if (error) throw error
    return ((data || []) as unknown as SpcUserRow[]).map(mapSpcUser)
  } catch (error) {
    throw friendlySpcUserError(error)
  }
}

export async function saveManagedSpcUser(input: SaveSpcUserInput, actor?: SpcActor) {
  const username = normaliseUsername(input.username)
  if (!username) throw new Error("Username is required.")

  const role = normaliseSpcRole(input.role)
  const now = new Date().toISOString()

  try {
    const supabase = getServiceClient(actor)
    const payload: Record<string, unknown> = {
      username,
      display_name: input.displayName?.trim() || username,
      role,
      is_active: input.isActive !== false,
      updated_at: now,
    }

    if (input.password?.trim()) {
      payload.password_hash = await hashPassword(input.password)
    } else if (!input.id) {
      throw new Error("Password is required for a new user.")
    }

    const query = input.id
      ? supabase.from("spc_users").update(payload).eq("id", input.id)
      : supabase.from("spc_users").insert(payload)

    const { data, error } = await query.select("*").single()
    if (error) throw error
    return mapSpcUser(data as SpcUserRow)
  } catch (error) {
    throw friendlySpcUserError(error)
  }
}

export async function deleteManagedSpcUser(id: string, actor?: SpcActor) {
  if (!id) throw new Error("Missing user id.")

  try {
    const supabase = getServiceClient(actor)
    const { error } = await supabase.from("spc_users").delete().eq("id", id)
    if (error) throw error
  } catch (error) {
    throw friendlySpcUserError(error)
  }
}
