import assert from "node:assert/strict"
import fs from "node:fs"
import vm from "node:vm"

class FakeElement {
  constructor({ text = "", attrs = {}, children = [], tag = "div", role = "" } = {}) {
    this._text = text
    this.attrs = attrs
    this.children = children
    this.tag = tag
    this.role = role
    this.dataset = {}
    this.id = attrs.id || ""
    this.parentElement = null
    this.clicked = 0
    this.listeners = {}
    this.classList = {
      add() {},
      remove() {},
      toggle() {},
    }
    this.children.forEach((child) => {
      child.parentElement = this
    })
  }

  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent).join(" ")
    return this._text
  }

  set textContent(value) {
    this._text = String(value || "")
  }

  get innerText() {
    return this.textContent
  }

  set innerText(value) {
    this._text = String(value || "")
  }

  getAttribute(name) {
    if (name === "role") return this.role
    return this.attrs[name] || null
  }

  setAttribute(name, value) {
    if (name === "role") this.role = String(value || "")
    this.attrs[name] = String(value || "")
  }

  querySelector(selector) {
    if (selector === "button[aria-label='Send']") {
      return this.querySelectorAll(selector)[0] || null
    }
    return this.querySelectorAll(selector)[0] || null
  }

  querySelectorAll(selector) {
    const selectors = selector.split(",").map((item) => item.trim()).filter(Boolean)
    const nodes = []
    const visit = (node) => {
      node.children.forEach((child) => {
        nodes.push(child)
        visit(child)
      })
    }
    visit(this)
    if (selectors.length > 1) {
      return nodes.filter((node) => selectors.some((part) => node.matches(part)))
    }
    if (selectors.length === 1 && !selector.includes("contenteditable") && !selector.includes("[role='textbox']")) {
      return nodes.filter((node) => node.matches(selectors[0]))
    }
    if (selector.includes("contenteditable") || selector.includes("[role='textbox']")) {
      return nodes.filter((child) => child.attrs.contenteditable === "true" || child.role === "textbox")
    }
    if (selector.includes("[title]") || selector.includes("[dir='auto']") || selector.includes("[aria-label")) {
      return nodes.filter((child) => child.attrs.title || child.attrs["aria-label"] || child.attrs.dir === "auto")
    }
    return []
  }

  closest(selector) {
    let current = this
    const selectors = selector.split(",").map((item) => item.trim()).filter(Boolean)
    while (current) {
      if (selector.startsWith("#") && current.id === selector.slice(1)) return current
      if (selectors.some((part) => current.matches(part))) return current
      current = current.parentElement
    }
    return null
  }

  matches(selector) {
    const value = String(selector || "").trim()
    if (!value) return false
    if (value === "header") return this.tag === "header"
    if (value === "button") return this.tag === "button"
    if (value === "span") return this.tag === "span"
    if (value === "div") return this.tag === "div"
    if (value === "[role='button']") return this.role === "button"
    if (value === "[role='textbox']") return this.role === "textbox"
    if (value === "[aria-label]") return Boolean(this.attrs["aria-label"])
    if (value === "[title]") return Boolean(this.attrs.title)
    if (value === "[data-testid]") return Boolean(this.attrs["data-testid"])
    if (value === "[data-icon]") return Boolean(this.attrs["data-icon"])
    if (value === "span[title]") return this.tag === "span" && Boolean(this.attrs.title)
    if (value === "div[title]") return this.tag === "div" && Boolean(this.attrs.title)
    if (value === "[dir='auto']") return this.attrs.dir === "auto"
    if (value === "[aria-label]") return Boolean(this.attrs["aria-label"])
    if (value === "span[data-icon]") return this.tag === "span" && Boolean(this.attrs["data-icon"])
    if (value === "div[data-testid]") return this.tag === "div" && Boolean(this.attrs["data-testid"])
    if (value === "button[data-testid]") return this.tag === "button" && Boolean(this.attrs["data-testid"])
    if (value === "button[aria-label='Send']") return this.tag === "button" && this.attrs["aria-label"] === "Send"
    if (value === "span[data-icon='send']") return this.tag === "span" && this.attrs["data-icon"] === "send"
    if (value === "[data-testid='send']") return this.attrs["data-testid"] === "send"
    if (value === "button[aria-label*='Send' i]") {
      return this.tag === "button" && String(this.attrs["aria-label"] || "").toLowerCase().includes("send")
    }
    if (value === "[role='button'][aria-label*='Send' i]") {
      return this.role === "button" && String(this.attrs["aria-label"] || "").toLowerCase().includes("send")
    }
    if (value === "button[title*='Send' i]") {
      return this.tag === "button" && String(this.attrs.title || "").toLowerCase().includes("send")
    }
    if (value === "[role='button'][title*='Send' i]") {
      return this.role === "button" && String(this.attrs.title || "").toLowerCase().includes("send")
    }
    if (value === "button[data-testid*='send' i]") {
      return this.tag === "button" && String(this.attrs["data-testid"] || "").toLowerCase().includes("send")
    }
    if (value === "[role='button'][data-testid*='send' i]") {
      return this.role === "button" && String(this.attrs["data-testid"] || "").toLowerCase().includes("send")
    }
    if (value === "span[data-icon*='send' i]") {
      return this.tag === "span" && String(this.attrs["data-icon"] || "").toLowerCase().includes("send")
    }
    return false
  }

  getBoundingClientRect() {
    return { width: 120, height: 24, top: 10, left: 10 }
  }

  focus() {
    activeElement = this
  }

  addEventListener(type, handler) {
    this.listeners[type] ||= []
    this.listeners[type].push(handler)
  }

  appendChild(child) {
    child.parentElement = this
    this.children.push(child)
    if (child.id) elementsById.set(child.id, child)
    return child
  }

  replaceChildren(...children) {
    this.children = children
    this._text = ""
    this.children.forEach((child) => {
      child.parentElement = this
    })
  }

  remove() {
    if (this.id) elementsById.delete(this.id)
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this)
    }
    this.parentElement = null
  }

  click() {
    this.clicked += 1
    ;(this.listeners.click || []).forEach((handler) => handler({ target: this }))
  }

  dispatchEvent(event) {
    ;(this.listeners[event?.type] || []).forEach((handler) => handler(event))
    return true
  }
}

