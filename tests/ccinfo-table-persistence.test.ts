import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import ts from "typescript"

const source = readFileSync(new URL("../app/admin/ccinfo/page.tsx", import.meta.url), "utf8")
const original = { title: "Supplier characteristics", info: "Keep notes", table: [["Supplier"], ["Original"]], extra: "Keep metadata" }
const table = [["Supplier"], ["Changed"]]
const widths = [100]
const updates = ["", "2026-09-25T08:00:00Z"]

for (const nested of [false, true]) {
  const name = nested ? "updateNestedSectionTable" : "updateMainSectionTable"
  const start = source.indexOf(`  async function ${name}(`)
  const end = source.indexOf("\n  }", start) + 4
  assert.ok(start >= 0 && end > start, `${name} must remain asynchronous`)
  const body = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  test(`${name} commits only after persistence, and keeps the original on failure`, async () => {
    let committed: unknown
    let release: () => void = () => {}
    let fail = false
    const mainSections = [original]
    const highlights = [{ title: "Country tab", sections: [original] }]
    const persist = async () => {
      await new Promise<void>((resolve) => { release = resolve })
      if (fail) throw new Error("Database unavailable")
    }
    const handler = new Function("mainSections", "highlights", "persistMainSections", "persistHighlights", "setMainSections", "setHighlights", `${body}; return ${name}`)(mainSections, highlights, persist, persist, (value: unknown) => { committed = value }, (value: unknown) => { committed = value })
    const args = nested ? [0, 0, table, widths, updates] : [0, table, widths, updates]
    const pending = handler(...args)
    assert.equal(committed, undefined)
    release()
    await pending
    const changed = { ...original, table, column_widths: widths, table_row_updates: updates }
    assert.deepEqual(committed, nested ? [{ title: "Country tab", sections: [changed] }] : [changed])
    assert.deepEqual(mainSections, [original], "existing data must not be mutated")

    committed = undefined
    fail = true
    const rejected = handler(...args)
    release()
    await assert.rejects(rejected, /Database unavailable/)
    assert.equal(committed, undefined, "a failed save cannot replace committed table data")
  })
}
