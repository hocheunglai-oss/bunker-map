"use client"

import Link from "next/link"
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import { useIsMobile } from "@/lib/useIsMobile"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

type WhatsAppConversation = {
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

type WhatsAppMessage = {
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

type WhatsAppConfig = {
  configured: boolean
  hasAccessToken: boolean
  hasPhoneNumberId: boolean
  hasBusinessAccountId: boolean
  hasTemplateBusinessAccountId: boolean
  hasVerifyToken: boolean
  hasAppSecret: boolean
  graphApiVersion: string
}

type WhatsAppTemplateComponent = {
  type?: string
  format?: string
  text?: string
}

type WhatsAppTemplate = {
  id?: string
  name: string
  language: string
  status: string
  category?: string
  components: WhatsAppTemplateComponent[]
}

type WhatsAppInboxResponse = {
  conversations: WhatsAppConversation[]
  messages: WhatsAppMessage[]
  selectedConversationId: string | null
  storageReady: boolean
  storageMessage: string | null
  config: WhatsAppConfig
  message?: string
}

type WhatsAppMessagesResponse = {
  messages: WhatsAppMessage[]
  message?: string
}

type InboxLoadOptions = {
  silent?: boolean
  keepNotice?: boolean
}

type WhatsAppRealtimeChange = {
  table?: "whatsapp_conversations" | "whatsapp_messages"
  eventType?: string
  conversationId?: string | null
}

type PhonebookContact = {
  id: string
  full_name: string
  company: string | null
  title: string | null
  position: string | null
  department: string | null
  mobile_area: string | null
  mobile_1: string | null
  mobile_2: string | null
  mobile_phone: string | null
  business_phone: string | null
  business_phone_2: string | null
  direct_line: string | null
  other_phone: string | null
  instant_messaging: string | null
  personal_email: string | null
  general_email: string | null
  private_email: string | null
  favorite: boolean
}

type ContactOption = {
  id: string
  name: string
  company: string
  phone: string
  phoneDigits: string
  detail: string
  source: "phonebook"
  favorite: boolean
  raw: PhonebookContact
}

type ManualListType = "supplier" | "buyer"

type DragState =
  | { kind: "contact"; contactId: string }
  | { kind: "conversation"; conversationId: string }
  | { kind: "manual"; conversationId: string; listType: ManualListType }

type DropTarget = {
  listType: ManualListType
  index: number
}

export type WhatsAppWorkspaceAuth = {
  loading: boolean
  authenticated: boolean
  canView: boolean
  canEdit: boolean
}

type WhatsAppWorkspaceProps = {
  auth: WhatsAppWorkspaceAuth
  apiBasePath?: string
  backHref?: string
  backLabel?: string
}

const EMPTY_CONFIG: WhatsAppConfig = {
  configured: false,
  hasAccessToken: false,
  hasPhoneNumberId: false,
  hasBusinessAccountId: false,
  hasTemplateBusinessAccountId: false,
  hasVerifyToken: false,
  hasAppSecret: false,
  graphApiVersion: "v23.0",
}

const COUNTRY_CODES: Record<string, string> = {
  HK: "852",
  HONGKONG: "852",
  "HONG KONG": "852",
  CHINA: "86",
  CN: "86",
  SINGAPORE: "65",
  SG: "65",
  MALAYSIA: "60",
  THAILAND: "66",
  VIETNAM: "84",
  JAPAN: "81",
  KOREA: "82",
  TAIWAN: "886",
  USA: "1",
  US: "1",
  "UNITED STATES": "1",
  UK: "44",
  "UNITED KINGDOM": "44",
}
const DEFAULT_PHONE_COUNTRY_CODE = "852"
const CONTACT_SESSION_CACHE_KEY = "fc-whatsapp-contacts-v1"
const TEMPLATE_SESSION_CACHE_KEY = "fc-whatsapp-templates-v1"
const SESSION_CACHE_MS = 5 * 60 * 1000

const pageStyle: CSSProperties = {
  height: "100dvh",
  minHeight: 0,
  maxHeight: "100dvh",
  background: "#111b21",
  color: "#111b21",
  fontFamily: "var(--fc-admin-font)",
  padding: 0,
  overflow: "hidden",
}

const appShellStyle: CSSProperties = {
  height: "100dvh",
  minHeight: 0,
  maxHeight: "100dvh",
  display: "grid",
  gridTemplateColumns: "390px 230px minmax(460px, 1fr) 230px",
  background: "#efeae2",
  overflow: "hidden",
}

const headerBarStyle: CSSProperties = {
  minHeight: "60px",
  background: "#f0f2f5",
  borderBottom: "1px solid #d1d7db",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
  padding: "10px 16px",
}

const iconButtonStyle: CSSProperties = {
  width: "36px",
  height: "36px",
  border: "none",
  borderRadius: "999px",
  background: "transparent",
  color: "#54656f",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "18px",
  fontWeight: 800,
  textDecoration: "none",
  boxShadow: "none",
}

const searchBoxStyle: CSSProperties = {
  minHeight: "36px",
  borderRadius: "8px",
  border: "none",
  background: "#f0f2f5",
  color: "#111b21",
  fontSize: "14px",
  outline: "none",
  padding: "0 14px 0 40px",
  width: "100%",
  boxSizing: "border-box",
}

function phoneDigits(value: string | null | undefined) {
  return (value || "").replace(/\D/g, "")
}

function phoneMatchKey(value: string | null | undefined) {
  const digits = phoneDigits(value)
  if (digits.length === 8) return `${DEFAULT_PHONE_COUNTRY_CODE}${digits}`
  return digits
}

function countryCode(value: string | null | undefined) {
  const normalized = (value || "")
    .trim()
    .toUpperCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
  if (!normalized) return ""
  if (/^\+?\d+$/.test(normalized)) return normalized.replace(/\D/g, "")
  return COUNTRY_CODES[normalized] || ""
}

function normalizePhone(value: string | null | undefined, area?: string | null) {
  const trimmed = (value || "").trim()
  if (!trimmed) return ""
  if (trimmed.startsWith("+")) {
    const digits = phoneDigits(trimmed)
    if (digits.length === 8) return `+${DEFAULT_PHONE_COUNTRY_CODE}${digits}`
    return `+${digits}`
  }
  if (trimmed.startsWith("00")) return `+${phoneDigits(trimmed.slice(2))}`

  const digits = phoneDigits(trimmed)
  if (!digits) return ""
  const code = countryCode(area)
  if (digits.length === 8) return `+${code || DEFAULT_PHONE_COUNTRY_CODE}${digits}`
  if (digits.length > 8) return `+${digits}`
  return digits
}

function contactPhone(contact: PhonebookContact) {
  const candidates = [
    contact.mobile_1,
    contact.mobile_phone,
    contact.mobile_2,
    contact.instant_messaging,
    contact.business_phone,
    contact.business_phone_2,
    contact.direct_line,
    contact.other_phone,
  ]

  for (const candidate of candidates) {
    const normalized = normalizePhone(candidate, contact.mobile_area)
    if (normalized) return normalized
  }

  return ""
}

function contactName(contact: PhonebookContact) {
  return [contact.title, contact.full_name].filter(Boolean).join(" ").trim() || "Unknown contact"
}

function contactDetail(contact: PhonebookContact) {
  return [contact.company, contact.position, contact.department].filter(Boolean).join(" / ")
}

function buildContactOption(contact: PhonebookContact): ContactOption | null {
  const phone = contactPhone(contact)
  if (!phone) return null

  return {
    id: contact.id,
    name: contactName(contact),
    company: contact.company || "",
    phone,
    phoneDigits: phoneMatchKey(phone),
    detail: contactDetail(contact),
    source: "phonebook",
    favorite: Boolean(contact.favorite),
    raw: contact,
  }
}

function formatTime(value: string | null | undefined) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat("en-HK", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)
}

function formatDay(value: string | null | undefined) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat("en-HK", {
    day: "2-digit",
    month: "short",
  }).format(date)
}

function conversationTitle(
  conversation: WhatsAppConversation | null | undefined,
  contact?: ContactOption | null,
) {
  if (contact?.name) return contact.name
  if (!conversation) return "Select a chat"
  return conversation.display_name || conversation.phone_e164
}

function storageReadyMessage(inbox: WhatsAppInboxResponse) {
  if (inbox.storageReady) return ""
  return inbox.storageMessage || "WhatsApp storage is not ready."
}

