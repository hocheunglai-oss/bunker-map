import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import type { SpcSession } from "@/lib/spcAuth"
import { createSpcAuditContext } from "@/lib/spcAudit"
import { listManagedSpcUsers } from "@/lib/spcUsers"
import type { SpcEnquiry } from "@/lib/spcEnquiries"

const MAX_ATTEMPTS = 20
const RETRY_SECONDS = [60, 300, 900, 1800, 3600, 7200, 14400, 21600]
const TEMPLATE_NAME = process.env.SPC_MOBILE_MODE_TEMPLATE_NAME?.trim() || "spc_mobile_mode_on"
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

type MobileModeRow = {
  spc_user_id: string
  recipient_phone: string
  activation_token: string
  activation_status: string
  activation_message_id: string | null
  activation_attempt_count: number
  conversation_open_until: string | null
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
  const user = users.find((candidate) => candidate.id === session.userId)
  if (!user) return null
  const whatsappPhone = user.whatsappPhone.replace(/\D/g, "")
  return user.isActive && user.isSupplierTrader && /^[1-9][0-9]{7,14}$/.test(whatsappPhone)
    ? { ...user, whatsappPhone }
    : null
}

export async function getSpcMobileMode(session: SpcSession) {
  const trader = await eligibleTrader(session)
  if (!trader) return { eligible: false, enabled: false, expiresAt: null, maskedPhone: "" }
  const { data, error } = await serviceClient().from("spc_mobile_modes").select("enabled,conversation_open_until,activation_status").eq("spc_user_id", trader.id).maybeSingle()
  if (error) throw error
  const enabled = data?.enabled === true
  return {
    eligible: true,
    enabled,
    expiresAt: null,
    conversationOpen: enabled && Date.parse(String(data?.conversation_open_until || "")) > Date.now(),
    activationStatus: enabled ? String(data?.activation_status || "queued") : "idle",
    maskedPhone: `+${trader.whatsappPhone.slice(0, 2)}${"•".repeat(Math.max(1, trader.whatsappPhone.length - 6))}${trader.whatsappPhone.slice(-4)}`,
  }
}

export async function setSpcMobileMode(session: SpcSession, enabled: boolean, request?: Request) {
  const trader = await eligibleTrader(session)
  if (!trader) throw new Error("Only an active supplier trader with a verified WhatsApp number can use Mobile Mode.")
  const now = new Date()
  const expiresAt = null
  const activationToken = randomBytes(24).toString("base64url")
  const { error } = await serviceClient().from("spc_mobile_modes").upsert({
    spc_user_id: trader.id,
    username: trader.username,
    display_name: trader.displayName || trader.username,
    recipient_phone: trader.whatsappPhone,
    enabled,
    expires_at: expiresAt,
    activated_at: enabled ? now.toISOString() : null,
    deactivated_at: enabled ? null : now.toISOString(),
    conversation_open_until: null,
    activation_token: enabled ? activationToken : null,
    activation_status: enabled ? "queued" : "idle",
    activation_message_id: null,
    activation_delivery_status: null,
    activation_attempt_count: 0,
    activation_next_attempt_at: now.toISOString(),
    activation_last_error: null,
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
    .select("spc_user_id,recipient_phone,display_name,conversation_open_until")
    .eq("enabled", true)
  if (error) throw error
  if (!modes?.length) return 0
  const rows = modes.map((mode) => ({
    enquiry_id: enquiry.id,
    spc_user_id: mode.spc_user_id,
    recipient_phone: mode.recipient_phone,
    recipient_display_name: mode.display_name,
    acknowledgement_token: randomBytes(24).toString("base64url"),
    status: Date.parse(String(mode.conversation_open_until || "")) > Date.now() ? "acknowledged" : "queued",
  }))
  const { error: insertError } = await supabase.from("spc_mobile_enquiry_deliveries")
    .upsert(rows, { onConflict: "enquiry_id,spc_user_id", ignoreDuplicates: true })
  if (insertError) throw insertError
  return rows.length
}

async function sendModePrompt(row: MobileModeRow) {
  return sendWhatsapp({
    to: row.recipient_phone,
    type: "template",
    template: {
      name: TEMPLATE_NAME,
      language: { code: TEMPLATE_LANGUAGE },
      components: [
        { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `MOBILE_RECEIVE_${row.activation_token}` }] },
      ],
    },
  })
}

