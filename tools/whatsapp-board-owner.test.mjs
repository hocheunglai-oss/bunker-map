import assert from "node:assert/strict"
import fs from "node:fs"
import vm from "node:vm"

const cases = [
  { file: "./whatsapp-speed-board/content.js", existingOwner: "spc", expected: /Speed Board did not start/ },
  { file: "./whatsapp-spc-speed-board/content.js", existingOwner: "fcuno", expected: /SPC WhatsApp Board did not start/ },
]

for (const testCase of cases) {
  const warnings = []
  const code = fs.readFileSync(new URL(testCase.file, import.meta.url), "utf8")
  const context = {
    chrome: { runtime: { getURL: (asset) => asset } },
    console: { warn: (message) => warnings.push(String(message)) },
    document: {
      documentElement: {
        getAttribute: () => testCase.existingOwner,
        setAttribute: () => {
          throw new Error("blocked board must not claim ownership")
        },
      },
    },
  }
  vm.createContext(context)
  vm.runInContext(code, context)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], testCase.expected)
}

console.log("WhatsApp board ownership tests passed")
