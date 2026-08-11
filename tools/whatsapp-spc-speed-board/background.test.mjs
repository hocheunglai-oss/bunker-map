import assert from "node:assert/strict"
import fs from "node:fs"
import vm from "node:vm"

const code = fs.readFileSync(new URL("./background.js", import.meta.url), "utf8")
const sharedFeedUrl =
  "https://spc.fcuno.com/api/spc/enquiries?limit=250&createdAfter=2026-07-23T09%3A20%3A00.000Z"
const listeners = []
const fetchedUrls = []
const fetchedOptions = []
const enquiryResponses = []
const debuggerCommands = []
const context = {
  console,
  fetch: async (url, options = {}) => {
    fetchedUrls.push(String(url))
    fetchedOptions.push(options)
    const payload = enquiryResponses.shift()
    if (!payload) throw new Error("Unexpected fetch in background test.")
    return {
      ok: true,
      status: 200,
      async json() {
        return payload
      },
    }
  },
  chrome: {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(listener) {
          listeners.push(listener)
        },
      },
    },
    notifications: {},
    debugger: {
      attach(_target, _version, callback) {
        callback()
      },
      sendCommand(_target, method, params, callback) {
        debuggerCommands.push({ method, params })
        callback()
      },
      detach(_target, callback) {
        callback()
      },
    },
  },
  setTimeout,
  clearTimeout,
}

vm.createContext(context)
vm.runInContext(code, context)

const crudeNow = Date.parse("2026-07-23T08:50:00.000Z")
const crudePayload = {
  crude: {
    symbol: "Brent",
    contract: "Sep26",
    price: 98.02,
    change: 3.95,
    changePercent: 4.199,
    points: [95.17, 96.03, null, 97.61, undefined, "", 97.94, 98.09],
    updatedAt: "2026-07-23T08:40:00.000Z",
    source: "ICE",
    sourceName: "Intercontinental Exchange",
    delayedMinutes: 15,
    verified: true,
  },
}
const crude = context.parseCrudePayload(crudePayload, crudeNow)

assert.equal(listeners.length, 1)
assert.equal(crude.price, 98.02)
assert.equal(crude.change.toFixed(2), "3.95")
assert.equal(crude.changePercent.toFixed(2), "4.20")
assert.deepEqual(crude.points, [95.17, 96.03, 97.61, 97.94, 98.09])
assert.equal(crude.points.includes(0), false)
assert.throws(
  () => context.parseCrudePayload({ crude: { ...crudePayload.crude, source: "Yahoo" } }, crudeNow),
  /unavailable/,
)
assert.throws(
  () =>
    context.parseCrudePayload(
      { crude: { ...crudePayload.crude, updatedAt: "2026-07-23T06:00:00.000Z" } },
      crudeNow,
    ),
  /failed validation/,
)

