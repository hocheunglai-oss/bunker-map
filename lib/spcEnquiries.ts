import type { SpcSession } from "@/lib/spcAuth"
import { createSpcAuditContext, createSpcAuditedSupabaseClient } from "@/lib/spcAudit"
import {
  formatSpcEnquiry,
  formatSpcFuelSegment,
  parseSpcEnquiryText,
  readSpcEnquiryMeta,
  splitSpcEnquiryNotes,
  writeSpcEnquiryNotes,
  type SpcEnquiryMeta,
} from "@/lib/spcEnquiryText"
import { ensurePendingSpcFixtureForEnquiry } from "@/lib/spcFixtures"
import {
  buildSpcEnquirySnapshot,
  buildSpcGroupAmendmentMessage,
  buildSpcGroupReofferMessage,
  diffSpcEnquirySnapshots,
  ensureCreatedSpcGroupDelivery,
  normalizeSpcAmendmentChanges,
  type SpcAmendmentChange,
} from "@/lib/spcGroupDispatcher"

export type SpcEnquiry = {
  id: string
  enquiryNumber: string
  title: string
  vesselName: string | null
  port: string | null
  product: string | null
  quantity: string | null
  deliveryDate: string | null
  supplierName: string | null
  status: string
  notes: string | null
  meta: SpcEnquiryMeta
  formattedText: string
  createdByUsername: string
  createdByDisplayName: string
  revisionNumber: number
  lastAmendedAt: string | null
  lastAmendedByUsername: string | null
  amendmentChanges: SpcAmendmentChange[]
  createdAt: string
  updatedAt: string
}

export type SaveSpcEnquiryInput = {
  title?: string
  vesselName?: string
  port?: string
  product?: string
  quantity?: string
  deliveryDate?: string
  supplierName?: string
  notes?: string
}

export type SpcEnquiryListOptions = {
  status?: string
  limit?: number
  createdAfter?: string
  updatedAfter?: string
  updatedAfterId?: string
  createdByUsername?: string
}

export type SpcEnquiryOutcome = "stem" | "lost" | "postpone" | "cancel"

export type SpcEnquiryOutcomeInput = {
  outcome: SpcEnquiryOutcome
  lostReason?: string
  supplierTraderUsername?: string
  supplierTraderDisplayName?: string
}

export type SpcFixtureInput = {
  supplier?: string
  eta?: string
  hsfo?: string
  vlsfo?: string
  lsmgo?: string
  price?: string
  barging?: string
}

export type ReofferSpcEnquiryInput = SaveSpcEnquiryInput

type SpcEnquiryRow = {
  id: string
  enquiry_number: string
  title: string
  vessel_name: string | null
  port: string | null
  product: string | null
  quantity: string | null
  delivery_date: string | null
  supplier_name: string | null
  status: string
  notes: string | null
  created_by_username: string
  created_by_display_name: string
  revision_number: number
  last_amended_at: string | null
  last_amended_by_username: string | null
  last_amendment_changes: unknown
  created_at: string
  updated_at: string
}

function cleanText(value: string | undefined) {
  const trimmed = value?.trim() || ""
  return trimmed || null
}

function cleanDateInput(value: string | undefined) {
  const trimmed = value?.trim() || ""
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null
}

function mapEnquiry(row: SpcEnquiryRow): SpcEnquiry {
  const meta = readSpcEnquiryMeta(row.notes)
  const mapped = {
    id: row.id,
    enquiryNumber: row.enquiry_number,
    title: row.title,
    vesselName: row.vessel_name,
    port: row.port,
    product: row.product,
    quantity: row.quantity,
    deliveryDate: row.delivery_date,
    supplierName: row.supplier_name,
    status: row.status,
    notes: row.notes,
    meta,
    formattedText: "",
    createdByUsername: row.created_by_username,
    createdByDisplayName: row.created_by_display_name,
    revisionNumber: Number(row.revision_number || 1),
    lastAmendedAt: row.last_amended_at,
    lastAmendedByUsername: row.last_amended_by_username,
    amendmentChanges: [] as SpcAmendmentChange[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  mapped.formattedText = formatSpcEnquiry(mapped)
  mapped.amendmentChanges = normalizeSpcAmendmentChanges(
    sanitizeAmendmentChanges(row.last_amendment_changes),
  )
  return mapped
}

function sanitizeAmendmentChanges(value: unknown): SpcAmendmentChange[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const row = item as Record<string, unknown>
    const field = cleanText(typeof row.field === "string" ? row.field : undefined)
    const label = cleanText(typeof row.label === "string" ? row.label : undefined)
    if (!field || !label) return []
    return [{
      field,
      label,
      before: typeof row.before === "string" ? row.before : "",
      after: typeof row.after === "string" ? row.after : "",
    }]
  })
}