export async function processPendingSpcMobileDeliveries(limit = 20) {
  const supabase = serviceClient()
  const now = new Date().toISOString()
  const { data: pendingModes, error: modeError } = await supabase.from("spc_mobile_modes")
    .select("spc_user_id,recipient_phone,activation_token,activation_status,activation_message_id,activation_attempt_count,conversation_open_until")
    .eq("enabled", true).in("activation_status", ["queued", "failed"])
    .lte("activation_next_attempt_at", now).limit(limit)
  if (modeError) throw modeError
  for (const mode of (pendingModes || []) as MobileModeRow[]) {
    try {
      const messageId = await sendModePrompt(mode)
      await supabase.from("spc_mobile_modes").update({
        activation_status: "prompt_sent", activation_message_id: messageId,
        activation_delivery_status: "accepted", activation_attempt_count: mode.activation_attempt_count + 1,
        activation_last_error: null, updated_at: new Date().toISOString(),
      }).eq("spc_user_id", mode.spc_user_id).in("activation_status", ["queued", "failed"])
    } catch (modeSendError) {
      const attempts = mode.activation_attempt_count + 1
      await supabase.from("spc_mobile_modes").update({
        activation_status: "failed", activation_attempt_count: attempts,
        activation_next_attempt_at: new Date(Date.now() + RETRY_SECONDS[Math.min(attempts - 1, RETRY_SECONDS.length - 1)] * 1000).toISOString(),
        activation_last_error: (modeSendError instanceof Error ? modeSendError.message : "activation_failed").slice(0, 160),
        updated_at: new Date().toISOString(),
      }).eq("spc_user_id", mode.spc_user_id)
    }
  }
  const { data, error } = await supabase.from("spc_mobile_enquiry_deliveries")
    .select("id,enquiry_id,spc_user_id,recipient_phone,acknowledgement_token,status,prompt_message_id,content_message_id,trader_message_id,attempt_count")
    .in("status", ["queued", "failed", "acknowledged"])
    .lte("next_attempt_at", new Date().toISOString())
    .lt("attempt_count", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(limit)
  if (error) throw error
  let processed = 0
  for (const delivery of (data || []) as DeliveryRow[]) {
    try {
      const { data: mode, error: currentModeError } = await supabase.from("spc_mobile_modes")
        .select("enabled,conversation_open_until,activation_status").eq("spc_user_id", delivery.spc_user_id).maybeSingle()
      if (currentModeError) throw currentModeError
      const windowOpen = mode?.enabled === true && Date.parse(String(mode.conversation_open_until || "")) > Date.now()
      if (!windowOpen) {
        if (mode?.enabled === true && mode.activation_status === "acknowledged") {
          await supabase.from("spc_mobile_modes").update({
            activation_token: randomBytes(24).toString("base64url"), activation_status: "queued",
            activation_message_id: null, activation_delivery_status: null, activation_attempt_count: 0,
            activation_next_attempt_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          }).eq("spc_user_id", delivery.spc_user_id)
        }
        continue
      }
      if (delivery.status === "acknowledged") {
        await releaseDelivery(delivery)
        processed += 1
        continue
      }
      const { error: updateError } = await supabase.from("spc_mobile_enquiry_deliveries").update({
        status: "acknowledged", acknowledged_at: new Date().toISOString(), last_error_code: null, updated_at: new Date().toISOString(),
      }).eq("id", delivery.id).in("status", ["queued", "failed", "prompt_sent"])
      if (updateError) throw updateError
      await releaseDelivery({ ...delivery, status: "acknowledged" })
      processed += 1
    } catch (error) {
      const attempts = delivery.attempt_count + 1
      await supabase.from("spc_mobile_enquiry_deliveries").update({
        status: delivery.status === "acknowledged" ? "acknowledged" : "failed", attempt_count: attempts,
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
  if (!contentId) {
    contentId = await sendWhatsapp({ to: delivery.recipient_phone, type: "text", text: { preview_url: false, body: formatSpcMobileEnquiryText(row) } })
    const { error: checkpointError } = await supabase.from("spc_mobile_enquiry_deliveries").update({
      content_message_id: contentId, content_delivery_status: "accepted", updated_at: new Date().toISOString(),
    }).eq("id", delivery.id)
    if (checkpointError) throw checkpointError
  }
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
  const modeQuery = supabase.from("spc_mobile_modes")
    .select("spc_user_id,activation_token,activation_status").eq("recipient_phone", from).eq("enabled", true)
  const { data: modes, error: modeError } = token
    ? await modeQuery.eq("activation_token", token).limit(1)
    : await modeQuery.in("activation_status", ["prompt_sent", "failed"]).limit(2)
  if (modeError) throw modeError
  if (modes?.length === 1) {
    const mode = modes[0]
    const inboundAt = new Date()
    const openUntil = new Date(inboundAt.getTime() + 24 * 60 * 60 * 1000).toISOString()
    await supabase.from("spc_mobile_modes").update({
      activation_status: "acknowledged", last_inbound_at: inboundAt.toISOString(),
      conversation_open_until: openUntil, activation_last_error: null, updated_at: inboundAt.toISOString(),
    }).eq("spc_user_id", mode.spc_user_id)
    await supabase.from("spc_mobile_enquiry_deliveries").update({
      status: "acknowledged", acknowledged_at: inboundAt.toISOString(), next_attempt_at: inboundAt.toISOString(), updated_at: inboundAt.toISOString(),
    }).eq("spc_user_id", mode.spc_user_id).in("status", ["queued", "failed", "prompt_sent"])
    await processPendingSpcMobileDeliveries()
    return true
  }

  // Backward compatibility for enquiry-specific RECEIVE prompts already delivered before this change.
  let query = supabase.from("spc_mobile_enquiry_deliveries")
    .select("id,enquiry_id,spc_user_id,recipient_phone,acknowledgement_token,status,prompt_message_id,content_message_id,trader_message_id,attempt_count")
    .eq("recipient_phone", from).in("status", ["prompt_sent", "acknowledged"])
  query = token ? query.eq("acknowledgement_token", token) : query.order("created_at", { ascending: false }).limit(2)
  const { data, error } = await query
  if (error) throw error
  if (!data?.length || (!token && data.length !== 1)) return false
  const delivery = data[0] as DeliveryRow
  const inboundAt = new Date()
  await supabase.from("spc_mobile_modes").update({
    activation_status: "acknowledged", last_inbound_at: inboundAt.toISOString(),
    conversation_open_until: new Date(inboundAt.getTime() + 24 * 60 * 60 * 1000).toISOString(), updated_at: inboundAt.toISOString(),
  }).eq("spc_user_id", delivery.spc_user_id)
  await supabase.from("spc_mobile_enquiry_deliveries").update({ status: "acknowledged", acknowledged_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", delivery.id).in("status", ["prompt_sent", "acknowledged"])
  await releaseDelivery(delivery)
  return true
}

export async function recordSpcMobileMessageStatus(messageId: string, status: string) {
  if (!messageId || !["sent", "delivered", "read", "failed"].includes(status)) return
  const supabase = serviceClient()
  const { data: modeRows } = await supabase.from("spc_mobile_modes").update({ activation_delivery_status: status, updated_at: new Date().toISOString() }).eq("activation_message_id", messageId).select("spc_user_id").limit(1)
  if (modeRows?.length) return
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
