import assert from "node:assert/strict"
import fs from "node:fs"
import vm from "node:vm"

const code = fs.readFileSync(new URL("./bridge.js", import.meta.url), "utf8")
const boardKey = "fcuno-wa-speed-board-v1"
const queueKey = "fcuno-wa-speed-board-enquiries-v1"
const boardState = {
  contacts: [{ id: "supplier-1", name: "Supplier One", list: "supplier" }],
  templateText: "Good day",
  enquiries: [{ id: "legacy", body: "legacy enquiry", createdAt: "2026-07-01T00:00:00Z" }],
}
const storageData = { [boardKey]: structuredClone(boardState) }
const messageListeners = []
const postedMessages = []
let notifications = 0

const windowObject = {
  location: { origin: "https://fcuno.com" },
  addEventListener(type, listener) {
    if (type === "message") messageListeners.push(listener)
  },
  postMessage(message) {
    postedMessages.push(message)
  },
}

const context = {
  console,
  crypto,
  structuredClone,
  window: windowObject,
  chrome: {
    runtime: {
      lastError: null,
      sendMessage() {
        notifications += 1
      },
    },
    storage: {
      local: {
        get(keys, callback) {
          const result = Object.fromEntries(keys.filter((key) => key in storageData).map((key) => [key, structuredClone(storageData[key])]))
          queueMicrotask(() => callback(result))
        },
        set(values, callback) {
          Object.assign(storageData, structuredClone(values))
          queueMicrotask(callback)
        },
      },
    },
  },
  Date,
  Math,
  Promise,
  queueMicrotask,
  setTimeout,
  clearTimeout,
}

vm.createContext(context)
vm.runInContext(code, context)

assert.equal(messageListeners.length, 1)
messageListeners[0]({
  source: windowObject,
  origin: windowObject.location.origin,
  data: {
    type: "fcuno-wa-enquiry-send",
    requestId: "request-1",
    text: "new enquiry one",
    buyer: "Trader One",
  },
})
messageListeners[0]({
  source: windowObject,
  origin: windowObject.location.origin,
  data: {
    type: "fcuno-wa-enquiry-send",
    requestId: "request-2",
    text: "new enquiry two",
    buyer: "Trader One",
  },
})

await new Promise((resolve) => setTimeout(resolve, 20))

assert.deepEqual(storageData[boardKey], boardState, "enqueue must not overwrite board contacts or settings")
assert.equal(storageData[queueKey].enquiries.length, 3)
assert.equal(storageData[queueKey].enquiries[0].body, "new enquiry two")
assert.equal(storageData[queueKey].enquiries[1].body, "new enquiry one")
assert.equal(storageData[queueKey].enquiries[2].id, "legacy")
assert.equal(notifications, 2)
assert.equal(postedMessages.length, 2)
assert.equal(postedMessages[0].ok, true)
assert.equal(postedMessages[0].requestId, "request-1")
assert.equal(postedMessages[1].requestId, "request-2")

console.log("FCUNO WhatsApp bridge tests passed")
