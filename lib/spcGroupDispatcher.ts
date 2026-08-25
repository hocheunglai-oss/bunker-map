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
  vesselName: string
  imo: string
  eta: string
  hsfo: string
  vlsfo: string
  lsmgo: string
  remarks: string
}

export type SpcGroupDeliveryJob = {
  id: string
  enquiryId: string
  revisionNumber: number
  eventType: "created" | "amended" | "postponed" | "reoffer"
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

export type SpcGroupDeliveryAlert = SpcGroupDeliveryActivity & {
  status: "failed" | "manual_review"
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
  event_type: SpcGroupDeliveryJob["eventType"]
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
    vesselName: cleanText(input.vesselName, 300),
    imo: cleanText(input.imo, 20),
    eta: cleanText(input.eta, 300),
    hsfo: cleanText(input.hsfo, 500),
    vlsfo: cleanText(input.vlsfo, 500),
    lsmgo: cleanText(input.lsmgo, 500),
    remarks: cleanText(input.remarks, 1000),
  }
}

const AMENDMENT_FIELDS: Array<{ field: keyof SpcEnquirySnapshot; label: string }> = [
  { field: "vesselName", label: "Vessel Name" },
  { field: "imo", label: "IMO" },
  { field: "eta", label: "Date" },
  { field: "hsfo", label: "Quantity" },
  { field: "vlsfo", label: "Quantity" },
  { field: "lsmgo", label: "Quantity" },
  { field: "remarks", label: "Remarks" },
]

export function diffSpcEnquirySnapshots(
  before: SpcEnquirySnapshot,
  after: SpcEnquirySnapshot,
): SpcAmendmentChange[] {
  return AMENDMENT_FIELDS.flatMap(({ field, label }) => {
    const previous = cleanText(before[field])
    const next = cleanText(after[field])
    if (previous === next) return []
    const nextLabel = (field === "hsfo" || field === "vlsfo" || field === "lsmgo") && !previous && next
      ? "Grade Added"
      : label
    return [{ field, label: nextLabel, before: previous, after: next }]
  })
}

function enquirySegments(value: string) {
  return cleanText(value)
    .split(/\s*\/\s*/)
    .map((segment) => cleanText(segment).replace(/\*/g, ""))
    .filter(Boolean)
}

function unchangedSegmentIndexes(current: string[], original: string[]) {
  const lengths = Array.from({ length: current.length + 1 }, () =>
    Array<number>(original.length + 1).fill(0),
  )
  for (let currentIndex = current.length - 1; currentIndex >= 0; currentIndex -= 1) {
    for (let originalIndex = original.length - 1; originalIndex >= 0; originalIndex -= 1) {
      lengths[currentIndex][originalIndex] =
        current[currentIndex].toLowerCase() === original[originalIndex].toLowerCase()
          ? lengths[currentIndex + 1][originalIndex + 1] + 1
          : Math.max(lengths[currentIndex + 1][originalIndex], lengths[currentIndex][originalIndex + 1])
    }
  }

  const unchanged = new Set<number>()
  let currentIndex = 0
  let originalIndex = 0
  while (currentIndex < current.length && originalIndex < original.length) {
    if (current[currentIndex].toLowerCase() === original[originalIndex].toLowerCase()) {
      unchanged.add(currentIndex)
      currentIndex += 1
      originalIndex += 1
    } else if (lengths[currentIndex + 1][originalIndex] >= lengths[currentIndex][originalIndex + 1]) {
      currentIndex += 1
    } else {
      originalIndex += 1
    }
  }
  return unchanged
}

function changedSegmentIndexes(current: string[], original: string[]) {
  const unchanged = unchangedSegmentIndexes(current, original)
  return new Set(current.map((_segment, index) => index).filter((index) => !unchanged.has(index)))
}

const AMENDMENT_LABEL_ORDER = ["Vessel Name", "IMO", "Date", "Quantity", "Grade Added", "Remarks"]

function segmentLabel(current: string[], original: string[], index: number) {
  if (index === 0) return "Vessel Name"
  if (index === 1 && /^\d{7}$/.test(current[index] || "")) return "IMO"
  if (index === 2) return "Date"

  const currentGrade = cleanText(current[index]).split(/\s+/)[0]?.toLowerCase() || ""
  const originalGrade = cleanText(original[index]).split(/\s+/)[0]?.toLowerCase() || ""
  return currentGrade && currentGrade !== originalGrade ? "Grade Added" : "Quantity"
}

