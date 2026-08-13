import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import type { SpcSession } from "@/lib/spcAuth"
import { createSpcAuditContext } from "@/lib/spcAudit"
import { listManagedSpcUsers } from "@/lib/spcUsers"
import type { SpcEnquiry } from "@/lib/spcEnquiries"

const MOBILE_MODE_HOURS = 12
const MAX_ATTEMPTS = 8
const RETRY_SECONDS = [60, 300, 900, 1800, 3600, 7200, 14400, 28800]
const TEMPLATE_NAME = process.env.SPC_MOBILE_ENQUIRY_TEMPLATE_NAME?.trim() || "spc_mobile_enquiry_ready"
const TEMPLATE_LANGUAGE = process.env.SPC_MOBILE_ENQUIRY_TEMPLATE_LANGUAGE?.trim() || "en_US"

type DeliveryRow = {
  id: string
  enquiry_id: string
  spc_user_id: string
  recipient_phone: string
  acknowledgement_token: string
  status: string
  prompt_message_id: string | null
  content_message_id: string | null
  trader_message_id: string | null
  attempt_count: number
}

type EnquiryRow = {
  id: string
  enquiry_number: string
  title: string
  notes: string | null
  created_by_display_name: string
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not configured.`)
  return value
}

function serviceClient() {
  return createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

function safeWhatsappId(payload: unknown) {
  const messages = payload && typeof payload === "object" ? (payload as { messages?: unknown }).messages : null
  const id = Array.isArray(messages) && messages[0] && typeof messages[0] === "object"
    ? String((messages[0] as { id?: unknown }).id || "").trim()
    : ""
  if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) throw new Error("WhatsApp returned an invalid message id.")
  return id
}

async function sendWhatsapp(body: Record<string, unknown>) {
  const version = requireEnv("WHATSAPP_GRAPH_API_VERSION")
  const phoneNumberId = requireEnv("SPC_WHATSAPP_LOGIN_MFA_PHONE_NUMBER_ID")
  const response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnv("WHATSAPP_ACCESS_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...body }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const code = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error?: { code?: unknown } }).error?.code || "rejected")
      : "rejected"
    throw new Error(`WhatsApp rejected the message (${code.slice(0, 32)}).`)
  }
  return safeWhatsappId(payload)
}

export function formatSpcMobileEnquiryText(row: Pick<EnquiryRow, "title" | "notes">) {
  const marker = "---SPC_META---"
  const notes = String(row.notes || "").split(marker)[0].trim()
  return (notes || row.title).replace(/\s*\n\s*/g, " / ").replace(/\s+/g, " ").trim().slice(0, 1400)
}

async function eligibleTrader(session: SpcSession) {
  const users = await listManagedSpcUsers()
  return users.find((user) =>
    user.id === session.userId && user.isActive && user.isSupplierTrader && /^[1-9][0-9]{7,14}$/.test(user.whatsappPhone),
  ) || null
}

export async function getSpcMobileMode(session: SpcSession) {
  const trader = await eligibleTrader(session)
  if (!trader) return { eligible: false, enabled: false, expiresAt: null, maskedPhone: "" }
  const { data, error } = await serviceClient().from("spc_mobile_modes").select("enabled,expires_at").eq("spc_user_id", trader.id).maybeSingle()
  if (error) throw error
  const enabled = data?.enabled === true && Date.parse(String(data.expires_at || "")) > Date.now()
  return {
    eligible: true,
    enabled,
    expiresAt: enabled ? String(data?.expires_at || "") : null,
    maskedPhone: `+${trader.whatsappPhone.slice(0, 2)}${"•".repeat(Math.max(1, trader.whatsappPhone.length - 6))}${trader.whatsappPhone.slice(-4)}`,
  }
}

export async function setSpcMobileMode(session: SpcSession, enabled: boolean, request?: Request) {
  const trader = await eligibleTrader(session)
  if (!trader) throw new Error("Only an active supplier trader with a verified WhatsApp number can use Mobile Mode.")
  const now = new Date()
  const expiresAt = enabled ? new Date(now.getTime() + MOBILE_MODE_HOURS * 3600_000).toISOString() : null
  const { error } = await serviceClient().from("spc_mobile_modes").upsert({
    spc_user_id: trader.id,
    username: trader.username,
    display_name: trader.displayName || trader.username,
    recipient_phone: trader.whatsappPhone,
    enabled,
    expires_at: expiresAt,
    activated_at: enabled ? now.toISOString() : null,
    deactivated_at: enabled ? null : now.toISOString(),
    updated_at: now.toISOString(),
  }, { onConflict: "spc_user_id" })
  if (error) throw error
  const context = createSpcAuditContext(session, request, "spc-chrome-extension", {
    action: enabled ? "activate-mobile-mode" : "deactivate-mobile-mode",
    targetType: "spc-mobile-mode",
    targetId: trader.id,
    targetUsername: trader.username,
  })
  const { error: auditError } = await serviceClient().from("audit_logs").insert({
    actor_user_id: context.actorUserId,
    actor_id: `spc:${context.username}`,
    actor_name: context.displayName,
    actor_source: "app",
    table_schema: "public",
    table_name: "spc_mobile_modes",
    operation: "UPDATE",
    record_pk: { spc_user_id: trader.id },
    changed_fields: ["enabled", "expires_at"],
    before_row: null,
    after_row: { title: "SPC Mobile Mode", enabled, expires_at: expiresAt },
    request_context: { pageId: context.pageId, pageLabel: context.pageLabel, pagePath: context.pagePath },
  })
  if (auditError) throw auditError
  return getSpcMobileMode(session)
}

export async function enqueueSpcMobileEnquiry(enquiry: SpcEnquiry) {
  const supabase = serviceClient()
  const { data: modes, error } = await supabase.from("spc_mobile_modes")
    .select("spc_user_id,recipient_phone,display_name")
    .eq("enabled", true)
    .gt("expires_at", new Date().toISOString())
  if (error) throw error
  if (!modes?.length) return 0
  const rows = modes.map((mode) => ({
    enquiry_id: enquiry.id,
    spc_user_id: mode.spc_user_id,
    recipient_phone: mode.recipient_phone,
    recipient_display_name: mode.display_name,
    acknowledgement_token: randomBytes(24).toString("base64url"),
  }))
  const { error: insertError } = await supabase.from("spc_mobile_enquiry_deliveries")
    .upsert(rows, { onConflict: "enquiry_id,spc_user_id", ignoreDuplicates: true })
  if (insertError) throw insertError
  return rows.length
}

async function sendPrompt(row: DeliveryRow, enquiryNumber: string) {
  return sendWhatsapp({
    to: row.recipient_phone,
    type: "template",
    template: {
      name: TEMPLATE_NAME,
      language: { code: TEMPLATE_LANGUAGE },
      components: [
        { type: "body", parameters: [{ type: "text", text: enquiryNumber }] },
        { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `RECEIVE_${row.acknowledgement_token}` }] },
      ],
    },
  })
}

export async function processPendingSpcMobileDeliveries(limit = 20) {
  const supabase = serviceClient()
  const { data, error } = await supabase.from("spc_mobile_enquiry_deliveries")
    .select("id,enquiry_id,spc_user_id,recipient_phone,acknowledgement_token,status,prompt_message_id,content_message_id,trader_message_id,attempt_count")
    .in("status", ["queued", "failed"])
    .lte("next_attempt_at", new Date().toISOString())
    .lt("attempt_count", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(limit)
  if (error) throw error
  let processed = 0
  for (const delivery of (data || []) as DeliveryRow[]) {
    try {
      const { data: enquiry, error: enquiryError } = await supabase.from("spc_enquiries")
        .select("id,enquiry_number,title,notes,created_by_display_name").eq("id", delivery.enquiry_id).single()
      if (enquiryError) throw enquiryError
      const messageId = await sendPrompt(delivery, String(enquiry.enquiry_number || "SPC enquiry"))
      const { error: updateError } = await supabase.from("spc_mobile_enquiry_deliveries").update({
        status: "prompt_sent", prompt_message_id: messageId, prompt_delivery_status: "accepted",
        attempt_count: delivery.attempt_count + 1, last_error_code: null, updated_at: new Date().toISOString(),
      }).eq("id", delivery.id).in("status", ["queued", "failed"])
      if (updateError) throw updateError
      processed += 1
    } catch (error) {
      const attempts = delivery.attempt_count + 1
      await supabase.from("spc_mobile_enquiry_deliveries").update({
        status: "failed", attempt_count: attempts,
        next_attempt_at: new Date(Date.now() + RETRY_SECONDS[Math.min(attempts - 1, RETRY_SECONDS.length - 1)] * 1000).toISOString(),
        last_error_code: (error instanceof Error ? error.message : "delivery_failed").slice(0, 160),
        updated_at: new Date().toISOString(),
      }).eq("id", delivery.id)
    }
  }
  return { examined: data?.length || 0, processed }
}

async function releaseDelivery(delivery: DeliveryRow) {
  const supabase = serviceClient()
  const { data: enquiry, error } = await supabase.from("spc_enquiries")
    .select("id,enquiry_number,title,notes,created_by_display_name").eq("id", delivery.enquiry_id).single()
  if (error) throw error
  const row = enquiry as EnquiryRow
  let contentId = delivery.content_message_id
  if (!contentId) contentId = await sendWhatsapp({ to: delivery.recipient_phone, type: "text", text: { preview_url: false, body: formatSpcMobileEnquiryText(row) } })
  let traderId = delivery.trader_message_id
  if (!traderId) traderId = await sendWhatsapp({ to: delivery.recipient_phone, type: "text", text: { preview_url: false, body: row.created_by_display_name.trim() || "SPC BUYER TRADER" } })
  const now = new Date().toISOString()
  const { error: updateError } = await supabase.from("spc_mobile_enquiry_deliveries").update({
    status: "content_sent", content_message_id: contentId, trader_message_id: traderId,
    content_delivery_status: "accepted", trader_delivery_status: "accepted",
    acknowledged_at: now, completed_at: now, last_error_code: null, updated_at: now,
  }).eq("id", delivery.id)
  if (updateError) throw updateError
}

export async function acknowledgeSpcMobileDelivery(from: string, token?: string) {
  const supabase = serviceClient()
  let query = supabase.from("spc_mobile_enquiry_deliveries")
    .select("id,enquiry_id,spc_user_id,recipient_phone,acknowledgement_token,status,prompt_message_id,content_message_id,trader_message_id,attempt_count")
    .eq("recipient_phone", from).eq("status", "prompt_sent")
  query = token ? query.eq("acknowledgement_token", token) : query.order("created_at", { ascending: false }).limit(2)
  const { data, error } = await query
  if (error) throw error
  if (!data?.length || (!token && data.length !== 1)) return false
  const delivery = data[0] as DeliveryRow
  await supabase.from("spc_mobile_enquiry_deliveries").update({ status: "acknowledged", acknowledged_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", delivery.id).eq("status", "prompt_sent")
  await releaseDelivery(delivery)
  return true
}

export async function recordSpcMobileMessageStatus(messageId: string, status: string) {
  if (!messageId || !["sent", "delivered", "read", "failed"].includes(status)) return
  const supabase = serviceClient()
  for (const [idColumn, statusColumn] of [
    ["prompt_message_id", "prompt_delivery_status"],
    ["content_message_id", "content_delivery_status"],
    ["trader_message_id", "trader_delivery_status"],
  ] as const) {
    const { data } = await supabase.from("spc_mobile_enquiry_deliveries").update({ [statusColumn]: status, updated_at: new Date().toISOString() }).eq(idColumn, messageId).select("id").limit(1)
    if (data?.length) return
  }
}

export function verifyMetaWebhookSignature(rawBody: string, signature: string | null) {
  const secret = requireEnv("WHATSAPP_APP_SECRET")
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`
  if (!signature || signature.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}
