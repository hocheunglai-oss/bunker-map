"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"
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

type WhatsAppLayout = {
  conversationSide: "left" | "right"
  conversationWidth: number
  showDetails: boolean
  showSetup: boolean
  compactMessages: boolean
  showMetadata: boolean
}

const LAYOUT_STORAGE_KEY = "whatsapp-admin-layout-v1"

const DEFAULT_LAYOUT: WhatsAppLayout = {
  conversationSide: "left",
  conversationWidth: 320,
  showDetails: true,
  showSetup: true,
  compactMessages: false,
  showMetadata: true,
}

const EMPTY_CONFIG: WhatsAppConfig = {
  configured: false,
  hasAccessToken: false,
  hasPhoneNumberId: false,
  hasBusinessAccountId: false,
  hasVerifyToken: false,
  hasAppSecret: false,
  graphApiVersion: "v23.0",
}

const pageStyle: CSSProperties = {
  minHeight: "100vh",
  background: "var(--fc-admin-page-bg)",
  color: "var(--fc-admin-panel-text)",
  fontFamily: "var(--fc-admin-font)",
  padding: "18px",
}

const buttonStyle: CSSProperties = {
  minHeight: "36px",
  border: "1px solid var(--fc-admin-button-border)",
  borderRadius: "999px",
  background: "var(--fc-admin-button-bg)",
  color: "var(--fc-admin-button-text)",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: 800,
  padding: "8px 13px",
  boxShadow: "none",
  textDecoration: "none",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "6px",
}

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: "var(--fc-admin-primary-button-bg)",
  background: "var(--fc-admin-primary-button-bg)",
  color: "var(--fc-admin-primary-button-text)",
}

const disabledButtonStyle: CSSProperties = {
  ...buttonStyle,
  opacity: 0.55,
  cursor: "not-allowed",
}

const panelStyle: CSSProperties = {
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "18px",
  background: "var(--fc-admin-panel-bg)",
  boxShadow: "0 12px 28px #00000010",
  overflow: "hidden",
}

const softPanelStyle: CSSProperties = {
  ...panelStyle,
  background: "var(--fc-admin-panel-soft-bg)",
}

const sectionHeaderStyle: CSSProperties = {
  minHeight: "42px",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "10px",
  padding: "10px 12px",
  borderBottom: "1px solid var(--fc-admin-border-soft)",
  background: "var(--fc-admin-panel-soft-bg)",
}

const sectionTitleStyle: CSSProperties = {
  minWidth: 0,
  color: "var(--fc-admin-heading)",
  fontSize: "12px",
  fontWeight: 900,
  textTransform: "uppercase",
}

const inputStyle: CSSProperties = {
  width: "100%",
  minHeight: "38px",
  border: "1px solid var(--fc-input-border)",
  borderRadius: "12px",
  background: "var(--fc-tool-input-bg)",
  color: "var(--fc-tool-input-text)",
  fontSize: "13px",
  outline: "none",
  padding: "9px 11px",
  boxSizing: "border-box",
}

const labelStyle: CSSProperties = {
  color: "var(--fc-admin-link)",
  fontSize: "10px",
  fontWeight: 900,
  letterSpacing: 0,
  textTransform: "uppercase",
}

const smallMutedStyle: CSSProperties = {
  color: "var(--fc-admin-muted)",
  fontSize: "12px",
  lineHeight: 1.45,
}

function clampConversationWidth(value: number) {
  return Math.max(260, Math.min(440, Math.round(value)))
}

function readLayout(): WhatsAppLayout {
  if (typeof window === "undefined") return DEFAULT_LAYOUT

  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY)
    if (!raw) return DEFAULT_LAYOUT
    const parsed = JSON.parse(raw) as Partial<WhatsAppLayout>

    return {
      ...DEFAULT_LAYOUT,
      ...parsed,
      conversationSide: parsed.conversationSide === "right" ? "right" : "left",
      conversationWidth: clampConversationWidth(
        typeof parsed.conversationWidth === "number"
          ? parsed.conversationWidth
          : DEFAULT_LAYOUT.conversationWidth,
      ),
      showDetails: parsed.showDetails !== false,
      showSetup: parsed.showSetup !== false,
      compactMessages: parsed.compactMessages === true,
      showMetadata: parsed.showMetadata !== false,
    }
  } catch {
    return DEFAULT_LAYOUT
  }
}

