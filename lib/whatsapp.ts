import { createHmac, timingSafeEqual } from "crypto"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import {
  createAdminAuditedSupabaseClient,
  type AdminAuditContext,
} from "@/lib/adminAudit"

export type WhatsAppConversation = {
  id: string
  phone_e164: string
  display_name: string | null
  company: string | null
  assigned_to: string | null
  status: string
  tags: string[] | null
  last_message_preview: string | null
  last_message_at: string | null
  unread_count: number
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export type WhatsAppMessage = {
  id: string
  conversation_id: string
  whatsapp_message_id: string | null
  direction: "inbound" | "outbound" | "status"
  message_type: string
  body: string | null
  media_url: string | null
  status: string
  from_phone: string | null
  to_phone: string | null
  payload: Record<string, unknown> | null
  sent_at: string
  created_at: string
}

export type WhatsAppInboxPayload = {
  conversations: WhatsAppConversation[]
  messages: WhatsAppMessage[]
  selectedConversationId: string | null
  storageReady: boolean
  storageMessage: string | null
}

export type WhatsAppSendResult = {
  messageId: string
  response: Record<string, unknown>
  storageWarning?: string
}

export type WhatsAppTemplateComponent = {
  type?: string
  format?: string
  text?: string
  example?: Record<string, unknown>
}

export type WhatsAppTemplate = {
  id?: string
  name: string
  language: string
  status: string
  category?: string
  components: WhatsAppTemplateComponent[]
}

export type WhatsAppManualListType = "supplier" | "buyer"

type SupabaseErrorLike = {
  code?: string
  message?: string
}

type IncomingWhatsAppMessage = {
  contacts?: Array<{
    profile?: { name?: string }
    wa_id?: string
  }>
  messages?: Array<{
    id?: string
    from?: string
    timestamp?: string
    type?: string
    errors?: Array<{
      code?: string | number
      title?: string
      message?: string
      error_data?: { details?: string }
    }>
    text?: { body?: string }
    button?: { text?: string }
    interactive?: {
      button_reply?: { title?: string }
      list_reply?: { title?: string; description?: string }
    }
    image?: { caption?: string; id?: string }
    document?: { caption?: string; filename?: string; id?: string }
    audio?: { id?: string }
    video?: { caption?: string; id?: string }
    sticker?: { id?: string }
  }>
  statuses?: Array<{
    id?: string
    status?: string
    timestamp?: string
    recipient_id?: string
  }>
}

const DEFAULT_GRAPH_API_VERSION = "v23.0"
const TABLE_SETUP_MESSAGE = "Run supabase/whatsapp_schema.sql to enable WhatsApp storage."

function optionalEnv(name: string) {
  return process.env[name]?.trim() || ""
}

function requireEnv(name: string) {
  const value = optionalEnv(name)
  if (!value) throw new Error(`${name} is not configured.`)
  return value
}

export function getWhatsAppConfigStatus() {
  const accessToken = optionalEnv("WHATSAPP_ACCESS_TOKEN")
  const phoneNumberId = optionalEnv("WHATSAPP_PHONE_NUMBER_ID")
  const businessAccountId = optionalEnv("WHATSAPP_BUSINESS_ACCOUNT_ID")
  const templateBusinessAccountId = optionalEnv("WHATSAPP_TEMPLATE_BUSINESS_ACCOUNT_ID")
  const verifyToken = optionalEnv("WHATSAPP_VERIFY_TOKEN")
  const appSecret = optionalEnv("WHATSAPP_APP_SECRET")
  const graphApiVersion = optionalEnv("WHATSAPP_GRAPH_API_VERSION") || DEFAULT_GRAPH_API_VERSION

  return {
    configured: Boolean(accessToken && phoneNumberId && verifyToken),
    hasAccessToken: Boolean(accessToken),
    hasPhoneNumberId: Boolean(phoneNumberId),
    hasBusinessAccountId: Boolean(businessAccountId),
    hasTemplateBusinessAccountId: Boolean(templateBusinessAccountId),
    hasVerifyToken: Boolean(verifyToken),
    hasAppSecret: Boolean(appSecret),
    graphApiVersion,
  }
}

export function getWhatsAppWebhookVerifyToken() {
  return optionalEnv("WHATSAPP_VERIFY_TOKEN")
}

export function getWhatsAppAppSecret() {
  return optionalEnv("WHATSAPP_APP_SECRET")
}

export function getWhatsAppGraphApiVersion() {
  return optionalEnv("WHATSAPP_GRAPH_API_VERSION") || DEFAULT_GRAPH_API_VERSION
}

export function getServiceSupabaseClient(auditContext?: AdminAuditContext) {
  if (auditContext) {
    return createAdminAuditedSupabaseClient(auditContext, { useServiceRole: true })
  }

  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  )
}

