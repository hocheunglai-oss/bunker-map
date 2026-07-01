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
    this.classList = {
      add() {},
      remove() {},
      toggle() {},
    }
  }

  get textContent() {
    return this._text
  }

  set textContent(value) {
    this._text = String(value || "")
  }

  get innerText() {
    return this._text
  }

  set innerText(value) {
    this._text = String(value || "")
  }

  getAttribute(name) {
    if (name === "role") return this.role
    return this.attrs[name] || null
  }

  querySelector(selector) {
    if (selector === "header") return this.children.find((child) => child.tag === "header") || null
    return this.querySelectorAll(selector)[0] || null
  }

  querySelectorAll(selector) {
    if (selector.includes("contenteditable") || selector.includes("[role='textbox']")) {
      return this.children.filter((child) => child.attrs.contenteditable === "true" || child.role === "textbox")
    }
    if (selector.includes("[title]") || selector.includes("[dir='auto']") || selector.includes("[aria-label]")) {
      return this.children.filter((child) => child.attrs.title || child.attrs["aria-label"] || child.attrs.dir === "auto")
    }
    return []
  }

  closest() {
    return null
  }

  matches() {
    return false
  }

  getBoundingClientRect() {
    return { width: 120, height: 24, top: 10, left: 10 }
  }

  focus() {
    activeElement = this
  }

  dispatchEvent() {
    return true
  }
}

let activeElement = null
let selected = false
let main = null

const document = {
  readyState: "loading",
  body: new FakeElement(),
  addEventListener() {},
  getElementById() {
    return null
  },
  createElement() {
    return new FakeElement()
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
  addEventListener() {},
  clearTimeout,
  document,
  getSelection() {
    return null
  },
  location: {
    assign() {},
  },
  setTimeout,
}

const context = vm.createContext({
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

function setComposer(text = "") {
  const composer = new FakeElement({
    text,
    attrs: { contenteditable: "true" },
    role: "textbox",
  })
  main = new FakeElement({ children: [composer] })
  return composer
}

setHeaderTitles("KOREA", "+60 12-699 4488, You")
const groupChat = api.getCurrentChat()
assert.equal(groupChat.name, "KOREA")
assert.equal(groupChat.phone, "")
assert.equal(groupChat.directUrl, "")
assert.equal(api.canUseDirectUrl({ name: "KOREA", phone: "+60126994488" }), false)
assert.equal(api.canUseDirectUrl({ name: "+85266885575", phone: "+85266885575" }), true)

setHeaderTitles("SUMITOMO KOREA TAIWAN")
assert.equal(api.currentChatMatchesContact({ name: "KOREA", phone: "" }), false)
assert.equal(api.currentChatMatchesContact({ name: "SUMITOMO KOREA TAIWAN", phone: "" }), true)
assert.equal(api.textMatchesContact({ name: "KOREA", phone: "" }, "SUMITOMO KOREA TAIWAN"), false)
assert.equal(api.textMatchesContact({ name: "KOREA", phone: "" }, "KOREA"), true)

const enquiry = "shan ren / 9474606 / 11 - 13 jan / vlsfo 110mts / lsmgo 55mts"
let composer = setComposer(enquiry)
assert.equal(api.insertComposerText(enquiry), true)
assert.equal(api.composerText(composer), enquiry)

composer = setComposer(`${enquiry}${enquiry}`)
assert.equal(api.insertComposerText(enquiry), true)
assert.equal(api.composerText(composer), enquiry)

console.log("SPC WhatsApp content tests passed")
