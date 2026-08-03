(function () {
  const STORAGE_KEY = "fcuno-wa-spc-board-v1"
  const BOARD_ID = "fcuno-wa-spc-board"
  const BOARD_OWNER_ATTRIBUTE = "data-fcuno-whatsapp-board-owner"
  const BOARD_OWNER = "spc"
  const SHARED_FEED_POLICY_VERSION = 1
  const SHARED_FEED_STARTED_AT = "2026-07-23T09:20:00.000Z"
  const LISTS = ["supplier", "buyer"]
  const LIST_LABELS = { supplier: "Supplier", buyer: "Buyer" }
  const DEFAULT_TEMPLATE_TEXT = "Good day, please quote for the following enquiries."
  const PENDING_SEND_TIMEOUT_MS = 30000
  const SEND_LOCK_KEY = "fcuno-wa-spc-send-lock-v1"
  const SEND_LOCK_TTL_MS = 30000
  const CRUDE_REFRESH_MS = 15000
  const CONTACT_MENU_AUTO_HIDE_MS = 1800
  const LOGO_SRC =
    typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL
      ? chrome.runtime.getURL("spc-sidebar-logo.png")
      : "https://spc.fcuno.com/spc-sidebar-logo.png"
  const ENQUIRY_CHAT_BUTTON_SRC =
    typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL
      ? chrome.runtime.getURL("spc-enquiry-chat-button.webp")
      : "https://spc.fcuno.com/spc-enquiry-chat-button.webp"

  const existingBoardOwner = document.documentElement?.getAttribute(BOARD_OWNER_ATTRIBUTE) || ""
  if (existingBoardOwner && existingBoardOwner !== BOARD_OWNER) {
    console.warn("SPC WhatsApp Board did not start because another WhatsApp board already owns this page.")
    return
  }
  document.documentElement?.setAttribute(BOARD_OWNER_ATTRIBUTE, BOARD_OWNER)

  const state = {
    collapsed: false,
    contacts: [],
    unreadById: {},
    enquiries: [],
    senderContacts: {},
    selectedEnquiries: {},
    hiddenEnquiryIds: {},
    templateEnabled: true,
    templateEditing: false,
    templateText: DEFAULT_TEMPLATE_TEXT,
    feedPolicyVersion: SHARED_FEED_POLICY_VERSION,
    feedStartedAt: SHARED_FEED_STARTED_AT,
    lastSeenEnquiryAt: SHARED_FEED_STARTED_AT,
    lastNotifiedEnquiryAt: SHARED_FEED_STARTED_AT,
    pendingSend: null,
    contactMenuId: "",
    loadingEnquiries: false,
    enquiryError: "",
    crude: null,
    crudeError: "",
    dragging: null,
    draggingType: "",
    draggingEnquiryIds: [],
  }

  let unreadTimer = 0
  let enquiryTimer = 0
  let crudeTimer = 0
  let templateSaveTimer = 0
  let contactMenuHideTimer = 0
  let lastEnquiryFingerprint = ""
  let lastCrudeFingerprint = ""
  let recentSend = { key: "", at: 0 }
  let memorySendLock = { key: "", at: 0 }
  let extensionContextStopped = false
  let renderPending = false

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

  function runtimeUnavailableMessage() {
    return "Reload WhatsApp Web after updating the SPC extension."
  }

  function isExtensionContextError(error) {
    return /extension context invalidated|context invalidated/i.test(String(error?.message || error || ""))
  }

  function stopExtensionContext() {
    if (extensionContextStopped) return
    extensionContextStopped = true
    if (unreadTimer) window.clearInterval(unreadTimer)
    if (enquiryTimer) window.clearInterval(enquiryTimer)
    if (crudeTimer) window.clearInterval(crudeTimer)
    if (templateSaveTimer) window.clearTimeout(templateSaveTimer)
    if (contactMenuHideTimer) window.clearTimeout(contactMenuHideTimer)
    unreadTimer = 0
    enquiryTimer = 0
    crudeTimer = 0
    templateSaveTimer = 0
    contactMenuHideTimer = 0
    window.removeEventListener("beforeunload", handleBeforeUnload)
    document.removeEventListener("DOMContentLoaded", launch)
    document.removeEventListener("visibilitychange", refreshVisibleBoard)
    document.removeEventListener("dragover", blockExternalEnquiryDrop, true)
    document.removeEventListener("drop", blockExternalEnquiryDrop, true)
    document.removeEventListener("click", handleDocumentClick)
    document.removeEventListener("keydown", handleDocumentKeydown)
    document.getElementById(BOARD_ID)?.remove()
    document.body?.classList.remove("fcuno-wa-spc-collapsed", "fcuno-wa-spc-active")
    if (document.documentElement?.getAttribute(BOARD_OWNER_ATTRIBUTE) === BOARD_OWNER) {
      document.documentElement.removeAttribute(BOARD_OWNER_ATTRIBUTE)
    }
  }

  function handleContentError(error) {
    if (isExtensionContextError(error)) {
      stopExtensionContext()
      return true
    }
    console.error(error)
    return true
  }

  function safeRun(callback) {
    if (extensionContextStopped) return undefined
    try {
      return callback()
    } catch (error) {
      handleContentError(error)
      return undefined
    }
  }

  function refreshVisibleBoard() {
    if (document.visibilityState === "hidden") return
    safeRun(loadEnquiries)
    safeRun(loadCrudeWatch)
    safeRun(refreshUnreadIndicators)
  }

  function runtimeLastErrorMessage() {
    try {
      return chrome.runtime.lastError?.message || ""
    } catch (error) {
      handleContentError(error)
      return runtimeUnavailableMessage()
    }
  }

  function canSendRuntimeMessage() {
    if (extensionContextStopped) return false
    try {
      return (
        typeof chrome !== "undefined" &&
        chrome.runtime &&
        Boolean(chrome.runtime.id) &&
        typeof chrome.runtime.sendMessage === "function"
      )
    } catch (error) {
      handleContentError(error)
      return false
    }
  }

  function sendRuntimeMessage(message, callback) {
    if (!canSendRuntimeMessage()) return false
    try {
      chrome.runtime.sendMessage(message, (response) => {
        callback?.(response, runtimeLastErrorMessage())
      })
      return true
    } catch (error) {
      handleContentError(error)
      return false
    }
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

  function formatPrice(value) {
    const number = Number(value)
    return Number.isFinite(number) ? number.toFixed(2) : "--.--"
  }

  function formatSigned(value) {
    const number = Number(value)
    if (!Number.isFinite(number)) return "--"
    const sign = number > 0 ? "+" : ""
    return `${sign}${number.toFixed(2)}`
  }

  function crudeSparklinePath(points, width = 170, height = 28) {
    const values = (Array.isArray(points) ? points : []).map(Number).filter(Number.isFinite)
    if (values.length < 2) return `M0 ${height / 2} L${width} ${height / 2}`
    const min = Math.min(...values)
    const max = Math.max(...values)
    const range = max - min || 1
    return values
      .map((value, index) => {
        const x = (index / (values.length - 1)) * width
        const y = height - ((value - min) / range) * (height - 4) - 2
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`
      })
      .join(" ")
  }

  function getStorage() {
    if (extensionContextStopped) return null
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return null
      return chrome.storage.local
    } catch (error) {
      handleContentError(error)
      return null
    }
  }

  function readStorage(keys) {
    const storage = getStorage()
    if (!storage) return Promise.resolve({})
    return new Promise((resolve) => {
      try {
        storage.get(keys, (items) => {
          const runtimeError = runtimeLastErrorMessage()
          if (runtimeError) {
            if (isExtensionContextError(runtimeError)) handleContentError(new Error(runtimeError))
            resolve({})
            return
          }
          resolve(items && typeof items === "object" ? items : {})
        })
      } catch (error) {
        handleContentError(error)
        resolve({})
      }
    })
  }

  function writeStorage(values) {
    const storage = getStorage()
    if (!storage || extensionContextStopped) return false
    try {
      storage.set(values, () => {
        const runtimeError = runtimeLastErrorMessage()
        if (runtimeError && isExtensionContextError(runtimeError)) {
          handleContentError(new Error(runtimeError))
        }
      })
      return true
    } catch (error) {
      handleContentError(error)
      return false
    }
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
      feedPolicyVersion: state.feedPolicyVersion,
      feedStartedAt: state.feedStartedAt,
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
    const usesSharedFeedPolicy = Number(source.feedPolicyVersion) === SHARED_FEED_POLICY_VERSION
    return {
      collapsed: Boolean(source.collapsed),
      feedPolicyVersion: SHARED_FEED_POLICY_VERSION,
      feedStartedAt: SHARED_FEED_STARTED_AT,
      lastSeenEnquiryAt: usesSharedFeedPolicy
        ? cleanText(source.lastSeenEnquiryAt) || SHARED_FEED_STARTED_AT
        : SHARED_FEED_STARTED_AT,
      lastNotifiedEnquiryAt: usesSharedFeedPolicy
        ? cleanText(source.lastNotifiedEnquiryAt) || SHARED_FEED_STARTED_AT
        : SHARED_FEED_STARTED_AT,
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
              const savedName = cleanText(contact.name)
              const chatName = cleanText(contact.chatName || contact.searchName || contact.whatsappName || contact.originalName || savedName)
              const phone = cleanText(contact.phone)
              return {
                id: String(contact.id || uid()),
                name: savedName || chatName || phone || "Unnamed chat",
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
    const items = await readStorage([STORAGE_KEY])
    const parsed = items[STORAGE_KEY] || {}
    const saved = sanitizeSavedState(parsed)
    state.collapsed = saved.collapsed
    state.contacts = saved.contacts
    state.hiddenEnquiryIds = saved.hiddenEnquiryIds
    state.templateEnabled = saved.templateEnabled
    state.templateText = saved.templateText
    state.feedPolicyVersion = saved.feedPolicyVersion
    state.feedStartedAt = saved.feedStartedAt
    state.lastSeenEnquiryAt = saved.lastSeenEnquiryAt
    state.lastNotifiedEnquiryAt = saved.lastNotifiedEnquiryAt
    state.pendingSend = saved.pendingSend
    normalizeOrders()
  }

  function saveState() {
    if (extensionContextStopped) return
    normalizeOrders()
    pruneEnquiryUiState()
    writeStorage({ [STORAGE_KEY]: statePayload() })
    if (extensionContextStopped) return
    document.body.classList.toggle("fcuno-wa-spc-collapsed", state.collapsed)
    document.body.classList.toggle("fcuno-wa-spc-active", !state.collapsed)
  }

  function saveTemplateState() {
    if (extensionContextStopped) return
    pruneEnquiryUiState()
    writeStorage({ [STORAGE_KEY]: statePayload() })
  }

  function scheduleTemplateSave() {
    if (extensionContextStopped) return
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

  function contactDisplayName(contact) {
    return cleanText(contact?.name) || contactChatName(contact) || cleanText(contact?.phone) || "Unnamed chat"
  }

  function contactSearchText(contact) {
    return contactChatName(contact) || cleanText(contact?.phone) || cleanText(contact?.name)
  }

  function contactSearchCandidates(contact) {
    const phone = phoneDigits(contact?.phone)
    const candidates = contact?.preferPhoneSearch
      ? [phone, contactSearchText(contact), contactDisplayName(contact)]
      : [contactSearchText(contact), phone, contactDisplayName(contact)]
    return Array.from(new Set(candidates.map(cleanText).filter(Boolean)))
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
    try {
      if (!element || element.closest(`#${BOARD_ID}`)) return false
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    } catch {
      return false
    }
  }

  function textCandidates(root) {
    if (!root || typeof root.querySelectorAll !== "function") return []
    const seen = new Set()
    let elements = []
    try {
      elements = Array.from(root.querySelectorAll("span[title], div[title], [dir='auto'], [aria-label]"))
    } catch {
      elements = ["span[title]", "div[title]", "[dir='auto']", "[aria-label]"].flatMap((selector) => {
        try {
          return Array.from(root.querySelectorAll(selector))
        } catch {
          return []
        }
      })
    }
    return elements
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
    try {
      const main = document.querySelector("#main") || document.querySelector("[role='main']")
      const header = main && main.querySelector("header")
      if (!main || !header) return null

      const candidates = textCandidates(header)
      const name = candidates.find((text) => phoneDigits(text).length < 7) || candidates[0] || ""
      const phone = phoneDigits(name).length >= 7 ? phoneDigits(name) : ""
      if (!name && !phone) return null
      return { name: cleanText(name || phone), company: "", phone, directUrl: getDirectUrl(phone) }
    } catch {
      return null
    }
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
      const previousChatName = contactChatName(duplicate)
      const hasAlias = previousChatName && cleanText(duplicate.name).toLowerCase() !== previousChatName.toLowerCase()
      if (!hasAlias) duplicate.name = keyName
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

  function renameContact(id) {
    const contact = state.contacts.find((item) => item.id === id)
    if (!contact) return
    const originalName = contactChatName(contact) || cleanText(contact.phone)
    const currentName = contactDisplayName(contact)
    const value = window.prompt("Display name", currentName)
    if (value === null) return
    contact.name = cleanText(value) || originalName || currentName
    contact.updatedAt = new Date().toISOString()
    state.contactMenuId = ""
    saveState()
    render()
  }

  function moveContact(id, targetList, targetId, position = "before") {
    const moving = state.contacts.find((contact) => contact.id === id)
    if (!moving || !LISTS.includes(targetList)) return
    if (moving.id === targetId) return
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

    for (const searchText of contactSearchCandidates(contact)) {
      setEditableText(searchBox, searchText)
      const immediateRow = findVisibleChatRow(contact)
      if (immediateRow) {
        activateChatRow(immediateRow)
        window.setTimeout(() => clearEditableText(searchBox), 80)
        return true
      }
      for (const delay of [120, 260, 480]) {
        await new Promise((resolve) => window.setTimeout(resolve, delay))
        const row = findVisibleChatRow(contact)
        if (row) {
          activateChatRow(row)
          window.setTimeout(() => clearEditableText(searchBox), 80)
          return true
        }
      }
    }

    clearEditableText(searchBox)
    return false
  }

  async function openContact(contact, { allowNavigation = true } = {}) {
    if (currentChatMatchesContact(contact)) return true
    const row = findVisibleChatRow(contact)
    if (row) {
      activateChatRow(row)
      return true
    }
    if (await searchAndOpenContact(contact)) return true

    const directUrl = allowNavigation && canUseDirectUrl(contact)
      ? getDirectUrl(contact.phone) || sanitizeDirectUrl(contact.directUrl)
      : ""
    if (directUrl) {
      window.location.assign(directUrl)
      return true
    }
    return false
  }

  function unreadCount(row) {
    try {
      const label = Array.from(row.querySelectorAll("[aria-label], [title]"))
        .map((element) => `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`)
        .map(cleanText)
        .find((text) => /unread|未讀|未读/i.test(text))
      const match = label && label.match(/\d+/)
      return match ? match[0] : label ? "•" : ""
    } catch (error) {
      handleContentError(error)
      return ""
    }
  }

  function refreshUnreadIndicators() {
    if (extensionContextStopped) return
    const next = {}
    state.contacts.forEach((contact) => {
      const row = findVisibleChatRow(contact)
      const unread = row ? unreadCount(row) : ""
      if (unread) next[contact.id] = unread
    })
    if (JSON.stringify(next) === JSON.stringify(state.unreadById)) return
    state.unreadById = next
    updateUnreadBadges()
  }

  function enquiriesFingerprint(enquiries) {
    return enquiries
      .map((enquiry) => {
        const id = cleanText(enquiry.id)
        const status = enquiryStatusKey(enquiry)
        const body = enquiryBodyText(enquiry)
        const createdAt = enquiryCreatedAt(enquiry)
        const updatedAt = cleanText(enquiry.updatedAt || enquiry.updated_at)
        return `${id}|${status}|${createdAt}|${updatedAt}|${body}`
      })
      .join("\n")
  }

  function loadEnquiries() {
    if (state.loadingEnquiries) return
    state.loadingEnquiries = true
    const previousError = state.enquiryError
    state.enquiryError = ""
    const sent = sendRuntimeMessage({ type: "load-spc-enquiries" }, (response, runtimeError) => {
      state.loadingEnquiries = false
      if (runtimeError || !response || !response.ok) {
        state.enquiryError = response?.message || runtimeError || "Open spc.fcuno.com and log in."
        if (state.enquiryError !== previousError) renderWhenIdle()
        return
      }
      const nextEnquiries = dedupeEnquiries(Array.isArray(response.enquiries) ? response.enquiries : [])
      const nextSenderContacts = sanitizeSenderContacts(response.senderContacts)
      const nextFingerprint = enquiriesFingerprint(nextEnquiries)
      const contactsChanged = JSON.stringify(nextSenderContacts) !== JSON.stringify(state.senderContacts)
      const changed = nextFingerprint !== lastEnquiryFingerprint || contactsChanged
      state.enquiries = nextEnquiries
      state.senderContacts = nextSenderContacts
      lastEnquiryFingerprint = nextFingerprint
      const initializedFeed = initializeFeedBaseline()
      pruneEnquiryUiState()
      if (!initializedFeed) notifyNewEnquiries()
      if (changed || previousError || initializedFeed) renderWhenIdle()
    })
    if (!sent) {
      state.loadingEnquiries = false
      state.enquiryError = runtimeUnavailableMessage()
      if (state.enquiryError !== previousError) renderWhenIdle()
    }
  }

  function loadCrudeWatch() {
    const sent = sendRuntimeMessage({ type: "load-crude-watch" }, (response, runtimeError) => {
      if (runtimeError || !response || !response.ok || !response.crude) {
        state.crudeError = response?.message || runtimeError || ""
        state.crude = null
        lastCrudeFingerprint = ""
        updateCrudeWatch()
        return
      }

      const crude = response.crude
      const fingerprint = JSON.stringify({
        price: crude.price,
        change: crude.change,
        changePercent: crude.changePercent,
        points: crude.points,
        contract: crude.contract,
        updatedAt: crude.updatedAt,
      })
      state.crude = crude
      state.crudeError = ""
      if (fingerprint !== lastCrudeFingerprint) {
        lastCrudeFingerprint = fingerprint
        updateCrudeWatch()
      }
    })

    if (!sent && !state.crude) {
      state.crudeError = runtimeUnavailableMessage()
      render()
    }
  }

  function visibleEnquiries() {
    return state.enquiries.filter((enquiry) => {
      if (state.hiddenEnquiryIds[enquiry.id]) return false
      if (!state.feedStartedAt) return true
      const createdAt = enquiryCreatedAt(enquiry)
      return Boolean(createdAt && createdAt > state.feedStartedAt)
    })
  }

  function initializeFeedBaseline() {
    if (state.feedStartedAt) return false
    state.feedPolicyVersion = SHARED_FEED_POLICY_VERSION
    state.feedStartedAt = SHARED_FEED_STARTED_AT
    state.lastSeenEnquiryAt = state.feedStartedAt
    state.lastNotifiedEnquiryAt = state.feedStartedAt
    state.selectedEnquiries = {}
    saveState()
    return true
  }

  function pruneEnquiryUiState() {
    const enquiryById = new Map(state.enquiries.map((enquiry) => [enquiry.id, enquiry]))
    Object.keys(state.selectedEnquiries).forEach((id) => {
      const enquiry = enquiryById.get(id)
      if (!enquiry || state.hiddenEnquiryIds[id] || !isSendableEnquiry(enquiry)) {
        delete state.selectedEnquiries[id]
      }
    })
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

  function enquirySenderUsername(enquiry) {
    return cleanText(enquiry?.createdByUsername || enquiry?.created_by_username).toLowerCase()
  }

  function sanitizeSenderContacts(value) {
    if (!value || typeof value !== "object") return {}
    return Object.fromEntries(Object.entries(value).flatMap(([key, contact]) => {
      if (!contact || typeof contact !== "object") return []
      const username = cleanText(contact.username || key).toLowerCase()
      const phone = phoneDigits(contact.phone)
      if (!username || phone.length < 8 || phone.length > 15) return []
      return [[username, {
        username,
        displayName: cleanText(contact.displayName || username),
        phone,
        phonebookContactId: cleanText(contact.phonebookContactId),
      }]]
    }))
  }

  function enquirySenderContact(enquiry) {
    const username = enquirySenderUsername(enquiry)
    const contact = state.senderContacts[username]
    if (!contact) return null
    return {
      id: `spc-sender:${username}`,
      name: contact.displayName || contact.phone,
      chatName: contact.displayName,
      phone: contact.phone,
      directUrl: "",
      preferPhoneSearch: true,
    }
  }

  async function openEnquirySenderChat(enquiry) {
    const contact = enquirySenderContact(enquiry)
    const replyText = enquiryReplyText(enquiry)
    if (!contact || !replyText) return false
    if (!(await openContact(contact, { allowNavigation: false }))) return false

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (currentChatMatchesContact(contact) && prepareComposerDraftText(replyText)) {
        window.setTimeout(() => {
          const composer = findComposer()
          if (currentChatMatchesContact(contact) && composerText(composer) === cleanText(replyText)) {
            focusComposerAtEnd(composer)
          }
        }, 180)
        return true
      }
      await new Promise((resolve) => window.setTimeout(resolve, 100))
    }
    return false
  }

  function recordEnquirySeen(enquiry) {
    const createdAt = enquiryCreatedAt(enquiry)
    if (!createdAt || createdAt <= state.lastSeenEnquiryAt) return false
    state.lastSeenEnquiryAt = createdAt
    return true
  }

  function toggleEnquirySelection(enquiry) {
    if (!enquiry) return
    if (isSendableEnquiry(enquiry)) {
      if (state.selectedEnquiries[enquiry.id]) delete state.selectedEnquiries[enquiry.id]
      else state.selectedEnquiries[enquiry.id] = true
    }
    recordEnquirySeen(enquiry)
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
      sendRuntimeMessage({ type: "notify-new-enquiries", count })
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

  function enquiryBodyHtml(enquiry) {
    const body = enquiryBodyText(enquiry)
    const separatorIndex = body.indexOf("/")
    if (separatorIndex <= 0) return escapeHtml(body)
    const vessel = body.slice(0, separatorIndex).trim()
    const details = body.slice(separatorIndex)
    if (!vessel) return escapeHtml(body)
    return `<strong class="fcuno-wa-spc-enquiry-vessel">${escapeHtml(vessel)}</strong> ${escapeHtml(details)}`
  }

  function enquiryVesselName(enquiry) {
    const explicitName = cleanText(enquiry?.vesselName || enquiry?.vessel_name)
    const bodyName = enquiryBodyText(enquiry).split("/")[0]
    const vessel = cleanText(explicitName || bodyName)
    return vessel.toLowerCase().replace(/(^|[\s/-])([a-z])/g, (_match, separator, letter) => {
      return `${separator}${letter.toUpperCase()}`
    })
  }

  function enquiryReplyText(enquiry) {
    const vessel = enquiryVesselName(enquiry)
    return vessel ? `Re: ${vessel}, ` : ""
  }

  function enquiryTextForDrag(id) {
    return enquiryTextForIds(activeDragEnquiryIds(id))
  }

  function selectedSendableEnquiryIds() {
    return visibleEnquiries()
      .filter((enquiry) => state.selectedEnquiries[enquiry.id] && isSendableEnquiry(enquiry))
      .map((enquiry) => enquiry.id)
  }

  function sendSelectionLabel() {
    const count = new Set(selectedSendableEnquiryIds()).size
    if (!count) return "Send"
    const enquiries = `${count} Enq${count === 1 ? "" : "s"}`
    return state.templateEnabled ? `Send Temp & ${enquiries}` : `Send ${enquiries}`
  }

  function activeDragEnquiryIds(draggedId) {
    const selectedIds = selectedSendableEnquiryIds()
    if (selectedIds.length >= 2) return selectedIds
    return draggedId ? [draggedId] : []
  }

  function enquiryTextForIds(ids) {
    const idSet = new Set((ids || []).map(cleanText).filter(Boolean))
    const seenBodies = new Set()
    const text = visibleEnquiries()
      .filter((enquiry) => idSet.has(enquiry.id) && isSendableEnquiry(enquiry))
      .map(enquiryBodyText)
      .filter((body) => {
        const key = body.toLowerCase()
        if (!key || seenBodies.has(key)) return false
        seenBodies.add(key)
        return true
      })
      .join("\n\n")
    return withTemplate(text)
  }

  function selectedEnquiryText() {
    return enquiryTextForIds(selectedSendableEnquiryIds())
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
    focusComposerAtEnd(composer)
    return composerText(composer) === cleanText(text)
  }

  function focusComposerAtEnd(composer) {
    if (!composer) return false
    composer.focus()
    const selection = window.getSelection()
    if (!selection) return true
    const range = document.createRange()
    range.selectNodeContents(composer)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  }

  function insertComposerText(text) {
    const composer = findComposer()
    if (!composer) return false
    return replaceComposerText(composer, text)
  }

  function prepareComposerDraftText(text) {
    const message = String(text || "")
    const comparableMessage = cleanText(message)
    const composer = findComposer()
    if (!composer || !comparableMessage) return false

    clearComposerText(composer)
    composer.focus()
    const sent = sendRuntimeMessage({ type: "spc-native-insert-text", text: message }, (response, runtimeError) => {
      const nextComposer = findComposer()
      const nativeReady = !runtimeError && response?.ok === true && nextComposer && composerText(nextComposer) === comparableMessage
      if (!nativeReady && !insertComposerText(message)) return
      focusComposerAtEnd(findComposer())
    })

    if (sent) return true
    if (!insertComposerText(message)) return false
    focusComposerAtEnd(findComposer())
    return true
  }

  function prepareComposerTextForSend(text, onReady) {
    const message = cleanTemplateText(text)
    const composer = findComposer()
    if (!composer || !message) return false

    clearComposerText(composer)
    composer.focus()
    const sent = sendRuntimeMessage({ type: "spc-native-insert-text", text: message }, (response, runtimeError) => {
      const nextComposer = findComposer()
      const nativeReady = !runtimeError && response?.ok === true && nextComposer && composerText(nextComposer) === cleanText(message)
      if (!nativeReady && !insertComposerText(message)) return
      window.setTimeout(() => onReady?.(message), nativeReady ? 80 : 120)
    })

    if (sent) return true
    if (!insertComposerText(message)) return false
    window.setTimeout(() => onReady?.(message), 120)
    return true
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

  function domClickSendButton(button, rect = null) {
    if (!button) return false
    button.focus?.()
    const buttonRect = rect || button.getBoundingClientRect()
    const clientX = buttonRect.left + buttonRect.width / 2
    const clientY = buttonRect.top + buttonRect.height / 2
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

  function requestNativeClick(button) {
    const rect = button.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    return sendRuntimeMessage({ type: "spc-native-click", x, y }, (response, runtimeError) => {
      const failed = runtimeError || !response || response.ok !== true
      if (failed) domClickSendButton(button, rect)
    })
  }

  function clickSendButton(button) {
    if (!button) return false
    if (requestNativeClick(button)) return true
    return domClickSendButton(button)
  }

  function requestNativeEnter(text = "", fallbackButton = null) {
    const composer = findComposer()
    composer?.focus()
    return sendRuntimeMessage({ type: "spc-native-enter" }, (response, runtimeError) => {
      const failed = runtimeError || !response || response.ok !== true
      window.setTimeout(() => {
        const nextComposer = findComposer()
        const stillStuck = Boolean(nextComposer && composerText(nextComposer))
        if ((failed || stillStuck) && fallbackButton) {
          clickSendButton(fallbackButton)
        } else if (failed && !fallbackButton) {
          pressComposerEnter()
        }
      }, failed ? 0 : 260)
    })
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
    if (requestNativeEnter(text, button)) return true
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
    if (contact && currentChatMatchesContact(contact) && prepareComposerTextForSend(pending.text, sendComposerWhenReady)) {
      clearPendingSend()
      return
    }

    pending.attempts += 1
    state.pendingSend = pending
    if (Date.now() - pending.startedAt > PENDING_SEND_TIMEOUT_MS || pending.attempts > 60) {
      clearPendingSend()
      return
    }
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

    if (currentChatMatchesContact(contact) && prepareComposerTextForSend(message, sendComposerWhenReady)) {
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

  function sendSelectedToContact(id) {
    const contact = state.contacts.find((item) => item.id === id)
    const text = selectedEnquiryText()
    state.contactMenuId = ""
    if (contact && text) sendTextToContact(contact, text)
    render()
  }

  function sendSelectedToChat() {
    const text = selectedEnquiryText()
    if (!text) return
    const chat = getCurrentChat()
    const scope = chat ? `chat:${chat.name || chat.phone}` : "chat:current"
    if (!acquireSendLock(scope, text)) return
    prepareComposerTextForSend(text, sendComposerWhenReady)
  }

  function cancelContactMenuAutoHide() {
    if (contactMenuHideTimer) window.clearTimeout(contactMenuHideTimer)
    contactMenuHideTimer = 0
  }

  function closeContactMenu(id = "") {
    cancelContactMenuAutoHide()
    if (!state.contactMenuId || (id && state.contactMenuId !== id)) return
    state.contactMenuId = ""
    render()
  }

  function scheduleContactMenuAutoHide(id) {
    cancelContactMenuAutoHide()
    if (!id || state.contactMenuId !== id) return
    contactMenuHideTimer = window.setTimeout(() => {
      contactMenuHideTimer = 0
      if (state.contactMenuId !== id) return
      state.contactMenuId = ""
      render()
    }, CONTACT_MENU_AUTO_HIDE_MS)
  }

  function renderContactList(list) {
    const hasSelectedEnquiries = selectedSendableEnquiryIds().length > 0
    const rows = contactsFor(list).map((contact) => {
      const details = [contact.company, contact.phone].filter(Boolean).join(" · ")
      const displayName = contactDisplayName(contact)
      const menuOpen = state.contactMenuId === contact.id
      return `
        <div class="fcuno-wa-spc-row" data-id="${escapeHtml(contact.id)}" data-list="${list}">
          <button class="fcuno-wa-spc-list-button" type="button" data-action="open-contact" data-id="${escapeHtml(contact.id)}">
            <strong>${escapeHtml(displayName)}</strong>
            ${details ? `<span>${escapeHtml(details)}</span>` : ""}
          </button>
          <div class="fcuno-wa-spc-row-actions">
            ${state.unreadById[contact.id] ? `<span class="fcuno-wa-spc-unread">${escapeHtml(state.unreadById[contact.id])}</span>` : ""}
            <button class="fcuno-wa-spc-contact-action" type="button" draggable="true" data-action="contact-menu" data-id="${escapeHtml(contact.id)}" title="Drag or manage">☰</button>
            ${menuOpen ? `
              <div class="fcuno-wa-spc-contact-menu" role="menu">
                <button type="button" data-action="rename-contact" data-id="${escapeHtml(contact.id)}">Rename</button>
                <button type="button" data-action="send-selected-contact" data-id="${escapeHtml(contact.id)}" ${hasSelectedEnquiries ? "" : "disabled"}>Send Selected</button>
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
    const rows = visibleEnquiries().map((enquiry) => {
      const createdAt = enquiryCreatedAt(enquiry)
      const isNew = !state.lastSeenEnquiryAt || createdAt > state.lastSeenEnquiryAt
      const sendable = isSendableEnquiry(enquiry)
      const status = enquiryStatusKey(enquiry)
      const statusText = enquiryStatusText(enquiry)
      const sender = enquiry.createdByDisplayName || enquiry.created_by_display_name || enquiry.createdByUsername || "Unknown"
      const body = enquiryBodyText(enquiry)
      const isDragging = state.draggingEnquiryIds.includes(enquiry.id)
      const isSelected = Boolean(state.selectedEnquiries[enquiry.id])
      const senderContact = enquirySenderContact(enquiry)
      return `
        <div class="fcuno-wa-spc-enquiry${isNew ? " is-new" : ""}${isDragging ? " is-dragging" : ""}${isSelected ? " is-selected" : ""} is-${escapeHtml(status)}" ${sendable ? `draggable="true"` : ""} data-action="select-enquiry" data-id="${escapeHtml(enquiry.id)}" aria-pressed="${isSelected ? "true" : "false"}">
          ${senderContact
            ? `<button class="fcuno-wa-spc-enquiry-chat" data-action="open-enquiry-chat" data-id="${escapeHtml(enquiry.id)}" type="button" draggable="false" title="Open WhatsApp chat with ${escapeHtml(sender)} and type ${escapeHtml(enquiryReplyText(enquiry))}" aria-label="Open WhatsApp chat with ${escapeHtml(sender)} and type ${escapeHtml(enquiryReplyText(enquiry))}"><img class="fcuno-wa-spc-enquiry-chat-image" src="${escapeHtml(ENQUIRY_CHAT_BUTTON_SRC)}" alt="" draggable="false" /></button>`
            : `<button class="fcuno-wa-spc-enquiry-chat is-unavailable" data-action="open-enquiry-chat" data-id="${escapeHtml(enquiry.id)}" type="button" disabled title="No unique phonebook mobile number for ${escapeHtml(sender)}" aria-label="No WhatsApp chat number for ${escapeHtml(sender)}"><img class="fcuno-wa-spc-enquiry-chat-image" src="${escapeHtml(ENQUIRY_CHAT_BUTTON_SRC)}" alt="" draggable="false" /></button>`}
          <span class="fcuno-wa-spc-enquiry-copy">
            <em>${body ? enquiryBodyHtml(enquiry) : escapeHtml(enquiry.title || "ENQUIRY")}</em>
            <small>${sendable ? "" : `<b class="fcuno-wa-spc-status is-${escapeHtml(status)}">${escapeHtml(statusText)}</b>`}<b class="fcuno-wa-spc-enquiry-sender">${escapeHtml(sender)}</b> · ${escapeHtml(formatTime(createdAt))}</small>
          </span>
          <button class="fcuno-wa-spc-enquiry-remove" type="button" data-action="hide-enquiry" data-id="${escapeHtml(enquiry.id)}" title="Remove">×</button>
        </div>
      `
    }).join("")

    return `
      <section class="fcuno-wa-spc-enquiry-panel">
        <div class="fcuno-wa-spc-enquiry-actions">
          <button type="button" data-action="clear-enquiries">Clear All</button>
          <button type="button" class="is-primary" data-action="send-selected">${escapeHtml(sendSelectionLabel())}</button>
        </div>
        ${renderTemplate()}
        <div class="fcuno-wa-spc-enquiry-list">
          ${state.enquiryError ? `<div class="fcuno-wa-spc-error">${escapeHtml(state.enquiryError)}</div>` : ""}
          ${rows || `<div class="fcuno-wa-spc-empty">No enquiries loaded.</div>`}
        </div>
      </section>
    `
  }

  function renderCrudeWatch() {
    const crude = state.crude || {}
    const change = Number(crude.change)
    const changeClass = Number.isFinite(change) && change > 0 ? "is-up" : change < 0 ? "is-down" : ""
    const updatedAt = new Date(String(crude.updatedAt || ""))
    const sourceLabel = [
      "ICE Brent crude futures",
      crude.contract,
      Number.isFinite(Number(crude.delayedMinutes))
        ? `delayed at least ${Number(crude.delayedMinutes)} minutes`
        : "",
      Number.isNaN(updatedAt.getTime()) ? "" : `quote ${updatedAt.toLocaleString()}`,
    ].filter(Boolean).join(" · ")
    const changeText =
      Number.isFinite(Number(crude.changePercent))
        ? `${formatSigned(crude.change)} ${formatSigned(crude.changePercent)}%`
        : state.crudeError
          ? "-- --"
          : "Loading"

    return `
      <div class="fcuno-wa-spc-crude" aria-label="${escapeHtml(sourceLabel || "Verified ICE Brent unavailable")}" title="${escapeHtml(sourceLabel || state.crudeError || "Verified ICE Brent unavailable")}">
        <svg viewBox="0 0 170 28" focusable="false" aria-hidden="true">
          <path d="${escapeHtml(crudeSparklinePath(crude.points))}" />
        </svg>
        <div>
          <strong>${escapeHtml(formatPrice(crude.price))}</strong>
          <span class="${escapeHtml(changeClass)}">${escapeHtml(changeText)}</span>
        </div>
      </div>
    `
  }

  function renderedElement(markup) {
    const template = document.createElement("template")
    template.innerHTML = String(markup || "").trim()
    return template.content.firstElementChild
  }

  function updateCrudeWatch() {
    const current = document.querySelector(`#${BOARD_ID} .fcuno-wa-spc-crude`)
    const next = renderedElement(renderCrudeWatch())
    if (!current || !next) {
      renderWhenIdle()
      return
    }
    current.replaceWith(next)
  }

  function updateUnreadBadges() {
    const host = document.getElementById(BOARD_ID)
    if (!host) {
      renderWhenIdle()
      return
    }
    host.querySelectorAll(".fcuno-wa-spc-row[data-id]").forEach((row) => {
      const actions = row.querySelector(".fcuno-wa-spc-row-actions")
      if (!actions) return
      const unread = state.unreadById[row.dataset.id || ""] || ""
      let badge = actions.querySelector(".fcuno-wa-spc-unread")
      if (!unread) {
        badge?.remove()
        return
      }
      if (!badge) {
        badge = document.createElement("span")
        badge.className = "fcuno-wa-spc-unread"
        actions.prepend(badge)
      }
      badge.textContent = unread
    })
  }

  function renderWhenIdle() {
    if (extensionContextStopped) return
    if (state.templateEditing || state.draggingType) {
      renderPending = true
      return
    }
    render()
  }

  function render() {
    if (extensionContextStopped) return
    renderPending = false
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
          ${renderCrudeWatch()}
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
    const shouldRender = renderPending
    state.dragging = null
    state.draggingType = ""
    state.draggingEnquiryIds = []
    clearDropMarkers(root)
    clearEnquiryDragMarkers(root)
    if (shouldRender) window.setTimeout(renderWhenIdle, 0)
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

  function setEnquiryDragData(event, ids) {
    if (!event.dataTransfer) return
    const enquiryIds = (Array.isArray(ids) ? ids : [ids]).map(cleanText).filter(Boolean)
    if (!enquiryIds.length) return
    event.dataTransfer.setData("application/x-fcuno-spc-enquiry-id", enquiryIds[0])
    event.dataTransfer.setData("application/x-fcuno-spc-enquiry-ids", JSON.stringify(enquiryIds))
    event.dataTransfer.setData("text/plain", enquiryTextForIds(enquiryIds))
  }

  function enquiryDragIds(event) {
    if (!event.dataTransfer) return state.draggingType === "enquiry" ? state.draggingEnquiryIds || [] : []
    const rawIds = event.dataTransfer.getData("application/x-fcuno-spc-enquiry-ids")
    if (rawIds) {
      try {
        const ids = JSON.parse(rawIds)
        if (Array.isArray(ids)) return ids.map(cleanText).filter(Boolean)
      } catch {
      }
    }
    const id =
      event.dataTransfer.getData("application/x-fcuno-spc-enquiry-id") ||
      (state.draggingType === "enquiry" ? state.dragging : "")
    return id ? [id] : []
  }

  function contactDragId(event) {
    if (!event.dataTransfer) return state.draggingType === "contact" ? state.dragging || "" : ""
    return (
      event.dataTransfer.getData("application/x-fcuno-spc-contact-id") ||
      (state.draggingType === "contact" ? event.dataTransfer.getData("text/plain") : "") ||
      (state.draggingType === "contact" ? state.dragging : "") ||
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

  function clearEnquiryDragMarkers(root = document) {
    root.querySelectorAll(".fcuno-wa-spc-enquiry.is-dragging").forEach((row) => {
      row.classList.remove("is-dragging")
    })
  }

  function markDraggingEnquiries(root, ids) {
    clearEnquiryDragMarkers(root)
    const idSet = new Set((ids || []).map(cleanText).filter(Boolean))
    root.querySelectorAll(".fcuno-wa-spc-enquiry[data-id]").forEach((row) => {
      if (idSet.has(row.dataset.id || "")) row.classList.add("is-dragging")
    })
  }

  function setEnquiryDragImage(event, row, ids) {
    if (!event.dataTransfer || typeof event.dataTransfer.setDragImage !== "function") return
    if (!ids || ids.length <= 1) {
      setRowDragImage(event, row)
      return
    }
    const preview = document.createElement("div")
    preview.className = "fcuno-wa-spc-drag-preview"
    const idSet = new Set(ids.map(cleanText).filter(Boolean))
    visibleEnquiries()
      .filter((enquiry) => idSet.has(enquiry.id))
      .slice(0, 3)
      .forEach((enquiry) => {
        const line = document.createElement("span")
        line.textContent = enquiryBodyText(enquiry)
        preview.appendChild(line)
      })
    if (ids.length > 3) {
      const line = document.createElement("span")
      line.textContent = `+${ids.length - 3} more`
      preview.appendChild(line)
    }
    document.body.appendChild(preview)
    event.dataTransfer.setDragImage(preview, 12, 12)
    window.setTimeout(() => preview.remove(), 0)
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
        cancelContactMenuAutoHide()
        state.contactMenuId = ""
        const contact = state.contacts.find((item) => item.id === button.dataset.id)
        if (contact) void openContact(contact)
      })
    })

    host.querySelectorAll("[data-action='contact-menu']").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation()
        const id = button.dataset.id || ""
        cancelContactMenuAutoHide()
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
        cancelContactMenuAutoHide()
        confirmRemoveContact(button.dataset.id || "")
      })
    })

    host.querySelectorAll("[data-action='rename-contact']").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation()
        cancelContactMenuAutoHide()
        renameContact(button.dataset.id || "")
      })
    })

    host.querySelectorAll("[data-action='send-selected-contact']").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation()
        if (button.disabled) return
        cancelContactMenuAutoHide()
        sendSelectedToContact(button.dataset.id || "")
      })
    })

    host.querySelectorAll(".fcuno-wa-spc-row-actions").forEach((zone) => {
      const row = zone.closest(".fcuno-wa-spc-row")
      const id = row?.dataset.id || ""
      zone.addEventListener("mouseenter", cancelContactMenuAutoHide)
      zone.addEventListener("mouseleave", () => scheduleContactMenuAutoHide(id))
      zone.addEventListener("focusin", cancelContactMenuAutoHide)
      zone.addEventListener("focusout", (event) => {
        if (event.relatedTarget instanceof Element && zone.contains(event.relatedTarget)) return
        scheduleContactMenuAutoHide(id)
      })
    })

    host.querySelectorAll(".fcuno-wa-spc-row").forEach((row) => {
      row.addEventListener("click", (event) => {
        if (event.target instanceof Element && event.target.closest(".fcuno-wa-spc-row-actions")) return
        cancelContactMenuAutoHide()
        state.contactMenuId = ""
        const contact = state.contacts.find((item) => item.id === row.dataset.id)
        if (contact) void openContact(contact)
      })
      row.addEventListener("drop", (event) => {
        event.preventDefault()
        event.stopPropagation()
        const position = row.dataset.dropPosition || "before"
        clearDropMarkers(host)
        const enquiryIds = enquiryDragIds(event)
        if (enquiryIds.length) {
          const contact = state.contacts.find((item) => item.id === row.dataset.id)
          const text = enquiryTextForIds(enquiryIds)
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
        if (enquiryDragIds(event).length) return
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
    host.querySelectorAll("[data-action='select-enquiry']").forEach((row) => {
      row.addEventListener("click", () => {
        const enquiry = state.enquiries.find((item) => item.id === row.dataset.id)
        toggleEnquirySelection(enquiry)
      })
    })
    host.querySelectorAll("[data-action='open-enquiry-chat']").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        const enquiry = state.enquiries.find((item) => item.id === button.dataset.id)
        if (!enquiry) return
        if (recordEnquirySeen(enquiry)) saveState()
        void openEnquirySenderChat(enquiry)
      })
    })
    host.querySelectorAll(".fcuno-wa-spc-enquiry[draggable='true']").forEach((row) => {
      row.addEventListener("dragstart", (event) => {
        const id = row.dataset.id || ""
        const ids = activeDragEnquiryIds(id)
        const text = enquiryTextForIds(ids)
        if (!text) {
          event.preventDefault()
          return
        }
        state.dragging = id
        state.draggingType = "enquiry"
        state.draggingEnquiryIds = ids
        prepareDragData(event, "copy")
        setEnquiryDragData(event, ids)
        markDraggingEnquiries(host, ids)
        setEnquiryDragImage(event, row, ids)
      })
      row.addEventListener("dragend", () => clearDragState(host))
    })
  }

  if (typeof window !== "undefined" && window.__FCUNO_WA_SPC_ENABLE_TEST_API__) {
    window.__FCUNO_WA_SPC_TEST_API__ = {
      state,
      activeDragEnquiryIds,
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
      enquiryTextForIds,
      enquirySenderContact,
      enquiryReplyText,
      loadCrudeWatch,
      insertComposerText,
      loadEnquiries,
      moveContact,
      phoneDigits,
      prepareComposerDraftText,
      prepareComposerTextForSend,
      refreshUnreadIndicators,
      renameContact,
      render,
      sanitizeSavedState,
      sanitizeSenderContacts,
      sendSelectionLabel,
      visibleEnquiries,
      selectedEnquiryText,
      selectedSendableEnquiryIds,
      acquireSendLock,
      sendSelectedToContact,
      sendTextToContact,
      textMatchesContact,
      toggleEnquirySelection,
      withTemplate,
    }
  }

  async function start() {
    document.getElementById(BOARD_ID)?.remove()
    await loadState()
    if (extensionContextStopped) return
    saveState()
    render()
    safeRun(loadEnquiries)
    safeRun(loadCrudeWatch)
    safeRun(refreshUnreadIndicators)
    window.setTimeout(() => safeRun(trySendPending), 650)
    unreadTimer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") safeRun(refreshUnreadIndicators)
    }, 1800)
    enquiryTimer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") safeRun(loadEnquiries)
    }, 2000)
    crudeTimer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") safeRun(loadCrudeWatch)
    }, CRUDE_REFRESH_MS)
  }

  function handleBeforeUnload() {
    stopExtensionContext()
  }

  function handleDocumentClick(event) {
    if (!state.contactMenuId) return
    if (event.target instanceof Element && event.target.closest(`#${BOARD_ID} .fcuno-wa-spc-row-actions`)) return
    closeContactMenu()
  }

  function handleDocumentKeydown(event) {
    if (event.key === "Escape") closeContactMenu()
  }

  function launch() {
    start().catch(handleContentError)
  }

  window.addEventListener("beforeunload", handleBeforeUnload)
  document.addEventListener("visibilitychange", refreshVisibleBoard)
  document.addEventListener("dragover", blockExternalEnquiryDrop, true)
  document.addEventListener("drop", blockExternalEnquiryDrop, true)
  document.addEventListener("click", handleDocumentClick)
  document.addEventListener("keydown", handleDocumentKeydown)

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", launch, { once: true })
  } else {
    launch()
  }
})()
