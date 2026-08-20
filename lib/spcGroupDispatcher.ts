import "server-only"

import { createHash, randomBytes, randomUUID } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import type { SpcSession } from "@/lib/spcAuth"
import { createSpcAuditContext, createSpcAuditedSupabaseClient } from "@/lib/spcAudit"
import { SPC_GROUP_DISPATCHER_VERSION } from "@/lib/spcGroupDispatcherVersion"

export { SPC_GROUP_DISPATCHER_VERSION }

export type SpcAmendmentChange = {
  field: string
  label: string
  before: string
  after: string
}

export type SpcEnquirySnapshot = {
  title: string
  vesselName: string
  port: string
  product: string
  quantity: string
  deliveryDate: string
  supplierName: string
  notes: string
}

export type SpcGroupDeliveryJob = {
  id: string
  enquiryId: string
  revisionNumber: number
  eventType: "created" | "amended"
  messageText: string
  routeLabel: string
  groupName: string
  attemptCount: number
}

export type SpcGroupDeliveryActivity = SpcGroupDeliveryJob & {
  status: "claimed" | "sent" | "failed" | "manual_review"
  lastError: string
  updatedAt: string
}

type DispatcherRow = {
  id: string
  device_label: string
  group_name: string
  extension_version: string
  active: boolean
  last_seen_at: string | null
  last_error: string | null
}

type DeliveryJobRow = {
  id: string
  enquiry_id: string
  revision_number: number
  event_type: "created" | "amended"
  message_text: string
  destination_route_label: string
  destination_group_name: string
  attempt_count: number
}

