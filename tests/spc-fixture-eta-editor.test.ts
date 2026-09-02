import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const fixturesPage = readFileSync(new URL("../app/spc/fixtures/page.tsx", import.meta.url), "utf8")
const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8")

test("fixture ETA editor presents two clearly labelled date groups", () => {
  assert.match(fixturesPage, /226, \/\/ ETA/)
  assert.match(fixturesPage, /className="spc-fixture-eta-date" role="group" aria-label="ETA start date"/)
  assert.match(fixturesPage, /className="spc-fixture-eta-date" role="group" aria-label="ETA end date"/)
  assert.match(fixturesPage, /className="spc-fixture-eta-separator" aria-hidden="true">–<\/span>/)
  assert.equal((fixturesPage.match(/className="spc-fixture-eta-day"/g) || []).length, 2)
  assert.equal((fixturesPage.match(/className="spc-fixture-eta-month"/g) || []).length, 2)
  assert.equal((fixturesPage.match(/<option value="">DD<\/option>/g) || []).length, 2)
  for (const label of ["ETA start day", "ETA start month", "ETA end day", "ETA end month"]) {
    assert.match(fixturesPage, new RegExp(`aria-label="${label}"`))
  }
  assert.match(fixturesPage, /disabled=\{!canEdit \|\| !parts\.endDay\}/)
})

test("fixture ETA date groups reserve enough room for full month abbreviations", () => {
  assert.match(styles, /\.spc-fixture-eta-editor\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 10px minmax\(0, 1fr\);/)
  assert.match(styles, /\.spc-fixture-eta-date\s*\{[^}]*grid-template-columns:\s*38px minmax\(0, 1fr\);/)
  assert.match(styles, /\.spc-fixture-eta-date:hover,[\s\S]*?\.spc-fixture-eta-date:focus-within/)
  assert.match(styles, /select\.spc-fixture-eta-day\s*\{[^}]*border-right:/)
  assert.match(styles, /font-variant-numeric:\s*tabular-nums;/)
  assert.match(styles, /\.spc-fixture-eta-separator\s*\{[^}]*text-align:\s*center;/)
})