function semanticChangesFromFormattedText(beforeText: string, afterText: string) {
  const before = enquirySegments(beforeText)
  const after = enquirySegments(afterText)
  const changed = changedSegmentIndexes(after, before)
  return Array.from(changed).map((index) => {
    const label = segmentLabel(after, before, index)
    const field = index === 0
      ? "vesselName"
      : label === "IMO"
        ? "imo"
        : label === "Date"
          ? "eta"
          : cleanText(after[index]).split(/\s+/)[0]?.toLowerCase() || `segment-${index}`
    return {
      field,
      label,
      before: before[index] || "",
      after: after[index] || "",
    }
  })
}

export function normalizeSpcAmendmentChanges(changes: SpcAmendmentChange[]) {
  const textChange = changes.find(
    (change) => change.field === "notes" && change.before && change.after,
  )
  if (textChange) return semanticChangesFromFormattedText(textChange.before, textChange.after)

  const semanticFields = new Set(["vesselName", "imo", "eta", "hsfo", "vlsfo", "lsmgo", "remarks"])
  const semantic = changes.filter((change) => semanticFields.has(change.field))
  if (semantic.length > 0) return semantic

  return changes.flatMap((change) => {
    if (change.field === "title") {
      return [{ ...change, field: "vesselName", label: "Vessel Name" }]
    }
    if (change.field === "deliveryDate" || change.field === "port") {
      return [{ ...change, field: "eta", label: "Date" }]
    }
    if (change.field === "product" || change.field === "quantity") {
      return [{ ...change, label: change.before ? "Quantity" : "Grade Added" }]
    }
    return []
  })
}

function amendmentLabels(
  changes: SpcAmendmentChange[],
  current: string[],
  original: string[],
  changed: Set<number>,
) {
  const labels = new Set(
    normalizeSpcAmendmentChanges(changes)
      .map((change) => cleanText(change.label, 100))
      .filter(Boolean),
  )
  if (labels.size === 0) {
    changed.forEach((index) => labels.add(segmentLabel(current, original, index)))
  }
  return AMENDMENT_LABEL_ORDER.filter((label) => labels.has(label))
}

export function buildSpcGroupAmendmentMessage(
  formattedText: string,
  originalFormattedText: string,
  changes: SpcAmendmentChange[] = [],
) {
  const current = enquirySegments(formattedText)
  const original = enquirySegments(originalFormattedText)
  const changed = changedSegmentIndexes(current, original)
  const amended = current
    .map((segment, index) => (changed.has(index) ? `*${segment}*` : segment))
    .join(" / ")
  const labels = amendmentLabels(changes, current, original, changed)
  const heading = `${(labels.length ? labels : ["Enquiry"]).join(" / ")} Amended`
  return amended ? `${heading}\n${amended}` : heading
}

export function buildSpcGroupReofferMessage(formattedText: string) {
  return cleanText(formattedText)
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

export async function listRecentSpcGroupDeliveries(token: string, hours = 24, limit = 100) {
  const authenticated = await authenticatedDispatcher(token)
  if (!authenticated) return null
  const safeHours = Math.min(Math.max(Math.trunc(hours), 1), 72)
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200)
  const since = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString()
  const { data, error } = await authenticated.supabase
    .from("spc_group_delivery_jobs")
    .select("id,enquiry_id,revision_number,event_type,message_text,destination_route_label,destination_group_name,attempt_count,status,last_error,updated_at")
    .eq("status", "sent")
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(safeLimit)
  if (error) throw error
  return ((data || []) as DeliveryActivityRow[]).map(mapActivity)
}

export async function listSpcGroupDeliveryAlerts(hours = 24, limit = 50) {
  const safeHours = Math.min(Math.max(Math.trunc(hours), 1), 72)
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100)
  const since = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString()
  const { data, error } = await serviceClient()
    .from("spc_group_delivery_jobs")
    .select("id,enquiry_id,revision_number,event_type,message_text,destination_route_label,destination_group_name,attempt_count,status,last_error,updated_at")
    .in("status", ["failed", "manual_review"])
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(safeLimit)
  if (error) throw error
  return ((data || []) as DeliveryActivityRow[]).map(mapActivity) as SpcGroupDeliveryAlert[]
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
