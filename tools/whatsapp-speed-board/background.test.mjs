import assert from "node:assert/strict"
import fs from "node:fs"
import vm from "node:vm"

const code = fs.readFileSync(new URL("./background.js", import.meta.url), "utf8")
const listeners = []
const boardKey = "fcuno-wa-speed-board-v1"
const queueKey = "fcuno-wa-speed-board-enquiries-v1"
const boardState = {
  contacts: [{ id: "supplier-1", name: "Supplier One", list: "supplier" }],
  enquiries: [{ id: "legacy", body: "legacy enquiry", createdAt: "2026-07-01T00:00:00Z" }],
}
const storageData = { [boardKey]: structuredClone(boardState) }
let notifications = 0
const context = {
  console,
  crypto,
  Date,
  Math,
  Promise,
  queueMicrotask,
  fetch,
  chrome: {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(listener) {
          listeners.push(listener)
        },
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
    notifications: {
      create() {
        notifications += 1
      },
    },
  },
  setTimeout,
  clearTimeout,
}

vm.createContext(context)
vm.runInContext(code, context)

const crude = context.parseCrudeChart({
  chart: {
    result: [
      {
        meta: {
          regularMarketPrice: 72.26,
          previousClose: 71.8,
          chartPreviousClose: 73.15,
        },
        indicators: {
          quote: [
            {
              close: [73.28, 73.29, null, 73.19, undefined, "", 70.84, 70.75],
            },
          ],
        },
      },
    ],
  },
})

assert.equal(listeners.length, 1)
assert.equal(crude.price, 72.26)
assert.equal(crude.change.toFixed(2), "0.46")
assert.equal(crude.changePercent.toFixed(2), "0.64")
assert.deepEqual(crude.points, [73.28, 73.29, 73.19, 70.84, 70.75])
assert.equal(crude.points.includes(0), false)

const debuggerOrder = []
let releaseDebugger
const debuggerGate = new Promise((resolve) => {
  releaseDebugger = resolve
})
const firstDebuggerAction = context.enqueueDebuggerAction(7, async () => {
  debuggerOrder.push("first-start")
  await debuggerGate
  debuggerOrder.push("first-end")
})
const secondDebuggerAction = context.enqueueDebuggerAction(7, async () => {
  debuggerOrder.push("second-start")
  debuggerOrder.push("second-end")
})
await new Promise((resolve) => setTimeout(resolve, 0))
assert.deepEqual(debuggerOrder, ["first-start"])
releaseDebugger()
await Promise.all([firstDebuggerAction, secondDebuggerAction])
assert.deepEqual(debuggerOrder, ["first-start", "first-end", "second-start", "second-end"])

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    const keepAlive = listeners[0](message, {}, resolve)
    assert.equal(keepAlive, true)
  })
}

const [firstEnquiry, secondEnquiry] = await Promise.all([
  sendRuntimeMessage({ type: "enqueue-fcuno-enquiry", text: "new enquiry one", buyer: "Trader One" }),
  sendRuntimeMessage({ type: "enqueue-fcuno-enquiry", text: "new enquiry two", buyer: "Trader Two" }),
])

assert.equal(firstEnquiry.ok, true)
assert.equal(secondEnquiry.ok, true)
assert.deepEqual(storageData[boardKey], boardState, "enqueue must not overwrite board contacts or settings")
assert.equal(storageData[queueKey].enquiries.length, 3)
assert.equal(storageData[queueKey].enquiries[0].body, "new enquiry two")
assert.equal(storageData[queueKey].enquiries[1].body, "new enquiry one")
assert.equal(storageData[queueKey].enquiries[2].id, "legacy")
assert.equal(notifications, 2)

console.log("FCUNO WhatsApp background tests passed")