function isMissingTableError(error: SupabaseErrorLike | null | undefined) {
  if (!error) return false
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    /relation .*whatsapp_/i.test(error.message || "") ||
    /could not find .*whatsapp_/i.test(error.message || "")
  )
}

function normalisePhone(value: string) {
  const cleaned = value.replace(/[^\d+]/g, "")
  if (cleaned.startsWith("+")) return cleaned
  return cleaned ? `+${cleaned}` : ""
}

function graphErrorMessage(data: Record<string, unknown>, fallback: string) {
  const error = data.error as
    | {
        message?: string
        type?: string
        code?: number | string
        error_subcode?: number | string
        fbtrace_id?: string
      }
    | undefined
  return [
    error?.message || fallback,
    error?.code ? `code ${error.code}` : "",
    error?.error_subcode ? `subcode ${error.error_subcode}` : "",
    error?.fbtrace_id ? `trace ${error.fbtrace_id}` : "",
  ].filter(Boolean).join(" / ")
}

function bodyVariableNames(text: string) {
  const names: string[] = []
  for (const match of text.matchAll(/{{\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*}}/g)) {
    const name = match[1]
    if (!names.includes(name)) names.push(name)
  }
  return names
}

function templateBodyComponent(template: WhatsAppTemplate) {
  return template.components.find((component) => component.type?.toUpperCase() === "BODY") || null
}

function renderTemplateMessagePreview(template: WhatsAppTemplate, variableText: string) {
  const lines: string[] = []
  for (const component of template.components) {
    const type = component.type?.toUpperCase()
    if ((type === "HEADER" || type === "BODY" || type === "FOOTER") && component.text) {
      lines.push(
        component.text.replace(/{{\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*}}/g, variableText.trim()),
      )
    }
  }
  return lines.filter(Boolean).join("\n\n").trim() || template.name
}

function buildTemplateComponents(template: WhatsAppTemplate, variableText: string) {
  const body = templateBodyComponent(template)
  const variables = body?.text ? bodyVariableNames(body.text) : []
  if (variables.length === 0) return []
  if (!variableText.trim()) throw new Error("Template variable text is required.")
  if (variables.length > 1) {
    throw new Error("This WhatsApp page currently supports templates with one body variable.")
  }

  const variable = variables[0]
  return [
    {
      type: "body",
      parameters: [
        {
          type: "text",
          ...(/^\d+$/.test(variable) ? {} : { parameter_name: variable }),
          text: variableText.trim(),
        },
      ],
    },
  ]
}

function normaliseManualListType(value: string | null | undefined): WhatsAppManualListType {
  return value === "buyer" ? "buyer" : "supplier"
}

function manualListConfig(value: string | null | undefined) {
  const listType = normaliseManualListType(value)
  return {
    listType,
    tag: listType,
    orderKey: `whatsapp_${listType}_order`,
    atKey: `whatsapp_${listType}_at`,
    legacyTags: listType === "supplier" ? ["assigned"] : [],
    legacyOrderKey: listType === "supplier" ? "whatsapp_assigned_order" : "",
    legacyAtKey: listType === "supplier" ? "whatsapp_assigned_at" : "",
  }
}

function messageTimestamp(value: string | undefined) {
  if (!value) return new Date().toISOString()
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return new Date().toISOString()
  return new Date(seconds * 1000).toISOString()
}