let activeElement = null
let selected = false
let main = null
let deleteFails = false
const elementsById = new Map()
const sessionStore = new Map()

const document = {
  readyState: "loading",
  documentElement: new FakeElement({ tag: "html" }),
  body: new FakeElement(),
  addEventListener() {},
  getElementById() {
    return elementsById.get("fcuno-wa-spc-board") || null
  },
  createElement(tag = "div") {
    return new FakeElement({ tag })
  },
  createTextNode(text = "") {
    return new FakeElement({ text, tag: "#text" })
  },
  createRange() {
    return {
      selectNodeContents() {
        selected = true
      },
    }
  },
  execCommand(command, _show, value) {
    if (!activeElement) return false
    if (command === "selectAll") {
      selected = true
      return true
    }
    if (command === "delete") {
      if (deleteFails) return true
      activeElement.textContent = ""
      selected = false
      return true
    }
    if (command === "insertText") {
      activeElement.textContent = selected ? String(value || "") : `${activeElement.textContent}${value || ""}`
      selected = false
      return true
    }
    return false
  },
  querySelector(selector) {
    if (selector === "#main" || selector === "[role='main']") return main
    return null
  },
}

const window = {
  __FCUNO_WA_SPC_ENABLE_TEST_API__: true,
  promptResponse: null,
  addEventListener() {},
  clearTimeout,
  document,
  getSelection() {
    return null
  },
  location: {
    assign() {},
  },
  sessionStorage: {
    getItem(key) {
      return sessionStore.get(key) || null
    },
    setItem(key, value) {
      sessionStore.set(key, String(value))
    },
  },
  setTimeout,
  prompt() {
    return this.promptResponse
  },
}

const context = vm.createContext({
  Element: FakeElement,
  InputEvent: class InputEvent {},
  KeyboardEvent: class KeyboardEvent {},
  MouseEvent: class MouseEvent {},
  PointerEvent: class PointerEvent {},
  URL,
  chrome: undefined,
  clearTimeout,
  console,
  crypto: { randomUUID: () => "test-id" },
  document,
  setTimeout,
  window,
})

const source = fs.readFileSync(new URL("./content.js", import.meta.url), "utf8")
vm.runInContext(source, context)

const api = window.__FCUNO_WA_SPC_TEST_API__
assert.ok(api, "content script test API should be exposed when the test flag is set")

function setHeaderTitles(...titles) {
  const header = new FakeElement({
    tag: "header",
    children: titles.map((title) => new FakeElement({ text: title, attrs: { title } })),
  })
  main = new FakeElement({ children: [header] })
}

function setHeaderTitleAndSubtitle(title, subtitle) {
  const header = new FakeElement({
    tag: "header",
    children: [
      new FakeElement({ text: title, tag: "span", attrs: { dir: "auto" } }),
      new FakeElement({ text: subtitle, tag: "span", attrs: { title: subtitle } }),
    ],
  })
  main = new FakeElement({ children: [header] })
}