function formatDate(value: string | null | undefined) {
  if (!value) return "No date"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "No date"
  return new Intl.DateTimeFormat("en-HK", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)
}

function displayConversationName(conversation: WhatsAppConversation | null | undefined) {
  if (!conversation) return "No conversation selected"
  return conversation.display_name || conversation.phone_e164
}

function statusPillStyle(active: boolean): CSSProperties {
  return {
    border: `1px solid ${active ? "var(--fc-admin-success-border)" : "var(--fc-admin-warning-border)"}`,
    borderRadius: "999px",
    background: active ? "var(--fc-admin-success-bg)" : "var(--fc-admin-warning-bg)",
    color: active ? "var(--fc-admin-success-text)" : "var(--fc-admin-warning-text)",
    padding: "5px 9px",
    fontSize: "11px",
    fontWeight: 900,
    whiteSpace: "nowrap",
  }
}

function metadataRows(value: Record<string, unknown> | null | undefined) {
  if (!value) return []
  return Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== "")
}

export default function WhatsAppAdminPage() {
  const isMobile = useIsMobile(900)
  const { loading: authLoading, authenticated, permissions, role } = useSimpleAdminAuth()
  const [layout, setLayout] = useState<WhatsAppLayout>(DEFAULT_LAYOUT)
  const [inbox, setInbox] = useState<WhatsAppInboxResponse>({
    conversations: [],
    messages: [],
    selectedConversationId: null,
    storageReady: false,
    storageMessage: null,
    config: EMPTY_CONFIG,
  })
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [composeTo, setComposeTo] = useState("")
  const [composeBody, setComposeBody] = useState("")
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")

  const canView = isAdminRole(role) || canAccessAdminPage(permissions, "whatsapp", "view")
  const canEdit = isAdminRole(role) || canAccessAdminPage(permissions, "whatsapp", "edit")

  useEffect(() => {
    setLayout(readLayout())
  }, [])

  const updateLayout = useCallback((patch: Partial<WhatsAppLayout>) => {
    setLayout((current) => {
      const next = {
        ...current,
        ...patch,
        conversationWidth: clampConversationWidth(
          patch.conversationWidth ?? current.conversationWidth,
        ),
      }
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }, [])

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

  const selectedConversation = useMemo(
    () =>
      inbox.conversations.find((conversation) => conversation.id === selectedConversationId) ||
      null,
    [inbox.conversations, selectedConversationId],
  )

  useEffect(() => {
    if (selectedConversation?.phone_e164) setComposeTo(selectedConversation.phone_e164)
  }, [selectedConversation?.phone_e164])

  const selectedMessages = useMemo(
    () =>
      inbox.messages.filter(
        (chatMessage) => chatMessage.conversation_id === selectedConversationId,
      ),
    [inbox.messages, selectedConversationId],
  )

  const webhookUrl =
    typeof window === "undefined" ? "/api/whatsapp/webhook" : `${window.location.origin}/api/whatsapp/webhook`
  const storageReady = inbox.storageReady
  const config = inbox.config || EMPTY_CONFIG
  const metadata = metadataRows(selectedConversation?.metadata)

  const gridColumns = useMemo(() => {
    if (isMobile) return "1fr"
    const listColumn = `${layout.conversationWidth}px`
    const chatColumn = "minmax(420px, 1fr)"
    const detailsColumn = layout.showDetails ? "300px" : ""

    return layout.conversationSide === "left"
      ? [listColumn, chatColumn, detailsColumn].filter(Boolean).join(" ")
      : [chatColumn, listColumn, detailsColumn].filter(Boolean).join(" ")
  }, [isMobile, layout.conversationSide, layout.conversationWidth, layout.showDetails])

  async function selectConversation(conversationId: string) {
    setSelectedConversationId(conversationId)
    await loadInbox(conversationId)
  }

  async function sendMessage() {
    const to = (selectedConversation?.phone_e164 || composeTo).trim()
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
      const data = (await response.json().catch(() => ({}))) as { message?: string }
      if (!response.ok) throw new Error(data.message || "Unable to send WhatsApp message.")

      setComposeBody("")
      setMessage("Message sent.")
      await loadInbox(selectedConversationId)
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Unable to send WhatsApp message.")
    } finally {
      setSending(false)
    }
  }

  function renderConversationList() {
    return (
      <section style={panelStyle} aria-label="WhatsApp conversations">
        <div style={sectionHeaderStyle}>
          <div>
            <div style={sectionTitleStyle}>Conversations</div>
            <div style={smallMutedStyle}>{inbox.conversations.length} loaded</div>
          </div>
          <button
            type="button"
            onClick={() => void loadInbox(selectedConversationId)}
            disabled={loading}
            style={loading ? disabledButtonStyle : buttonStyle}
          >
            {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>

        <div
          data-admin-button-style="preserve"
          style={{
            maxHeight: isMobile ? "none" : "calc(100vh - 280px)",
            overflowY: "auto",
          }}
        >
          {!storageReady ? (
            <div style={{ padding: "18px", ...smallMutedStyle }}>
              {inbox.storageMessage || "WhatsApp storage is not ready."}
            </div>
          ) : inbox.conversations.length === 0 ? (
            <div style={{ padding: "18px", ...smallMutedStyle }}>No conversations yet.</div>
          ) : (
            inbox.conversations.map((conversation) => {
              const selected = conversation.id === selectedConversationId
              return (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => void selectConversation(conversation.id)}
                  style={{
                    width: "100%",
                    border: "none",
                    borderBottom: "1px solid var(--fc-admin-border-soft)",
                    background: selected ? "var(--fc-admin-selected-bg)" : "var(--fc-admin-panel-bg)",
                    color: "var(--fc-admin-panel-text)",
                    textAlign: "left",
                    padding: "12px 14px",
                    cursor: "pointer",
                    display: "grid",
                    gap: "5px",
                    boxShadow: "none",
                  }}
                >
                  <span
                    style={{
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: "var(--fc-admin-heading)",
                      fontSize: "13px",
                      fontWeight: 900,
                    }}
                  >
                    {displayConversationName(conversation)}
                  </span>
                  <span
                    style={{
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: "var(--fc-admin-link)",
                      fontSize: "11px",
                      fontWeight: 800,
                      textTransform: "uppercase",
                    }}
                  >
                    {conversation.company || conversation.phone_e164}
                  </span>
                  <span
                    style={{
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: "var(--fc-admin-muted)",
                      fontSize: "12px",
                    }}
                  >
                    {conversation.last_message_preview || "No message preview"}
                  </span>
                  <span style={{ color: "var(--fc-admin-muted)", fontSize: "11px" }}>
                    {formatDate(conversation.last_message_at)}
                    {conversation.unread_count > 0 ? ` · ${conversation.unread_count} unread` : ""}
                  </span>
                </button>
              )
            })
          )}
        </div>
      </section>
    )
  }

  function renderChatPanel() {
    return (
      <section
        style={{
          ...panelStyle,
          display: "grid",
          gridTemplateRows: "auto minmax(260px, 1fr) auto",
          minHeight: isMobile ? "560px" : "calc(100vh - 196px)",
        }}
        aria-label="WhatsApp chat window"
      >
        <div style={sectionHeaderStyle}>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                color: "var(--fc-admin-heading)",
                fontSize: "15px",
                fontWeight: 900,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {displayConversationName(selectedConversation)}
            </div>
            <div style={smallMutedStyle}>
              {selectedConversation?.phone_e164 || "Select a conversation or enter a recipient."}
            </div>
          </div>
          <span style={statusPillStyle(config.configured)}>API {config.configured ? "Ready" : "Setup"}</span>
        </div>

        <div
          style={{
            padding: layout.compactMessages ? "12px" : "18px",
            display: "flex",
            flexDirection: "column",
            gap: layout.compactMessages ? "8px" : "12px",
            overflowY: "auto",
            background: "var(--fc-admin-page-bg)",
          }}
        >
          {loading ? (
            <div style={smallMutedStyle}>Loading messages...</div>
          ) : !storageReady ? (
            <div style={smallMutedStyle}>{inbox.storageMessage || "WhatsApp storage is not ready."}</div>
          ) : selectedMessages.length === 0 ? (
            <div style={smallMutedStyle}>No messages in this conversation.</div>
          ) : (
            selectedMessages.map((chatMessage) => {
              const outbound = chatMessage.direction === "outbound"
              const status = chatMessage.direction === "status"
              return (
                <div
                  key={chatMessage.id}
                  style={{
                    alignSelf: status ? "center" : outbound ? "flex-end" : "flex-start",
                    width: status ? "min(420px, 100%)" : "min(620px, 82%)",
                  }}
                >
                  <div
                    style={{
                      border: "1px solid var(--fc-admin-border-soft)",
                      borderRadius: status ? "999px" : outbound ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
                      background: status
                        ? "var(--fc-admin-panel-soft-bg)"
                        : outbound
                          ? "var(--fc-admin-selected-bg)"
                          : "var(--fc-admin-panel-bg)",
                      color: "var(--fc-admin-panel-text)",
                      padding: layout.compactMessages ? "8px 10px" : "11px 13px",
                      boxShadow: "0 8px 18px #0000000a",
                    }}
                  >
                    <div style={{ fontSize: layout.compactMessages ? "13px" : "14px", lineHeight: 1.45 }}>
                      {chatMessage.body || `[${chatMessage.message_type}]`}
                    </div>
                    <div
                      style={{
                        marginTop: "6px",
                        display: "flex",
                        justifyContent: "space-between",
                        gap: "12px",
                        color: "var(--fc-admin-muted)",
                        fontSize: "10px",
                        fontWeight: 800,
                        textTransform: "uppercase",
                      }}
                    >
                      <span>{formatDate(chatMessage.sent_at)}</span>
                      <span>{chatMessage.status}</span>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div style={{ borderTop: "1px solid var(--fc-admin-border-soft)", padding: "12px" }}>
          <div style={{ display: "grid", gap: "9px" }}>
            {!selectedConversation ? (
              <label style={{ display: "grid", gap: "5px" }}>
                <span style={labelStyle}>Recipient</span>
                <input
                  type="text"
                  value={composeTo}
                  onChange={(event) => setComposeTo(event.target.value)}
                  placeholder="+852..."
                  style={inputStyle}
                />
              </label>
            ) : null}
            <label style={{ display: "grid", gap: "5px" }}>
              <span style={labelStyle}>Message</span>
              <textarea
                value={composeBody}
                onChange={(event) => setComposeBody(event.target.value)}
                placeholder="Type WhatsApp message..."
                rows={isMobile ? 4 : 3}
                style={{ ...inputStyle, resize: "vertical", lineHeight: 1.45 }}
              />
            </label>
            <div
              data-admin-button-style="preserve"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "10px",
                flexWrap: "wrap",
              }}
            >
              <div style={smallMutedStyle}>
                {canEdit
                  ? config.configured
                    ? "Ready to send through Meta WhatsApp."
                    : "Configure Meta WhatsApp env vars before sending."
                  : "View-only access."}
              </div>
              <button
                type="button"
                onClick={() => void sendMessage()}
                disabled={!canEdit || !config.configured || !composeBody.trim() || sending}
                style={
                  !canEdit || !config.configured || !composeBody.trim() || sending
                    ? disabledButtonStyle
                    : primaryButtonStyle
                }
              >
                {sending ? "Sending" : "Send"}
              </button>
            </div>
          </div>
        </div>
      </section>
    )
  }

  function renderDetailsPanel() {
    if (!layout.showDetails) return null

    return (
      <aside style={panelStyle} aria-label="WhatsApp details">
        <div style={sectionHeaderStyle}>
          <div style={sectionTitleStyle}>Information</div>
        </div>
        <div style={{ padding: "14px", display: "grid", gap: "13px" }}>
          <div style={{ display: "grid", gap: "4px" }}>
            <span style={labelStyle}>Name</span>
            <strong style={{ color: "var(--fc-admin-heading)", fontSize: "14px" }}>
              {displayConversationName(selectedConversation)}
            </strong>
          </div>
          <div style={{ display: "grid", gap: "4px" }}>
            <span style={labelStyle}>Company</span>
            <span style={{ fontSize: "13px" }}>{selectedConversation?.company || "Not set"}</span>
          </div>
          <div style={{ display: "grid", gap: "4px" }}>
            <span style={labelStyle}>Assigned To</span>
            <span style={{ fontSize: "13px" }}>{selectedConversation?.assigned_to || "Not assigned"}</span>
          </div>
          <div style={{ display: "grid", gap: "4px" }}>
            <span style={labelStyle}>Status</span>
            <span style={{ fontSize: "13px", textTransform: "uppercase" }}>
              {selectedConversation?.status || "Open"}
            </span>
          </div>
          <div style={{ display: "grid", gap: "6px" }}>
            <span style={labelStyle}>Tags</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
              {(selectedConversation?.tags || []).length > 0 ? (
                (selectedConversation?.tags || []).map((tag) => (
                  <span key={tag} style={statusPillStyle(true)}>
                    {tag}
                  </span>
                ))
              ) : (
                <span style={smallMutedStyle}>No tags</span>
              )}
            </div>
          </div>
          <div style={{ display: "grid", gap: "4px" }}>
            <span style={labelStyle}>Last Message</span>
            <span style={{ fontSize: "13px", lineHeight: 1.45 }}>
              {selectedConversation?.last_message_preview || "No message preview"}
            </span>
            <span style={smallMutedStyle}>{formatDate(selectedConversation?.last_message_at)}</span>
          </div>

          {layout.showMetadata ? (
            <div style={{ display: "grid", gap: "8px" }}>
              <span style={labelStyle}>Metadata</span>
              {metadata.length === 0 ? (
                <span style={smallMutedStyle}>No metadata</span>
              ) : (
                metadata.map(([key, value]) => (
                  <div
                    key={key}
                    style={{
                      border: "1px solid var(--fc-admin-border-soft)",
                      borderRadius: "12px",
                      padding: "8px",
                      background: "var(--fc-admin-panel-soft-bg)",
                    }}
                  >
                    <div style={labelStyle}>{key}</div>
                    <div style={{ marginTop: "4px", fontSize: "12px", wordBreak: "break-word" }}>
                      {typeof value === "string" || typeof value === "number" || typeof value === "boolean"
                        ? String(value)
                        : JSON.stringify(value)}
                    </div>
                  </div>
                ))
              )}
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
      <div style={{ display: "grid", gap: "14px" }}>
        <header
          data-admin-button-style="preserve"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
            <Link
              href="/admin"
              className="fc-admin-nav-button"
              aria-label="Return to admin page"
              title="Return to admin page"
              style={buttonStyle}
            >
              Back
            </Link>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: "var(--fc-admin-link)", fontSize: "12px", fontWeight: 900 }}>
                Contact Tools
              </div>
              <div
                style={{
                  color: "var(--fc-admin-heading)",
                  fontSize: "24px",
                  fontWeight: 900,
                  lineHeight: 1.1,
                }}
              >
                WHATSAPP
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span style={statusPillStyle(config.configured)}>API {config.configured ? "Ready" : "Setup"}</span>
            <span style={statusPillStyle(storageReady)}>Storage {storageReady ? "Ready" : "Setup"}</span>
            <button
              type="button"
              onClick={() => void loadInbox(selectedConversationId)}
              disabled={loading}
              style={loading ? disabledButtonStyle : buttonStyle}
            >
              {loading ? "Refreshing" : "Refresh"}
            </button>
          </div>
        </header>

        {error || message ? (
          <div
            role="status"
            style={{
              ...softPanelStyle,
              borderColor: error ? "var(--fc-admin-danger-border)" : "var(--fc-admin-success-border)",
              color: error ? "var(--fc-admin-danger-text)" : "var(--fc-admin-success-text)",
              padding: "10px 12px",
              fontSize: "13px",
              fontWeight: 800,
            }}
          >
            {error || message}
          </div>
        ) : null}

        <section
          data-admin-view-safe="true"
          data-admin-button-style="preserve"
          style={{ ...softPanelStyle, padding: "12px" }}
          aria-label="WhatsApp layout controls"
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "minmax(260px, 1fr) minmax(280px, 1fr) minmax(260px, 1fr)",
              gap: "12px",
              alignItems: "center",
            }}
          >
            <div style={{ display: "grid", gap: "6px" }}>
              <span style={labelStyle}>Conversation List</span>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                {(["left", "right"] as const).map((side) => {
                  const active = layout.conversationSide === side
                  return (
                    <button
                      key={side}
                      type="button"
                      aria-pressed={active}
                      onClick={() => updateLayout({ conversationSide: side })}
                      style={active ? primaryButtonStyle : buttonStyle}
                    >
                      {side === "left" ? "Left" : "Right"}
                    </button>
                  )
                })}
              </div>
            </div>

            <label style={{ display: "grid", gap: "6px" }}>
              <span style={labelStyle}>List Width: {layout.conversationWidth}px</span>
              <input
                type="range"
                min={260}
                max={440}
                step={10}
                value={layout.conversationWidth}
                onChange={(event) => updateLayout({ conversationWidth: Number(event.target.value) })}
              />
            </label>

            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              {[
                { key: "showDetails", label: "Details", value: layout.showDetails },
                { key: "showSetup", label: "Setup", value: layout.showSetup },
                { key: "compactMessages", label: "Compact", value: layout.compactMessages },
                { key: "showMetadata", label: "Metadata", value: layout.showMetadata },
              ].map((control) => (
                <button
                  key={control.key}
                  type="button"
                  aria-pressed={control.value}
                  onClick={() => updateLayout({ [control.key]: !control.value } as Partial<WhatsAppLayout>)}
                  style={control.value ? primaryButtonStyle : buttonStyle}
                >
                  {control.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        {layout.showSetup ? (
          <section style={{ ...panelStyle, padding: "14px" }} aria-label="WhatsApp setup status">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: isMobile ? "1fr" : "repeat(4, minmax(0, 1fr))",
                gap: "10px",
              }}
            >
              {[
                ["Access Token", config.hasAccessToken],
                ["Phone Number ID", config.hasPhoneNumberId],
                ["Webhook Verify", config.hasVerifyToken],
                ["App Secret", config.hasAppSecret],
              ].map(([label, ready]) => (
                <div
                  key={String(label)}
                  style={{
                    border: "1px solid var(--fc-admin-border-soft)",
                    borderRadius: "14px",
                    background: "var(--fc-admin-panel-soft-bg)",
                    padding: "10px",
                    display: "grid",
                    gap: "6px",
                  }}
                >
                  <span style={labelStyle}>{label}</span>
                  <span style={statusPillStyle(Boolean(ready))}>{ready ? "Configured" : "Missing"}</span>
                </div>
              ))}
            </div>
            <div
              style={{
                marginTop: "12px",
                display: "grid",
                gridTemplateColumns: isMobile ? "1fr" : "1fr auto",
                gap: "10px",
                alignItems: "center",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={labelStyle}>Webhook URL</div>
                <div
                  style={{
                    marginTop: "4px",
                    color: "var(--fc-admin-panel-text)",
                    fontSize: "13px",
                    overflowWrap: "anywhere",
                  }}
                >
                  {webhookUrl}
                </div>
              </div>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                <span style={statusPillStyle(config.hasBusinessAccountId)}>
                  WABA {config.hasBusinessAccountId ? "Set" : "Optional"}
                </span>
                <span style={statusPillStyle(true)}>{config.graphApiVersion}</span>
              </div>
            </div>
          </section>
        ) : null}

        <main
          style={{
            display: "grid",
            gridTemplateColumns: gridColumns,
            gap: "14px",
            alignItems: "stretch",
          }}
        >
          {layout.conversationSide === "left" ? renderConversationList() : renderChatPanel()}
          {layout.conversationSide === "left" ? renderChatPanel() : renderConversationList()}
          {renderDetailsPanel()}
        </main>
      </div>
    </div>
  )
}