const merged = context.mergeSpcEnquiries(
  [
    { id: "older", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" },
    { id: "changed", createdAt: "2026-07-02T00:00:00Z", updatedAt: "2026-07-02T00:00:00Z", status: "sent" },
  ],
  [
    { id: "changed", createdAt: "2026-07-02T00:00:00Z", updatedAt: "2026-07-03T00:00:00Z", status: "quoted" },
    { id: "new", createdAt: "2026-07-04T00:00:00Z", updatedAt: "2026-07-04T00:00:00Z" },
  ],
  2,
)
assert.deepEqual(Array.from(merged, (item) => item.id), ["new", "changed"])
assert.equal(merged[1].status, "quoted")
assert.equal(context.latestEnquiryCursor(merged), "2026-07-04T00:00:00Z|new")

const reconciled = context.mergeSpcEnquiries(
  merged,
  [],
  160,
  ["new"],
)
assert.deepEqual(Array.from(reconciled, (item) => item.id), ["new"])

enquiryResponses.push(
  {
    enquiries: [
      { id: "initial", createdAt: "2026-07-05T00:00:00Z", updatedAt: "2026-07-05T00:00:00.123456Z", status: "sent" },
    ],
    cursor: "2026-07-05T00:00:00.123456Z|00000000-0000-4000-8000-000000000001",
    sessionKey: "trader-a",
  },
  {
    enquiries: [
      { id: "initial", createdAt: "2026-07-05T00:00:00Z", updatedAt: "2026-07-05T00:01:00.654321Z", status: "quoted" },
    ],
    cursor: "2026-07-05T00:01:00.654321Z|00000000-0000-4000-8000-000000000001",
    activeIds: ["initial"],
    sessionKey: "trader-a",
  },
  {
    enquiries: [
      { id: "partial-b", createdAt: "2026-07-05T00:02:00Z", updatedAt: "2026-07-05T00:02:00Z", status: "sent" },
    ],
    cursor: "2026-07-05T00:02:00Z",
    sessionKey: "trader-b",
  },
  {
    enquiries: [
      { id: "full-b", createdAt: "2026-07-05T00:03:00Z", updatedAt: "2026-07-05T00:03:00Z", status: "sent" },
    ],
    cursor: "2026-07-05T00:03:00Z",
    sessionKey: "trader-b",
  },
)
const initialEnquiries = await context.fetchSpcEnquiries()
const refreshedEnquiries = await context.fetchSpcEnquiries()
const nextTraderEnquiries = await context.fetchSpcEnquiries()
assert.equal(initialEnquiries[0].status, "sent")
assert.equal(refreshedEnquiries[0].status, "quoted")
assert.deepEqual(Array.from(nextTraderEnquiries, (item) => item.id), ["full-b"])
assert.equal(fetchedUrls.length, 4)
assert.ok(fetchedUrls[0].startsWith(sharedFeedUrl))
assert.ok(fetchedUrls[1].startsWith(`${sharedFeedUrl}&updatedAfter=`))
assert.match(fetchedUrls[1], /updatedAfter=2026-07-05T00%3A00%3A00\.123456Z%7C00000000-0000-4000-8000-000000000001/)
assert.ok(fetchedUrls[2].startsWith(`${sharedFeedUrl}&updatedAfter=`))
assert.match(fetchedUrls[2], /updatedAfter=2026-07-05T00%3A01%3A00\.654321Z%7C00000000-0000-4000-8000-000000000001/)
assert.equal(fetchedUrls[3], sharedFeedUrl)

enquiryResponses.push({
  contacts: [
    {
      username: "barry@cosulich.com.sg",
      displayName: "BARRY KHOO",
      phone: "6590000001",
      phonebookContactId: "phonebook-barry",
    },
  ],
})
const senderContacts = await context.fetchSpcEnquiryChatContacts(
  ["BARRY@COSULICH.COM.SG", "missing@cosulich.com.sg"],
  "trader-b",
)
assert.deepEqual(JSON.parse(JSON.stringify(senderContacts)), {
  "barry@cosulich.com.sg": {
    username: "barry@cosulich.com.sg",
    displayName: "BARRY KHOO",
    phone: "6590000001",
    phonebookContactId: "phonebook-barry",
  },
})
assert.equal(
  fetchedUrls.at(-1),
  "https://spc.fcuno.com/api/spc/enquiry-chat-contacts?username=barry%40cosulich.com.sg&username=missing%40cosulich.com.sg",
)
assert.equal(fetchedOptions.at(-1).method, undefined)
const senderFetchCount = fetchedUrls.length
await context.fetchSpcEnquiryChatContacts(["barry@cosulich.com.sg"], "trader-b")
assert.equal(fetchedUrls.length, senderFetchCount)

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

await context.nativeReplaceText(7, "+85266885575")
assert.deepEqual(JSON.parse(JSON.stringify(debuggerCommands)), [
  {
    method: "Input.dispatchKeyEvent",
    params: { type: "rawKeyDown", key: "a", code: "KeyA", modifiers: 4, commands: ["SelectAll"] },
  },
  {
    method: "Input.dispatchKeyEvent",
    params: { type: "keyUp", key: "a", code: "KeyA", modifiers: 4 },
  },
  {
    method: "Input.dispatchKeyEvent",
    params: {
      type: "rawKeyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    },
  },
  {
    method: "Input.dispatchKeyEvent",
    params: {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    },
  },
  {
    method: "Input.insertText",
    params: { text: "+85266885575" },
  },
])

console.log("SPC WhatsApp background tests passed")