function setComposer(text = "") {
  const composer = new FakeElement({
    text,
    attrs: { contenteditable: "true" },
    role: "textbox",
  })
  main = new FakeElement({ children: [composer] })
  return composer
}

function setChatWithComposer(title, text = "") {
  const header = new FakeElement({
    tag: "header",
    children: [new FakeElement({ text: title, attrs: { title } })],
  })
  const composer = new FakeElement({
    text,
    attrs: { contenteditable: "true" },
    role: "textbox",
  })
  const sendButton = new FakeElement({
    tag: "button",
    attrs: { "aria-label": "Send" },
  })
  main = new FakeElement({ children: [header, composer, sendButton] })
  return { composer, sendButton }
}

function setChatWithIconSendButton(title, text = "") {
  const header = new FakeElement({
    tag: "header",
    children: [new FakeElement({ text: title, attrs: { title } })],
  })
  const composer = new FakeElement({
    text,
    attrs: { contenteditable: "true" },
    role: "textbox",
  })
  const sendIcon = new FakeElement({
    tag: "span",
    attrs: { "data-icon": "wds-ic-send-filled" },
  })
  const sendButton = new FakeElement({
    tag: "div",
    role: "button",
    children: [sendIcon],
  })
  main = new FakeElement({ children: [header, composer, sendButton] })
  return { composer, sendButton }
}

setHeaderTitles("KOREA", "+60 12-699 4488, You")
const groupChat = api.getCurrentChat()
assert.equal(groupChat.name, "KOREA")
assert.equal(groupChat.phone, "")
assert.equal(groupChat.directUrl, "")
assert.equal(api.canUseDirectUrl({ name: "KOREA", phone: "+60126994488" }), false)
assert.equal(api.canUseDirectUrl({ name: "+85266885575", phone: "+85266885575" }), true)

setHeaderTitleAndSubtitle("Cosulich - Sumitomo (South Korea/Taiwan)", "ATSUSHI, MASATO, SHUGO, You")
const renamedGroupChat = api.getCurrentChat()
assert.equal(renamedGroupChat.name, "Cosulich - Sumitomo (South Korea/Taiwan)")
assert.equal(renamedGroupChat.phone, "")

setHeaderTitles("SUMITOMO KOREA TAIWAN")
assert.equal(api.currentChatMatchesContact({ name: "KOREA", chatName: "KOREA", phone: "" }), false)
assert.equal(api.currentChatMatchesContact({ name: "SUMITOMO KOREA TAIWAN", phone: "" }), true)
assert.equal(api.textMatchesContact({ name: "KOREA", chatName: "KOREA", phone: "" }, "SUMITOMO KOREA TAIWAN"), false)
assert.equal(api.textMatchesContact({ name: "KOREA", chatName: "KOREA", phone: "" }, "KOREA"), true)

const formerRenamedContact = { name: "OTTO", chatName: "Otto Tone", phone: "" }
assert.equal(api.contactSearchText(formerRenamedContact), "Otto Tone")
assert.equal(api.textMatchesContact(formerRenamedContact, "Otto Tone"), true)
assert.equal(api.textMatchesContact(formerRenamedContact, "OTTO"), false)
setHeaderTitles("Otto Tone")
assert.equal(api.currentChatMatchesContact(formerRenamedContact), true)
setHeaderTitles("OTTO")
assert.equal(api.currentChatMatchesContact(formerRenamedContact), false)

const aliasOnlyContact = { name: "OTTO", phone: "" }
assert.equal(api.textMatchesContact(aliasOnlyContact, "Otto Tone"), false)
setHeaderTitles("Otto Tone")
assert.equal(api.currentChatMatchesContact(aliasOnlyContact), false)

const renameSafeContact = {
  id: "rename-safe",
  name: "Cosulich - Sumitomo (South Korea/Taiwan)",
  chatName: "Cosulich - Sumitomo (South Korea/Taiwan)",
  phone: "",
  list: "supplier",
  order: 1000,
}
api.state.contacts = [renameSafeContact]
window.promptResponse = "SUMITOMO DESK"
api.renameContact(renameSafeContact.id)
assert.equal(renameSafeContact.name, "SUMITOMO DESK")
assert.equal(renameSafeContact.chatName, "Cosulich - Sumitomo (South Korea/Taiwan)")
const restoredRename = api.sanitizeSavedState({ contacts: [renameSafeContact] }).contacts[0]
assert.equal(restoredRename.name, "SUMITOMO DESK")
assert.equal(restoredRename.chatName, "Cosulich - Sumitomo (South Korea/Taiwan)")
assert.equal(api.contactSearchText(renameSafeContact), "Cosulich - Sumitomo (South Korea/Taiwan)")
setHeaderTitles("Cosulich - Sumitomo (South Korea/Taiwan)")
assert.equal(api.currentChatMatchesContact(renameSafeContact), true)
setHeaderTitles("SUMITOMO DESK")
assert.equal(api.currentChatMatchesContact(renameSafeContact), false)

