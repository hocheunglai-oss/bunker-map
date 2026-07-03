import assert from "node:assert/strict"
import fs from "node:fs"
import vm from "node:vm"

const code = fs.readFileSync(new URL("./background.js", import.meta.url), "utf8")
const listeners = []
const context = {
  console,
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

console.log("SPC WhatsApp background tests passed")
