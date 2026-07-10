import assert from "node:assert/strict"
import fs from "node:fs"
import vm from "node:vm"

const code = fs.readFileSync(new URL("./background.js", import.meta.url), "utf8")
const listeners = []
const fetchedUrls = []
const enquiryResponses = []
const context = {
  console,
  fetch: async (url) => {
    fetchedUrls.push(String(url))
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
          regularMarketPrice: 72.27,
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
assert.equal(crude.price, 72.27)
assert.equal(crude.change.toFixed(2), "0.47")
assert.equal(crude.changePercent.toFixed(2), "0.65")
assert.deepEqual(crude.points, [73.28, 73.29, 73.19, 70.84, 70.75])
assert.equal(crude.points.includes(0), false)

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
assert.equal(context.latestEnquiryCursor(merged), "2026-07-04T00:00:00Z")

enquiryResponses.push(
  {
    enquiries: [
      { id: "initial", createdAt: "2026-07-05T00:00:00Z", updatedAt: "2026-07-05T00:00:00.123456Z", status: "sent" },
    ],
    cursor: "2026-07-05T00:00:00.123456Z",
  },
  {
    enquiries: [
      { id: "initial", createdAt: "2026-07-05T00:00:00Z", updatedAt: "2026-07-05T00:01:00.654321Z", status: "quoted" },
    ],
    cursor: "2026-07-05T00:01:00.654321Z",
  },
)
const initialEnquiries = await context.fetchSpcEnquiries()
const refreshedEnquiries = await context.fetchSpcEnquiries()
assert.equal(initialEnquiries[0].status, "sent")
assert.equal(refreshedEnquiries[0].status, "quoted")
assert.equal(fetchedUrls.length, 2)
assert.match(fetchedUrls[1], /updatedAfter=2026-07-05T00%3A00%3A00\.123456Z/)

console.log("SPC WhatsApp background tests passed")
