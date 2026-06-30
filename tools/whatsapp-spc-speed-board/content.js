(function () {
  const STORAGE_KEY = "fcuno-wa-spc-board-v1"
  const BOARD_ID = "fcuno-wa-spc-board"
  const LISTS = ["supplier", "buyer"]
  const LIST_LABELS = { supplier: "Supplier", buyer: "Buyer" }
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
    lastSeenEnquiryAt: "",
    lastNotifiedEnquiryAt: "",
    loadingEnquiries: false,
    enquiryError: "",
    dragging: null,
  }

  let unreadTimer = 0
  let enquiryTimer = 0

  function uid() {
    if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID()
    return `fcuno-spc-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim()
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
      lastSeenEnquiryAt: state.lastSeenEnquiryAt,
      lastNotifiedEnquiryAt: state.lastNotifiedEnquiryAt,
    }
  }

  function sanitizeSavedState(value) {
    const source = value && typeof value === "object" ? value : {}
    return {
      collapsed: Boolean(source.collapsed),
      lastSeenEnquiryAt: cleanText(source.lastSeenEnquiryAt),
      lastNotifiedEnquiryAt: cleanText(source.lastNotifiedEnquiryAt),
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
            .map((contact, index) => ({
              id: String(contact.id || uid()),
              name: cleanText(contact.name) || "Unnamed chat",
              company: cleanText(contact.company),
              phone: cleanText(contact.phone),
              directUrl: cleanText(contact.directUrl),
              list: contact.list === "buyer" ? "buyer" : "supplier",
              order: Number.isFinite(Number(contact.order)) ? Number(contact.order) : index + 1,
              createdAt: contact.createdAt || new Date().toISOString(),
              updatedAt: contact.updatedAt || new Date().toISOString(),
            }))
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
    state.lastSeenEnquiryAt = saved.lastSeenEnquiryAt
    state.lastNotifiedEnquiryAt = saved.lastNotifiedEnquiryAt
    normalizeOrders()
  }

  function saveState() {
    normalizeOrders()
    const storage = getStorage()
    if (storage) storage.set({ [STORAGE_KEY]: statePayload() })
    document.body.classList.toggle("fcuno-wa-spc-collapsed", state.collapsed)
    document.body.classList.toggle("fcuno-wa-spc-active", !state.collapsed)
  }

  function getDirectUrl(phone) {
    const digits = phoneDigits(phone)
    return digits ? `https://web.whatsapp.com/send?phone=${digits}` : ""
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
        if (["search", "menu", "message", "typing", "online", "last seen"].some((item) => key.includes(item))) return false
        seen.add(key)
        return true
      })
  }

  function getCurrentChat() {
    const main = document.querySelector("#main") || document.querySelector("[role='main']")
    const header = main && main.querySelector("header")
    if (!main || !header) return null

    const candidates = textCandidates(header)
    const phoneText = candidates.find((text) => phoneDigits(text).length >= 7) || ""
    const phone = phoneDigits(phoneText)
    const name = candidates.find((text) => phoneDigits(text).length < 7) || phoneText || phone
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
      return cleanText(contact.name).toLowerCase() === keyName.toLowerCase()
    })

    if (duplicate) {
      duplicate.name = keyName
      duplicate.phone = chat.phone || duplicate.phone
      duplicate.directUrl = chat.directUrl || duplicate.directUrl
      duplicate.updatedAt = new Date().toISOString()
    } else {
      state.contacts.push({
        id: uid(),
        name: keyName,
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
    saveState()
    render()
  }

  function moveContact(id, targetList, targetId) {
    const moving = state.contacts.find((contact) => contact.id === id)
    if (!moving) return
    const next = {
      supplier: contactsFor("supplier").filter((contact) => contact.id !== id),
      buyer: contactsFor("buyer").filter((contact) => contact.id !== id),
    }
    moving.list = targetList
    moving.updatedAt = new Date().toISOString()
    const target = next[targetList]
    const index = targetId ? target.findIndex((contact) => contact.id === targetId) : target.length
    target.splice(index < 0 ? target.length : index, 0, moving)
    state.contacts = [...next.supplier, ...next.buyer]
    saveState()
    render()
  }

  function getSidePane() {
    return document.querySelector("#pane-side") || document.querySelector("#side")
  }

  function textMatchesContact(contact, value) {
    const text = cleanText(value).toLowerCase()
    if (!text) return false
    const name = cleanText(contact.name).toLowerCase()
    const digits = phoneDigits(contact.phone)
    return Boolean((name && text.includes(name)) || (digits && phoneDigits(text).includes(digits)))
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

  async function openContact(contact) {
    const directUrl = getDirectUrl(contact.phone) || sanitizeDirectUrl(contact.directUrl)
    if (directUrl) {
      window.location.assign(directUrl)
      return
    }
    const row = findVisibleChatRow(contact)
    if (row) activateChatRow(row)
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
      state.enquiries = Array.isArray(response.enquiries) ? response.enquiries : []
      Object.keys(state.selectedEnquiries).forEach((id) => {
        const enquiry = state.enquiries.find((item) => item.id === id)
        if (!enquiry || state.hiddenEnquiryIds[id] || !isSendableEnquiry(enquiry)) {
          delete state.selectedEnquiries[id]
        }
      })
      notifyNewEnquiries()
      render()
    })
  }

  function visibleEnquiries() {
    return state.enquiries.filter((enquiry) => !state.hiddenEnquiryIds[enquiry.id])
  }

  function isSendableEnquiry(enquiry) {
    return !enquiry.status || enquiry.status === "sent"
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

  function selectedEnquiryText() {
    return visibleEnquiries()
      .filter((enquiry) => state.selectedEnquiries[enquiry.id] && isSendableEnquiry(enquiry))
      .map((enquiry) => cleanText(enquiry.formattedText || enquiry.notes || enquiry.title))
      .filter(Boolean)
      .join("\n\n")
  }

  function findComposer() {
    const main = document.querySelector("#main") || document.querySelector("[role='main']")
    if (!main) return null
    const candidates = Array.from(
      main.querySelectorAll("div[contenteditable='true'][role='textbox'], div[contenteditable='true'], [role='textbox']"),
    ).filter(isVisible)
    return candidates[candidates.length - 1] || null
  }

  function insertComposerText(text) {
    const composer = findComposer()
    if (!composer) return false
    composer.focus()
    document.execCommand("selectAll", false)
    document.execCommand("insertText", false, text)
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }))
    return true
  }

  function clickSendButton() {
    const main = document.querySelector("#main") || document.querySelector("[role='main']")
    const button =
      main?.querySelector("button[aria-label='Send']") ||
      main?.querySelector("span[data-icon='send']")?.closest("button")
    if (button) {
      button.click()
      return true
    }
    const composer = findComposer()
    if (!composer) return false
    composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", code: "Enter" }))
    composer.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Enter", code: "Enter" }))
    return true
  }

  function sendSelectedToChat() {
    const text = selectedEnquiryText()
    if (!text) return
    if (!insertComposerText(text)) return
    window.setTimeout(() => clickSendButton(), 120)
  }

  function renderContactList(list) {
    const rows = contactsFor(list).map((contact) => {
      const details = [contact.company, contact.phone].filter(Boolean).join(" · ")
      return `
        <div class="fcuno-wa-spc-row" draggable="true" data-id="${escapeHtml(contact.id)}" data-list="${list}">
          <button class="fcuno-wa-spc-list-button" type="button" data-action="open-contact" data-id="${escapeHtml(contact.id)}">
            <strong>${escapeHtml(contact.name)}</strong>
            ${details ? `<span>${escapeHtml(details)}</span>` : ""}
          </button>
          <div class="fcuno-wa-spc-row-actions">
            ${state.unreadById[contact.id] ? `<span class="fcuno-wa-spc-unread">${escapeHtml(state.unreadById[contact.id])}</span>` : ""}
            <button class="fcuno-wa-spc-remove" type="button" data-action="remove-contact" data-id="${escapeHtml(contact.id)}" title="Remove">×</button>
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

  function renderEnquiries() {
    const count = newEnquiryCount()
    const rows = visibleEnquiries().map((enquiry) => {
      const createdAt = enquiryCreatedAt(enquiry)
      const isNew = !state.lastSeenEnquiryAt || createdAt > state.lastSeenEnquiryAt
      const sendable = isSendableEnquiry(enquiry)
      const status = enquiry.status || "sent"
      const statusText = status === "quoted" ? "STEM" : status === "cancelled" ? "LOST" : "SENT"
      const sender = enquiry.createdByDisplayName || enquiry.created_by_display_name || enquiry.createdByUsername || "Unknown"
      const heading = enquiry.vesselName || enquiry.vessel_name || enquiry.title || "ENQUIRY"
      return `
        <div class="fcuno-wa-spc-enquiry${isNew ? " is-new" : ""} is-${escapeHtml(status)}" data-action="seen-enquiry" data-id="${escapeHtml(enquiry.id)}">
          ${sendable ? `<input type="checkbox" data-action="toggle-enquiry" data-id="${escapeHtml(enquiry.id)}" ${state.selectedEnquiries[enquiry.id] ? "checked" : ""} />` : `<span class="fcuno-wa-spc-status is-${escapeHtml(status)}">${escapeHtml(statusText)}</span>`}
          <span>
            <strong>${escapeHtml(heading)}</strong>
            <em>${escapeHtml(enquiry.formattedText || enquiry.notes || enquiry.title || "")}</em>
            <small>${escapeHtml(sender)} · ${escapeHtml(formatTime(createdAt))}</small>
          </span>
          <button class="fcuno-wa-spc-enquiry-remove" type="button" data-action="hide-enquiry" data-id="${escapeHtml(enquiry.id)}" title="Remove">×</button>
        </div>
      `
    }).join("")

    return `
      <section class="fcuno-wa-spc-enquiry-panel">
        <div class="fcuno-wa-spc-enquiry-head">
          <strong>ENQUIRIES</strong>
          ${count ? `<span class="fcuno-wa-spc-new">${count} new</span>` : ""}
        </div>
        <div class="fcuno-wa-spc-enquiry-actions">
          <button type="button" data-action="clear-enquiries">Clear All</button>
          <button type="button" class="is-primary" data-action="send-selected">Send Selected</button>
        </div>
        ${state.enquiryError ? `<div class="fcuno-wa-spc-error">${escapeHtml(state.enquiryError)}</div>` : ""}
        <div class="fcuno-wa-spc-enquiry-list">
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
        const contact = state.contacts.find((item) => item.id === button.dataset.id)
        if (contact) void openContact(contact)
      })
    })

    host.querySelectorAll("[data-action='remove-contact']").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation()
        removeContact(button.dataset.id || "")
      })
    })

    host.querySelectorAll(".fcuno-wa-spc-row").forEach((row) => {
      row.addEventListener("click", (event) => {
        if (event.target.closest("[data-action='remove-contact']")) return
        const contact = state.contacts.find((item) => item.id === row.dataset.id)
        if (contact) void openContact(contact)
      })
      row.addEventListener("dragstart", (event) => {
        state.dragging = row.dataset.id || ""
        event.dataTransfer.effectAllowed = "move"
        event.dataTransfer.setData("text/plain", state.dragging)
      })
      row.addEventListener("drop", (event) => {
        event.preventDefault()
        const id = event.dataTransfer.getData("text/plain") || state.dragging
        moveContact(id, row.dataset.list || "supplier", row.dataset.id || "")
      })
      row.addEventListener("dragover", (event) => event.preventDefault())
    })

    host.querySelectorAll(".fcuno-wa-spc-contact-list").forEach((list) => {
      list.addEventListener("dragover", (event) => event.preventDefault())
      list.addEventListener("drop", (event) => {
        event.preventDefault()
        const id = event.dataTransfer.getData("text/plain") || state.dragging
        moveContact(id, list.dataset.list || "supplier", "")
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
      checkbox.addEventListener("change", () => {
        state.selectedEnquiries[checkbox.dataset.id || ""] = checkbox.checked
        const enquiry = state.enquiries.find((item) => item.id === checkbox.dataset.id)
        if (enquiry) markEnquirySeen(enquiry)
      })
    })
  }

  async function start() {
    if (document.getElementById(BOARD_ID)) return
    await loadState()
    saveState()
    render()
    loadEnquiries()
    refreshUnreadIndicators()
    unreadTimer = window.setInterval(refreshUnreadIndicators, 1800)
    enquiryTimer = window.setInterval(loadEnquiries, 2000)
  }

  window.addEventListener("beforeunload", () => {
    if (unreadTimer) window.clearInterval(unreadTimer)
    if (enquiryTimer) window.clearInterval(enquiryTimer)
  })

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true })
  } else {
    start()
  }
})()