const enquiry = "shan ren / 9474606 / 11 - 13 jan / vlsfo 110mts / lsmgo 55mts"
let composer = setComposer(enquiry)
assert.equal(api.insertComposerText(enquiry), true)
assert.equal(api.composerText(composer), enquiry)

composer = setComposer(`${enquiry}${enquiry}`)
assert.equal(api.insertComposerText(enquiry), true)
assert.equal(api.composerText(composer), enquiry)

deleteFails = true
composer = setComposer(`${enquiry}${enquiry}${enquiry}${enquiry}`)
assert.equal(api.insertComposerText(enquiry), true)
assert.equal(api.composerText(composer), enquiry)
deleteFails = false

api.state.contacts = [
  { id: "supplier-a", name: "Supplier A", list: "supplier", order: 1000 },
  { id: "supplier-b", name: "Supplier B", list: "supplier", order: 2000 },
  { id: "supplier-c", name: "Supplier C", list: "supplier", order: 3000 },
  { id: "buyer-a", name: "Buyer A", list: "buyer", order: 1000 },
]
api.moveContact("supplier-c", "supplier", "supplier-a", "before")
assert.deepEqual(
  Array.from(api.contactsFor("supplier").map((contact) => contact.id)),
  ["supplier-c", "supplier-a", "supplier-b"],
  "contacts should reorder before a target row",
)
api.moveContact("supplier-c", "buyer", "", "before")
assert.deepEqual(
  Array.from(api.contactsFor("buyer").map((contact) => contact.id)),
  ["buyer-a", "supplier-c"],
  "contacts should move to the end of another list",
)

const duplicateMessage = "taisei maru no.15 / 8710728 / 14 - 15 jan / vlsfo 600mts"
const { composer: sendComposer, sendButton } = setChatWithComposer("Supplier B")
const contact = { id: "supplier-b", name: "Supplier B", phone: "", list: "supplier" }
api.sendTextToContact(contact, duplicateMessage)
api.sendTextToContact(contact, duplicateMessage)
await new Promise((resolve) => setTimeout(resolve, 180))
assert.equal(api.composerText(sendComposer), duplicateMessage)
assert.equal(sendButton.clicked, 1, "duplicate sends for the same contact/message should be suppressed")

sessionStore.clear()
api.acquireSendLock("reset-lock", "different message")
const { composer: iconComposer, sendButton: iconSendButton } = setChatWithIconSendButton("Icon Send")
assert.equal(api.insertComposerText(duplicateMessage), true)
assert.equal(api.findSendButton(), iconSendButton, "send button should be found from WhatsApp-style send icon")

assert.equal(api.acquireSendLock("same-contact", "same message"), true)
assert.equal(api.acquireSendLock("same-contact", "same message"), false)

api.state.templateEnabled = false
api.state.enquiries = [
  { id: "enq-1", formattedText: duplicateMessage, createdAt: "2026-07-01T08:00:00Z", status: "sent" },
  { id: "enq-1", formattedText: duplicateMessage, createdAt: "2026-07-01T08:00:00Z", status: "sent" },
  { id: "enq-2", formattedText: duplicateMessage, createdAt: "2026-07-01T08:00:00Z", status: "sent" },
]
api.state.selectedEnquiries = { "enq-1": true, "enq-2": true }
assert.equal(api.selectedEnquiryText(), duplicateMessage)

api.state.senderContacts = api.sanitizeSenderContacts({
  "BARRY@COSULICH.COM.SG": {
    username: "barry@cosulich.com.sg",
    displayName: "BARRY KHOO",
    phone: "+65 9000 0001",
    phonebookContactId: "phonebook-barry",
  },
})
assert.equal(
  api.enquirySenderChatUrl({ createdByUsername: "BARRY@COSULICH.COM.SG" }),
  "https://web.whatsapp.com/send?phone=6590000001",
)
assert.equal(api.enquirySenderChatUrl({ createdByUsername: "missing@cosulich.com.sg" }), "")

console.log("SPC WhatsApp content tests passed")