function enquirySnapshot(row: Pick<SpcEnquiryRow,
  "title" | "vessel_name" | "port" | "product" | "quantity" | "delivery_date" | "supplier_name" | "notes"
>) {
  const notesText = splitSpcEnquiryNotes(row.notes).text
  const meta = readSpcEnquiryMeta(row.notes)
  const parsed = parseSpcEnquiryText(notesText)
  return buildSpcEnquirySnapshot({
    vesselName: row.vessel_name || parsed.vesselName,
    imo: meta.imo || parsed.imo,
    eta: meta.eta || parsed.eta,
    hsfo: formatSpcFuelSegment("hsfo", meta.hsfo || parsed.hsfo),
    vlsfo: formatSpcFuelSegment("vlsfo", meta.vlsfo || parsed.vlsfo),
    lsmgo: formatSpcFuelSegment("lsmgo", meta.lsmgo || parsed.lsmgo),
    remarks: parsed.remarks,
  })
}

function requireEnquiryOwner(row: SpcEnquiryRow, session: SpcSession) {
  if (
    !session.username ||
    row.created_by_username.toLowerCase() !== session.username.toLowerCase()
  ) {
    throw new Error("Forbidden")
  }
}

async function loadSpcEnquiryRow(
  supabase: ReturnType<typeof createSpcAuditedSupabaseClient>,
  enquiryId: string,
) {
  const { data, error } = await supabase
    .from("spc_enquiries")
    .select("*")
    .eq("id", enquiryId)
    .single()

  if (error) throw error
  return data as SpcEnquiryRow
}

export async function listSpcEnquiries(session: SpcSession, options: SpcEnquiryListOptions = {}) {
  const context = createSpcAuditContext(session, undefined, "spc-buyer-enquiries")
  const supabase = createSpcAuditedSupabaseClient(context)
  const limit = Math.min(Math.max(Number(options.limit || 250), 1), 250)
  // This is a shared trading feed. Do not scope rows to session.username.
  let query = supabase
    .from("spc_enquiries")
    .select("*")
    .limit(limit)

  query = options.updatedAfter
    ? query.order("updated_at", { ascending: true }).order("id", { ascending: true })
    : query.order("created_at", { ascending: false }).order("id", { ascending: true })

  if (options.status) {
    query = query.eq("status", options.status)
  }
  if (options.createdAfter) {
    query = query.gt("created_at", options.createdAfter)
  }
  if (options.createdByUsername) {
    query = query.eq("created_by_username", options.createdByUsername)
  }

  if (options.updatedAfter) {
    query = options.updatedAfterId
      ? query.or(
          `updated_at.gt.${options.updatedAfter},and(updated_at.eq.${options.updatedAfter},id.gt.${options.updatedAfterId})`,
        )
      : query.gt("updated_at", options.updatedAfter)
  }

  const { data, error } = await query

  if (error) throw error
  return ((data || []) as unknown as SpcEnquiryRow[]).map(mapEnquiry)
}

export async function listSpcEnquiryIds(session: SpcSession, options: SpcEnquiryListOptions = {}) {
  const context = createSpcAuditContext(session, undefined, "spc-buyer-enquiries")
  const supabase = createSpcAuditedSupabaseClient(context)
  const limit = Math.min(Math.max(Number(options.limit || 250), 1), 250)
  let query = supabase
    .from("spc_enquiries")
    .select("id")
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(limit)

  if (options.status) query = query.eq("status", options.status)
  if (options.createdAfter) query = query.gt("created_at", options.createdAfter)
  if (options.createdByUsername) query = query.eq("created_by_username", options.createdByUsername)

  const { data, error } = await query
  if (error) throw error
  return (data || []).map((row) => String(row.id || "")).filter(Boolean)
}

