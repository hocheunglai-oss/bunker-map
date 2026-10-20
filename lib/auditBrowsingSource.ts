import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { AUDIT_BROWSING_INDEX_SELECT, AUDIT_SELECT, mapAuditLog } from "@/lib/auditLog"
import { AuditBrowsingError, compareAuditBrowsePositions, validateAuditBrowsePosition, type AuditBrowsePosition } from "@/lib/auditBrowsingCursor"

export async function readAuditBrowsingBatch(client: SupabaseClient, after: AuditBrowsePosition | null, limit: number, options: { compact?: boolean } = {}) {
  // Exact count is the count of THIS raw keyset statement, not a displayed
  // history total. It proves exhaustion even with a lower provider row cap.
  let query = client.from("audit_logs").select(options.compact ? AUDIT_BROWSING_INDEX_SELECT : AUDIT_SELECT, { count: "exact" })
    .or("table_schema.eq.public,and(table_schema.eq.app,table_name.in.(outlook_template_insertion_attempts,spc_user_management_events,spc_mfa_test_events))")
    .in("actor_source", ["app", "header"])
    .order("occurred_at", { ascending: false }).order("id", { ascending: false }).limit(limit)
  if (after) {
    validateAuditBrowsePosition(after)
    query = query.or(`occurred_at.lt.${after.occurredAt},and(occurred_at.eq.${after.occurredAt},id.lt.${after.id})`)
  }
  const { data, count, error } = await query
  if (error || !Array.isArray(data) || !Number.isSafeInteger(count) || count! < data.length || data.length > limit
    || !data.length && count !== 0) throw new AuditBrowsingError(503)
  const records = (data as unknown as Parameters<typeof mapAuditLog>[0][]).map(mapAuditLog)
  let previous = after
  for (const record of records) {
    const position = { occurredAt: record.occurredAt, id: record.id }
    try { validateAuditBrowsePosition(position) } catch { throw new AuditBrowsingError(503) }
    if (previous && compareAuditBrowsePositions(position, previous) >= 0) throw new AuditBrowsingError(503)
    previous = position
  }
  return { records, exhausted: data.length === count }
}

/** Small non-secret classification map. Never silently accept a provider cap. */
export async function loadAuditBrowsingPortNames(client: SupabaseClient) {
  const ports = new Map<string, string>()
  let after: number | null = null
  for (;;) {
    let query = client.from("ports").select("id,name", { count: "exact" }).order("id", { ascending: true }).limit(250)
    if (after !== null) query = query.gt("id", after)
    const { data, count, error } = await query
    if (error || !Array.isArray(data) || !Number.isSafeInteger(count) || count! < data.length || data.length > 250
      || !data.length && count !== 0) throw new AuditBrowsingError(503)
    for (const port of data as Array<{ id: number; name: string }>) {
      if (!Number.isSafeInteger(port.id) || port.id < 0 || after !== null && port.id <= after || typeof port.name !== "string") throw new AuditBrowsingError(503)
      ports.set(String(port.id), port.name)
      after = port.id
    }
    if (data.length === count) return ports
  }
}

export async function loadAuditBrowsingUserNames(client: SupabaseClient, table: "admin_users" | "spc_users") {
  const users: Array<{ username: string; displayName: string }> = []
  const normalizedNames = new Map<string, string>()
  let after: string | null = null
  for (;;) {
    let query = client.from(table).select("id,username,display_name", { count: "exact" }).order("id", { ascending: true }).limit(250)
    if (after !== null) query = query.gt("id", after)
    const { data, count, error } = await query
    if (error || !Array.isArray(data) || !Number.isSafeInteger(count) || count! < data.length || data.length > 250
      || !data.length && count !== 0) throw new AuditBrowsingError(503)
    for (const user of data as Array<{ id: string; username: string; display_name: string | null }>) {
      if (typeof user.id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(user.id)
        || after !== null && user.id <= after || typeof user.username !== "string"
        || user.display_name !== null && typeof user.display_name !== "string") throw new AuditBrowsingError(503)
      after = user.id
      if (!user.username.trim()) continue
      const displayName = user.display_name?.trim() || user.username
      const normalized = user.username.trim().toLowerCase()
      // Do not choose an arbitrary winner if independently stored user names
      // collapse under the existing JavaScript normalization differently.
      if (normalizedNames.has(normalized) && normalizedNames.get(normalized) !== displayName) throw new AuditBrowsingError(503)
      normalizedNames.set(normalized, displayName)
      users.push({ username: user.username, displayName })
    }
    if (data.length === count) return users
  }
}
