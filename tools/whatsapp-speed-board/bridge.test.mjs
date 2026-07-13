import assert from "node:assert/strict"
import fs from "node:fs"
import vm from "node:vm"

const code = fs.readFileSync(new URL("./bridge.js", import.meta.url), "utf8")
const messageListeners = []
const postedMessages = []
const runtimeMessages = []

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
  window: windowObject,
  chrome: {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        runtimeMessages.push(message)
        queueMicrotask(() => callback({
          ok: true,
          id: `saved-${runtimeMessages.length}`,
          createdAt: "2026-07-13T00:00:00.000Z",
        }))
      },
    },
  },
  Promise,
  queueMicrotask,
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
    buyer: "Trader Two",
  },
})

await new Promise((resolve) => setTimeout(resolve, 0))

assert.deepEqual(JSON.parse(JSON.stringify(runtimeMessages)), [
  { type: "enqueue-fcuno-enquiry", text: "new enquiry one", buyer: "Trader One" },
  { type: "enqueue-fcuno-enquiry", text: "new enquiry two", buyer: "Trader Two" },
])
assert.equal(postedMessages.length, 2)
assert.equal(postedMessages[0].ok, true)
assert.equal(postedMessages[0].requestId, "request-1")
assert.equal(postedMessages[1].requestId, "request-2")

console.log("FCUNO WhatsApp bridge tests passed")