function displayMessageText(message: Pick<WhatsAppMessage, "body" | "message_type">) {
  const body = (message.body || "").trim()
  if (message.message_type === "unsupported" || body === "[unsupported]") {
    return "Unsupported WhatsApp message"
  }
  return body || `[${message.message_type}]`
}

function displayPreview(value: string | null | undefined) {
  const preview = (value || "").trim()
  if (preview === "[unsupported]" || preview.toLowerCase().startsWith("unsupported message:")) {
    return "Unsupported WhatsApp message"
  }
  return preview
}

function templateKey(template: Pick<WhatsAppTemplate, "name" | "language">) {
  return `${template.name}|||${template.language}`
}

function templateHeader(template: WhatsAppTemplate) {
  return template.components.find((component) => component.type?.toUpperCase() === "HEADER")?.text?.trim() || ""
}

function templateLabel(template: WhatsAppTemplate) {
  return templateHeader(template) || template.name.replace(/_/g, " ")
}

function templateBodyVariables(template: WhatsAppTemplate) {
  const body = template.components.find((component) => component.type?.toUpperCase() === "BODY")
  const text = body?.text || ""
  const names: string[] = []
  for (const match of text.matchAll(/{{\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*}}/g)) {
    const name = match[1]
    if (!names.includes(name)) names.push(name)
  }
  return names
}

function templateOptionLabel(template: WhatsAppTemplate) {
  const variables = templateBodyVariables(template)
  const variableText = variables.length > 0 ? ` · ${variables.join(", ")}` : ""
  return `${templateLabel(template)} · ${template.name} · ${template.language}${variableText}`
}

