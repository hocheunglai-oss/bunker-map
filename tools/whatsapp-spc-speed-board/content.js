(function () {
  const STORAGE_KEY = "fcuno-wa-spc-board-v1"
  const BOARD_ID = "fcuno-wa-spc-board"
  const LISTS = ["supplier", "buyer"]
  const LIST_LABELS = { supplier: "Supplier", buyer: "Buyer" }
  const DEFAULT_TEMPLATE_TEXT = "Good day, please quote for the following enquiries."
  const PENDING_SEND_TIMEOUT_MS = 30000
  const SEND_LOCK_KEY = "fcuno-wa-spc-send-lock-v1"
  const SEND_LOCK_TTL_MS = 30000
  const LOGO_SRC =
    typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL
      ? chrome.runtime.getURL("spc-sidebar-logo.png")
      : "https://spc.fcuno.com/spc-sidebar-logo.png"

  const state = {
    collapsed: false,
    contacts: [],
    unreadById: {},
    enquiries: [],
    selectedEnquiries: {},
    hiddenEnquiryIds: {},
    templateEnabled: true,
    templateEditing: false,
    templateText: DEFAULT_TEMPLATE_TEXT,
    lastSeenEnquiryAt: "",
    lastNotifiedEnquiryAt: "",
    pendingSend: null,
    contactMenuId: "",
    loadingEnquiries: false,
    enquiryError: "",
    dragging: null,
    draggingType: "",
  }

  let unreadTimer = 0
  let enquiryTimer = 0
  let templateSaveTimer = 0
  let lastEnquiryFingerprint = ""
  let recentSend = { key: "", at: 0 }
  let memorySendLock = { key: "", at: 0 }

  function uid() {
    if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID()
    return `fcuno-spc-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim()
  }

  function cleanTemplateText(value) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim()
  }

  function readSendLock() {
    if (memorySendLock.key) return memorySendLock
    try {
      const raw = window.sessionStorage?.getItem(SEND_LOCK_KEY)
      const parsed = raw ? JSON.parse(raw) : null
      if (parsed && typeof parsed === "object") return { key: cleanText(parsed.key), at: Number(parsed.at) || 0 }
    } catch {
    }
    const raw = document.documentElement?.getAttribute("data-fcuno-wa-spc-send-lock") || ""
    const [key, at] = raw.split("|")
    return key ? { key: cleanText(key), at: Number(at) || 0 } : null
  }

  function writeSendLock(lock) {
    memorySendLock = lock
    try {
      window.sessionStorage?.setItem(SEND_LOCK_KEY, JSON.stringify(lock))
    } catch {
    }
    document.documentElement?.setAttribute("data-fcuno-wa-spc-send-lock", `${lock.key}|${lock.at}`)
  }

  function acquireSendLock(scope, text) {
    const message = cleanTemplateText(text)
    const key = `${cleanText(scope)}|${message}`
    if (!message || !key) return false
    const now = Date.now()
    const current = readSendLock()
    if (current?.key === key && now - current.at < SEND_LOCK_TTL_MS) return false
    writeSendLock({ key, at: now })
    recentSend = { key, at: now }
    return true
  }

  function phoneDigits(value) {
    return String(value || "").replace(/\D/g, "")
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;")
  }

  function formatTime(value) {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return ""
    return date.toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
  }

  function getStorage() {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return null
    return chrome.storage.local
  }

  function normalizeOrders() {
    LISTS.forEach((list) => {
      contactsFor(list).forEach((contact, index) => {
        contact.order = (index + 1) * 1000
      })
    })
  }

  function assignOrdersByCurrentListOrder() {
    LISTS.forEach((list) => {
      state.contacts
        .filter((contact) => contact.list === list)
        .forEach((contact, index) => {
          contact.order = (index + 1) * 1000
        })
    })
  }

  function contactsFor(list) {
    return state.contacts
      .filter((contact) => contact.list === list)
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
  }

  function statePayload() {
    return {
      collapsed: state.collapsed,
      contacts: state.contacts,
      hiddenEnquiryIds: state.hiddenEnquiryIds,
      templateEnabled: state.templateEnabled,
      templateText: state.templateText,
      lastSeenEnquiryAt: state.lastSeenEnquiryAt,
      lastNotifiedEnquiryAt: state.lastNotifiedEnquiryAt,
      pendingSend: state.pendingSend,
    }
  }

  function sanitizePendingSend(value) {
    if (!value || typeof value !== "object") return null
    const startedAt = Number(value.startedAt || 0)
    if (!startedAt || Date.now() - startedAt > PENDING_SEND_TIMEOUT_MS) return null
    const text = cleanTemplateText(value.text)
    if (!text) return null
    return {
      contactId: cleanText(value.contactId),
      text,
      startedAt,
      attempts: Number.isFinite(Number(value.attempts)) ? Number(value.attempts) : 0,
    }
  }

  function sanitizeSavedState(value) {
    const source = value && typeof value === "object" ? value : {}
    return {
      collapsed: Boolean(source.collapsed),
      lastSeenEnquiryAt: cleanText(source.lastSeenEnquiryAt),
      lastNotifiedEnquiryAt: cleanText(source.lastNotifiedEnquiryAt),
      templateEnabled: typeof source.templateEnabled === "boolean" ? source.templateEnabled : true,
      templateText: cleanTemplateText(source.templateText) || DEFAULT_TEMPLATE_TEXT,
      pendingSend: sanitizePendingSend(source.pendingSend),
      hiddenEnquiryIds:
        source.hiddenEnquiryIds && typeof source.hiddenEnquiryIds === "object"
          ? Object.fromEntries(
              Object.entries(source.hiddenEnquiryIds)
                .filter((entry) => entry[1])
                .map((entry) => [String(entry[0]), true]),
            )
          : {},
      contacts: Array.isArray(source.contacts)
        ? source.contacts
            .filter((contact) => contact && typeof contact === "object")
            .map((contact, index) => {
              const chatName = cleanText(contact.chatName || contact.searchName || contact.whatsappName || contact.originalName || contact.name)
              const phone = cleanText(contact.phone)
              return {
                id: String(contact.id || uid()),
                name: chatName || phone || "Unnamed chat",
                chatName,
                company: cleanText(contact.company),
                phone,
                directUrl: cleanText(contact.directUrl),
                list: contact.list === "buyer" ? "buyer" : "supplier",
                order: Number.isFinite(Number(contact.order)) ? Number(contact.order) : index + 1,
                createdAt: contact.createdAt || new Date().toISOString(),
                updatedAt: contact.updatedAt || new Date().toISOString(),
              }
            })
        : [],
    }
  }

  async function loadState() {
    const storage = getStorage()
    let parsed = {}
    if (storage) {
      parsed = await new Promise((resolve) => {
        storage.get([STORAGE_KEY], (items) => resolve(items && items[STORAGE_KEY] ? items[STORAGE_KEY] : {}))
      })
    }
    const saved = sanitizeSavedState(parsed)
    state.collapsed = saved.collapsed
    state.contacts = saved.contacts
    state.hiddenEnquiryIds = saved.hiddenEnquiryIds
    state.templateEnabled = saved.templateEnabled
    state.templateText = saved.templateText
    state.lastSeenEnquiryAt = saved.lastSeenEnquiryAt
    state.lastNotifiedEnquiryAt = saved.lastNotifiedEnquiryAt
    state.pendingSend = saved.pendingSend
    normalizeOrders()
  }

  function saveState() {
    normalizeOrders()
    const storage = getStorage()
    if (storage) storage.set({ [STORAGE_KEY]: statePayload() })
    document.body.classList.toggle("fcuno-wa-spc-collapsed", state.collapsed)
    document.body.classList.toggle("fcuno-wa-spc-active", !state.collapsed)
  }

  function saveTemplateState() {
    const storage = getStorage()
    if (storage) storage.set({ [STORAGE_KEY]: statePayload() })
  }

  function scheduleTemplateSave() {
    if (templateSaveTimer) window.clearTimeout(templateSaveTimer)
    templateSaveTimer = window.setTimeout(() => {
      templateSaveTimer = 0
      saveTemplateState()
    }, 250)
  }

  function getDirectUrl(phone) {
    const digits = phoneDigits(phone)
    return digits ? `https://web.whatsapp.com/send?phone=${digits}` : ""
  }

  function contactNameIsPhone(contact) {
    const name = cleanText(contact?.chatName || contact?.name)
    const digits = phoneDigits(name)
    return Boolean(digits.length >= 7 && digits === phoneDigits(contact?.phone || name))
  }

  function contactChatName(contact) {
    return cleanText(contact?.chatName || contact?.searchName || contact?.whatsappName || contact?.originalName)
  }

  function contactSearchText(contact) {
    return contactChatName(contact) || cleanText(contact?.phone) || cleanText(contact?.name)
  }

  function contactLookupNames(contact) {
    const name = contactChatName(contact) || cleanText(contact?.name)
    return name ? [name] : []
  }

  function canUseDirectUrl(contact) {
    const digits = phoneDigits(contact?.phone)
    return Boolean(digits && (!cleanText(contact?.name) || contactNameIsPhone(contact)))
  }

  function sanitizeDirectUrl(value) {
    try {
      const url = new URL(value, window.location.origin)
      if (url.hostname !== "web.whatsapp.com" || !url.pathname.startsWith("/send")) return ""
      return getDirectUrl(url.searchParams.get("phone") || "")
    } catch {
      return ""
    }
  }

  function isVisible(element) {
    if (!element || element.closest(`#${BOARD_ID}`)) return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  function textCandidates(root) {
    const seen = new Set()
    return Array.from(root.querySelectorAll("span[title], div[title], [dir='auto'], [aria-label]"))
      .filter(isVisible)
      .map((element) =>
        cleanText(
          element.getAttribute("title") ||
            element.getAttribute("aria-label") ||
            element.textContent,
        ),
      )
      .filter((text) => {
        const key = text.toLowerCase()
        if (!text || seen.has(key)) return false
        if ([
          "search",
          "menu",
          "message",
          "more options",
          "typing",
          "online",
          "last seen",
          "video call",
          "voice call",
          "audio call",
          "profile details",
          "contact info",
          "group info",
          "click to see",
          "open chat details",
        ].some((item) => key.includes(item))) return false
        seen.add(key)
        return true
      })
  }

  function getCurrentChat() {
    const main = document.querySelector("#main") || document.querySelector("[role='main']")
    const header = main && main.querySelector("header")
    if (!main || !header) return null

    const candidates = textCandidates(header)
    const name = candidates.find((text) => phoneDigits(text).length < 7) || candidates[0] || ""
    const phone = phoneDigits(name).length >= 7 ? phoneDigits(name) : ""
    if (!name && !phone) return null
    return { name: cleanText(name || phone), company: "", phone, directUrl: getDirectUrl(phone) }
  }

  function addContact(list) {
    const chat = getCurrentChat()
    if (!chat) return

    const keyName = chat.name || chat.phone
    const duplicate = state.contacts.find((contact) => {
      if (contact.list !== list) return false
      if (chat.phone && phoneDigits(contact.phone) === phoneDigits(chat.phone)) return true
      return contactLookupNames(contact).some((name) => name.toLowerCase() === keyName.toLowerCase())
    })

    if (duplicate) {
      duplicate.name = keyName
      duplicate.chatName = keyName
      duplicate.phone = chat.phone || duplicate.phone
      duplicate.directUrl = chat.directUrl || duplicate.directUrl
      duplicate.updatedAt = new Date().toISOString()
    } else {
      state.contacts.push({
        id: uid(),
        name: keyName,
        chatName: keyName,
        company: "",
        phone: chat.phone,
        directUrl: chat.directUrl,
        list,
        order: contactsFor(list).length * 1000 + 1000,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }
    saveState()
    render()
  }

  function removeContact(id) {
    state.contacts = state.contacts.filter((contact) => contact.id !== id)
    delete state.unreadById[id]
    if (state.contactMenuId === id) state.contactMenuId = ""
    saveState()
    render()
  }

  function confirmRemoveContact(id) {
    const contact = state.contacts.find((item) => item.id === id)
    if (!contact) return
    if (!window.confirm(`Remove ${contact.name} from the SPC board?`)) return
    removeContact(id)
  }

  function moveContact(id, targetList, targetId, position = "before") {
    const moving = state.contacts.find((contact) => contact.id === id)
    if (!moving || !LISTS.includes(targetList)) return
    const next = {
      supplier: contactsFor("supplier").filter((contact) => contact.id !== id),
      buyer: contactsFor("buyer").filter((contact) => contact.id !== id),
    }
    moving.list = targetList
    moving.updatedAt = new Date().toISOString()
    const target = next[targetList]
    const index = targetId ? target.findIndex((contact) => contact.id === targetId) : target.length
    const insertAt = index < 0 ? target.length : position === "after" ? index + 1 : index
    target.splice(insertAt, 0, moving)
    state.contacts = [...next.supplier, ...next.buyer]
    assignOrdersByCurrentListOrder()
    saveState()
    render()
  }

  function getSidePane() {
    return document.querySelector("#pane-side") || document.querySelector("#side")
  }

  function textMatchesContact(contact, value) {
    const text = cleanText(value).toLowerCase()
    if (!text) return false
    const digits = phoneDigits(contact.phone)
    if (digits && phoneDigits(text).includes(digits)) return true
    const lookupNames = contactLookupNames(contact).map((name) => name.toLowerCase())
    return lookupNames.some((name) => text === name)
  }

  function clickableRow(element) {
    if (!element || element.closest("[role='search']") || element.matches("input, textarea, [role='textbox']")) return null
    const row =
      element.closest("[data-testid='cell-frame-container']") ||
      element.closest("[role='listitem']") ||
      element.closest("[role='row']") ||
      element.closest("div[tabindex='0']") ||
      element.closest("div[tabindex='-1']")
    return row && isVisible(row) ? row : null
  }

  function findVisibleChatRow(contact) {
    const pane = getSidePane()
    if (!pane) return null
    const matches = Array.from(pane.querySelectorAll("span[title], [dir='auto'], [aria-label], [title]")).filter(isVisible)
    for (const element of matches) {
      const text = cleanText(element.getAttribute("title") || element.getAttribute("aria-label") || element.textContent)
      if (!textMatchesContact(contact, text)) continue
      const row = clickableRow(element)
      if (row) return row
    }
    return null
  }

  function activateChatRow(row) {
    row.scrollIntoView({ block: "center", inline: "nearest" })
    row.focus?.()
    ;["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) => {
      const EventCtor = type.startsWith("pointer") && typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent
      row.dispatchEvent(new EventCtor(type, { bubbles: true, cancelable: true, view: window, button: 0 }))
    })
  }

  function sideSearchRoot() {
    return document.querySelector("#side") || document.body
  }

  function editableLabel(element) {
    return cleanText(
      element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.getAttribute("placeholder") ||
        element.textContent,
    ).toLowerCase()
  }

  function findSideSearchBox() {
    const root = sideSearchRoot()
    const candidates = Array.from(
      root.querySelectorAll("input[type='text'], div[contenteditable='true'][role='textbox'], div[contenteditable='true'], [role='textbox']"),
    ).filter(isVisible)
    return (
      candidates.find((element) => editableLabel(element).includes("search")) ||
      candidates.find((element) => {
        const rect = element.getBoundingClientRect()
        return rect.top < 180 && rect.left < window.innerWidth / 2
      }) ||
      null
    )
  }

  function setEditableText(element, text) {
    element.focus()
    if ("value" in element) {
      element.value = ""
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: "" }))
      element.value = text
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }))
      return
    }
    document.execCommand("selectAll", false)
    document.execCommand("insertText", false, text)
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }))
  }

  function clearEditableText(element) {
    if (!element) return
    element.focus()
    if ("value" in element) {
      element.value = ""
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: "" }))
      return
    }
    document.execCommand("selectAll", false)
    document.execCommand("delete", false)
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: "" }))
  }

  async function searchAndOpenContact(contact) {
    const searchBox = findSideSearchBox()
    if (!searchBox) return false
    setEditableText(searchBox, contactSearchText(contact))
    for (const delay of [250, 550, 950]) {
      await new Promise((resolve) => window.setTimeout(resolve, delay))
      const row = findVisibleChatRow(contact)
      if (row) {
        activateChatRow(row)
        window.setTimeout(() => clearEditableText(searchBox), 120)
        return true
      }
    }
    return false
  }

  async function openContact(contact) {
    const row = findVisibleChatRow(contact)
    if (row) {
      activateChatRow(row)
      return
    }
    if (await searchAndOpenContact(contact)) return

    const directUrl = canUseDirectUrl(contact)
      ? getDirectUrl(contact.phone) || sanitizeDirectUrl(contact.directUrl)
      : ""
    if (directUrl) window.location.assign(directUrl)
  }

  function unreadCount(row) {
    const label = Array.from(row.querySelectorAll("[aria-label], [title]"))
      .map((element) => `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`)
      .map(cleanText)
      .find((text) => /unread|未讀|未读/i.test(text))
    const match = label && label.match(/\d+/)
    return match ? match[0] : label ? "•" : ""
  }

  function refreshUnreadIndicators() {
    const next = {}
    state.contacts.forEach((contact) => {
      const row = findVisibleChatRow(contact)
      const unread = row ? unreadCount(row) : ""
      if (unread) next[contact.id] = unread
    })
    if (JSON.stringify(next) === JSON.stringify(state.unreadById)) return
    state.unreadById = next
    render()
  }

  function enquiriesFingerprint(enquiries) {
    return enquiries
      .map((enquiry) => {
        const id = cleanText(enquiry.id)
        const status = enquiryStatusKey(enquiry)
        const body = enquiryBodyText(enquiry)
        const createdAt = enquiryCreatedAt(enquiry)
        return `${id}|${status}|${createdAt}|${body}`
      })
      .join("\n")
  }

  function loadEnquiries() {
    if (state.loadingEnquiries) return
    state.loadingEnquiries = true
    state.enquiryError = ""
    if (state.enquiries.length === 0) render()
    chrome.runtime.sendMessage({ type: "load-spc-enquiries" }, (response) => {
      state.loadingEnquiries = false
      if (chrome.runtime.lastError || !response || !response.ok) {
        state.enquiryError = response?.message || chrome.runtime.lastError?.message || "Open spc.fcuno.com and log in."
        render()
        return
      }
      const nextEnquiries = dedupeEnquiries(Array.isArray(response.enquiries) ? response.enquiries : [])
      const nextFingerprint = enquiriesFingerprint(nextEnquiries)
      const changed = nextFingerprint !== lastEnquiryFingerprint
      state.enquiries = nextEnquiries
      lastEnquiryFingerprint = nextFingerprint
      Object.keys(state.selectedEnquiries).forEach((id) => {
        const enquiry = state.enquiries.find((item) => item.id === id)
        if (!enquiry || state.hiddenEnquiryIds[id] || !isSendableEnquiry(enquiry)) {
          delete state.selectedEnquiries[id]
        }
      })
      notifyNewEnquiries()
      if (!state.templateEditing || changed) render()
    })
  }

  function visibleEnquiries() {
    return state.enquiries.filter((enquiry) => !state.hiddenEnquiryIds[enquiry.id])
  }

  function dedupeEnquiries(enquiries) {
    const seenIds = new Set()
    const seenBodies = new Set()
    return enquiries.filter((enquiry) => {
      if (!enquiry || typeof enquiry !== "object") return false
      const id = cleanText(enquiry.id)
      if (id && seenIds.has(id)) return false
      if (id) seenIds.add(id)
      const createdBucket = cleanText(enquiryCreatedAt(enquiry)).slice(0, 16)
      const sender = cleanText(enquiry.createdByDisplayName || enquiry.created_by_display_name || enquiry.createdByUsername)
      const bodyKey = `${enquiryBodyText(enquiry).toLowerCase()}|${sender.toLowerCase()}|${createdBucket}`
      if (bodyKey !== "||" && seenBodies.has(bodyKey)) return false
      if (bodyKey !== "||") seenBodies.add(bodyKey)
      return true
    })
  }

  function isSendableEnquiry(enquiry) {
    return (!enquiry.status || enquiry.status === "sent") && !enquiry.meta?.postponedAt && !enquiry.meta?.cancelledAt
  }

  function enquiryStatusKey(enquiry) {
    if ((!enquiry.status || enquiry.status === "sent") && enquiry.meta?.cancelledAt) return "closed"
    if ((!enquiry.status || enquiry.status === "sent") && enquiry.meta?.postponedAt) return "postponed"
    return enquiry.status || "sent"
  }

  function enquiryStatusText(enquiry) {
    const status = enquiryStatusKey(enquiry)
    if (status === "quoted") return "STEM"
    if (status === "cancelled") return "LOST"
    if (status === "closed") return "CANX"
    if (status === "postponed") return "POST"
    return "SENT"
  }

  function enquiryCreatedAt(enquiry) {
    return enquiry.createdAt || enquiry.created_at || ""
  }

  function markEnquirySeen(enquiry) {
    const createdAt = enquiryCreatedAt(enquiry)
    if (!createdAt || createdAt <= state.lastSeenEnquiryAt) return
    state.lastSeenEnquiryAt = createdAt
    saveState()
    render()
  }

  function hideEnquiry(id) {
    if (!id) return
    state.hiddenEnquiryIds[id] = true
    delete state.selectedEnquiries[id]
    saveState()
    render()
  }

  function clearVisibleEnquiries() {
    visibleEnquiries().forEach((enquiry) => {
      state.hiddenEnquiryIds[enquiry.id] = true
      delete state.selectedEnquiries[enquiry.id]
    })
    saveState()
    render()
  }

  function latestEnquiryAt() {
    return visibleEnquiries().reduce((latest, enquiry) => {
      const value = enquiryCreatedAt(enquiry)
      return value > latest ? value : latest
    }, "")
  }

  function newEnquiryCount() {
    const visible = visibleEnquiries()
    if (!state.lastSeenEnquiryAt) return visible.length
    return visible.filter((enquiry) => enquiryCreatedAt(enquiry) > state.lastSeenEnquiryAt).length
  }

  function notifyNewEnquiries() {
    const latest = latestEnquiryAt()
    if (!latest) return
    if (!state.lastNotifiedEnquiryAt) {
      state.lastNotifiedEnquiryAt = latest
      saveState()
      return
    }
    if (latest <= state.lastNotifiedEnquiryAt) return

    const count = visibleEnquiries().filter((enquiry) => {
      const createdAt = enquiryCreatedAt(enquiry)
      return createdAt > state.lastNotifiedEnquiryAt
    }).length
    state.lastNotifiedEnquiryAt = latest
    saveState()
    if (count > 0) {
      chrome.runtime.sendMessage({ type: "notify-new-enquiries", count })
    }
  }

  function withTemplate(text) {
    const body = cleanTemplateText(text)
    if (!body) return ""
    const template = state.templateEnabled ? cleanTemplateText(state.templateText) : ""
    return template ? `${template}\n\n${body}` : body
  }

  function enquiryBodyText(enquiry) {
    return cleanText(enquiry?.formattedText || enquiry?.notes || enquiry?.title || "")
  }

  function enquiryTextForDrag(id) {
    const enquiry = visibleEnquiries().find((item) => item.id === id)
    if (!enquiry || !isSendableEnquiry(enquiry)) return ""
    return withTemplate(enquiryBodyText(enquiry))
  }

  function selectedEnquiryText() {
    const seenIds = new Set()
    const seenBodies = new Set()
    const text = visibleEnquiries()
      .filter((enquiry) => {
        if (!state.selectedEnquiries[enquiry.id] || !isSendableEnquiry(enquiry)) return false
        const body = enquiryBodyText(enquiry)
        const id = cleanText(enquiry.id)
        const bodyKey = body.toLowerCase()
        if ((id && seenIds.has(id)) || (bodyKey && seenBodies.has(bodyKey))) return false
        if (id) seenIds.add(id)
        if (bodyKey) seenBodies.add(bodyKey)
        return true
      })
      .map(enquiryBodyText)
      .filter(Boolean)
      .join("\n\n")
    return withTemplate(text)
  }

  function findComposer() {
    const main = document.querySelector("#main") || document.querySelector("[role='main']")
    if (!main) return null
    const candidates = Array.from(
      main.querySelectorAll("div[contenteditable='true'][role='textbox'], div[contenteditable='true'], [role='textbox']"),
    ).filter(isVisible)
    return candidates[candidates.length - 1] || null
  }

  function composerText(composer) {
    return cleanText(composer?.innerText || composer?.textContent || "")
  }

  function setComposerDomText(composer, text) {
    const lines = String(text || "").split("\n")
    if (typeof composer.replaceChildren === "function") {
      composer.replaceChildren()
    } else {
      composer.textContent = ""
    }
    lines.forEach((line, index) => {
      if (index > 0) composer.appendChild(document.createElement("br"))
      composer.appendChild(document.createTextNode(line))
    })
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }))
  }

  function clearComposerText(composer) {
    composer.focus()
    const selection = window.getSelection()
    if (selection) {
      const range = document.createRange()
      range.selectNodeContents(composer)
      selection.removeAllRanges()
      selection.addRange(range)
    } else {
      document.execCommand("selectAll", false)
    }
    document.execCommand("delete", false)
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: "" }))
    if (composerText(composer)) {
      if (typeof composer.replaceChildren === "function") {
        composer.replaceChildren()
      }
      composer.textContent = ""
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: "" }))
    }
  }

  function replaceComposerText(composer, text) {
    clearComposerText(composer)
    setComposerDomText(composer, text)
    return composerText(composer) === cleanText(text)
  }

  function insertComposerText(text) {
    const composer = findComposer()
    if (!composer) return false
    return replaceComposerText(composer, text)
  }

  function sendButtonLabel(item) {
    const ownLabel = [
      item.getAttribute("aria-label"),
      item.getAttribute("title"),
      item.getAttribute("data-testid"),
      item.getAttribute("data-icon"),
    ].map(cleanText).join(" ")
    const childLabel = Array.from(item.querySelectorAll("[aria-label], [title], [data-testid], [data-icon]"))
      .map((child) =>
        [
          child.getAttribute("aria-label"),
          child.getAttribute("title"),
          child.getAttribute("data-testid"),
          child.getAttribute("data-icon"),
        ].map(cleanText).join(" "),
      )
      .join(" ")
    return `${ownLabel} ${childLabel}`.toLowerCase()
  }

  function isSendButtonLabel(label) {
    return /\bsend\b|send-filled|wds-ic-send/.test(label)
  }

  function isBlockedComposerControl(label) {
    return /\bmicrophone\b|\bvoice\b|\baudio\b|\bcamera\b|\battach\b|\bemoji\b|\bsticker\b|\bgif\b|\bplus\b/.test(label)
  }

  function sortByBottomRight(items) {
    return [...items].sort((a, b) => {
      const aRect = a.getBoundingClientRect()
      const bRect = b.getBoundingClientRect()
      return aRect.left - bRect.left || aRect.top - bRect.top
    })
  }

  function isNearComposerAction(item, composerRect) {
    const rect = item.getBoundingClientRect()
    const verticalOverlap = rect.bottom >= composerRect.top - 12 && rect.top <= composerRect.bottom + 36
    const rightAligned = rect.left >= composerRect.right - 140 || rect.right >= composerRect.right - 12
    return verticalOverlap && rightAligned
  }

  function findSendButton() {
    const main = document.querySelector("#main") || document.querySelector("[role='main']")
    if (!main) return null

    const candidates = Array.from(
      main.querySelectorAll("button,[role='button'],span[data-icon],div[data-testid],button[data-testid]"),
    )
      .map((item) => item.closest("button,[role='button']") || item)
      .filter((item, index, items) => item && items.indexOf(item) === index && isVisible(item))

    const composer = findComposer()
    if (composer) {
      const composerRect = composer.getBoundingClientRect()
      const nearComposer = candidates.filter((item) => isNearComposerAction(item, composerRect))
      const nearSendButtons = sortByBottomRight(nearComposer.filter((item) => isSendButtonLabel(sendButtonLabel(item))))
      if (nearSendButtons.length) return nearSendButtons[nearSendButtons.length - 1]

      const nearActions = sortByBottomRight(
        nearComposer.filter((item) => !isBlockedComposerControl(sendButtonLabel(item))),
      )
      if (nearActions.length) return nearActions[nearActions.length - 1]
    }

    const byLabel = sortByBottomRight(candidates.filter((item) => isSendButtonLabel(sendButtonLabel(item))))
    return byLabel[byLabel.length - 1] || null
  }

  function clickSendButton(button) {
    if (!button) return false
    button.focus?.()
    const rect = button.getBoundingClientRect()
    const clientX = rect.left + rect.width / 2
    const clientY = rect.top + rect.height / 2
    try {
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", pointerId: 1, isPrimary: true, button: 0, buttons: 1, clientX, clientY }))
      button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX, clientY }))
      button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "mouse", pointerId: 1, isPrimary: true, button: 0, buttons: 0, clientX, clientY }))
      button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, buttons: 0, clientX, clientY }))
    } catch {
    }
    button.click()
    return true
  }

  function pressComposerEnter() {
    const composer = findComposer()
    if (!composer) return false
    composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }))
    composer.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }))
    return true
  }

  function sendComposerWhenReady(text = "", attempt = 0) {
    const composer = findComposer()
    if (text && composer && composerText(composer) !== cleanText(text)) {
      return false
    }
    const button = findSendButton()
    if (button) {
      return clickSendButton(button)
    }
    if (attempt < 10) {
      window.setTimeout(() => sendComposerWhenReady(text, attempt + 1), 80)
      return false
    }
    return pressComposerEnter()
  }

  function currentChatMatchesContact(contact) {
    const chat = getCurrentChat()
    if (!chat || !contact) return false
    const contactPhone = phoneDigits(contact.phone)
    if (contactPhone && phoneDigits(chat.phone) === contactPhone) return true
    const chatName = cleanText(chat.name).toLowerCase()
    return contactLookupNames(contact).some((name) => chatName && chatName === name.toLowerCase())
  }

  function clearPendingSend() {
    state.pendingSend = null
    saveState()
  }

  function trySendPending() {
    const pending = sanitizePendingSend(state.pendingSend)
    if (!pending) {
      if (state.pendingSend) clearPendingSend()
      return
    }

    const contact = state.contacts.find((item) => item.id === pending.contactId)
    if (contact && currentChatMatchesContact(contact) && insertComposerText(pending.text)) {
      clearPendingSend()
      window.setTimeout(() => sendComposerWhenReady(pending.text), 120)
      return
    }

    pending.attempts += 1
    state.pendingSend = pending
    if (Date.now() - pending.startedAt > PENDING_SEND_TIMEOUT_MS || pending.attempts > 60) {
      clearPendingSend()
      return
    }
    saveState()
    window.setTimeout(trySendPending, 250)
  }

  function sendTextToContact(contact, text) {
    const message = cleanTemplateText(text)
    if (!contact || !message) return
    const sendKey = `${contact.id}|${message}`
    const now = Date.now()
    if (recentSend.key === sendKey && now - recentSend.at < 1200) return
    if (!acquireSendLock(`contact:${contact.id}`, message)) return
    recentSend = { key: sendKey, at: now }
    if (state.pendingSend?.contactId === contact.id) clearPendingSend()

    if (currentChatMatchesContact(contact) && insertComposerText(message)) {
      window.setTimeout(() => sendComposerWhenReady(message), 120)
      return
    }

    state.pendingSend = {
      contactId: contact.id,
      text: message,
      startedAt: Date.now(),
      attempts: 0,
    }
    saveState()
    void openContact(contact).then(() => window.setTimeout(trySendPending, 180))
    window.setTimeout(trySendPending, 320)
  }

  function sendSelectedToChat() {
    const text = selectedEnquiryText()
    if (!text) return
    const chat = getCurrentChat()
    const scope = chat ? `chat:${chat.name || chat.phone}` : "chat:current"
    if (!acquireSendLock(scope, text)) return
    if (!insertComposerText(text)) return
    window.setTimeout(() => sendComposerWhenReady(text), 120)
  }

  function renderContactList(list) {
    const rows = contactsFor(list).map((contact) => {
      const details = [contact.company, contact.phone].filter(Boolean).join(" · ")
      const menuOpen = state.contactMenuId === contact.id
      return `
        <div class="fcuno-wa-spc-row" draggable="true" data-id="${escapeHtml(contact.id)}" data-list="${list}">
          <button class="fcuno-wa-spc-list-button" type="button" data-action="open-contact" data-id="${escapeHtml(contact.id)}">
            <strong>${escapeHtml(contact.name)}</strong>
            ${details ? `<span>${escapeHtml(details)}</span>` : ""}
          </button>
          <div class="fcuno-wa-spc-row-actions">
            ${state.unreadById[contact.id] ? `<span class="fcuno-wa-spc-unread">${escapeHtml(state.unreadById[contact.id])}</span>` : ""}
            <button class="fcuno-wa-spc-contact-action" type="button" draggable="true" data-action="contact-menu" data-id="${escapeHtml(contact.id)}" title="Drag or remove">☰</button>
            ${menuOpen ? `
              <div class="fcuno-wa-spc-contact-menu" role="menu">
                <button type="button" data-action="remove-contact" data-id="${escapeHtml(contact.id)}">Remove</button>
              </div>
            ` : ""}
          </div>
        </div>
      `
    }).join("")

    return `
      <section class="fcuno-wa-spc-contact-panel" data-panel="${list}">
        <div class="fcuno-wa-spc-contact-list" data-list="${list}">
          ${rows || `<div class="fcuno-wa-spc-empty">No ${LIST_LABELS[list].toLowerCase()} saved.</div>`}
        </div>
      </section>
    `
  }

  function renderTemplate() {
    return `
      <section class="fcuno-wa-spc-template" aria-label="SPC message template">
        <div class="fcuno-wa-spc-template-toolbar">
          <label class="fcuno-wa-spc-template-toggle">
            <input type="checkbox" data-action="toggle-template" ${state.templateEnabled ? "checked" : ""} />
            <span>Use Template</span>
          </label>
          <button type="button" data-action="edit-template">${state.templateEditing ? "Done" : "Edit"}</button>
        </div>
        ${state.templateEditing ? `<textarea data-action="template-text" aria-label="Template text">${escapeHtml(state.templateText)}</textarea>` : ""}
      </section>
    `
  }

  function renderEnquiries() {
    const count = newEnquiryCount()
    const rows = visibleEnquiries().map((enquiry) => {
      const createdAt = enquiryCreatedAt(enquiry)
      const isNew = !state.lastSeenEnquiryAt || createdAt > state.lastSeenEnquiryAt
      const sendable = isSendableEnquiry(enquiry)
      const status = enquiryStatusKey(enquiry)
      const statusText = enquiryStatusText(enquiry)
      const sender = enquiry.createdByDisplayName || enquiry.created_by_display_name || enquiry.createdByUsername || "Unknown"
      const body = enquiryBodyText(enquiry)
      return `
        <div class="fcuno-wa-spc-enquiry${isNew ? " is-new" : ""} is-${escapeHtml(status)}" ${sendable ? `draggable="true"` : ""} data-action="seen-enquiry" data-id="${escapeHtml(enquiry.id)}">
          ${sendable ? `<input type="checkbox" data-action="toggle-enquiry" data-id="${escapeHtml(enquiry.id)}" ${state.selectedEnquiries[enquiry.id] ? "checked" : ""} />` : `<span class="fcuno-wa-spc-status is-${escapeHtml(status)}">${escapeHtml(statusText)}</span>`}
          <span>
            <em>${escapeHtml(body || enquiry.title || "ENQUIRY")}</em>
            <small>${escapeHtml(sender)} · ${escapeHtml(formatTime(createdAt))}</small>
          </span>
          <button class="fcuno-wa-spc-enquiry-remove" type="button" data-action="hide-enquiry" data-id="${escapeHtml(enquiry.id)}" title="Remove">×</button>
        </div>
      `
    }).join("")

    return `
      <section class="fcuno-wa-spc-enquiry-panel">
        <div class="fcuno-wa-spc-enquiry-actions">
          <button type="button" data-action="clear-enquiries">Clear All</button>
          <button type="button" class="is-primary" data-action="send-selected">Send${count ? ` · ${count} new` : ""}</button>
        </div>
        ${renderTemplate()}
        <div class="fcuno-wa-spc-enquiry-list">
          ${state.enquiryError ? `<div class="fcuno-wa-spc-error">${escapeHtml(state.enquiryError)}</div>` : ""}
          ${rows || `<div class="fcuno-wa-spc-empty">No enquiries loaded.</div>`}
        </div>
      </section>
    `
  }

  function render() {
    let host = document.getElementById(BOARD_ID)
    if (!host) {
      host = document.createElement("aside")
      host.id = BOARD_ID
      document.body.appendChild(host)
    }

    host.innerHTML = `
      <div class="fcuno-wa-spc-shell${state.collapsed ? " is-collapsed" : ""}">
        <div class="fcuno-wa-spc-head">
          <img class="fcuno-wa-spc-logo" src="${escapeHtml(LOGO_SRC)}" alt="Singapore Purchasing Center" />
          <button class="fcuno-wa-spc-icon" type="button" data-action="toggle">${state.collapsed ? "‹" : "›"}</button>
        </div>
        <div class="fcuno-wa-spc-main">
          <div class="fcuno-wa-spc-contacts">
            <div class="fcuno-wa-spc-quick">
              <button type="button" data-action="add-current" data-list="supplier">Add as Supplier</button>
              <button type="button" class="is-buyer" data-action="add-current" data-list="buyer">Add as Buyer</button>
            </div>
            <div class="fcuno-wa-spc-lists">
              ${renderContactList("supplier")}
              ${renderContactList("buyer")}
            </div>
          </div>
          ${renderEnquiries()}
        </div>
      </div>
    `

    document.body.classList.toggle("fcuno-wa-spc-collapsed", state.collapsed)
    document.body.classList.toggle("fcuno-wa-spc-active", !state.collapsed)
    bindEvents(host)
  }

  function clearDropMarkers(root = document) {
    root.querySelectorAll(".fcuno-wa-spc-row.is-drop-before, .fcuno-wa-spc-row.is-drop-after, .fcuno-wa-spc-row.is-send-target").forEach((row) => {
      row.classList.remove("is-drop-before", "is-drop-after", "is-send-target")
      delete row.dataset.dropPosition
    })
  }

  function clearDragState(root = document) {
    state.dragging = null
    state.draggingType = ""
    clearDropMarkers(root)
  }

  function dragHasType(event, type) {
    return Array.from(event.dataTransfer?.types || []).includes(type)
  }

  function prepareDragData(event, effectAllowed) {
    if (!event.dataTransfer) return
    event.dataTransfer.clearData()
    event.dataTransfer.effectAllowed = effectAllowed
  }

  function setContactDragData(event, id) {
    if (!event.dataTransfer || !id) return
    event.dataTransfer.setData("application/x-fcuno-spc-contact-id", id)
    event.dataTransfer.setData("text/plain", id)
  }

  function setEnquiryDragData(event, id) {
    if (!event.dataTransfer || !id) return
    event.dataTransfer.setData("application/x-fcuno-spc-enquiry-id", id)
  }

  function contactDragId(event) {
    if (!event.dataTransfer) return state.dragging || ""
    return (
      event.dataTransfer.getData("application/x-fcuno-spc-contact-id") ||
      event.dataTransfer.getData("text/plain") ||
      state.dragging ||
      ""
    )
  }

  function isBoardEventTarget(target) {
    return Boolean(target && typeof target.closest === "function" && target.closest(`#${BOARD_ID}`))
  }

  function blockExternalEnquiryDrop(event) {
    if (state.draggingType !== "enquiry") return
    if (isBoardEventTarget(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation()
    if (event.type === "drop") clearDragState()
  }

  function setRowDragImage(event, row) {
    if (event.dataTransfer && typeof event.dataTransfer.setDragImage === "function") {
      event.dataTransfer.setDragImage(row, 16, 16)
    }
  }

  function setDropMarker(event, row, root) {
    const rect = row.getBoundingClientRect()
    const position = event.clientY > rect.top + rect.height / 2 ? "after" : "before"
    clearDropMarkers(root)
    row.dataset.dropPosition = position
    row.classList.add(position === "after" ? "is-drop-after" : "is-drop-before")
  }

  function bindEvents(host) {
    host.querySelectorAll("[data-action='toggle']").forEach((button) => {
      button.addEventListener("click", () => {
        state.collapsed = !state.collapsed
        saveState()
        render()
      })
    })

    host.querySelectorAll("[data-action='add-current']").forEach((button) => {
      button.addEventListener("click", () => addContact(button.dataset.list === "buyer" ? "buyer" : "supplier"))
    })

    host.querySelectorAll("[data-action='open-contact']").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation()
        state.contactMenuId = ""
        const contact = state.contacts.find((item) => item.id === button.dataset.id)
        if (contact) void openContact(contact)
      })
    })

    host.querySelectorAll("[data-action='contact-menu']").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation()
        const id = button.dataset.id || ""
        state.contactMenuId = state.contactMenuId === id ? "" : id
        render()
      })
      button.addEventListener("dragstart", (event) => {
        const row = button.closest(".fcuno-wa-spc-row")
        if (!row) return
        state.dragging = button.dataset.id || ""
        state.draggingType = "contact"
        prepareDragData(event, "move")
        setContactDragData(event, state.dragging)
        setRowDragImage(event, row)
      })
      button.addEventListener("dragend", () => clearDragState(host))
    })

    host.querySelectorAll("[data-action='remove-contact']").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation()
        confirmRemoveContact(button.dataset.id || "")
      })
    })

    host.querySelectorAll(".fcuno-wa-spc-row").forEach((row) => {
      row.addEventListener("click", (event) => {
        if (event.target instanceof Element && event.target.closest(".fcuno-wa-spc-row-actions")) return
        state.contactMenuId = ""
        const contact = state.contacts.find((item) => item.id === row.dataset.id)
        if (contact) void openContact(contact)
      })
      row.addEventListener("dragstart", (event) => {
        state.dragging = row.dataset.id || ""
        state.draggingType = "contact"
        prepareDragData(event, "move")
        setContactDragData(event, state.dragging)
        setRowDragImage(event, row)
      })
      row.addEventListener("drop", (event) => {
        event.preventDefault()
        event.stopPropagation()
        const position = row.dataset.dropPosition || "before"
        clearDropMarkers(host)
        const enquiryId = event.dataTransfer.getData("application/x-fcuno-spc-enquiry-id")
        if (enquiryId) {
          const contact = state.contacts.find((item) => item.id === row.dataset.id)
          const text = enquiryTextForDrag(enquiryId)
          if (contact && text) sendTextToContact(contact, text)
          return
        }
        const id = contactDragId(event)
        moveContact(id, row.dataset.list || "supplier", row.dataset.id || "", position)
      })
      row.addEventListener("dragover", (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (dragHasType(event, "application/x-fcuno-spc-enquiry-id") || state.draggingType === "enquiry") {
          event.dataTransfer.dropEffect = "copy"
          clearDropMarkers(host)
          row.classList.add("is-send-target")
          return
        }
        event.dataTransfer.dropEffect = "move"
        setDropMarker(event, row, host)
      })
      row.addEventListener("dragleave", (event) => {
        if (!row.contains(event.relatedTarget)) clearDropMarkers(host)
      })
      row.addEventListener("dragend", () => clearDragState(host))
    })

    host.querySelectorAll(".fcuno-wa-spc-contact-list").forEach((list) => {
      list.addEventListener("dragover", (event) => event.preventDefault())
      list.addEventListener("drop", (event) => {
        event.preventDefault()
        event.stopPropagation()
        clearDropMarkers(host)
        const enquiryId = event.dataTransfer.getData("application/x-fcuno-spc-enquiry-id")
        if (enquiryId) return
        const id = contactDragId(event)
        moveContact(id, list.dataset.list || "supplier", "")
      })
    })

    host.querySelectorAll("[data-action='toggle-template']").forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        state.templateEnabled = checkbox.checked
        saveState()
        render()
      })
    })
    host.querySelectorAll("[data-action='edit-template']").forEach((button) => {
      button.addEventListener("click", () => {
        if (state.templateEditing) {
          state.templateText = cleanTemplateText(state.templateText) || DEFAULT_TEMPLATE_TEXT
          saveTemplateState()
        }
        state.templateEditing = !state.templateEditing
        render()
      })
    })
    host.querySelectorAll("[data-action='template-text']").forEach((textarea) => {
      textarea.addEventListener("input", () => {
        state.templateText = String(textarea.value || "").replace(/\r\n?/g, "\n")
        scheduleTemplateSave()
      })
      textarea.addEventListener("blur", () => {
        state.templateText = cleanTemplateText(textarea.value) || DEFAULT_TEMPLATE_TEXT
        saveTemplateState()
      })
    })

    host.querySelectorAll("[data-action='clear-enquiries']").forEach((button) => {
      button.addEventListener("click", clearVisibleEnquiries)
    })
    host.querySelectorAll("[data-action='send-selected']").forEach((button) => {
      button.addEventListener("click", sendSelectedToChat)
    })
    host.querySelectorAll("[data-action='hide-enquiry']").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation()
        hideEnquiry(button.dataset.id || "")
      })
    })
    host.querySelectorAll("[data-action='seen-enquiry']").forEach((row) => {
      row.addEventListener("click", () => {
        const enquiry = state.enquiries.find((item) => item.id === row.dataset.id)
        if (enquiry) markEnquirySeen(enquiry)
      })
    })
    host.querySelectorAll("[data-action='toggle-enquiry']").forEach((checkbox) => {
      checkbox.addEventListener("click", (event) => event.stopPropagation())
      checkbox.addEventListener("change", () => {
        state.selectedEnquiries[checkbox.dataset.id || ""] = checkbox.checked
        const enquiry = state.enquiries.find((item) => item.id === checkbox.dataset.id)
        if (enquiry) markEnquirySeen(enquiry)
      })
    })
    host.querySelectorAll(".fcuno-wa-spc-enquiry[draggable='true']").forEach((row) => {
      row.addEventListener("dragstart", (event) => {
        const id = row.dataset.id || ""
        const text = enquiryTextForDrag(id)
        if (!text) {
          event.preventDefault()
          return
        }
        state.dragging = id
        state.draggingType = "enquiry"
        prepareDragData(event, "copy")
        setEnquiryDragData(event, id)
        setRowDragImage(event, row)
      })
      row.addEventListener("dragend", () => clearDragState(host))
    })
  }

  if (typeof window !== "undefined" && window.__FCUNO_WA_SPC_ENABLE_TEST_API__) {
    window.__FCUNO_WA_SPC_TEST_API__ = {
      state,
      canUseDirectUrl,
      cleanText,
      composerText,
      contactNameIsPhone,
      contactsFor,
      contactDragId,
      contactSearchText,
      currentChatMatchesContact,
      findSendButton,
      getCurrentChat,
      insertComposerText,
      moveContact,
      phoneDigits,
      selectedEnquiryText,
      acquireSendLock,
      sendTextToContact,
      textMatchesContact,
      withTemplate,
    }
  }

  async function start() {
    document.getElementById(BOARD_ID)?.remove()
    await loadState()
    saveState()
    render()
    loadEnquiries()
    refreshUnreadIndicators()
    window.setTimeout(trySendPending, 650)
    unreadTimer = window.setInterval(refreshUnreadIndicators, 1800)
    enquiryTimer = window.setInterval(loadEnquiries, 2000)
  }

  window.addEventListener("beforeunload", () => {
    if (unreadTimer) window.clearInterval(unreadTimer)
    if (enquiryTimer) window.clearInterval(enquiryTimer)
    if (templateSaveTimer) window.clearTimeout(templateSaveTimer)
  })

  document.addEventListener("dragover", blockExternalEnquiryDrop, true)
  document.addEventListener("drop", blockExternalEnquiryDrop, true)

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true })
  } else {
    start()
  }
})()