function messageBody(message: NonNullable<IncomingWhatsAppMessage["messages"]>[number]) {
  if (message.text?.body) return message.text.body
  if (message.button?.text) return message.button.text
  if (message.interactive?.button_reply?.title) return message.interactive.button_reply.title
  if (message.interactive?.list_reply?.title) {
    return [message.interactive.list_reply.title, message.interactive.list_reply.description]
      .filter(Boolean)
      .join(" - ")
  }
  if (message.image?.caption) return message.image.caption
  if (message.document?.caption) return message.document.caption
  if (message.video?.caption) return message.video.caption
  if (message.document?.filename) return message.document.filename
  if (message.type === "unsupported") {
    const error = message.errors?.[0]
    const detail =
      error?.error_data?.details ||
      error?.message ||
      error?.title ||
      "This WhatsApp message type is not supported by the API."
    return `Unsupported message: ${detail}`
  }
  return `[${message.type || "message"}]`
}

function tableSetupPayload(): WhatsAppInboxPayload {
  return {
    conversations: [],
    messages: [],
    selectedConversationId: null,
    storageReady: false,
    storageMessage: TABLE_SETUP_MESSAGE,
  }
}

export async function loadWhatsAppInbox(selectedConversationId?: string | null): Promise<WhatsAppInboxPayload> {
  const supabase = getServiceSupabaseClient()
  const conversationsResult = await supabase
    .from("whatsapp_conversations")
    .select("*")
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(200)

  if (conversationsResult.error) {
    if (isMissingTableError(conversationsResult.error)) return tableSetupPayload()
    throw conversationsResult.error
  }

  const conversations = (conversationsResult.data || []) as WhatsAppConversation[]
  const fallbackConversationId = conversations[0]?.id || null
  const resolvedConversationId =
    selectedConversationId && conversations.some((conversation) => conversation.id === selectedConversationId)
      ? selectedConversationId
      : fallbackConversationId

  if (!resolvedConversationId) {
    return {
      conversations,
      messages: [],
      selectedConversationId: null,
      storageReady: true,
      storageMessage: null,
    }
  }

  const messagesResult = await supabase
    .from("whatsapp_messages")
    .select("*")
    .eq("conversation_id", resolvedConversationId)
    .order("sent_at", { ascending: true })
    .limit(220)

  if (messagesResult.error) {
    if (isMissingTableError(messagesResult.error)) return tableSetupPayload()
    throw messagesResult.error
  }

  return {
    conversations,
    messages: (messagesResult.data || []) as WhatsAppMessage[],
    selectedConversationId: resolvedConversationId,
    storageReady: true,
    storageMessage: null,
  }
}

async function ensureConversation(
  supabase: SupabaseClient,
  phone: string,
  values: Partial<WhatsAppConversation> = {},
) {
  const phone_e164 = normalisePhone(phone)
  if (!phone_e164) throw new Error("WhatsApp phone number is required.")

  const { data: existing, error: existingError } = await supabase
    .from("whatsapp_conversations")
    .select("*")
    .eq("phone_e164", phone_e164)
    .maybeSingle()

  if (existingError) throw existingError

  const now = new Date().toISOString()
  if (existing) {
    const updateValues: Record<string, unknown> = { updated_at: now }
    if (values.display_name !== undefined && values.display_name !== null) updateValues.display_name = values.display_name
    if (values.company !== undefined) updateValues.company = values.company
    if (values.assigned_to !== undefined) updateValues.assigned_to = values.assigned_to
    if (values.status !== undefined) updateValues.status = values.status
    if (values.tags !== undefined) updateValues.tags = values.tags
    if (values.last_message_preview !== undefined) updateValues.last_message_preview = values.last_message_preview
    if (values.last_message_at !== undefined) updateValues.last_message_at = values.last_message_at
    if (values.metadata !== undefined) updateValues.metadata = values.metadata

    const { data, error } = await supabase
      .from("whatsapp_conversations")
      .update(updateValues)
      .eq("id", existing.id)
      .select("*")
      .single()

    if (error) throw error
    return data as WhatsAppConversation
  }

  const { data, error } = await supabase
    .from("whatsapp_conversations")
    .insert({
      phone_e164,
      display_name: values.display_name || null,
      company: values.company || null,
      assigned_to: values.assigned_to || null,
      status: values.status || "open",
      tags: values.tags || [],
      last_message_preview: values.last_message_preview || null,
      last_message_at: values.last_message_at || null,
      metadata: values.metadata || {},
      updated_at: now,
    })
    .select("*")
    .single()

  if (error) throw error
  return data as WhatsAppConversation
}

