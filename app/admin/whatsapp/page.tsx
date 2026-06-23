"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
  hasVerifyToken: boolean
  hasAppSecret: boolean
  graphApiVersion: string
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

type DragState =
  | { kind: "contact"; contactId: string }
  | { kind: "conversation"; conversationId: string }
  | { kind: "assigned"; conversationId: string }

const EMPTY_CONFIG: WhatsAppConfig = {
  configured: false,
  hasAccessToken: false,
  hasPhoneNumberId: false,
  hasBusinessAccountId: false,
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

const pageStyle: CSSProperties = {
  minHeight: "100vh",
  background: "#111b21",
  color: "#111b21",
  fontFamily: "var(--fc-admin-font)",
  padding: 0,
}

const appShellStyle: CSSProperties = {
  height: "100vh",
  minHeight: "720px",
  display: "grid",
  gridTemplateColumns: "390px 260px minmax(460px, 1fr)",
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
  if (trimmed.startsWith("+")) return `+${phoneDigits(trimmed)}`
  if (trimmed.startsWith("00")) return `+${phoneDigits(trimmed.slice(2))}`

  const digits = phoneDigits(trimmed)
  if (!digits) return ""
  const code = countryCode(area)
  if (digits.length <= 8 && code) return `+${code}${digits}`
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
    phoneDigits: phoneDigits(phone),
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

function metadataNumber(conversation: WhatsAppConversation, key: string) {
  const value = conversation.metadata?.[key]
  const numberValue = typeof value === "number" ? value : Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function assignedSortValue(conversation: WhatsAppConversation) {
  const savedOrder = metadataNumber(conversation, "whatsapp_assigned_order")
  if (savedOrder !== null) return savedOrder
  const assignedAt = conversation.metadata?.whatsapp_assigned_at
  const assignedTime = typeof assignedAt === "string" ? Date.parse(assignedAt) : Number.NaN
  if (Number.isFinite(assignedTime)) return assignedTime
  const updatedTime = Date.parse(conversation.updated_at || conversation.created_at)
  return Number.isFinite(updatedTime) ? updatedTime : Number.MAX_SAFE_INTEGER
}

function withAssignedOrder(conversations: WhatsAppConversation[]) {
  return conversations.map((conversation, index) => ({
    ...conversation,
    tags: Array.from(new Set([...(conversation.tags || []), "assigned"])),
    metadata: {
      ...(conversation.metadata || {}),
      whatsapp_assigned_order: (index + 1) * 1000,
    },
  }))
}

function withoutAssignment(conversation: WhatsAppConversation) {
  const metadata = { ...(conversation.metadata || {}) }
  delete metadata.whatsapp_assigned_at
  delete metadata.whatsapp_assigned_order
  return {
    ...conversation,
    tags: (conversation.tags || []).filter((tag) => tag !== "assigned"),
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

export default function WhatsAppAdminPage() {
  const isMobile = useIsMobile(980)
  const { loading: authLoading, authenticated, permissions, role } = useSimpleAdminAuth()
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
  const [contacts, setContacts] = useState<ContactOption[]>([])
  const [contactMatches, setContactMatches] = useState<Record<string, ContactOption>>({})
  const [composeTo, setComposeTo] = useState("")
  const [composeBody, setComposeBody] = useState("")
  const [loading, setLoading] = useState(true)
  const [contactLoading, setContactLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [dragState, setDragState] = useState<DragState | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [savingList, setSavingList] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const composeRef = useRef<HTMLTextAreaElement | null>(null)

  const canView = isAdminRole(role) || canAccessAdminPage(permissions, "whatsapp", "view")
  const canEdit = isAdminRole(role) || canAccessAdminPage(permissions, "whatsapp", "edit")
  const config = inbox.config || EMPTY_CONFIG
  const storageMessage = storageReadyMessage(inbox)

  const mergeContactMatches = useCallback((items: ContactOption[]) => {
    setContactMatches((current) => {
      const next = { ...current }
      for (const item of items) {
        if (item.phoneDigits) next[item.phoneDigits] = item
      }
      return next
    })
  }, [])

  const loadContacts = useCallback(async (query: string) => {
    setContactLoading(true)
    try {
      const url = new URL("/api/whatsapp/contacts", window.location.origin)
      if (query.trim()) url.searchParams.set("query", query.trim())
      const response = await fetch(url, { cache: "no-store" })
      const data = (await response.json().catch(() => ({}))) as {
        contacts?: PhonebookContact[]
        message?: string
      }
      if (!response.ok) throw new Error(data.message || "Unable to load phonebook contacts.")
      const nextContacts = (data.contacts || [])
        .map(buildContactOption)
        .filter((item): item is ContactOption => Boolean(item))
      setContacts(nextContacts)
      mergeContactMatches(nextContacts)
    } catch (contactError) {
      setError(contactError instanceof Error ? contactError.message : "Unable to load phonebook contacts.")
    } finally {
      setContactLoading(false)
    }
  }, [mergeContactMatches])

  const loadContactByPhone = useCallback(async (phone: string) => {
    const digits = phoneDigits(phone)
    if (!digits || contactMatches[digits]) return

    try {
      const url = new URL("/api/whatsapp/contacts", window.location.origin)
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
      // Contact enrichment should never block the chat.
    }
  }, [contactMatches, mergeContactMatches])

  const loadInbox = useCallback(async (conversationId?: string | null) => {
    setError("")
    setMessage("")
    setLoading(true)

    try {
      const url = new URL("/api/whatsapp/inbox", window.location.origin)
      if (conversationId) url.searchParams.set("conversationId", conversationId)
      const response = await fetch(url, { cache: "no-store" })
      const data = (await response.json().catch(() => ({}))) as WhatsAppInboxResponse
      if (!response.ok) throw new Error(data.message || "Unable to load WhatsApp inbox.")

      setInbox(data)
      setSelectedConversationId(data.selectedConversationId)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load WhatsApp inbox.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (authLoading || !authenticated || !canView) return
    void loadInbox(selectedConversationId)
  }, [authLoading, authenticated, canView, loadInbox])

  useEffect(() => {
    if (authLoading || !authenticated || !canView) return
    const timer = window.setTimeout(() => {
      void loadContacts(leftSearchQuery)
    }, leftSearchQuery ? 220 : 0)

    return () => window.clearTimeout(timer)
  }, [authLoading, authenticated, canView, leftSearchQuery, loadContacts])

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
    ? contactMatches[phoneDigits(selectedConversation.phone_e164)] || null
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
    const normalizedQuery = leftSearchQuery.trim().toLowerCase()
    return inbox.conversations.filter((conversation) => {
      if (!conversation.last_message_at && !conversation.last_message_preview) return false
      if (!normalizedQuery) return true
      const match = contactMatches[phoneDigits(conversation.phone_e164)]
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
  }, [contactMatches, inbox.conversations, leftSearchQuery])

  const assignedConversations = useMemo(
    () =>
      inbox.conversations.filter((conversation) =>
        (conversation.tags || []).includes("assigned"),
      ).sort((first, second) => assignedSortValue(first) - assignedSortValue(second)),
    [inbox.conversations],
  )

  const phonebookItems = useMemo(() => {
    const assignedPhones = new Set(assignedConversations.map((item) => phoneDigits(item.phone_e164)))
    return contacts.filter((contact) => !assignedPhones.has(contact.phoneDigits))
  }, [assignedConversations, contacts])

  const activeTitle = conversationTitle(selectedConversation, activeContact)
  const activeSubtitle =
    activeContact?.detail ||
    activeContact?.phone ||
    selectedConversation?.phone_e164 ||
    "Search phonebook contacts to start a chat"
  const activePhone = selectedConversation?.phone_e164 || selectedContact?.phone || composeTo
  const mobileGridStyle: CSSProperties = isMobile
    ? {
        gridTemplateColumns: "1fr",
        height: "auto",
        minHeight: "100vh",
      }
    : {}

  const focusComposer = useCallback(() => {
    window.requestAnimationFrame(() => {
      composeRef.current?.focus()
    })
  }, [])

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
      await fetch("/api/whatsapp/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId }),
      })
    } catch {
      // Reading a chat should not block the operator if the background write fails.
    }
  }, [])

  async function selectConversation(conversationId: string) {
    const conversation = inbox.conversations.find((item) => item.id === conversationId)
    setSelectedConversationId(conversationId)
    setSelectedContact(null)
    setError("")
    setMessage("")
    if (conversation?.phone_e164) setComposeTo(conversation.phone_e164)
    await markConversationRead(conversationId)
    await loadInbox(conversationId)
    focusComposer()
  }

  function selectContact(contact: ContactOption) {
    const existing = inbox.conversations.find(
      (conversation) => phoneDigits(conversation.phone_e164) === contact.phoneDigits,
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
        conversations: [
          ...current.conversations.map((conversation) => byId.get(conversation.id) || conversation),
          ...conversations.filter((conversation) => !existingIds.has(conversation.id)),
        ],
      }
    })
  }

  async function saveAssignedOrder(conversations: WhatsAppConversation[]) {
    const ordered = withAssignedOrder(conversations)
    applyConversationUpdates(ordered)
    const response = await fetch("/api/whatsapp/assigned-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: ordered.map((conversation, index) => ({
          conversationId: conversation.id,
          order: (index + 1) * 1000,
        })),
      }),
    })
    const data = (await response.json().catch(() => ({}))) as { message?: string }
    if (!response.ok) throw new Error(data.message || "Unable to save contact order.")
  }

  async function assignContact(contact: ContactOption, index = assignedConversations.length) {
    if (savingList || !canEdit) return
    setSavingList(true)
    setError("")
    setMessage("")

    try {
      const assignedOrder = (index + 1) * 1000
      const response = await fetch("/api/whatsapp/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: contact.phone,
          displayName: contact.name,
          company: contact.company,
          contactId: contact.id,
          assignedOrder,
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
      const nextAssigned = insertConversationAt(assignedConversations, assignedConversation, index)
      await saveAssignedOrder(nextAssigned)
      setSelectedContact(null)
      setSelectedConversationId(assignedConversation.id)
      setComposeTo(assignedConversation.phone_e164)
      await loadInbox(assignedConversation.id)
      focusComposer()
    } catch (assignError) {
      setError(assignError instanceof Error ? assignError.message : "Unable to assign WhatsApp contact.")
    } finally {
      setSavingList(false)
    }
  }

  async function reorderAssignedContact(conversationId: string, index: number) {
    if (savingList || !canEdit) return
    const conversation = assignedConversations.find((item) => item.id === conversationId)
    if (!conversation) return
    const currentIndex = assignedConversations.findIndex((item) => item.id === conversationId)
    const adjustedIndex = currentIndex >= 0 && currentIndex < index ? index - 1 : index

    setSavingList(true)
    setError("")
    setMessage("")
    try {
      const nextAssigned = insertConversationAt(assignedConversations, conversation, adjustedIndex)
      await saveAssignedOrder(nextAssigned)
    } catch (orderError) {
      setError(orderError instanceof Error ? orderError.message : "Unable to save contact order.")
    } finally {
      setSavingList(false)
    }
  }

  async function removeAssignedContact(conversationId: string) {
    if (savingList || !canEdit) return
    const conversation = assignedConversations.find((item) => item.id === conversationId)
    if (!conversation) return

    setSavingList(true)
    setError("")
    setMessage("")
    try {
      applyConversationUpdates([withoutAssignment(conversation)])
      const response = await fetch("/api/whatsapp/unassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId }),
      })
      const data = (await response.json().catch(() => ({}))) as {
        conversation?: WhatsAppConversation
        message?: string
      }
      if (!response.ok || !data.conversation) {
        throw new Error(data.message || "Unable to remove WhatsApp contact.")
      }
      applyConversationUpdates([data.conversation])
      const remaining = assignedConversations.filter((item) => item.id !== conversationId)
      await saveAssignedOrder(remaining)
      if (selectedConversationId === conversationId) {
        setSelectedConversationId(null)
        setSelectedContact(null)
      }
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Unable to remove WhatsApp contact.")
      applyConversationUpdates([conversation])
    } finally {
      setSavingList(false)
    }
  }

  async function dropOnAssignedPanel(index: number) {
    if (!dragState) return
    const boundedIndex = Math.max(0, Math.min(index, assignedConversations.length))
    if (dragState.kind === "contact") {
      const contact = contacts.find((item) => item.id === dragState.contactId)
      if (contact) await assignContact(contact, boundedIndex)
    } else if (dragState.kind === "conversation") {
      const conversation = inbox.conversations.find((item) => item.id === dragState.conversationId)
      if (conversation) {
        if ((conversation.tags || []).includes("assigned")) {
          await reorderAssignedContact(conversation.id, boundedIndex)
        } else {
          setSavingList(true)
          setError("")
          setMessage("")
          try {
            const nextAssigned = insertConversationAt(assignedConversations, conversation, boundedIndex)
            await saveAssignedOrder(nextAssigned)
          } catch (orderError) {
            setError(orderError instanceof Error ? orderError.message : "Unable to save contact order.")
          } finally {
            setSavingList(false)
          }
        }
      }
    } else {
      await reorderAssignedContact(dragState.conversationId, boundedIndex)
    }
    setDragState(null)
    setDropIndex(null)
  }

  async function sendMessage() {
    const to = (selectedConversation?.phone_e164 || selectedContact?.phone || composeTo).trim()
    const body = composeBody.trim()
    if (!to || !body || sending) return

    setSending(true)
    setError("")
    setMessage("")

    try {
      const response = await fetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, message: body }),
      })
      const data = (await response.json().catch(() => ({}))) as {
        message?: string
        storageWarning?: string
      }
      if (!response.ok) throw new Error(data.message || "Unable to send WhatsApp message.")

      setComposeBody("")
      await loadInbox(selectedConversationId)
      setSelectedContact(null)
      setMessage(data.storageWarning || "Message sent.")
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Unable to send WhatsApp message.")
    } finally {
      setSending(false)
    }
  }

  function renderConversationRow(conversation: WhatsAppConversation) {
    const selected = conversation.id === selectedConversationId
    const match = contactMatches[phoneDigits(conversation.phone_e164)] || null
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
          setDropIndex(assignedConversations.length)
        }}
        onDragEnd={() => {
          setDragState(null)
          setDropIndex(null)
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

  function renderDropIndicator(index: number) {
    const active = dropIndex === index && Boolean(dragState)
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

  function renderAssignedRow(conversation: WhatsAppConversation, index: number) {
    const selected = conversation.id === selectedConversationId
    const match = contactMatches[phoneDigits(conversation.phone_e164)] || null
    const title = conversationTitle(conversation, match)

    return (
      <div
        key={conversation.id}
        draggable={canEdit}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move"
          event.dataTransfer.setData("text/plain", `assigned:${conversation.id}`)
          setDragState({ kind: "assigned", conversationId: conversation.id })
          setDropIndex(index)
        }}
        onDragEnd={() => {
          setDragState(null)
          setDropIndex(null)
        }}
        onDragOver={(event) => {
          if (!dragState) return
          event.preventDefault()
          const bounds = event.currentTarget.getBoundingClientRect()
          const nextIndex = event.clientY > bounds.top + bounds.height / 2 ? index + 1 : index
          setDropIndex(nextIndex)
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
          onClick={() => void removeAssignedContact(conversation.id)}
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
          setDropIndex(assignedConversations.length)
        }}
        onDragEnd={() => {
          setDragState(null)
          setDropIndex(null)
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

  if (authLoading || !authenticated || !canView) {
    return <div style={pageStyle} />
  }

  return (
    <div style={pageStyle}>
      <main style={{ ...appShellStyle, ...mobileGridStyle }} aria-label="WhatsApp workspace">
        <aside
          style={{
            minWidth: 0,
            background: "#ffffff",
            borderRight: "1px solid #d1d7db",
            display: "grid",
            gridTemplateRows: "auto auto minmax(0, 1fr)",
          }}
        >
          <div style={headerBarStyle} data-admin-button-style="preserve">
            <Link
              href="/admin"
              className="fc-admin-nav-button"
              style={iconButtonStyle}
              aria-label="Return to admin"
              title="Return to admin"
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

        <aside
          style={{
            minWidth: 0,
            background: "#ffffff",
            borderRight: "1px solid #d1d7db",
            display: "grid",
            gridTemplateRows: "auto minmax(0, 1fr)",
          }}
          aria-label="Manual list"
        >
          <div style={headerBarStyle}>
            <strong style={{ color: "#111b21", fontSize: "16px" }}>Manual list</strong>
            {savingList ? <span style={{ color: "#667781", fontSize: "12px", fontWeight: 700 }}>Saving</span> : null}
          </div>

          <div
            data-admin-button-style="preserve"
            onDragOver={(event) => {
              if (!dragState) return
              event.preventDefault()
              if (dropIndex === null) setDropIndex(assignedConversations.length)
            }}
            onDrop={(event) => {
              event.preventDefault()
              void dropOnAssignedPanel(dropIndex ?? assignedConversations.length)
            }}
            style={{ minHeight: 0, overflowY: "auto", paddingTop: "4px" }}
          >
            {assignedConversations.map((conversation, index) => (
              <div key={conversation.id}>
                {renderDropIndicator(index)}
                {renderAssignedRow(conversation, index)}
              </div>
            ))}
            {renderDropIndicator(assignedConversations.length)}
            {assignedConversations.length === 0 ? (
              <div style={{ padding: "16px", color: "#667781", fontSize: "13px", lineHeight: 1.45 }}>
                Drag phonebook contacts here.
              </div>
            ) : null}
          </div>
        </aside>

        <section
          style={{
            minWidth: 0,
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
                          <span style={{ color: chatMessage.status === "read" ? "#53bdeb" : "#667781" }}>✓✓</span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>

          <div
            style={{
              minHeight: "62px",
              background: "#f0f2f5",
              borderTop: "1px solid #d1d7db",
              display: "grid",
              gridTemplateColumns: activePhone ? "minmax(0, 1fr) auto" : "160px minmax(0, 1fr) auto",
              gap: "10px",
              alignItems: "end",
              padding: "10px 14px",
            }}
            data-admin-button-style="preserve"
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
            <textarea
              ref={composeRef}
              value={composeBody}
              onChange={(event) => setComposeBody(event.target.value)}
              placeholder={activePhone ? "Type a message" : "Select or assign a contact"}
              rows={1}
              disabled={!activePhone || sending}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  void sendMessage()
                }
              }}
              style={{
                width: "100%",
                minHeight: "42px",
                maxHeight: "120px",
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
                opacity: activePhone ? 1 : 0.7,
              }}
            />
            <button
              type="button"
              onClick={() => void sendMessage()}
              disabled={!canEdit || !config.configured || !composeBody.trim() || !activePhone || sending}
              aria-label="Send message"
              title="Send message"
              style={{
                ...iconButtonStyle,
                width: "44px",
                height: "44px",
                background:
                  !canEdit || !config.configured || !composeBody.trim() || !activePhone || sending
                    ? "#c7d0d4"
                    : "#00a884",
                color: "#ffffff",
                fontSize: "17px",
              }}
            >
              {sending ? "…" : "➤"}
            </button>
          </div>
        </section>
      </main>
    </div>
  )
}