export async function createSpcEnquiry(
  input: SaveSpcEnquiryInput,
  session: SpcSession,
  request: Request,
) {
  const title = cleanText(input.title)
  if (!title) throw new Error("Enquiry title is required.")
  if (!session.username) throw new Error("Authenticated username is required.")
  const context = createSpcAuditContext(session, request, "spc-buyer-enquiries", {
    action: "create-enquiry",
    targetType: "spc-enquiry",
  })
  const supabase = createSpcAuditedSupabaseClient(context)
  const notes = cleanText(input.notes)
  const duplicateWindow = new Date(Date.now() - 120000).toISOString()
  const duplicateQuery = supabase
    .from("spc_enquiries")
    .select("*")
    .eq("created_by_username", session.username)
    .eq("status", "sent")
    .gte("created_at", duplicateWindow)
    .order("created_at", { ascending: false })
    .limit(1)

  const { data: duplicate, error: duplicateError } = notes
    ? await duplicateQuery.eq("notes", notes).maybeSingle()
    : await duplicateQuery.eq("title", title).maybeSingle()

  if (duplicateError) throw duplicateError
  if (duplicate) {
    const enquiry = mapEnquiry(duplicate as SpcEnquiryRow)
    await ensureCreatedSpcGroupDelivery({
      enquiryId: enquiry.id,
      session,
      request,
      formattedText: enquiry.formattedText,
      snapshot: enquirySnapshot(duplicate as SpcEnquiryRow),
    })
    return enquiry
  }

  const { data, error } = await supabase
    .from("spc_enquiries")
    .insert({
      title,
      vessel_name: cleanText(input.vesselName),
      port: cleanText(input.port),
      product: cleanText(input.product),
      quantity: cleanText(input.quantity),
      delivery_date: cleanDateInput(input.deliveryDate),
      supplier_name: cleanText(input.supplierName),
      notes,
      status: "sent",
      created_by_username: session.username,
      created_by_display_name: session.displayName || session.username,
    })
    .select("*")
    .single()

  if (error) throw error
  const row = data as SpcEnquiryRow
  const enquiry = mapEnquiry(row)
  await ensureCreatedSpcGroupDelivery({
    enquiryId: enquiry.id,
    session,
    request,
    formattedText: enquiry.formattedText,
    snapshot: enquirySnapshot(row),
  })
  return enquiry
}