export async function assignWhatsAppContact(params: {
  phone: string
  displayName?: string | null
  company?: string | null
  contactId?: string | null
  assignedOrder?: number | null
  listType?: WhatsAppManualListType | null
  auditContext?: AdminAuditContext
}) {
  const supabase = getServiceSupabaseClient(params.auditContext)
  const listConfig = manualListConfig(params.listType)
  const conversation = await ensureConversation(supabase, params.phone, {
    display_name: params.displayName || null,
    company: params.company || null,
    status: "open",
  })
  const now = new Date().toISOString()
  const tags = Array.from(new Set([
    ...(conversation.tags || []),
    listConfig.tag,
    ...listConfig.legacyTags,
  ]))
  const existingOrder = Number(
    (conversation.metadata || {})[listConfig.orderKey] ||
    (listConfig.legacyOrderKey ? (conversation.metadata || {})[listConfig.legacyOrderKey] : undefined),
  )
  const requestedOrder = params.assignedOrder === null || params.assignedOrder === undefined
    ? Number.NaN
    : Number(params.assignedOrder)
  const assignedOrder = Number.isFinite(requestedOrder)
    ? requestedOrder
    : Number.isFinite(existingOrder)
      ? existingOrder
      : Date.now()
  const metadata = {
    ...(conversation.metadata || {}),
    source: "phonebook",
    phonebook_contact_id: params.contactId || null,
    [listConfig.atKey]: (conversation.metadata || {})[listConfig.atKey] || now,
    [listConfig.orderKey]: assignedOrder,
  }
  if (listConfig.legacyAtKey && listConfig.legacyOrderKey) {
    metadata[listConfig.legacyAtKey] = metadata[listConfig.legacyAtKey] || metadata[listConfig.atKey] || now
    metadata[listConfig.legacyOrderKey] = assignedOrder
  }

  const { data, error } = await supabase
    .from("whatsapp_conversations")
    .update({
      display_name: params.displayName || conversation.display_name,
      company: params.company || conversation.company,
      tags,
      metadata,
      updated_at: now,
    })
    .eq("id", conversation.id)
    .select("*")
    .single()

  if (error) throw error
  return data as WhatsAppConversation
}

