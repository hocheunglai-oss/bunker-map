(function () {
  const STORAGE_KEY = "fcuno-wa-speed-board-v1"
  const BOARD_ID = "fcuno-wa-board"
  const LISTS = ["supplier", "buyer"]
  const LIST_LABELS = {
    supplier: "Supplier",
    buyer: "Buyer",
  }

  const state = {
    collapsed: false,
    contacts: [],
    dragging: null,
    dropTargetId: "",
    status: "",
    unreadById: {},
  }

  let unreadTimer = 0

  function uid() {
    if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID()
    return `fcuno-${Date.now()}-${Math.random().toString(16).slice(2)}`
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

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")
      state.collapsed = Boolean(parsed.collapsed)
      state.contacts = Array.isArray(parsed.contacts)
        ? parsed.contacts
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
        : []
    } catch {
      state.collapsed = false
      state.contacts = []
    }
    normalizeOrders()
  }

  function saveState() {
    normalizeOrders()
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        collapsed: state.collapsed,
        contacts: state.contacts,
      }),
    )
    document.body.classList.toggle("fcuno-wa-board-collapsed", state.collapsed)
    document.body.classList.toggle("fcuno-wa-board-active", !state.collapsed)
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

  function getDirectUrl(phone) {
    const digits = phoneDigits(phone)
    return digits ? `https://web.whatsapp.com/send?phone=${digits}` : ""
  }

  function sanitizeDirectUrl(value) {
    try {
      const url = new URL(value, window.location.origin)
      if (url.hostname !== "web.whatsapp.com") return ""
      if (!url.pathname.startsWith("/send")) return ""
      const phone = phoneDigits(url.searchParams.get("phone") || "")
      return getDirectUrl(phone)
    } catch {
      return ""
    }
  }

  function setStatus(message) {
    state.status = message
    render()
    if (!message) return
    window.setTimeout(() => {
      if (state.status === message) {
        state.status = ""
        render()
      }
    }, 2200)
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms))
  }

  function isIgnoredHeaderText(value) {
    const text = cleanText(value).toLowerCase()
    if (!text || text.length < 2) return true
    return [
      "search",
      "menu",
      "more",
      "voice call",
      "video call",
      "last seen",
      "online",
      "typing",
      "click here for contact info",
      "tap here for contact info",
      "message",
      "messages",
      "encrypted",
      "end-to-end encrypted",
      "搜尋",
      "搜索",
    ].some((ignored) => text.includes(ignored))
  }

  function getTextCandidates(root) {
    const selectors = [
      "[data-testid='conversation-info-header-chat-title']",
      "span[title]",
      "div[title]",
      "[dir='auto'][title]",
      "[role='button'] [dir='auto']",
      "[dir='auto']",
      "[aria-label]",
    ]
    const seen = new Set()
    return selectors
      .flatMap((selector) => Array.from(root.querySelectorAll(selector)))
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
        if (seen.has(key) || isIgnoredHeaderText(text)) return false
        seen.add(key)
        return true
      })
  }

  function getCurrentChat() {
    const main =
      document.querySelector("#main") ||
      document.querySelector("[data-testid='conversation-panel-wrapper']") ||
      document.querySelector("[role='main']")
    const header = main && main.querySelector("header")

    if (!main || !header) return null

    const urlPhone = (() => {
      try {
        return phoneDigits(new URL(window.location.href).searchParams.get("phone") || "")
      } catch {
        return ""
      }
    })()
    const candidates = getTextCandidates(header)
    const phoneFromHeader = candidates.find((text) => phoneDigits(text).length >= 7) || ""
    const phone = urlPhone || phoneDigits(phoneFromHeader)
    const name = candidates.find((text) => phoneDigits(text).length < 7) || phoneFromHeader || phone

    if (!name && !phone) return null

    return {
      name: cleanText(name || phone),
      company: "",
      phone,
      directUrl: getDirectUrl(phone),
    }
  }

  function addContact(list, input = {}) {
    const name = cleanText(input.name)
    const phone = cleanText(input.phone)
    const company = cleanText(input.company)
    const directUrl = sanitizeDirectUrl(input.directUrl) || getDirectUrl(phone)

    if (!name && !phone) {
      setStatus("Add a name or phone first.")
      return
    }

    const lookupName = name || phone
    const duplicate = state.contacts.find((contact) => {
      if (contact.list !== list) return false
      if (phone && phoneDigits(contact.phone) && phoneDigits(contact.phone) === phoneDigits(phone)) return true
      return cleanText(contact.name).toLowerCase() === lookupName.toLowerCase()
    })

    if (duplicate) {
      duplicate.name = lookupName
      duplicate.company = company || duplicate.company
      duplicate.phone = phone || duplicate.phone
      duplicate.directUrl = directUrl || duplicate.directUrl
      duplicate.updatedAt = new Date().toISOString()
      saveState()
      setStatus(`Updated ${LIST_LABELS[list]}.`)
      return
    }

    state.contacts.push({
      id: uid(),
      name: lookupName,
      company,
      phone,
      directUrl,
      list,
      order: contactsFor(list).length * 1000 + 1000,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    saveState()
    setStatus(`Added to ${LIST_LABELS[list]}.`)
  }

  function addCurrentChat(list) {
    const chat = getCurrentChat()
    if (!chat) {
      setStatus("Open a WhatsApp chat first.")
      return
    }
    addContact(list, chat)
  }

  function removeContact(id) {
    state.contacts = state.contacts.filter((contact) => contact.id !== id)
    delete state.unreadById[id]
    saveState()
    setStatus("Removed.")
  }

  function moveContact(id, targetList, targetId) {
    const moving = state.contacts.find((contact) => contact.id === id)
    if (!moving) return

    const nextByList = {
      supplier: contactsFor("supplier").filter((contact) => contact.id !== id),
      buyer: contactsFor("buyer").filter((contact) => contact.id !== id),
    }

    moving.list = targetList
    moving.updatedAt = new Date().toISOString()
    const target = nextByList[targetList]
    const targetIndex = targetId ? Math.max(0, target.findIndex((contact) => contact.id === targetId)) : target.length
    target.splice(targetIndex === -1 ? target.length : targetIndex, 0, moving)

    state.contacts = [...nextByList.supplier, ...nextByList.buyer]
    saveState()
    render()
  }

  function isVisible(element) {
    if (!element || element.closest(`#${BOARD_ID}`)) return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  function getSidePane() {
    return (
      document.querySelector("#pane-side") ||
      document.querySelector("#side [role='grid']") ||
      document.querySelector("#side [aria-label='Chat list']") ||
      document.querySelector("#side [aria-label='Chats']")
    )
  }

  function textMatchesContact(contact, value) {
    const text = cleanText(value).toLowerCase()
    if (!text) return false
    const name = cleanText(contact.name).toLowerCase()
    const digits = phoneDigits(contact.phone)
    if (name && text.includes(name)) return true
    if (digits && phoneDigits(text).includes(digits)) return true
    return false
  }

  function findVisibleChatRow(contact) {
    const pane = getSidePane()
    if (!pane) return null

    const candidates = Array.from(
      pane.querySelectorAll("[role='listitem'], [role='row'], [role='button'], div[tabindex='0'], div[tabindex='-1']"),
    ).filter(isVisible)

    return candidates.find((element) => {
      const text = cleanText(
        element.getAttribute("title") ||
          element.getAttribute("aria-label") ||
          element.textContent,
      )
      return textMatchesContact(contact, text)
    })
  }

  function findSidebarSearchBox() {
    const side = document.querySelector("#side")
    if (!side) return null

    const candidates = Array.from(
      side.querySelectorAll("input[type='search'], input[type='text'], div[contenteditable='true'], [role='textbox']"),
    ).filter(isVisible)

    return candidates.find((element) => {
      const text = cleanText(
        element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          element.getAttribute("placeholder") ||
          element.getAttribute("data-testid") ||
          element.closest("[aria-label]")?.getAttribute("aria-label") ||
          "",
      ).toLowerCase()
      return text.includes("search") || text.includes("chat") || text.includes("搜尋") || text.includes("搜索")
    }) || candidates[0] || null
  }

  function setSearchText(element, text) {
    element.focus()

    if ("value" in element) {
      const prototype = Object.getPrototypeOf(element)
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value")
      if (descriptor && descriptor.set) {
        descriptor.set.call(element, text)
      } else {
        element.value = text
      }
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }))
      return
    }

    document.execCommand("selectAll", false)
    document.execCommand("insertText", false, text)
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }))
  }

  async function openContactBySidebarSearch(contact) {
    const query = cleanText(contact.name) || phoneDigits(contact.phone)
    if (!query) return false

    const searchBox = findSidebarSearchBox()
    if (!searchBox) return false

    setSearchText(searchBox, query)

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await wait(80)
      const row = findVisibleChatRow(contact)
      if (row) {
        row.click()
        setStatus(`Opened ${contact.name}.`)
        return true
      }
    }

    return false
  }

  async function openContact(contact) {
    const directUrl = getDirectUrl(contact.phone) || sanitizeDirectUrl(contact.directUrl)
    if (directUrl) {
      setStatus(`Opening ${contact.name}...`)
      window.location.assign(directUrl)
      return
    }

    const visibleRow = findVisibleChatRow(contact)
    if (visibleRow) {
      visibleRow.click()
      setStatus(`Opened ${contact.name}.`)
      return
    }

    if (!cleanText(contact.name)) {
      setStatus("Missing chat name or phone.")
      return
    }

    setStatus(`Searching ${contact.name}...`)
    if (await openContactBySidebarSearch(contact)) return
    setStatus("Chat not found in WhatsApp list.")
  }

  function getUnreadCountFromRow(row) {
    const labels = Array.from(row.querySelectorAll("[aria-label], [title]"))
      .map((element) => `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`)
      .map(cleanText)

    const unreadLabel = labels.find((label) => {
      const text = label.toLowerCase()
      return text.includes("unread") || text.includes("未讀") || text.includes("未读")
    })

    if (!unreadLabel) return ""
    const match = unreadLabel.match(/\d+/)
    return match ? match[0] : "•"
  }

  function refreshUnreadIndicators() {
    if (state.dragging) return

    const next = {}
    state.contacts.forEach((contact) => {
      const row = findVisibleChatRow(contact)
      if (!row) return
      const unread = getUnreadCountFromRow(row)
      if (unread) next[contact.id] = unread
    })

    const previous = JSON.stringify(state.unreadById)
    const current = JSON.stringify(next)
    if (previous === current) return

    state.unreadById = next
    render()
  }

  function renderList(list) {
    const contacts = contactsFor(list)
    const rows = contacts.map((contact) => {
      const details = [contact.company, contact.phone].filter(Boolean).join(" · ")
      return `
        <div class="fcuno-wa-row${state.dragging === contact.id ? " is-dragging" : ""}${state.dropTargetId === contact.id ? " is-drop-target" : ""}" draggable="true" data-id="${escapeHtml(contact.id)}" data-list="${list}">
          <button class="fcuno-wa-list-button" type="button" data-action="open" data-id="${escapeHtml(contact.id)}">
            <strong>${escapeHtml(contact.name)}</strong>
            <span>${escapeHtml(details || "Saved chat")}</span>
          </button>
          <div class="fcuno-wa-row-actions">
            ${state.unreadById[contact.id] ? `<span class="fcuno-wa-unread" title="${escapeHtml(state.unreadById[contact.id])} unread">${escapeHtml(state.unreadById[contact.id])}</span>` : ""}
            <button class="fcuno-wa-remove" type="button" data-action="remove" data-id="${escapeHtml(contact.id)}" title="Remove">×</button>
          </div>
        </div>
      `
    }).join("")

    return `
      <section class="fcuno-wa-panel" data-panel="${list}">
        <div class="fcuno-wa-list" data-list="${list}">
          ${rows || `<div class="fcuno-wa-empty">Add current WhatsApp chats here. No phonebook is loaded.</div>`}
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
      <div class="fcuno-wa-shell${state.collapsed ? " is-collapsed" : ""}">
        <div class="fcuno-wa-head">
          <img class="fcuno-wa-logo" src="https://fcuno.com/fc-uno-sidebar-logo.png" alt="FC UNO" />
          <button class="fcuno-wa-icon" type="button" data-action="toggle" title="${state.collapsed ? "Expand" : "Collapse"}">${state.collapsed ? "‹" : "›"}</button>
        </div>
        <div class="fcuno-wa-quick">
          <button class="fcuno-wa-button" type="button" data-action="add-current" data-list="supplier">Add as Supplier</button>
          <button class="fcuno-wa-button is-buyer" type="button" data-action="add-current" data-list="buyer">Add as Buyer</button>
        </div>
        <div class="fcuno-wa-status">${escapeHtml(state.status)}</div>
        <div class="fcuno-wa-body">
          <div class="fcuno-wa-lists">
            ${renderList("supplier")}
            ${renderList("buyer")}
          </div>
        </div>
      </div>
    `

    document.body.classList.toggle("fcuno-wa-board-collapsed", state.collapsed)
    document.body.classList.toggle("fcuno-wa-board-active", !state.collapsed)
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
      button.addEventListener("click", () => {
        addCurrentChat(button.dataset.list === "buyer" ? "buyer" : "supplier")
      })
    })

    host.querySelectorAll("[data-action='open']").forEach((button) => {
      button.addEventListener("click", () => {
        const contact = state.contacts.find((item) => item.id === button.dataset.id)
        if (contact) void openContact(contact)
      })
    })

    host.querySelectorAll("[data-action='remove']").forEach((button) => {
      button.addEventListener("click", () => removeContact(button.dataset.id || ""))
    })

    host.querySelectorAll(".fcuno-wa-row").forEach((row) => {
      row.addEventListener("dragstart", (event) => {
        state.dragging = row.dataset.id || ""
        event.dataTransfer.effectAllowed = "move"
        event.dataTransfer.setData("text/plain", state.dragging)
        render()
      })
      row.addEventListener("dragend", () => {
        state.dragging = null
        state.dropTargetId = ""
        render()
      })
      row.addEventListener("dragover", (event) => {
        event.preventDefault()
        host.querySelectorAll(".fcuno-wa-row.is-drop-target").forEach((target) => {
          if (target !== row) target.classList.remove("is-drop-target")
        })
        row.classList.add("is-drop-target")
      })
      row.addEventListener("dragleave", () => {
        row.classList.remove("is-drop-target")
      })
      row.addEventListener("drop", (event) => {
        event.preventDefault()
        const id = event.dataTransfer.getData("text/plain") || state.dragging
        moveContact(id, row.dataset.list || "supplier", row.dataset.id || "")
      })
    })

    host.querySelectorAll(".fcuno-wa-list").forEach((listElement) => {
      listElement.addEventListener("dragover", (event) => {
        event.preventDefault()
      })
      listElement.addEventListener("drop", (event) => {
        event.preventDefault()
        const id = event.dataTransfer.getData("text/plain") || state.dragging
        moveContact(id, listElement.dataset.list || "supplier", "")
      })
    })
  }

  function start() {
    if (document.getElementById(BOARD_ID)) return
    loadState()
    saveState()
    render()
    refreshUnreadIndicators()
    if (!unreadTimer) unreadTimer = window.setInterval(refreshUnreadIndicators, 1600)
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true })
  } else {
    start()
  }
})()
