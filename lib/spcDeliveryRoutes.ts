import "server-only"

import { createClient } from "@supabase/supabase-js"
import {
  createSpcAuditedSupabaseClient,
  type SpcAuditContext,
} from "@/lib/spcAudit"

type SpcDeliveryRouteRow = {
  id: string
  label: string
  exact_group_name: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export type SpcDeliveryRoute = {
  id: string
  label: string
  exactGroupName: string
  isActive: boolean
  assignedUserCount: number
  createdAt: string
  updatedAt: string
}

export type SaveSpcDeliveryRouteInput = {
  id?: string
  label: string
  exactGroupName: string
  isActive?: boolean
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function serviceClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

function cleanText(value: unknown, maximumLength: number) {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").slice(0, maximumLength)
    : ""
}

function mapRoute(row: SpcDeliveryRouteRow, assignedUserCount = 0): SpcDeliveryRoute {
  return {
    id: row.id,
    label: row.label,
    exactGroupName: row.exact_group_name,
    isActive: row.is_active,
    assignedUserCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listSpcDeliveryRoutes() {
  const supabase = serviceClient()
  const [{ data, error }, { data: users, error: usersError }] = await Promise.all([
    supabase
      .from("spc_delivery_routes")
      .select("id,label,exact_group_name,is_active,created_at,updated_at")
      .order("is_active", { ascending: false })
      .order("label", { ascending: true }),
    supabase
      .from("spc_users")
      .select("delivery_route_id")
      .not("delivery_route_id", "is", null),
  ])
  if (error) throw error
  if (usersError) throw usersError

  const counts = (users || []).reduce<Record<string, number>>((result, user) => {
    const routeId = typeof user.delivery_route_id === "string" ? user.delivery_route_id : ""
    if (routeId) result[routeId] = (result[routeId] || 0) + 1
    return result
  }, {})

  return ((data || []) as SpcDeliveryRouteRow[]).map((row) =>
    mapRoute(row, counts[row.id] || 0),
  )
}

export async function requireActiveSpcDeliveryRouteForUsername(username: string) {
  const cleanUsername = cleanText(username, 320)
  if (!cleanUsername) throw new Error("Authenticated username is required.")
  const supabase = serviceClient()
  const { data: user, error: userError } = await supabase
    .from("spc_users")
    .select("delivery_route_id")
    .eq("username", cleanUsername.toLowerCase())
    .eq("is_active", true)
    .maybeSingle()
  if (userError) throw userError

  const routeId = typeof user?.delivery_route_id === "string" ? user.delivery_route_id : ""
  if (!routeId) throw new Error("No active enquiry delivery route is assigned to your account.")
  const { data, error } = await supabase
    .from("spc_delivery_routes")
    .select("id,label,exact_group_name,is_active,created_at,updated_at")
    .eq("id", routeId)
    .eq("is_active", true)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error("Your assigned enquiry delivery route is inactive.")
  return mapRoute(data as SpcDeliveryRouteRow)
}

export async function saveSpcDeliveryRoute(
  input: SaveSpcDeliveryRouteInput,
  auditContext: SpcAuditContext,
) {
  const label = cleanText(input.label, 100)
  const exactGroupName = cleanText(input.exactGroupName, 200)
  if (!label) throw new Error("Route label is required.")
  if (!exactGroupName) throw new Error("Exact WhatsApp group name is required.")

  const supabase = createSpcAuditedSupabaseClient(auditContext)
  const values = {
    label,
    exact_group_name: exactGroupName,
    is_active: input.isActive !== false,
    updated_at: new Date().toISOString(),
  }
  const query = input.id
    ? supabase.from("spc_delivery_routes").update(values).eq("id", input.id)
    : supabase.from("spc_delivery_routes").insert(values)
  const { data, error } = await query
    .select("id,label,exact_group_name,is_active,created_at,updated_at")
    .single()
  if (error) {
    if (error.code === "23505") {
      throw new Error("Route label and exact WhatsApp group name must each be unique.")
    }
    throw error
  }
  return mapRoute(data as SpcDeliveryRouteRow)
}

export async function deactivateSpcDeliveryRoute(
  id: string,
  auditContext: SpcAuditContext,
) {
  const routeId = cleanText(id, 64)
  if (!routeId) throw new Error("Delivery route is required.")
  const supabase = createSpcAuditedSupabaseClient(auditContext)
  const { count, error: countError } = await supabase
    .from("spc_users")
    .select("id", { count: "exact", head: true })
    .eq("delivery_route_id", routeId)
    .eq("is_active", true)
  if (countError) throw countError
  if ((count || 0) > 0) {
    throw new Error("Move all active users to another route before deactivating this route.")
  }

  const { data, error } = await supabase
    .from("spc_delivery_routes")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", routeId)
    .select("id,label,exact_group_name,is_active,created_at,updated_at")
    .single()
  if (error) throw error
  return mapRoute(data as SpcDeliveryRouteRow)
}

export async function getSpcGroupDeliveryHealth() {
  const supabase = serviceClient()
  const [routesResult, queuedResult, reviewResult, failedResult] = await Promise.all([
    supabase.from("spc_delivery_routes").select("id", { count: "exact", head: true }).eq("is_active", true),
    supabase.from("spc_group_delivery_jobs").select("id", { count: "exact", head: true }).in("status", ["queued", "claimed"]),
    supabase.from("spc_group_delivery_jobs").select("id", { count: "exact", head: true }).eq("status", "manual_review"),
    supabase.from("spc_group_delivery_jobs").select("id", { count: "exact", head: true }).eq("status", "failed"),
  ])
  for (const result of [routesResult, queuedResult, reviewResult, failedResult]) {
    if (result.error) throw result.error
  }
  return {
    activeRouteCount: routesResult.count || 0,
    queuedCount: queuedResult.count || 0,
    manualReviewCount: reviewResult.count || 0,
    failedCount: failedResult.count || 0,
  }
}