export async function unassignWhatsAppContact(
  conversationId: string,
  listType: WhatsAppManualListType | null = "supplier",
  auditContext?: AdminAuditContext,
) {
  if (!conversationId) throw new Error("Conversation id is required.")
  const supabase = getServiceSupabaseClient(auditContext)
  const listConfig = manualListConfig(listType)
  const { data: existing, error: existingError } = await supabase
    .from("whatsapp_conversations")
    .select("*")
    .eq("id", conversationId)
    .single()

  if (existingError) throw existingError

  const conversation = existing as WhatsAppConversation
  const metadata = { ...(conversation.metadata || {}) }
  delete metadata[listConfig.atKey]
  delete metadata[listConfig.orderKey]
  if (listConfig.legacyAtKey) delete metadata[listConfig.legacyAtKey]
  if (listConfig.legacyOrderKey) delete metadata[listConfig.legacyOrderKey]
  const removeTags = new Set([listConfig.tag, ...listConfig.legacyTags])

  const { data, error } = await supabase
    .from("whatsapp_conversations")
    .update({
      tags: (conversation.tags || []).filter((tag) => !removeTags.has(tag)),
      metadata,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversation.id)
    .select("*")
    .single()

  if (error) throw error
  return data as WhatsAppConversation
}

export async function reorderWhatsAppAssignedContacts(
  items: Array<{ conversationId: string; order: number }>,
  auditContext?: AdminAuditContext,
  listType: WhatsAppManualListType | null = "supplier",
) {
  const supabase = getServiceSupabaseClient(auditContext)
  const listConfig = manualListConfig(listType)
  const safeItems = items
    .map((item) => ({
      conversationId: item.conversationId.trim(),
      order: Number(item.order),
    }))
    .filter((item) => item.conversationId && Number.isFinite(item.order))

  if (safeItems.length === 0) return []

  const { data: existingRows, error: existingError } = await supabase
    .from("whatsapp_conversations")
    .select("*")
    .in("id", safeItems.map((item) => item.conversationId))

  if (existingError) throw existingError

  const orderById = new Map(safeItems.map((item) => [item.conversationId, item.order]))
  const updated: WhatsAppConversation[] = []
  for (const row of (existingRows || []) as WhatsAppConversation[]) {
    const order = orderById.get(row.id)
    if (!Number.isFinite(order)) continue

    const { data, error } = await supabase
      .from("whatsapp_conversations")
      .update({
        tags: Array.from(new Set([
          ...(row.tags || []),
          listConfig.tag,
          ...listConfig.legacyTags,
        ])),
        metadata: {
          ...(row.metadata || {}),
          [listConfig.orderKey]: order,
          ...(listConfig.legacyOrderKey ? { [listConfig.legacyOrderKey]: order } : {}),
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .select("*")
      .single()

    if (error) throw error
    updated.push(data as WhatsAppConversation)
  }

  return updated
}

export async function markWhatsAppConversationRead(
  conversationId: string,
  auditContext?: AdminAuditContext,
) {
  if (!conversationId) throw new Error("Conversation id is required.")
  const supabase = getServiceSupabaseClient(auditContext)
  const { data, error } = await supabase
    .from("whatsapp_conversations")
    .update({
      unread_count: 0,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId)
    .select("*")
    .single()

  if (error) throw error
  return data as WhatsAppConversation
}

export async function storeOutgoingMessage(params: {
  to: string
  body: string
  whatsappMessageId?: string | null
  messageType?: string
  payload?: Record<string, unknown>
  auditContext?: AdminAuditContext
}) {
  try {
    const supabase = getServiceSupabaseClient(params.auditContext)
    const toPhone = normalisePhone(params.to)
    const now = new Date().toISOString()
    const conversation = await ensureConversation(supabase, toPhone, {
      last_message_preview: params.body,
      last_message_at: now,
    } as Partial<WhatsAppConversation>)

    await supabase.from("whatsapp_conversations").update({
      last_message_preview: params.body,
      last_message_at: now,
      updated_at: now,
    }).eq("id", conversation.id)

    const storedMessage = {
      conversation_id: conversation.id,
      whatsapp_message_id: params.whatsappMessageId || null,
      direction: "outbound",
      message_type: params.messageType || "text",
      body: params.body,
      media_url: null,
      status: params.whatsappMessageId ? "sent" : "queued",
      from_phone: null,
      to_phone: toPhone,
      payload: params.payload || {},
      sent_at: now,
    }

    const { error } = params.whatsappMessageId
      ? await supabase
          .from("whatsapp_messages")
          .upsert(storedMessage, { onConflict: "whatsapp_message_id" })
      : await supabase.from("whatsapp_messages").insert(storedMessage)

    if (error && !isMissingTableError(error)) throw error
  } catch (error) {
    if (isMissingTableError(error as SupabaseErrorLike)) return
    throw error
  }
}

export async function loadWhatsAppTemplates() {
  const accessToken = requireEnv("WHATSAPP_ACCESS_TOKEN")
  const businessAccountId = optionalEnv("WHATSAPP_TEMPLATE_BUSINESS_ACCOUNT_ID") || requireEnv("WHATSAPP_BUSINESS_ACCOUNT_ID")
  const graphApiVersion = getWhatsAppGraphApiVersion()
  const url = new URL(`https://graph.facebook.com/${graphApiVersion}/${businessAccountId}/message_templates`)
  url.searchParams.set("fields", "id,name,language,status,category,components")
  url.searchParams.set("limit", "100")

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  })
  const data = (await response.json().catch(() => ({}))) as {
    data?: unknown[]
    error?: unknown
  } & Record<string, unknown>

  if (!response.ok) {
    throw new Error(`Meta WhatsApp API: ${graphErrorMessage(data, "Unable to load WhatsApp templates.")}`)
  }

  return (data.data || [])
    .map((item) => {
      const template = item as {
        id?: unknown
        name?: unknown
        language?: unknown
        status?: unknown
        category?: unknown
        components?: unknown
      }
      const parsed: WhatsAppTemplate = {
        name: typeof template.name === "string" ? template.name : "",
        language: typeof template.language === "string" ? template.language : "",
        status: typeof template.status === "string" ? template.status : "",
        components: Array.isArray(template.components)
          ? template.components.map((component) => component as WhatsAppTemplateComponent)
          : [],
      }
      if (typeof template.id === "string") parsed.id = template.id
      if (typeof template.category === "string") parsed.category = template.category
      return parsed
    })
    .filter((template): template is WhatsAppTemplate => Boolean(template.name && template.language))
}

export async function sendWhatsAppTextMessage(params: {
  to: string
  body: string
  auditContext?: AdminAuditContext
}): Promise<WhatsAppSendResult> {
  const accessToken = requireEnv("WHATSAPP_ACCESS_TOKEN")
  const phoneNumberId = requireEnv("WHATSAPP_PHONE_NUMBER_ID")
  const graphApiVersion = getWhatsAppGraphApiVersion()
  const to = normalisePhone(params.to).replace(/^\+/, "")

  if (!to) throw new Error("Recipient phone number is required.")
  if (!params.body.trim()) throw new Error("Message body is required.")

  const response = await fetch(`https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: {
        preview_url: false,
        body: params.body.trim(),
      },
    }),
  })
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>

  if (!response.ok) {
    const error = data.error as
      | {
          message?: string
          type?: string
          code?: number | string
          error_subcode?: number | string
          fbtrace_id?: string
        }
      | undefined
    const details = [
      error?.message || "WhatsApp send failed.",
      error?.code ? `code ${error.code}` : "",
      error?.error_subcode ? `subcode ${error.error_subcode}` : "",
      error?.fbtrace_id ? `trace ${error.fbtrace_id}` : "",
    ].filter(Boolean)
    throw new Error(`Meta WhatsApp API: ${details.join(" / ")}`)
  }

  const messageId =
    Array.isArray(data.messages) && data.messages[0] && typeof data.messages[0] === "object"
      ? String((data.messages[0] as { id?: unknown }).id || "")
      : ""

  let storageWarning: string | undefined
  try {
    await storeOutgoingMessage({
      to: params.to,
      body: params.body.trim(),
      whatsappMessageId: messageId || null,
      payload: data,
      auditContext: params.auditContext,
    })
  } catch (error) {
    storageWarning =
      error instanceof Error
        ? `Message accepted by Meta, but local WhatsApp storage failed: ${error.message}`
        : "Message accepted by Meta, but local WhatsApp storage failed."
    console.error("whatsapp outgoing storage failed", error)
  }

  return { messageId, response: data, storageWarning }
}

export async function sendWhatsAppTemplateMessage(params: {
  to: string
  templateName: string
  language: string
  variableText: string
  auditContext?: AdminAuditContext
}): Promise<WhatsAppSendResult> {
  const accessToken = requireEnv("WHATSAPP_ACCESS_TOKEN")
  const phoneNumberId = requireEnv("WHATSAPP_PHONE_NUMBER_ID")
  const graphApiVersion = getWhatsAppGraphApiVersion()
  const to = normalisePhone(params.to).replace(/^\+/, "")
  const templateName = params.templateName.trim()
  const language = params.language.trim()

  if (!to) throw new Error("Recipient phone number is required.")
  if (!templateName) throw new Error("Template name is required.")
  if (!language) throw new Error("Template language is required.")

  const templates = await loadWhatsAppTemplates()
  const template = templates.find(
    (item) => item.name === templateName && item.language === language,
  )
  if (!template) throw new Error("Selected WhatsApp template was not found in Meta.")
  if (template.status.toUpperCase() !== "APPROVED") {
    throw new Error(`Selected WhatsApp template is ${template.status || "not approved"}.`)
  }

  const components = buildTemplateComponents(template, params.variableText)
  const requestBody = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: template.name,
      language: {
        code: template.language,
      },
      ...(components.length > 0 ? { components } : {}),
    },
  }

  const response = await fetch(`https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  })
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>

  if (!response.ok) {
    throw new Error(`Meta WhatsApp API: ${graphErrorMessage(data, "WhatsApp template send failed.")}`)
  }

  const messageId =
    Array.isArray(data.messages) && data.messages[0] && typeof data.messages[0] === "object"
      ? String((data.messages[0] as { id?: unknown }).id || "")
      : ""
  const preview = renderTemplateMessagePreview(template, params.variableText)

  let storageWarning: string | undefined
  try {
    await storeOutgoingMessage({
      to: params.to,
      body: preview,
      whatsappMessageId: messageId || null,
      messageType: "template",
      payload: {
        request: requestBody,
        response: data,
      },
      auditContext: params.auditContext,
    })
  } catch (error) {
    storageWarning =
      error instanceof Error
        ? `Template accepted by Meta, but local WhatsApp storage failed: ${error.message}`
        : "Template accepted by Meta, but local WhatsApp storage failed."
    console.error("whatsapp template storage failed", error)
  }

  return { messageId, response: data, storageWarning }
}

export function verifyWhatsAppSignature(rawBody: string, signature: string | null) {
  const appSecret = getWhatsAppAppSecret()
  if (!appSecret) return true
  if (!signature?.startsWith("sha256=")) return false

  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`
  const expectedBuffer = Buffer.from(expected)
  const signatureBuffer = Buffer.from(signature)
  if (expectedBuffer.length !== signatureBuffer.length) return false
  return timingSafeEqual(expectedBuffer, signatureBuffer)
}

export async function storeInboundWebhook(payload: Record<string, unknown>) {
  const supabase = getServiceSupabaseClient()
  const entries = Array.isArray(payload.entry) ? payload.entry : []

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue
    const changes = Array.isArray((entry as { changes?: unknown }).changes)
      ? ((entry as { changes: unknown[] }).changes)
      : []

    for (const change of changes) {
      if (!change || typeof change !== "object") continue
      const value = (change as { value?: IncomingWhatsAppMessage }).value || {}
      const contactsByPhone = new Map(
        (value.contacts || []).map((contact) => [
          normalisePhone(contact.wa_id || ""),
          contact.profile?.name || null,
        ]),
      )

      for (const message of value.messages || []) {
        const fromPhone = normalisePhone(message.from || "")
        if (!fromPhone) continue
        const sentAt = messageTimestamp(message.timestamp)
        const body = messageBody(message)
        const displayName = contactsByPhone.get(fromPhone) || null
        const conversation = await ensureConversation(supabase, fromPhone, {
          display_name: displayName,
          last_message_preview: body,
          last_message_at: sentAt,
        } as Partial<WhatsAppConversation>)

        await supabase.from("whatsapp_conversations").update({
          display_name: displayName || conversation.display_name,
          last_message_preview: body,
          last_message_at: sentAt,
          unread_count: (conversation.unread_count || 0) + 1,
          updated_at: new Date().toISOString(),
        }).eq("id", conversation.id)

        const { error } = await supabase.from("whatsapp_messages").upsert(
          {
            conversation_id: conversation.id,
            whatsapp_message_id: message.id || null,
            direction: "inbound",
            message_type: message.type || "message",
            body,
            media_url: null,
            status: "received",
            from_phone: fromPhone,
            to_phone: null,
            payload: message,
            sent_at: sentAt,
          },
          { onConflict: "whatsapp_message_id" },
        )

        if (error && !isMissingTableError(error)) throw error
      }

      for (const status of value.statuses || []) {
        if (!status.id) continue
        await supabase
          .from("whatsapp_messages")
          .update({
            status: status.status || "status",
            payload: status,
          })
          .eq("whatsapp_message_id", status.id)
      }
    }
  }
}