export async function amendSpcEnquiry(
  id: string,
  input: SaveSpcEnquiryInput,
  session: SpcSession,
  request: Request,
) {
  const enquiryId = cleanText(id)
  const title = cleanText(input.title)
  if (!enquiryId) throw new Error("Enquiry id is required.")
  if (!title) throw new Error("Enquiry title is required.")
  if (!session.username) throw new Error("Authenticated username is required.")
  const context = createSpcAuditContext(session, request, "spc-buyer-enquiries", {
    action: "amend-enquiry",
    targetType: "spc-enquiry",
    targetId: enquiryId,
  })
  const supabase = createSpcAuditedSupabaseClient(context)
  const existing = await loadSpcEnquiryRow(supabase, enquiryId)
  requireEnquiryOwner(existing, session)

  const providedNotes = cleanText(input.notes)
  const nextNotes = writeSpcEnquiryNotes(
    providedNotes || splitSpcEnquiryNotes(existing.notes).text,
    { ...readSpcEnquiryMeta(existing.notes), ...readSpcEnquiryMeta(providedNotes) },
  )
  const nextRow: SpcEnquiryRow = {
    ...existing,
    title,
    vessel_name: cleanText(input.vesselName),
    port: cleanText(input.port),
    product: cleanText(input.product),
    quantity: cleanText(input.quantity),
    delivery_date: cleanDateInput(input.deliveryDate),
    supplier_name: cleanText(input.supplierName),
    notes: nextNotes,
    revision_number: Number(existing.revision_number || 1) + 1,
    last_amended_at: new Date().toISOString(),
    last_amended_by_username: session.username,
    last_amendment_changes: [],
    updated_at: new Date().toISOString(),
  }
  const beforeSnapshot = enquirySnapshot(existing)
  const afterSnapshot = enquirySnapshot(nextRow)
  const changes = diffSpcEnquirySnapshots(beforeSnapshot, afterSnapshot)
  if (changes.length === 0) throw new Error("At least one enquiry field must change.")
  const originalFormattedText = formatSpcEnquiry(existing)
  const formattedText = formatSpcEnquiry(nextRow)
  const messageText = buildSpcGroupAmendmentMessage(
    formattedText,
    originalFormattedText,
    changes,
  )

  const { data, error } = await supabase.rpc("amend_spc_enquiry_with_group_delivery", {
    p_enquiry_id: enquiryId,
    p_actor_username: session.username,
    p_actor_display_name: session.displayName || session.username,
    p_enquiry: {
      title: nextRow.title,
      vesselName: nextRow.vessel_name,
      port: nextRow.port,
      product: nextRow.product,
      quantity: nextRow.quantity,
      deliveryDate: nextRow.delivery_date,
      supplierName: nextRow.supplier_name,
      notes: nextRow.notes,
    },
    p_formatted_text: formattedText,
    p_changed_fields: changes,
    p_message_text: messageText,
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : null
  if (!row) throw new Error("SPC amendment did not return the updated enquiry.")
  return mapEnquiry(row as SpcEnquiryRow)
}

export async function updateSpcEnquiryOutcome(
  id: string,
  input: SpcEnquiryOutcomeInput,
  session: SpcSession,
  request: Request,
) {
  const enquiryId = cleanText(id)
  if (!enquiryId) throw new Error("Enquiry id is required.")
  const outcome = input.outcome
  if (outcome !== "stem" && outcome !== "lost" && outcome !== "postpone" && outcome !== "cancel") {
    throw new Error("Outcome is required.")
  }
  if (outcome === "lost" && !cleanText(input.lostReason)) {
    throw new Error("Lost reason is required.")
  }
  if (outcome === "stem" && !cleanText(input.supplierTraderUsername)) {
    throw new Error("Supplier trader is required.")
  }

  const context = createSpcAuditContext(session, request, "spc-buyer-enquiries", {
    action: `set-enquiry-${outcome}`,
    targetType: "spc-enquiry",
    targetId: enquiryId,
  })
  const supabase = createSpcAuditedSupabaseClient(context)
  const existing = await loadSpcEnquiryRow(supabase, enquiryId)
  requireEnquiryOwner(existing, session)
  const status =
    outcome === "stem"
      ? "quoted"
      : outcome === "lost"
        ? "cancelled"
        : outcome === "cancel"
          ? "closed"
          : existing.status || "sent"
  const now = new Date().toISOString()
  const currentText = formatSpcEnquiry(existing)
  const nextMeta: SpcEnquiryMeta = {
    ...readSpcEnquiryMeta(existing.notes),
  }

  if (outcome === "lost") {
    nextMeta.outcomeAt = now
    nextMeta.lostReason = cleanText(input.lostReason) || undefined
    nextMeta.stemSupplierTraderUsername = undefined
    nextMeta.stemSupplierTraderDisplayName = undefined
    nextMeta.postponedAt = undefined
    nextMeta.cancelledAt = undefined
  } else if (outcome === "stem") {
    nextMeta.outcomeAt = now
    nextMeta.lostReason = undefined
    nextMeta.stemSupplierTraderUsername = cleanText(input.supplierTraderUsername) || undefined
    nextMeta.stemSupplierTraderDisplayName =
      cleanText(input.supplierTraderDisplayName) || cleanText(input.supplierTraderUsername) || undefined
    nextMeta.postponedAt = undefined
    nextMeta.cancelledAt = undefined
  } else if (outcome === "postpone") {
    nextMeta.postponedAt = now
    nextMeta.cancelledAt = undefined
  } else {
    nextMeta.outcomeAt = now
    nextMeta.lostReason = undefined
    nextMeta.stemSupplierTraderUsername = undefined
    nextMeta.stemSupplierTraderDisplayName = undefined
    nextMeta.postponedAt = undefined
    nextMeta.cancelledAt = now
  }

  const nextNotes = writeSpcEnquiryNotes(currentText, nextMeta)
  const { data, error } = await supabase
    .from("spc_enquiries")
    .update({
      status,
      notes: nextNotes,
      updated_at: now,
    })
    .eq("id", enquiryId)
    .select("*")
    .single()

  if (error) throw error
  if (outcome === "stem") {
    await ensurePendingSpcFixtureForEnquiry(data as SpcEnquiryRow, session, request)
  }
  return mapEnquiry(data as SpcEnquiryRow)
}

export async function reofferSpcEnquiry(
  id: string,
  input: ReofferSpcEnquiryInput,
  session: SpcSession,
  request: Request,
) {
  const enquiryId = cleanText(id)
  if (!enquiryId) throw new Error("Enquiry id is required.")
  const title = cleanText(input.title)
  if (!title) throw new Error("Enquiry title is required.")
  if (!session.username) throw new Error("Authenticated username is required.")
  const context = createSpcAuditContext(session, request, "spc-buyer-enquiries")
  const supabase = createSpcAuditedSupabaseClient(context)
  const existing = await loadSpcEnquiryRow(supabase, enquiryId)
  requireEnquiryOwner(existing, session)
  const currentText = formatSpcEnquiry(existing)
  const providedNotes = cleanText(input.notes)
  const now = new Date().toISOString()
  const newMeta: SpcEnquiryMeta = {
    ...readSpcEnquiryMeta(providedNotes),
    outcomeAt: undefined,
    postponedAt: undefined,
    cancelledAt: undefined,
    lostReason: undefined,
    stemSupplierTraderUsername: undefined,
    stemSupplierTraderDisplayName: undefined,
  }
  const nextRow: SpcEnquiryRow = {
    ...existing,
    id: "",
    enquiry_number: "",
    title,
    vessel_name: cleanText(input.vesselName),
    port: cleanText(input.port),
    product: cleanText(input.product),
    quantity: cleanText(input.quantity),
    delivery_date: cleanDateInput(input.deliveryDate),
    supplier_name: cleanText(input.supplierName),
    notes: writeSpcEnquiryNotes(providedNotes || currentText, newMeta),
    status: "sent",
    revision_number: 1,
    last_amended_at: null,
    last_amended_by_username: null,
    last_amendment_changes: [],
    created_by_username: session.username,
    created_by_display_name: session.displayName || session.username,
    created_at: now,
    updated_at: now,
  }
  const formattedText = formatSpcEnquiry(nextRow)
  const messageText = buildSpcGroupReofferMessage(formattedText)

  const retiredMeta: SpcEnquiryMeta = {
    ...readSpcEnquiryMeta(existing.notes),
    outcomeAt: now,
    postponedAt: undefined,
    cancelledAt: now,
    lostReason: undefined,
    stemSupplierTraderUsername: undefined,
    stemSupplierTraderDisplayName: undefined,
  }

  const { data, error } = await supabase.rpc("reoffer_spc_enquiry_with_group_delivery", {
    p_source_enquiry_id: enquiryId,
    p_actor_username: session.username,
    p_actor_display_name: session.displayName || session.username,
    p_enquiry: {
      title: nextRow.title,
      vesselName: nextRow.vessel_name,
      port: nextRow.port,
      product: nextRow.product,
      quantity: nextRow.quantity,
      deliveryDate: nextRow.delivery_date,
      supplierName: nextRow.supplier_name,
      notes: nextRow.notes,
    },
    p_formatted_text: formattedText,
    p_after_snapshot: enquirySnapshot(nextRow),
    p_message_text: messageText,
    p_retired_notes: writeSpcEnquiryNotes(currentText, retiredMeta),
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : null
  if (!row) throw new Error("SPC reoffer did not return the new enquiry.")
  return mapEnquiry(row as SpcEnquiryRow)
}

export async function updateSpcEnquiryFixture(
  id: string,
  fixture: SpcFixtureInput,
  session: SpcSession,
  request: Request,
) {
  const enquiryId = cleanText(id)
  if (!enquiryId) throw new Error("Enquiry id is required.")

  const context = createSpcAuditContext(session, request, "spc-fixtures")
  const supabase = createSpcAuditedSupabaseClient(context)
  const existing = await loadSpcEnquiryRow(supabase, enquiryId)
  const currentText = formatSpcEnquiry(existing)
  const now = new Date().toISOString()
  const nextMeta: SpcEnquiryMeta = {
    ...readSpcEnquiryMeta(existing.notes),
    fixtureSupplier: cleanText(fixture.supplier) || undefined,
    eta: cleanText(fixture.eta) || undefined,
    hsfo: cleanText(fixture.hsfo) || undefined,
    vlsfo: cleanText(fixture.vlsfo) || undefined,
    lsmgo: cleanText(fixture.lsmgo) || undefined,
    price: cleanText(fixture.price) || undefined,
    barging: cleanText(fixture.barging) || undefined,
  }

  const { data, error } = await supabase
    .from("spc_enquiries")
    .update({
      supplier_name: nextMeta.fixtureSupplier || existing.supplier_name,
      notes: writeSpcEnquiryNotes(currentText, nextMeta),
      updated_at: now,
    })
    .eq("id", enquiryId)
    .select("*")
    .single()

  if (error) throw error
  return mapEnquiry(data as SpcEnquiryRow)
}