function splitTemplateEntries(value: string) {
  const normalized = value.replace(/\r\n?/g, "\n").trim()
  if (!normalized) return []
  const separator = /\n\s*\n/.test(normalized) ? /\n\s*\n+/ : /\n+/
  return normalized
    .split(separator)
    .map((entry) => entry.replace(/\s*\n\s*/g, " ").replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
}

function buildTemplateVariableValues(template: WhatsAppTemplate, variableText: string) {
  const variables = templateBodyVariables(template)
  if (variables.length === 0) return {}
  if (variables.length === 1) return { [variables[0]]: variableText.trim() }

  const entries = splitTemplateEntries(variableText)
  return Object.fromEntries(
    variables.map((variable, index) => [variable, entries[index] || ""]),
  )
}

function renderTemplatePreview(
  template: WhatsAppTemplate,
  variableText: string,
  variableValues = buildTemplateVariableValues(template, variableText),
) {
  const lines: string[] = []

  for (const component of template.components) {
    const type = component.type?.toUpperCase()
    if ((type === "HEADER" || type === "BODY" || type === "FOOTER") && component.text) {
      lines.push(
        component.text.replace(
          /{{\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*}}/g,
          (_placeholder, variable: string) => variableValues[variable] || "",
        ),
      )
    }
  }

  return lines.filter(Boolean).join("\n\n").trim() || template.name
}

function conversationPreviewTime(value: string | null | undefined) {
  const time = Date.parse(value || "")
  return Number.isFinite(time) ? time : 0
}

function sortConversations(conversations: WhatsAppConversation[]) {
  return [...conversations].sort(
    (first, second) => conversationPreviewTime(second.last_message_at) - conversationPreviewTime(first.last_message_at),
  )
}

function inboxSignature(inbox: WhatsAppInboxResponse) {
  return JSON.stringify({
    selected: inbox.selectedConversationId,
    conversations: inbox.conversations.map((conversation) => [
      conversation.id,
      conversation.last_message_at,
      conversation.updated_at,
      conversation.unread_count,
      conversation.last_message_preview,
    ]),
    messages: inbox.messages.map((messageItem) => [
      messageItem.id,
      messageItem.status,
      messageItem.sent_at,
      messageItem.body,
    ]),
  })
}

function metadataNumber(conversation: WhatsAppConversation, key: string) {
  const value = conversation.metadata?.[key]
  const numberValue = typeof value === "number" ? value : Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function listTag(listType: ManualListType) {
  return listType
}

function listOrderKey(listType: ManualListType) {
  return `whatsapp_${listType}_order`
}

function listAtKey(listType: ManualListType) {
  return `whatsapp_${listType}_at`
}

function conversationInList(conversation: WhatsAppConversation, listType: ManualListType) {
  const tags = conversation.tags || []
  if (listType === "supplier") return tags.includes("supplier") || tags.includes("assigned")
  return tags.includes("buyer")
}

function manualSortValue(conversation: WhatsAppConversation, listType: ManualListType) {
  const savedOrder =
    metadataNumber(conversation, listOrderKey(listType)) ??
    (listType === "supplier" ? metadataNumber(conversation, "whatsapp_assigned_order") : null)
  if (savedOrder !== null) return savedOrder
  const listedAt =
    conversation.metadata?.[listAtKey(listType)] ||
    (listType === "supplier" ? conversation.metadata?.whatsapp_assigned_at : null)
  const listedTime = typeof listedAt === "string" ? Date.parse(listedAt) : Number.NaN
  if (Number.isFinite(listedTime)) return listedTime
  const updatedTime = Date.parse(conversation.updated_at || conversation.created_at)
  return Number.isFinite(updatedTime) ? updatedTime : Number.MAX_SAFE_INTEGER
}

function withManualOrder(conversations: WhatsAppConversation[], listType: ManualListType) {
  return conversations.map((conversation, index) => ({
    ...conversation,
    tags: Array.from(new Set([
      ...(conversation.tags || []),
      listTag(listType),
      ...(listType === "supplier" ? ["assigned"] : []),
    ])),
    metadata: {
      ...(conversation.metadata || {}),
      [listOrderKey(listType)]: (index + 1) * 1000,
      ...(listType === "supplier" ? { whatsapp_assigned_order: (index + 1) * 1000 } : {}),
    },
  }))
}

function withoutManualList(conversation: WhatsAppConversation, listType: ManualListType) {
  const metadata = { ...(conversation.metadata || {}) }
  delete metadata[listAtKey(listType)]
  delete metadata[listOrderKey(listType)]
  if (listType === "supplier") {
    delete metadata.whatsapp_assigned_at
    delete metadata.whatsapp_assigned_order
  }
  const removeTags = new Set([listTag(listType), ...(listType === "supplier" ? ["assigned"] : [])])
  return {
    ...conversation,
    tags: (conversation.tags || []).filter((tag) => !removeTags.has(tag)),
    metadata,
  }
}

function insertConversationAt(
  conversations: WhatsAppConversation[],
  conversation: WhatsAppConversation,
  index: number,
) {
  const withoutCurrent = conversations.filter((item) => item.id !== conversation.id)
  const boundedIndex = Math.max(0, Math.min(index, withoutCurrent.length))
  return [
    ...withoutCurrent.slice(0, boundedIndex),
    conversation,
    ...withoutCurrent.slice(boundedIndex),
  ]
}

export function WhatsAppWorkspace({
  auth,
  apiBasePath = "/api/whatsapp",
  backHref = "/admin",
  backLabel = "Return to admin",
}: WhatsAppWorkspaceProps) {
  const isMobile = useIsMobile(980)
  const { loading: authLoading, authenticated, canView, canEdit } = auth
  const [inbox, setInbox] = useState<WhatsAppInboxResponse>({
    conversations: [],
    messages: [],
    selectedConversationId: null,
    storageReady: false,
    storageMessage: null,
    config: EMPTY_CONFIG,
  })
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [selectedContact, setSelectedContact] = useState<ContactOption | null>(null)
  const [leftSearchQuery, setLeftSearchQuery] = useState("")
  const deferredLeftSearchQuery = useDeferredValue(leftSearchQuery)
  const [contacts, setContacts] = useState<ContactOption[]>([])
  const [contactMatches, setContactMatches] = useState<Record<string, ContactOption>>({})
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([])
  const [selectedTemplateKey, setSelectedTemplateKey] = useState("")
  const [composeTo, setComposeTo] = useState("")
  const [composeBody, setComposeBody] = useState("")
  const [loading, setLoading] = useState(true)
  const [contactLoading, setContactLoading] = useState(false)
  const [templateLoading, setTemplateLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [dragState, setDragState] = useState<DragState | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [savingList, setSavingList] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const composeRef = useRef<HTMLTextAreaElement | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const contactRequestIdRef = useRef(0)
  const messageRequestIdRef = useRef(0)
  const inboxPollRef = useRef(false)
  const inboxSignatureRef = useRef("")
  const contactMatchesRef = useRef<Record<string, ContactOption>>({})
  const contactLookupRef = useRef(new Set<string>())
  const selectedConversationIdRef = useRef<string | null>(null)
  const selectedContactRef = useRef<ContactOption | null>(null)
  const realtimeRefreshTimerRef = useRef<number | null>(null)

  const config = inbox.config || EMPTY_CONFIG
  const storageMessage = storageReadyMessage(inbox)

  const apiPath = useCallback((path: string) => `${apiBasePath}${path}`, [apiBasePath])

  const mergeContactMatches = useCallback((items: ContactOption[]) => {
    setContactMatches((current) => {
      const next = { ...current }
      for (const item of items) {
        if (item.phoneDigits) next[item.phoneDigits] = item
        const key = phoneMatchKey(item.phone)
        if (key) next[key] = item
      }
      contactMatchesRef.current = next
      return next
    })
  }, [])

  const loadContacts = useCallback(async (query: string) => {
    const requestId = contactRequestIdRef.current + 1
    contactRequestIdRef.current = requestId
    const normalizedQuery = query.trim()
    let usedCache = false

    if (!normalizedQuery) {
      try {
        const cached = window.sessionStorage.getItem(CONTACT_SESSION_CACHE_KEY)
        if (cached) {
          const parsed = JSON.parse(cached) as { at?: number; contacts?: PhonebookContact[] }
          if (parsed.at && Date.now() - parsed.at < SESSION_CACHE_MS && Array.isArray(parsed.contacts)) {
            const cachedContacts = parsed.contacts
              .map(buildContactOption)
              .filter((item): item is ContactOption => Boolean(item))
            setContacts(cachedContacts)
            mergeContactMatches(cachedContacts)
            usedCache = true
          }
        }
      } catch {
        window.sessionStorage.removeItem(CONTACT_SESSION_CACHE_KEY)
      }
    }

    setContactLoading(!usedCache)
    try {
      const url = new URL(apiPath("/contacts"), window.location.origin)
      if (normalizedQuery) url.searchParams.set("query", normalizedQuery)
      const response = await fetch(url, { cache: "no-store" })
      const data = (await response.json().catch(() => ({}))) as {
        contacts?: PhonebookContact[]
        message?: string
      }
      if (!response.ok) throw new Error(data.message || "Unable to load phonebook contacts.")
      const nextContacts = (data.contacts || [])
        .map(buildContactOption)
        .filter((item): item is ContactOption => Boolean(item))
      if (contactRequestIdRef.current !== requestId) return
      if (!normalizedQuery) {
        try {
          window.sessionStorage.setItem(
            CONTACT_SESSION_CACHE_KEY,
            JSON.stringify({ at: Date.now(), contacts: data.contacts || [] }),
          )
        } catch {}
      }
      setContacts(nextContacts)
      mergeContactMatches(nextContacts)
    } catch (contactError) {
      if (contactRequestIdRef.current !== requestId) return
      setError(contactError instanceof Error ? contactError.message : "Unable to load phonebook contacts.")
    } finally {
      if (contactRequestIdRef.current === requestId) setContactLoading(false)
    }
  }, [apiPath, mergeContactMatches])

  const loadContactByPhone = useCallback(async (phone: string) => {
    const digits = phoneDigits(phone)
    const key = phoneMatchKey(phone)
    if (!digits || contactMatchesRef.current[key] || contactLookupRef.current.has(key)) return
    contactLookupRef.current.add(key)

    try {
      const url = new URL(apiPath("/contacts"), window.location.origin)
      url.searchParams.set("phone", digits)
      url.searchParams.set("limit", "6")
      const response = await fetch(url, { cache: "no-store" })
      const data = (await response.json().catch(() => ({}))) as {
        contacts?: PhonebookContact[]
      }
      if (!response.ok) return
      const matches = (data.contacts || [])
        .map(buildContactOption)
        .filter((item): item is ContactOption => Boolean(item))
      mergeContactMatches(matches)
    } catch {
      contactLookupRef.current.delete(key)
      // Contact enrichment should never block the chat.
    }
  }, [apiPath, mergeContactMatches])

  useEffect(() => {
    contactMatchesRef.current = contactMatches
  }, [contactMatches])

  const loadTemplates = useCallback(async () => {
    let usedCache = false
    try {
      const cached = window.sessionStorage.getItem(TEMPLATE_SESSION_CACHE_KEY)
      if (cached) {
        const parsed = JSON.parse(cached) as { at?: number; templates?: WhatsAppTemplate[] }
        if (parsed.at && Date.now() - parsed.at < SESSION_CACHE_MS && Array.isArray(parsed.templates)) {
          setTemplates(parsed.templates)
          usedCache = true
        }
      }
    } catch {
      window.sessionStorage.removeItem(TEMPLATE_SESSION_CACHE_KEY)
    }

    setTemplateLoading(!usedCache)
    try {
      const response = await fetch(apiPath("/templates"), { cache: "no-store" })
      const data = (await response.json().catch(() => ({}))) as {
        templates?: WhatsAppTemplate[]
        message?: string
      }
      if (!response.ok) throw new Error(data.message || "Unable to load WhatsApp templates.")
      setTemplates(data.templates || [])
      try {
        window.sessionStorage.setItem(
          TEMPLATE_SESSION_CACHE_KEY,
          JSON.stringify({ at: Date.now(), templates: data.templates || [] }),
        )
      } catch {}
    } catch (templateError) {
      if (!usedCache) {
        setError(templateError instanceof Error ? templateError.message : "Unable to load WhatsApp templates.")
      }
    } finally {
      setTemplateLoading(false)
    }
  }, [apiPath])

  const loadInbox = useCallback(async (
    conversationId?: string | null,
    options: InboxLoadOptions = {},
  ) => {
    if (!options.silent) {
      setError("")
      if (!options.keepNotice) setMessage("")
      setLoading(true)
    }

    try {
      const url = new URL(apiPath("/inbox"), window.location.origin)
      if (conversationId) url.searchParams.set("conversationId", conversationId)
      const response = await fetch(url, { cache: "no-store" })
      const data = (await response.json().catch(() => ({}))) as WhatsAppInboxResponse
      if (!response.ok) throw new Error(data.message || "Unable to load WhatsApp inbox.")

      const nextSignature = inboxSignature(data)
      if (options.silent && nextSignature === inboxSignatureRef.current) return
      inboxSignatureRef.current = nextSignature
      setInbox(data)
      setSelectedConversationId(data.selectedConversationId)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load WhatsApp inbox.")
    } finally {
      if (!options.silent) setLoading(false)
    }
  }, [apiPath])

  const loadConversationMessages = useCallback(async (conversationId: string) => {
    if (!conversationId) return
    const requestId = messageRequestIdRef.current + 1
    messageRequestIdRef.current = requestId

    try {
      const url = new URL(apiPath("/messages"), window.location.origin)
      url.searchParams.set("conversationId", conversationId)
      const response = await fetch(url, { cache: "no-store" })
      const data = (await response.json().catch(() => ({}))) as WhatsAppMessagesResponse
      if (!response.ok) throw new Error(data.message || "Unable to load WhatsApp messages.")
      if (messageRequestIdRef.current !== requestId) return

      setInbox((current) => ({
        ...current,
        selectedConversationId: conversationId,
        messages: data.messages || [],
      }))
    } catch (messagesError) {
      setError(messagesError instanceof Error ? messagesError.message : "Unable to load WhatsApp messages.")
    }
  }, [apiPath])

  const scheduleRealtimeRefresh = useCallback((change: WhatsAppRealtimeChange) => {
    if (realtimeRefreshTimerRef.current) {
      window.clearTimeout(realtimeRefreshTimerRef.current)
    }

    realtimeRefreshTimerRef.current = window.setTimeout(() => {
      realtimeRefreshTimerRef.current = null
      if (selectedContactRef.current) return
      void loadInbox(selectedConversationIdRef.current, { silent: true, keepNotice: true })
    }, change.table === "whatsapp_messages" ? 80 : 120)
  }, [loadInbox])

  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId
  }, [selectedConversationId])

  useEffect(() => {
    selectedContactRef.current = selectedContact
  }, [selectedContact])

  useEffect(() => {
    if (authLoading || !authenticated || !canView) return
    void loadInbox(selectedConversationId)
  }, [authLoading, authenticated, canView, loadInbox])

  useEffect(() => {
    if (authLoading || !authenticated || !canView) return
    void loadTemplates()
  }, [authLoading, authenticated, canView, loadTemplates])

  useEffect(() => {
    if (authLoading || !authenticated || !canView) return
    const timer = window.setTimeout(() => {
      void loadContacts(deferredLeftSearchQuery)
    }, deferredLeftSearchQuery ? 180 : 0)

    return () => window.clearTimeout(timer)
  }, [authLoading, authenticated, canView, deferredLeftSearchQuery, loadContacts])

  useEffect(() => {
    if (authLoading || !authenticated || !canView || selectedContact || sending || savingList || dragState) return

    const pollInbox = async () => {
      if (document.hidden) return
      if (composeRef.current && document.activeElement === composeRef.current) return
      if (inboxPollRef.current) return
      inboxPollRef.current = true
      try {
        await loadInbox(selectedConversationId, { silent: true, keepNotice: true })
      } finally {
        inboxPollRef.current = false
      }
    }

    const timer = window.setInterval(() => {
      void pollInbox()
    }, 15000)

    return () => window.clearInterval(timer)
  }, [
    authLoading,
    authenticated,
    canView,
    dragState,
    loadInbox,
    savingList,
    selectedContact,
    selectedConversationId,
    sending,
  ])

  useEffect(() => {
    if (authLoading || !authenticated || !canView) return

    const events = new EventSource(apiPath("/events"))
    const handleChange = (event: Event) => {
      try {
        const messageEvent = event as MessageEvent<string>
        scheduleRealtimeRefresh(JSON.parse(messageEvent.data) as WhatsAppRealtimeChange)
      } catch {
        scheduleRealtimeRefresh({})
      }
    }

    events.addEventListener("whatsapp-change", handleChange)

    return () => {
      events.removeEventListener("whatsapp-change", handleChange)
      events.close()
      if (realtimeRefreshTimerRef.current) {
        window.clearTimeout(realtimeRefreshTimerRef.current)
        realtimeRefreshTimerRef.current = null
      }
    }
  }, [apiPath, authLoading, authenticated, canView, scheduleRealtimeRefresh])

  const selectedConversation = useMemo(
    () =>
      inbox.conversations.find((conversation) => conversation.id === selectedConversationId) ||
      null,
    [inbox.conversations, selectedConversationId],
  )

  useEffect(() => {
    if (selectedConversation?.phone_e164) {
      setComposeTo(selectedConversation.phone_e164)
      void loadContactByPhone(selectedConversation.phone_e164)
    }
  }, [loadContactByPhone, selectedConversation?.phone_e164])

  const selectedConversationContact = selectedConversation
    ? contactMatches[phoneMatchKey(selectedConversation.phone_e164)] || null
    : null
  const activeContact = selectedConversationContact || selectedContact
  const selectedMessages = useMemo(
    () =>
      inbox.messages.filter(
        (chatMessage) => chatMessage.conversation_id === selectedConversationId,
      ),
    [inbox.messages, selectedConversationId],
  )

  const conversationItems = useMemo(() => {
    const normalizedQuery = deferredLeftSearchQuery.trim().toLowerCase()
    return inbox.conversations.filter((conversation) => {
      if (!conversation.last_message_at && !conversation.last_message_preview) return false
      if (!normalizedQuery) return true
      const match = contactMatches[phoneMatchKey(conversation.phone_e164)]
      return [
        conversation.display_name,
        conversation.phone_e164,
        conversation.company,
        conversation.last_message_preview,
        match?.name,
        match?.company,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery)
    })
  }, [contactMatches, deferredLeftSearchQuery, inbox.conversations])

  const supplierConversations = useMemo(
    () =>
      inbox.conversations
        .filter((conversation) => conversationInList(conversation, "supplier"))
        .sort((first, second) => manualSortValue(first, "supplier") - manualSortValue(second, "supplier")),
    [inbox.conversations],
  )

  const buyerConversations = useMemo(
    () =>
      inbox.conversations
        .filter((conversation) => conversationInList(conversation, "buyer"))
        .sort((first, second) => manualSortValue(first, "buyer") - manualSortValue(second, "buyer")),
    [inbox.conversations],
  )

  const manualConversationsByType = useMemo(
    () => ({
      supplier: supplierConversations,
      buyer: buyerConversations,
    }),
    [buyerConversations, supplierConversations],
  )

  const phonebookItems = useMemo(() => {
    const listedPhones = new Set(
      [...supplierConversations, ...buyerConversations].map((item) => phoneMatchKey(item.phone_e164)),
    )
    return contacts.filter((contact) => !listedPhones.has(contact.phoneDigits))
  }, [buyerConversations, contacts, supplierConversations])

  const activeTitle = conversationTitle(selectedConversation, activeContact)
  const activeSubtitle =
    activeContact?.detail ||
    activeContact?.phone ||
    selectedConversation?.phone_e164 ||
    "Search phonebook contacts to start a chat"
  const activePhone = selectedConversation?.phone_e164 || selectedContact?.phone || composeTo

  const approvedTemplates = useMemo(
    () =>
      templates
        .filter((template) => template.status.toUpperCase() === "APPROVED")
        .sort((first, second) =>
          `${templateLabel(first)} ${first.language}`.localeCompare(`${templateLabel(second)} ${second.language}`),
        ),
    [templates],
  )
  const variableTemplates = useMemo(
    () => approvedTemplates.filter((template) => templateBodyVariables(template).length > 0),
    [approvedTemplates],
  )
  const selectedTemplate = useMemo(
    () => variableTemplates.find((template) => templateKey(template) === selectedTemplateKey) || null,
    [selectedTemplateKey, variableTemplates],
  )
  const selectedTemplateVariables = useMemo(
    () => (selectedTemplate ? templateBodyVariables(selectedTemplate) : []),
    [selectedTemplate],
  )
  const selectedTemplateValues = useMemo(
    () => (selectedTemplate ? buildTemplateVariableValues(selectedTemplate, composeBody) : {}),
    [composeBody, selectedTemplate],
  )
  const selectedTemplateEntryCount = useMemo(
    () => Object.values(selectedTemplateValues).filter(Boolean).length,
    [selectedTemplateValues],
  )
  const selectedTemplateInputCount = useMemo(
    () =>
      selectedTemplate && selectedTemplateVariables.length > 1
        ? splitTemplateEntries(composeBody).length
        : selectedTemplateEntryCount,
    [composeBody, selectedTemplate, selectedTemplateEntryCount, selectedTemplateVariables.length],
  )
  const selectedTemplateOverLimit =
    selectedTemplateVariables.length > 0 && selectedTemplateInputCount > selectedTemplateVariables.length
  const selectedTemplatePreview = useMemo(
    () =>
      selectedTemplate
        ? renderTemplatePreview(selectedTemplate, composeBody, selectedTemplateValues)
        : "",
    [composeBody, selectedTemplate, selectedTemplateValues],
  )
  const templateNeedsText = selectedTemplateVariables.length > 0
  useEffect(() => {
    if (!selectedTemplateKey) return
    if (!variableTemplates.some((template) => templateKey(template) === selectedTemplateKey)) {
      setSelectedTemplateKey("")
    }
  }, [selectedTemplateKey, variableTemplates])

  const canSendMessage = Boolean(
    canEdit &&
      config.configured &&
      activePhone &&
      !sending &&
      !selectedTemplateOverLimit &&
      (selectedTemplate
        ? !templateNeedsText || selectedTemplateEntryCount > 0
        : composeBody.trim()),
  )

  const mobileGridStyle: CSSProperties = isMobile
    ? {
        gridTemplateColumns: "1fr",
        height: "auto",
        minHeight: "100dvh",
      }
    : {}

  const focusComposer = useCallback(() => {
    window.requestAnimationFrame(() => {
      composeRef.current?.focus({ preventScroll: true })
    })
  }, [])

  const updateDropTarget = useCallback((nextTarget: DropTarget | null) => {
    setDropTarget((current) => {
      if (!current && !nextTarget) return current
      if (
        current &&
        nextTarget &&
        current.listType === nextTarget.listType &&
        current.index === nextTarget.index
      ) {
        return current
      }
      return nextTarget
    })
  }, [])

  const adjustComposerHeight = useCallback(() => {
    const textarea = composeRef.current
    if (!textarea) return

    textarea.style.height = "auto"
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, 42), 120)
    textarea.style.height = `${nextHeight}px`
    textarea.style.overflowY = textarea.scrollHeight > 120 ? "auto" : "hidden"
  }, [])

  useEffect(() => {
    adjustComposerHeight()
  }, [adjustComposerHeight, composeBody])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" })
  }, [selectedConversationId, selectedMessages.length])

  const markConversationRead = useCallback(async (conversationId: string) => {
    if (!conversationId) return
    setInbox((current) => ({
      ...current,
      conversations: current.conversations.map((conversation) =>
        conversation.id === conversationId
          ? { ...conversation, unread_count: 0 }
          : conversation,
      ),
    }))

    try {
      await fetch(apiPath("/read"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId }),
      })
    } catch {
      // Reading a chat should not block the operator if the background write fails.
    }
  }, [apiPath])

  async function selectConversation(conversationId: string) {
    const conversation = inbox.conversations.find((item) => item.id === conversationId)
    setSelectedConversationId(conversationId)
    setSelectedContact(null)
    setError("")
    setMessage("")
    if (conversation?.phone_e164) setComposeTo(conversation.phone_e164)
    void markConversationRead(conversationId)
    void loadConversationMessages(conversationId)
    focusComposer()
  }

  function selectContact(contact: ContactOption) {
    const existing = inbox.conversations.find(
      (conversation) => phoneMatchKey(conversation.phone_e164) === contact.phoneDigits,
    )
    if (existing) {
      void selectConversation(existing.id)
      return
    }

    setSelectedConversationId(null)
    setSelectedContact(contact)
    setComposeTo(contact.phone)
    setError("")
    setMessage("")
    focusComposer()
  }

  useEffect(() => {
    if (!selectedConversation?.id || !selectedConversation.unread_count) return
    void markConversationRead(selectedConversation.id)
  }, [markConversationRead, selectedConversation?.id, selectedConversation?.unread_count])

  function applyConversationUpdates(conversations: WhatsAppConversation[]) {
    setInbox((current) => {
      const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]))
      const existingIds = new Set(current.conversations.map((conversation) => conversation.id))
      return {
        ...current,
        conversations: sortConversations([
          ...current.conversations.map((conversation) => byId.get(conversation.id) || conversation),
          ...conversations.filter((conversation) => !existingIds.has(conversation.id)),
        ]),
      }
    })
  }

  function addOptimisticMessage(to: string, preview: string, messageType: string) {
    messageRequestIdRef.current += 1
    const now = new Date().toISOString()
    const normalizedTo = normalizePhone(to) || to
    const conversationId = selectedConversation?.id || `local-${phoneDigits(normalizedTo) || Date.now()}`
    const optimisticMessageId = `optimistic-${conversationId}-${Date.now()}`
    const baseConversation: WhatsAppConversation = selectedConversation || {
      id: conversationId,
      phone_e164: normalizedTo,
      display_name: selectedContact?.name || normalizedTo,
      company: selectedContact?.company || null,
      assigned_to: null,
      status: "open",
      tags: [],
      last_message_preview: null,
      last_message_at: null,
      unread_count: 0,
      metadata: { optimistic: true },
      created_at: now,
      updated_at: now,
    }
    const optimisticConversation: WhatsAppConversation = {
      ...baseConversation,
      phone_e164: normalizedTo,
      last_message_preview: preview,
      last_message_at: now,
      unread_count: 0,
      updated_at: now,
    }
    const optimisticMessage: WhatsAppMessage = {
      id: optimisticMessageId,
      conversation_id: conversationId,
      whatsapp_message_id: null,
      direction: "outbound",
      message_type: messageType,
      body: preview,
      media_url: null,
      status: "sending",
      from_phone: null,
      to_phone: normalizedTo,
      payload: { optimistic: true },
      sent_at: now,
      created_at: now,
    }

    setInbox((current) => ({
      ...current,
      selectedConversationId: conversationId,
      conversations: sortConversations([
        optimisticConversation,
        ...current.conversations.filter((conversation) => conversation.id !== conversationId),
      ]),
      messages: [
        ...current.messages.filter((messageItem) => messageItem.id !== optimisticMessageId),
        optimisticMessage,
      ],
    }))
    setSelectedConversationId(conversationId)
    setSelectedContact(null)
    setComposeTo(normalizedTo)
    return { conversationId, optimisticMessageId }
  }

  function markOptimisticMessageFailed(messageId: string) {
    setInbox((current) => ({
      ...current,
      messages: current.messages.map((messageItem) =>
        messageItem.id === messageId
          ? { ...messageItem, status: "failed" }
          : messageItem,
      ),
    }))
  }

  function manualConversations(listType: ManualListType) {
    return manualConversationsByType[listType]
  }

  async function saveManualOrder(conversations: WhatsAppConversation[], listType: ManualListType) {
    const ordered = withManualOrder(conversations, listType)
    applyConversationUpdates(ordered)
    const response = await fetch(apiPath("/assigned-order"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        listType,
        items: ordered.map((conversation, index) => ({
          conversationId: conversation.id,
          order: (index + 1) * 1000,
        })),
      }),
    })
    const data = (await response.json().catch(() => ({}))) as {
      conversations?: WhatsAppConversation[]
      message?: string
    }
    if (!response.ok) throw new Error(data.message || "Unable to save contact order.")
    if (data.conversations?.length) applyConversationUpdates(data.conversations)
  }

  async function assignContact(
    contact: ContactOption,
    listType: ManualListType,
    index = manualConversations(listType).length,
  ) {
    if (savingList || !canEdit) return
    setSavingList(true)
    setError("")
    setMessage("")

    try {
      const assignedOrder = (index + 1) * 1000
      const response = await fetch(apiPath("/assign"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: contact.phone,
          displayName: contact.name,
          company: contact.company,
          contactId: contact.id,
          assignedOrder,
          listType,
        }),
      })
      const data = (await response.json().catch(() => ({}))) as {
        conversation?: WhatsAppConversation
        message?: string
      }
      if (!response.ok || !data.conversation) {
        throw new Error(data.message || "Unable to assign WhatsApp contact.")
      }
      const assignedConversation = data.conversation

      mergeContactMatches([contact])
      const nextList = insertConversationAt(manualConversations(listType), assignedConversation, index)
      setSelectedContact(null)
      setSelectedConversationId(assignedConversation.id)
      setComposeTo(assignedConversation.phone_e164)
      void loadConversationMessages(assignedConversation.id)
      focusComposer()
      await saveManualOrder(nextList, listType)
    } catch (assignError) {
      setError(assignError instanceof Error ? assignError.message : "Unable to assign WhatsApp contact.")
    } finally {
      setSavingList(false)
    }
  }

  async function reorderManualContact(conversationId: string, index: number, listType: ManualListType) {
    if (savingList || !canEdit) return
    const listItems = manualConversations(listType)
    const conversation = listItems.find((item) => item.id === conversationId)
    if (!conversation) return
    const currentIndex = listItems.findIndex((item) => item.id === conversationId)
    const adjustedIndex = currentIndex >= 0 && currentIndex < index ? index - 1 : index

    setSavingList(true)
    setError("")
    setMessage("")
    try {
      const nextList = insertConversationAt(listItems, conversation, adjustedIndex)
      await saveManualOrder(nextList, listType)
    } catch (orderError) {
      setError(orderError instanceof Error ? orderError.message : "Unable to save contact order.")
    } finally {
      setSavingList(false)
    }
  }

  async function removeManualContact(conversationId: string, listType: ManualListType) {
    if (savingList || !canEdit) return
    const listItems = manualConversations(listType)
    const conversation = listItems.find((item) => item.id === conversationId)
    if (!conversation) return

    setSavingList(true)
    setError("")
    setMessage("")
    try {
      applyConversationUpdates([withoutManualList(conversation, listType)])
      const response = await fetch(apiPath("/unassign"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, listType }),
      })
      const data = (await response.json().catch(() => ({}))) as {
        conversation?: WhatsAppConversation
        message?: string
      }
      if (!response.ok || !data.conversation) {
        throw new Error(data.message || "Unable to remove WhatsApp contact.")
      }
      applyConversationUpdates([data.conversation])
      const remaining = listItems.filter((item) => item.id !== conversationId)
      await saveManualOrder(remaining, listType)
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Unable to remove WhatsApp contact.")
      applyConversationUpdates([conversation])
    } finally {
      setSavingList(false)
    }
  }

  async function dropOnManualPanel(listType: ManualListType, index: number) {
    if (!dragState) return
    const listItems = manualConversations(listType)
    const boundedIndex = Math.max(0, Math.min(index, listItems.length))
    if (dragState.kind === "contact") {
      const contact = contacts.find((item) => item.id === dragState.contactId)
      if (contact) await assignContact(contact, listType, boundedIndex)
    } else if (dragState.kind === "conversation") {
      const conversation = inbox.conversations.find((item) => item.id === dragState.conversationId)
      if (conversation) {
        if (conversationInList(conversation, listType)) {
          await reorderManualContact(conversation.id, boundedIndex, listType)
        } else {
          setSavingList(true)
          setError("")
          setMessage("")
          try {
            const nextList = insertConversationAt(listItems, conversation, boundedIndex)
            await saveManualOrder(nextList, listType)
          } catch (orderError) {
            setError(orderError instanceof Error ? orderError.message : "Unable to save contact order.")
          } finally {
            setSavingList(false)
          }
        }
      }
    } else {
      if (dragState.listType === listType) {
        await reorderManualContact(dragState.conversationId, boundedIndex, listType)
      } else {
        const sourceItems = manualConversations(dragState.listType)
        const conversation =
          sourceItems.find((item) => item.id === dragState.conversationId) ||
          inbox.conversations.find((item) => item.id === dragState.conversationId)
        if (conversation) {
          setSavingList(true)
          setError("")
          setMessage("")
          try {
            const nextTarget = insertConversationAt(listItems, conversation, boundedIndex)
            await saveManualOrder(nextTarget, listType)
            const response = await fetch(apiPath("/unassign"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                conversationId: conversation.id,
                listType: dragState.listType,
              }),
            })
            const data = (await response.json().catch(() => ({}))) as {
              conversation?: WhatsAppConversation
              message?: string
            }
            if (!response.ok || !data.conversation) {
              throw new Error(data.message || "Unable to move WhatsApp contact.")
            }
            applyConversationUpdates([data.conversation])
            await saveManualOrder(
              sourceItems.filter((item) => item.id !== conversation.id),
              dragState.listType,
            )
          } catch (moveError) {
            setError(moveError instanceof Error ? moveError.message : "Unable to move WhatsApp contact.")
          } finally {
            setSavingList(false)
          }
        }
      }
    }
    setDragState(null)
    updateDropTarget(null)
  }

  async function sendMessage() {
    const to = (selectedConversation?.phone_e164 || selectedContact?.phone || composeTo).trim()
    const body = composeBody.trim()
    if (!to || !canSendMessage || sending) return

    const preview = selectedTemplate ? selectedTemplatePreview : body
    const targetConversationId = selectedConversation?.id || null
    const { optimisticMessageId } = addOptimisticMessage(
      to,
      preview,
      selectedTemplate ? "template" : "text",
    )

    setSending(true)
    setError("")
    setMessage("")
    setComposeBody("")

    try {
      const response = await fetch(apiPath(selectedTemplate ? "/send-template" : "/send"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          selectedTemplate
            ? {
                to,
                templateName: selectedTemplate.name,
                language: selectedTemplate.language,
                variableText: body,
                variableValues: selectedTemplateValues,
              }
            : { to, message: body },
        ),
      })
      const data = (await response.json().catch(() => ({}))) as {
        message?: string
        storageWarning?: string
      }
      if (!response.ok) throw new Error(data.message || "Unable to send WhatsApp message.")

      if (targetConversationId) {
        void loadConversationMessages(targetConversationId)
      } else {
        await loadInbox(null)
      }
      setMessage(data.storageWarning || (selectedTemplate ? "Template sent." : "Message sent."))
    } catch (sendError) {
      markOptimisticMessageFailed(optimisticMessageId)
      setError(sendError instanceof Error ? sendError.message : "Unable to send WhatsApp message.")
    } finally {
      setSending(false)
    }
  }

  function renderConversationRow(conversation: WhatsAppConversation) {
    const selected = conversation.id === selectedConversationId
    const match = contactMatches[phoneMatchKey(conversation.phone_e164)] || null
    const title = conversationTitle(conversation, match)
    const detail = match?.detail || conversation.company || conversation.phone_e164
    const unread = conversation.unread_count > 0

    return (
      <button
        key={conversation.id}
        type="button"
        onClick={() => void selectConversation(conversation.id)}
        draggable={canEdit}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "copyMove"
          event.dataTransfer.setData("text/plain", `conversation:${conversation.id}`)
          setDragState({ kind: "conversation", conversationId: conversation.id })
          updateDropTarget({ listType: "supplier", index: supplierConversations.length })
        }}
        onDragEnd={() => {
          setDragState(null)
          updateDropTarget(null)
        }}
        style={{
          width: "100%",
          minHeight: "72px",
          border: "none",
          borderBottom: "1px solid #e9edef",
          background: selected ? "#f0f2f5" : "#ffffff",
          color: "#111b21",
          cursor: canEdit ? "grab" : "pointer",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto",
          gap: "12px",
          alignItems: "center",
          padding: "11px 14px 11px 18px",
          textAlign: "left",
          boxShadow: "none",
        }}
      >
        <span style={{ minWidth: 0, display: "grid", gap: "4px" }}>
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "#111b21",
              fontSize: "16px",
              fontWeight: unread ? 700 : 500,
            }}
          >
            {title}
          </span>
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: unread ? "#111b21" : "#667781",
              fontSize: "13px",
              fontWeight: unread ? 600 : 400,
            }}
          >
            {displayPreview(conversation.last_message_preview) || detail}
          </span>
        </span>
        <span style={{ display: "grid", gap: "7px", justifyItems: "end", alignSelf: "stretch" }}>
          <span style={{ color: "#667781", fontSize: "12px" }}>{formatTime(conversation.last_message_at)}</span>
          {unread ? (
            <span
              style={{
                minWidth: "20px",
                height: "20px",
                borderRadius: "999px",
                background: "#25d366",
                color: "#ffffff",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "11px",
                fontWeight: 900,
                padding: "0 6px",
              }}
            >
              {conversation.unread_count}
            </span>
          ) : null}
        </span>
      </button>
    )
  }

  function renderDropIndicator(listType: ManualListType, index: number) {
    const active = dropTarget?.listType === listType && dropTarget.index === index && Boolean(dragState)
    return (
      <div
        aria-hidden="true"
        style={{
          height: active ? "8px" : "0px",
          padding: active ? "2px 10px" : 0,
          boxSizing: "border-box",
          transition: "height 120ms ease",
        }}
      >
        {active ? (
          <div
            style={{
              height: "4px",
              borderRadius: "999px",
              background: "#00a884",
              boxShadow: "0 0 0 1px #ffffff",
            }}
          />
        ) : null}
      </div>
    )
  }

  function renderManualRow(conversation: WhatsAppConversation, index: number, listType: ManualListType) {
    const selected = conversation.id === selectedConversationId
    const match = contactMatches[phoneMatchKey(conversation.phone_e164)] || null
    const title = conversationTitle(conversation, match)

    return (
      <div
        key={conversation.id}
        draggable={canEdit}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move"
          event.dataTransfer.setData("text/plain", `${listType}:${conversation.id}`)
          setDragState({ kind: "manual", conversationId: conversation.id, listType })
          updateDropTarget({ listType, index })
        }}
        onDragEnd={() => {
          setDragState(null)
          updateDropTarget(null)
        }}
        onDragOver={(event) => {
          if (!dragState) return
          event.preventDefault()
          const bounds = event.currentTarget.getBoundingClientRect()
          const nextIndex = event.clientY > bounds.top + bounds.height / 2 ? index + 1 : index
          updateDropTarget({ listType, index: nextIndex })
        }}
        style={{
          width: "100%",
          minHeight: "42px",
          borderBottom: "1px solid #e9edef",
          background: selected ? "#f0f2f5" : "#ffffff",
          color: "#111b21",
          cursor: canEdit ? "grab" : "default",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 28px",
          gap: "6px",
          alignItems: "center",
          padding: "6px 8px 6px 12px",
        }}
      >
        <button
          type="button"
          onClick={() => void selectConversation(conversation.id)}
          style={{
            minWidth: 0,
            border: "none",
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
            display: "block",
            padding: 0,
            textAlign: "left",
            boxShadow: "none",
          }}
        >
          <span
            style={{
              display: "block",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "#111b21",
              fontSize: "14px",
              fontWeight: 600,
            }}
          >
            {title}
          </span>
        </button>
        <button
          type="button"
          onClick={() => void removeManualContact(conversation.id, listType)}
          disabled={!canEdit || savingList}
          aria-label={`Remove ${title}`}
          title={`Remove ${title}`}
          style={{
            width: "24px",
            height: "24px",
            border: "none",
            borderRadius: "999px",
            background: "transparent",
            color: "#667781",
            cursor: !canEdit || savingList ? "not-allowed" : "pointer",
            fontSize: "18px",
            fontWeight: 800,
            lineHeight: 1,
            boxShadow: "none",
          }}
        >
          -
        </button>
      </div>
    )
  }

  function renderContactRow(contact: ContactOption) {
    return (
      <div
        key={contact.id}
        draggable={canEdit}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "copyMove"
          event.dataTransfer.setData("text/plain", `contact:${contact.id}`)
          setDragState({ kind: "contact", contactId: contact.id })
          updateDropTarget({ listType: "supplier", index: supplierConversations.length })
        }}
        onDragEnd={() => {
          setDragState(null)
          updateDropTarget(null)
        }}
        style={{
          width: "100%",
          minHeight: "58px",
          borderBottom: "1px solid #e9edef",
          background: selectedContact?.id === contact.id ? "#f0f2f5" : "#ffffff",
          color: "#111b21",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr)",
          gap: "4px",
          alignItems: "center",
          padding: "8px 14px 8px 18px",
          cursor: canEdit ? "grab" : "default",
        }}
      >
        <button
          type="button"
          onClick={() => selectContact(contact)}
          style={{
            minWidth: 0,
            border: "none",
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
            display: "grid",
            gap: "4px",
            padding: 0,
            textAlign: "left",
            boxShadow: "none",
          }}
        >
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "#111b21",
              fontSize: "15px",
              fontWeight: 500,
            }}
          >
            {contact.name}
          </span>
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "#667781",
              fontSize: "12px",
            }}
          >
            {contact.company || contact.phone}
          </span>
        </button>
      </div>
    )
  }

  function renderManualPanel(listType: ManualListType, label: string, borderSide: "left" | "right") {
    const listItems = manualConversations(listType)

    return (
      <aside
        style={{
          minWidth: 0,
          minHeight: 0,
          height: "100%",
          overflow: "hidden",
          background: "#ffffff",
          borderLeft: borderSide === "left" ? "1px solid #d1d7db" : undefined,
          borderRight: borderSide === "right" ? "1px solid #d1d7db" : undefined,
          display: "grid",
          gridTemplateRows: "auto minmax(0, 1fr)",
        }}
        aria-label={label}
      >
        <div style={headerBarStyle}>
          <strong style={{ color: "#111b21", fontSize: "16px" }}>{label}</strong>
          {savingList ? <span style={{ color: "#667781", fontSize: "12px", fontWeight: 700 }}>Saving</span> : null}
        </div>

        <div
          data-admin-button-style="preserve"
          onDragOver={(event) => {
            if (!dragState) return
            event.preventDefault()
            if (!dropTarget || dropTarget.listType !== listType) {
              updateDropTarget({ listType, index: listItems.length })
            }
          }}
          onDrop={(event) => {
            event.preventDefault()
            const index = dropTarget?.listType === listType ? dropTarget.index : listItems.length
            void dropOnManualPanel(listType, index)
          }}
          style={{ minHeight: 0, overflowY: "auto", paddingTop: "4px" }}
        >
          {listItems.map((conversation, index) => (
            <div key={conversation.id}>
              {renderDropIndicator(listType, index)}
              {renderManualRow(conversation, index, listType)}
            </div>
          ))}
          {renderDropIndicator(listType, listItems.length)}
          {listItems.length === 0 ? (
            <div style={{ padding: "16px", color: "#667781", fontSize: "13px", lineHeight: 1.45 }}>
              Drag phonebook contacts here.
            </div>
          ) : null}
        </div>
      </aside>
    )
  }

  if (authLoading || !authenticated || !canView) {
    return <div style={pageStyle} />
  }

  return (
    <div style={pageStyle}>
      <main style={{ ...appShellStyle, ...mobileGridStyle }} aria-label="WhatsApp workspace">
        <aside
          style={{
            minWidth: 0,
            minHeight: 0,
            height: "100%",
            overflow: "hidden",
            background: "#ffffff",
            borderRight: "1px solid #d1d7db",
            display: "grid",
            gridTemplateRows: "auto auto minmax(0, 1fr)",
          }}
        >
          <div style={headerBarStyle} data-admin-button-style="preserve">
            <Link
              href={backHref}
              className="fc-admin-nav-button"
              style={iconButtonStyle}
              aria-label={backLabel}
              title={backLabel}
            >
              ‹
            </Link>
          </div>

          <div style={{ padding: "8px 12px", borderBottom: "1px solid #e9edef", background: "#ffffff" }}>
            <label style={{ position: "relative", display: "block" }}>
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: "14px",
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "#667781",
                  fontSize: "15px",
                }}
              >
                ⌕
              </span>
              <input
                type="search"
                value={leftSearchQuery}
                onChange={(event) => setLeftSearchQuery(event.target.value)}
                placeholder="Search chats or phonebook"
                style={searchBoxStyle}
              />
            </label>
          </div>

          <div data-admin-button-style="preserve" style={{ minHeight: 0, overflowY: "auto" }}>
            {storageMessage ? (
              <div style={{ padding: "12px 16px", color: "#b54708", fontSize: "13px", lineHeight: 1.45 }}>
                {storageMessage}
              </div>
            ) : null}
            <div
              style={{
                padding: "11px 16px 7px",
                color: "#008069",
                fontSize: "12px",
                fontWeight: 700,
                textTransform: "uppercase",
              }}
            >
              Recent chats
            </div>
            {conversationItems.map(renderConversationRow)}
            {loading ? (
              <div style={{ padding: "16px", color: "#667781", fontSize: "13px" }}>Loading...</div>
            ) : null}
            {!loading && conversationItems.length === 0 ? (
              <div style={{ padding: "16px", color: "#667781", fontSize: "13px" }}>
                No chats found.
              </div>
            ) : null}
            <div
              style={{
                padding: "11px 16px 7px",
                color: "#008069",
                fontSize: "12px",
                fontWeight: 700,
                textTransform: "uppercase",
              }}
            >
              Phonebook
            </div>
            {phonebookItems.map(renderContactRow)}
            {contactLoading ? (
              <div style={{ padding: "16px", color: "#667781", fontSize: "13px" }}>Loading contacts...</div>
            ) : null}
            {!contactLoading && phonebookItems.length === 0 ? (
              <div style={{ padding: "16px", color: "#667781", fontSize: "13px" }}>
                No matching phonebook contacts.
              </div>
            ) : null}
          </div>
        </aside>

        {renderManualPanel("supplier", "Supplier", "right")}

        <section
          style={{
            minWidth: 0,
            minHeight: 0,
            height: "100%",
            overflow: "hidden",
            display: "grid",
            gridTemplateRows: "auto minmax(0, 1fr) auto",
            background: "#efeae2",
          }}
          aria-label="Chat"
        >
          <div style={headerBarStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
              <div style={{ minWidth: 0, display: "grid", gap: "2px" }}>
                <strong
                  style={{
                    minWidth: 0,
                    color: "#111b21",
                    fontSize: "16px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {activeTitle}
                </strong>
                <span
                  style={{
                    minWidth: 0,
                    color: "#667781",
                    fontSize: "13px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {activeSubtitle}
                </span>
              </div>
            </div>
            <div data-admin-button-style="preserve" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <button
                type="button"
                style={iconButtonStyle}
                onClick={() => setLeftSearchQuery(activePhone || "")}
                aria-label="Find this contact"
                title="Find this contact"
              >
                ⌕
              </button>
              <span style={{ color: config.configured ? "#008069" : "#b54708", fontSize: "12px", fontWeight: 800 }}>
                {config.configured ? "API Ready" : "API Setup"}
              </span>
            </div>
          </div>

          <div
            style={{
              minHeight: 0,
              overflowY: "auto",
              padding: isMobile ? "18px 14px" : "28px 54px",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              overscrollBehavior: "contain",
              background:
                "linear-gradient(rgba(239,234,226,0.94), rgba(239,234,226,0.94)), repeating-linear-gradient(45deg, #d9d1c6 0 1px, transparent 1px 28px)",
            }}
          >
            {error || message ? (
              <div
                role="status"
                style={{
                  alignSelf: "center",
                  maxWidth: "min(680px, 100%)",
                  borderRadius: "8px",
                  background: error ? "#fce3e3" : "#d9fdd3",
                  color: error ? "#b42318" : "#008069",
                  padding: "9px 14px",
                  fontSize: "13px",
                  boxShadow: "0 1px 1px #0000001a",
                }}
              >
                {error || message}
              </div>
            ) : null}

            {!selectedConversation && !selectedContact ? (
              <div
                style={{
                  alignSelf: "center",
                  maxWidth: "420px",
                  marginTop: "12vh",
                  textAlign: "center",
                  color: "#667781",
                  fontSize: "14px",
                  lineHeight: 1.5,
                }}
              >
                Search the phonebook or select an existing chat.
              </div>
            ) : selectedMessages.length === 0 ? (
              <div
                style={{
                  alignSelf: "center",
                  borderRadius: "8px",
                  background: "#fff3c4",
                  color: "#54656f",
                  padding: "8px 12px",
                  fontSize: "12px",
                  boxShadow: "0 1px 1px #0000001a",
                }}
              >
                {formatDay(new Date().toISOString()) || "Today"}
              </div>
            ) : (
              selectedMessages.map((chatMessage) => {
                const outbound = chatMessage.direction === "outbound"
                const status = chatMessage.direction === "status"
                return (
                  <div
                    key={chatMessage.id}
                    style={{
                      alignSelf: status ? "center" : outbound ? "flex-end" : "flex-start",
                      maxWidth: status ? "min(420px, 100%)" : "min(680px, 72%)",
                    }}
                  >
                    <div
                      style={{
                        borderRadius: outbound ? "7.5px 0 7.5px 7.5px" : "0 7.5px 7.5px 7.5px",
                        background: status ? "#fff3c4" : outbound ? "#d9fdd3" : "#ffffff",
                        color: "#111b21",
                        padding: status ? "7px 12px" : "6px 8px 6px 9px",
                        boxShadow: "0 1px 1px #0000001a",
                        display: "grid",
                        gap: "3px",
                      }}
                    >
                      <div style={{ fontSize: "14px", lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
                        {displayMessageText(chatMessage)}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "flex-end",
                          gap: "5px",
                          color: "#667781",
                          fontSize: "11px",
                          lineHeight: 1,
                        }}
                      >
                        <span>{formatTime(chatMessage.sent_at)}</span>
                        {outbound ? (
                          chatMessage.status === "sending" ? (
                            <span style={{ color: "#667781" }}>…</span>
                          ) : chatMessage.status === "failed" ? (
                            <span style={{ color: "#d92d20", fontWeight: 800 }}>!</span>
                          ) : (
                            <span style={{ color: chatMessage.status === "read" ? "#53bdeb" : "#667781" }}>✓✓</span>
                          )
                        ) : null}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
            <div ref={messagesEndRef} aria-hidden="true" />
          </div>

          <div
            style={{
              minHeight: "62px",
              background: "#f0f2f5",
              borderTop: "1px solid #d1d7db",
              display: "grid",
              gridTemplateRows: selectedTemplate ? "auto auto" : "auto",
              gridTemplateColumns: "minmax(0, 1fr)",
              gap: "8px",
              alignItems: "stretch",
              padding: "10px 14px",
              position: "sticky",
              bottom: 0,
              zIndex: 5,
            }}
            data-admin-button-style="preserve"
          >
            {selectedTemplate ? (
              <div
                style={{
                  minWidth: 0,
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  gap: "10px",
                  alignItems: "start",
                }}
              >
                <pre
                  aria-label="Template preview"
                  style={{
                    minWidth: 0,
                    maxHeight: "150px",
                    overflowY: "auto",
                    margin: 0,
                    borderRadius: "8px",
                    background: "#ffffff",
                    color: "#111b21",
                    fontFamily: "inherit",
                    fontSize: "13px",
                    lineHeight: 1.42,
                    padding: "10px 12px",
                    whiteSpace: "pre-wrap",
                    boxShadow: "inset 0 0 0 1px #e9edef",
                  }}
                >
                  {selectedTemplatePreview}
                </pre>
                <span
                  style={{
                    minWidth: "52px",
                    borderRadius: "8px",
                    background: "#ffffff",
                    color: selectedTemplateOverLimit ? "#b42318" : "#008069",
                    fontSize: "12px",
                    fontWeight: 800,
                    lineHeight: 1,
                    padding: "10px 8px",
                    textAlign: "center",
                    boxShadow: "inset 0 0 0 1px #e9edef",
                  }}
                >
                  {selectedTemplateInputCount}/{selectedTemplateVariables.length}
                </span>
              </div>
            ) : null}

            <div
              style={{
                minWidth: 0,
                display: "grid",
                gridTemplateColumns: activePhone
                  ? "210px minmax(0, 1fr) auto"
                  : "160px 210px minmax(0, 1fr) auto",
                gap: "10px",
                alignItems: "end",
              }}
            >
              <input
                type="text"
                value={composeTo}
                onChange={(event) => setComposeTo(event.target.value)}
                placeholder="+852..."
                style={{
                  width: "160px",
                  minHeight: "42px",
                  border: "none",
                  borderRadius: "8px",
                  background: "#ffffff",
                  color: "#111b21",
                  fontSize: "13px",
                  outline: "none",
                  padding: "0 12px",
                  display: selectedConversation || selectedContact ? "none" : "block",
                }}
              />
              <select
                value={selectedTemplateKey}
                onChange={(event) => {
                  setSelectedTemplateKey(event.target.value)
                  focusComposer()
                }}
                disabled={templateLoading || variableTemplates.length === 0 || sending}
                title="WhatsApp template"
                aria-label="WhatsApp template"
                style={{
                  width: "210px",
                  minHeight: "42px",
                  border: "none",
                  borderRadius: "8px",
                  background: "#ffffff",
                  color: "#111b21",
                  fontSize: "13px",
                  outline: "none",
                  padding: "0 10px",
                  boxSizing: "border-box",
                  opacity: templateLoading || variableTemplates.length === 0 ? 0.7 : 1,
                }}
              >
                <option value="">
                  {templateLoading
                    ? "Loading templates"
                    : variableTemplates.length === 0
                      ? approvedTemplates.length === 0
                        ? "Text message"
                        : "No editable templates"
                      : "Text message"}
                </option>
                {variableTemplates.map((template) => (
                  <option key={templateKey(template)} value={templateKey(template)}>
                    {templateOptionLabel(template)}
                  </option>
                ))}
              </select>
              <textarea
                ref={composeRef}
                value={composeBody}
                onChange={(event) => setComposeBody(event.target.value)}
                onInput={adjustComposerHeight}
                placeholder={
                  activePhone
                    ? selectedTemplate
                      ? selectedTemplateVariables.length > 1
                        ? "Paste enquiries"
                        : templateNeedsText
                          ? `Type ${selectedTemplateVariables.join(", ")}`
                          : "Type a message"
                      : "Type a message"
                    : "Select or assign a contact"
                }
                rows={1}
                disabled={!activePhone || sending}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    void sendMessage()
                    return
                  }
                  if (event.key === "Enter" && !event.shiftKey && selectedTemplateVariables.length <= 1) {
                    event.preventDefault()
                    void sendMessage()
                  }
                }}
                style={{
                  width: "100%",
                  minHeight: "42px",
                  maxHeight: selectedTemplateVariables.length > 1 ? "150px" : "120px",
                  border: "none",
                  borderRadius: "8px",
                  background: "#ffffff",
                  color: "#111b21",
                  fontSize: "15px",
                  outline: "none",
                  padding: "11px 14px",
                  resize: "none",
                  boxSizing: "border-box",
                  lineHeight: 1.35,
                  overflowY: "hidden",
                  opacity: activePhone ? 1 : 0.7,
                }}
              />
              <button
                type="button"
                onClick={() => void sendMessage()}
                disabled={!canSendMessage}
                aria-label={selectedTemplate ? "Send template" : "Send message"}
                title={selectedTemplate ? "Send template" : "Send message"}
                style={{
                  ...iconButtonStyle,
                  width: "44px",
                  height: "44px",
                  background:
                    !canSendMessage ? "#c7d0d4" : "#00a884",
                  color: "#ffffff",
                  fontSize: "17px",
                }}
              >
                {sending ? "…" : "➤"}
              </button>
            </div>
          </div>
        </section>

        {renderManualPanel("buyer", "Buyer", "left")}
      </main>
    </div>
  )
}

export default function WhatsAppAdminWorkspace() {
  const { loading, authenticated, permissions, role } = useSimpleAdminAuth()

  return (
    <WhatsAppWorkspace
      auth={{
        loading,
        authenticated,
        canView: isAdminRole(role) || canAccessAdminPage(permissions, "whatsapp", "view"),
        canEdit: isAdminRole(role) || canAccessAdminPage(permissions, "whatsapp", "edit"),
      }}
    />
  )
}