type DeliveryActivityRow = DeliveryJobRow & {
  status: SpcGroupDeliveryActivity["status"]
  last_error: string | null
  updated_at: string
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

function cleanText(value: unknown, maximumLength = 12000) {
  const clean = typeof value === "string" ? value.trim() : ""
  return clean.slice(0, maximumLength)
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

function mapJob(row: DeliveryJobRow): SpcGroupDeliveryJob {
  return {
    id: row.id,
    enquiryId: row.enquiry_id,
    revisionNumber: row.revision_number,
    eventType: row.event_type,
    messageText: row.message_text,
    routeLabel: cleanText(row.destination_route_label, 100),
    groupName: cleanText(row.destination_group_name, 200),
    attemptCount: row.attempt_count,
  }
}

function mapActivity(row: DeliveryActivityRow): SpcGroupDeliveryActivity {
  return {
    ...mapJob(row),
    status: row.status,
    lastError: cleanText(row.last_error, 1000),
    updatedAt: row.updated_at,
  }
}

export function buildSpcEnquirySnapshot(input: Partial<SpcEnquirySnapshot>): SpcEnquirySnapshot {
  return {
    title: cleanText(input.title, 1000),
    vesselName: cleanText(input.vesselName, 300),
    port: cleanText(input.port, 300),
    product: cleanText(input.product, 500),
    quantity: cleanText(input.quantity, 500),
    deliveryDate: cleanText(input.deliveryDate, 20),
    supplierName: cleanText(input.supplierName, 500),
    notes: cleanText(input.notes),
  }
}

const AMENDMENT_FIELDS: Array<{ field: keyof SpcEnquirySnapshot; label: string }> = [
  { field: "vesselName", label: "Vessel" },
  { field: "title", label: "Enquiry" },
  { field: "deliveryDate", label: "ETA" },
  { field: "product", label: "Fuel" },
  { field: "quantity", label: "Quantity" },
  { field: "port", label: "Port" },
  { field: "supplierName", label: "Supplier" },
  { field: "notes", label: "Details" },
]

export function diffSpcEnquirySnapshots(
  before: SpcEnquirySnapshot,
  after: SpcEnquirySnapshot,
): SpcAmendmentChange[] {
  return AMENDMENT_FIELDS.flatMap(({ field, label }) => {
    const previous = cleanText(before[field])
    const next = cleanText(after[field])
    return previous === next ? [] : [{ field, label, before: previous, after: next }]
  })
}

function whatsappBold(value: string) {
  const clean = cleanText(value).replace(/\*/g, "")
  return clean ? `*${clean}*` : "*(removed)*"
}

export function buildSpcGroupAmendmentMessage(
  formattedText: string,
  revisionNumber: number,
  changes: SpcAmendmentChange[],
) {
  const details = changes
    .map((change) => {
      const before = change.before ? ` (was ${change.before.replace(/\*/g, "")})` : ""
      return `*${change.label}:* ${whatsappBold(change.after)}${before}`
    })
    .join("\n")
  return [`*AMENDED - REV ${revisionNumber}*`, cleanText(formattedText), details]
    .filter(Boolean)
    .join("\n\n")
}

export async function ensureCreatedSpcGroupDelivery(input: {
  enquiryId: string
  session: SpcSession
  request: Request
  formattedText: string
  snapshot: SpcEnquirySnapshot
}) {
  if (!input.session.username) throw new Error("Authenticated username is required.")
  const context = createSpcAuditContext(input.session, input.request, "spc-buyer-enquiries", {
    action: "enqueue-group-enquiry",
    targetType: "spc-group-delivery",
    targetId: input.enquiryId,
  })
  const supabase = createSpcAuditedSupabaseClient(context)
  const { error } = await supabase.rpc("enqueue_spc_enquiry_group_delivery", {
    p_enquiry_id: input.enquiryId,
    p_actor_username: input.session.username,
    p_actor_display_name: input.session.displayName || input.session.username,
    p_formatted_text: input.formattedText,
    p_after_snapshot: input.snapshot,
    p_message_text: input.formattedText,
  })
  if (error) throw error
}

export async function pairSpcGroupDispatcher(input: {
  session: SpcSession
  request: Request
  dispatcherId?: string
  deviceLabel: string
  groupName?: string
  extensionVersion: string
}) {
  if (!input.session.username) throw new Error("Authenticated username is required.")
  const dispatcherId = /^[0-9a-f-]{36}$/i.test(input.dispatcherId || "")
    ? String(input.dispatcherId)
    : randomUUID()
  const deviceLabel = cleanText(input.deviceLabel, 100)
  if (!deviceLabel) throw new Error("Device label is required.")

  const token = randomBytes(32).toString("base64url")
  const context = createSpcAuditContext(input.session, input.request, "spc-chrome-extension", {
    action: "pair-group-dispatcher",
    targetType: "spc-group-dispatcher",
    targetId: dispatcherId,
  })
  const supabase = createSpcAuditedSupabaseClient(context)
  const { error: deactivateError } = await supabase
    .from("spc_group_dispatchers")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("active", true)
  if (deactivateError) throw deactivateError

  const { error } = await supabase.from("spc_group_dispatchers").upsert({
    id: dispatcherId,
    device_label: deviceLabel,
    group_name: "MULTI-ROUTE",
    token_hash: tokenHash(token),
    extension_version: cleanText(input.extensionVersion, 30) || SPC_GROUP_DISPATCHER_VERSION,
    active: true,
    paired_by_username: input.session.username,
    paired_by_display_name: input.session.displayName || input.session.username,
    last_seen_at: new Date().toISOString(),
    last_error: null,
    updated_at: new Date().toISOString(),
  })
  if (error) throw error
  return { dispatcherId, token, groupName: "MULTI-ROUTE", deviceLabel }
}

export async function getActiveSpcGroupDispatcher() {
  const { data, error } = await serviceClient()
    .from("spc_group_dispatchers")
    .select("id,device_label,group_name,extension_version,active,last_seen_at,last_error")
    .eq("active", true)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const row = data as DispatcherRow
  return {
    id: row.id,
    deviceLabel: row.device_label,
    groupName: row.group_name,
    extensionVersion: row.extension_version,
    active: row.active,
    lastSeenAt: row.last_seen_at,
    lastError: row.last_error,
  }
}

export async function revokeSpcGroupDispatcher(session: SpcSession, request: Request) {
  const context = createSpcAuditContext(session, request, "spc-chrome-extension", {
    action: "revoke-group-dispatcher",
    targetType: "spc-group-dispatcher",
  })
  const { error } = await createSpcAuditedSupabaseClient(context)
    .from("spc_group_dispatchers")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("active", true)
  if (error) throw error
}

async function authenticatedDispatcher(token: string) {
  const clean = cleanText(token, 200)
  if (!clean) return null
  const supabase = serviceClient()
  const { data, error } = await supabase
    .from("spc_group_dispatchers")
    .select("id,device_label,group_name,extension_version,active,last_seen_at,last_error")
    .eq("token_hash", tokenHash(clean))
    .eq("active", true)
    .maybeSingle()
  if (error) throw error
  return data ? { supabase, row: data as DispatcherRow } : null
}

export async function heartbeatSpcGroupDispatcher(token: string, extensionVersion: string) {
  const authenticated = await authenticatedDispatcher(token)
  if (!authenticated) return null
  const now = new Date().toISOString()
  const { error } = await authenticated.supabase
    .from("spc_group_dispatchers")
    .update({
      last_seen_at: now,
      extension_version: cleanText(extensionVersion, 30) || authenticated.row.extension_version,
      last_error: null,
      updated_at: now,
    })
    .eq("id", authenticated.row.id)
    .eq("active", true)
  if (error) throw error
  return {
    id: authenticated.row.id,
    groupName: authenticated.row.group_name,
    deviceLabel: authenticated.row.device_label,
    extensionVersion: cleanText(extensionVersion, 30) || authenticated.row.extension_version,
  }
}

export async function claimSpcGroupDelivery(token: string, extensionVersion: string) {
  if (cleanText(extensionVersion, 30) !== SPC_GROUP_DISPATCHER_VERSION) {
    throw new Error(`Update the SPC Group Dispatcher to v${SPC_GROUP_DISPATCHER_VERSION} before sending.`)
  }
  const dispatcher = await heartbeatSpcGroupDispatcher(token, extensionVersion)
  if (!dispatcher) return null
  const claimToken = randomBytes(32).toString("base64url")
  const { data, error } = await serviceClient().rpc("claim_spc_group_delivery_job", {
    p_dispatcher_id: dispatcher.id,
    p_claim_token_hash: tokenHash(claimToken),
    p_lease_seconds: 90,
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : null
  return row
    ? { dispatcher, claimToken, job: mapJob(row as DeliveryJobRow) }
    : { dispatcher, claimToken: "", job: null }
}

export async function getLatestSpcGroupDelivery(token: string) {
  const authenticated = await authenticatedDispatcher(token)
  if (!authenticated) return null
  const { data, error } = await authenticated.supabase
    .from("spc_group_delivery_jobs")
    .select("id,enquiry_id,revision_number,event_type,message_text,destination_route_label,destination_group_name,attempt_count,status,last_error,updated_at")
    .eq("claimed_by", authenticated.row.id)
    .in("status", ["claimed", "sent", "failed", "manual_review"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data ? mapActivity(data as DeliveryActivityRow) : null
}

export async function completeSpcGroupDelivery(input: {
  token: string
  jobId: string
  claimToken: string
  result: "sent" | "failed" | "manual_review"
  error?: string
}) {
  const authenticated = await authenticatedDispatcher(input.token)
  if (!authenticated) return null
  const { data, error } = await authenticated.supabase.rpc("complete_spc_group_delivery_job", {
    p_job_id: input.jobId,
    p_dispatcher_id: authenticated.row.id,
    p_claim_token_hash: tokenHash(input.claimToken),
    p_result: input.result,
    p_error: cleanText(input.error, 1000) || null,
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : null
  return row ? mapJob(row as DeliveryJobRow) : null
}
