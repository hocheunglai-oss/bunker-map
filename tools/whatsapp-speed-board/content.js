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
  }

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

  function getCurrentChatTitle() {
    const header = document.querySelector("header")
    const candidates = [
      header && header.querySelector("[data-testid='conversation-info-header-chat-title']"),
      header && header.querySelector("span[title]"),
      header && header.querySelector("[dir='auto'][title]"),
      header && header.querySelector("[role='button'] span[dir='auto']"),
      header && header.querySelector("span[dir='auto']"),
    ].filter(Boolean)

    for (const candidate of candidates) {
      const title = cleanText(candidate.getAttribute("title") || candidate.textContent)
      if (
        title &&
        title.length > 1 &&
        title.toLowerCase() !== "search" &&
        title.toLowerCase() !== "menu"
      ) {
        return title
      }
    }

    return ""
  }

  function addContact(list, input = {}) {
    const name = cleanText(input.name)
    const phone = cleanText(input.phone)
    const company = cleanText(input.company)

    if (!name && !phone) {
      setStatus("Add a name or phone first.")
      return
    }

    const lookupName = name || phone
    const duplicate = state.contacts.find(
      (contact) =>
        contact.list === list &&
        cleanText(contact.name).toLowerCase() === lookupName.toLowerCase() &&
        phoneDigits(contact.phone) === phoneDigits(phone),
    )

    if (duplicate) {
      setStatus(`${lookupName} is already in ${LIST_LABELS[list]}.`)
      return
    }

    state.contacts.push({
      id: uid(),
      name: lookupName,
      company,
      phone,
      list,
      order: contactsFor(list).length * 1000 + 1000,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    saveState()
    setStatus(`Added to ${LIST_LABELS[list]}.`)
  }

  function addCurrentChat(list) {
    const name = getCurrentChatTitle()
    if (!name) {
      setStatus("Open a WhatsApp chat first.")
      return
    }
    addContact(list, { name })
  }

  function removeContact(id) {
    state.contacts = state.contacts.filter((contact) => contact.id !== id)
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

  function findSearchButton() {
    const labels = ["Search", "搜尋", "搜索"]
    const candidates = Array.from(
      document.querySelectorAll("button,[role='button'],span[data-icon='search']"),
    )
    return candidates.find((element) => {
      if (!isVisible(element)) return false
      const text = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""} ${element.textContent || ""}`
      return labels.some((label) => text.toLowerCase().includes(label.toLowerCase()))
    })
  }

  function findSearchBox() {
    const active = document.activeElement
    if (
      active &&
      active.getAttribute &&
      active.getAttribute("contenteditable") === "true" &&
      isVisible(active) &&
      !active.closest("footer")
    ) {
      return active
    }

    const boxes = Array.from(
      document.querySelectorAll("div[contenteditable='true'], [role='textbox']"),
    ).filter(isVisible)

    const searchBox = boxes.find((element) => {
      const text = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""} ${element.getAttribute("data-testid") || ""}`.toLowerCase()
      return text.includes("search") || text.includes("搜尋") || text.includes("搜索")
    })

    return searchBox || null
  }

  function setEditableText(element, text) {
    element.focus()
    document.execCommand("selectAll", false)
    document.execCommand("insertText", false, text)
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }))
  }

  function findChatResult(contact) {
    const name = cleanText(contact.name).toLowerCase()
    const digits = phoneDigits(contact.phone)
    const candidates = Array.from(document.querySelectorAll("span[title], [dir='auto'], [aria-label]"))
      .filter(isVisible)

    const match = candidates.find((element) => {
      const text = cleanText(
        element.getAttribute("title") ||
          element.getAttribute("aria-label") ||
          element.textContent,
      ).toLowerCase()
      if (!text) return false
      if (name && (text === name || text.includes(name))) return true
      if (digits && phoneDigits(text).includes(digits)) return true
      return false
    })

    if (!match) return null

    return (
      match.closest("[role='listitem']") ||
      match.closest("div[tabindex='0']") ||
      match.closest("div[tabindex='-1']") ||
      match.closest("div[role='button']") ||
      match
    )
  }

  async function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms))
  }

  async function openContact(contact) {
    const query = phoneDigits(contact.phone) || cleanText(contact.name)
    if (!query) {
      setStatus("Missing chat name or phone.")
      return
    }

    setStatus(`Opening ${contact.name}...`)

    const searchButton = findSearchButton()
    if (searchButton) searchButton.click()
    await wait(90)

    const searchBox = findSearchBox()
    if (searchBox) {
      setEditableText(searchBox, query)
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await wait(110)
        const result = findChatResult(contact)
        if (result) {
          result.click()
          setStatus(`Opened ${contact.name}.`)
          return
        }
      }
    }

    const digits = phoneDigits(contact.phone)
    if (digits) {
      window.location.href = `https://web.whatsapp.com/send?phone=${digits}`
      return
    }

    setStatus("Chat not found. Open it once, then save it again.")
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
            <button class="fcuno-wa-remove" type="button" data-action="move" data-id="${escapeHtml(contact.id)}" data-list="${list === "supplier" ? "buyer" : "supplier"}" title="Move to ${list === "supplier" ? "Buyer" : "Supplier"}">${list === "supplier" ? "B" : "S"}</button>
            <button class="fcuno-wa-remove" type="button" data-action="remove" data-id="${escapeHtml(contact.id)}" title="Remove">×</button>
          </div>
        </div>
      `
    }).join("")

    return `
      <section class="fcuno-wa-panel" data-panel="${list}">
        <div class="fcuno-wa-panel-head">
          <strong>${LIST_LABELS[list]}</strong>
          <span>${contacts.length}</span>
        </div>
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
          <div class="fcuno-wa-title">
            <strong>FCUNO WhatsApp</strong>
            <span>Speed Board</span>
          </div>
          <button class="fcuno-wa-icon" type="button" data-action="toggle" title="${state.collapsed ? "Expand" : "Collapse"}">${state.collapsed ? "‹" : "›"}</button>
        </div>
        <div class="fcuno-wa-quick">
          <button class="fcuno-wa-button" type="button" data-action="add-current" data-list="supplier">+ Current Supplier</button>
          <button class="fcuno-wa-button is-buyer" type="button" data-action="add-current" data-list="buyer">+ Current Buyer</button>
        </div>
        <div class="fcuno-wa-body">
          <form class="fcuno-wa-form">
            <input name="name" autocomplete="off" placeholder="Name or chat title" />
            <input name="company" autocomplete="off" placeholder="Company / note" />
            <input name="phone" autocomplete="off" placeholder="Phone optional, e.g. 85298472818" />
            <div class="fcuno-wa-form-actions">
              <button class="fcuno-wa-button" type="submit" data-list="supplier">Add Supplier</button>
              <button class="fcuno-wa-button is-buyer" type="submit" data-list="buyer">Add Buyer</button>
            </div>
            <div class="fcuno-wa-status">${escapeHtml(state.status)}</div>
          </form>
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

    const form = host.querySelector(".fcuno-wa-form")
    if (form) {
      form.addEventListener("submit", (event) => {
        event.preventDefault()
        const submitter = event.submitter
        const list = submitter && submitter.dataset.list === "buyer" ? "buyer" : "supplier"
        const data = new FormData(form)
        addContact(list, {
          name: data.get("name"),
          company: data.get("company"),
          phone: data.get("phone"),
        })
        form.reset()
      })
    }

    host.querySelectorAll("[data-action='open']").forEach((button) => {
      button.addEventListener("click", () => {
        const contact = state.contacts.find((item) => item.id === button.dataset.id)
        if (contact) void openContact(contact)
      })
    })

    host.querySelectorAll("[data-action='remove']").forEach((button) => {
      button.addEventListener("click", () => removeContact(button.dataset.id || ""))
    })

    host.querySelectorAll("[data-action='move']").forEach((button) => {
      button.addEventListener("click", () => moveContact(button.dataset.id || "", button.dataset.list || "supplier", ""))
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true })
  } else {
    start()
  }
})()
