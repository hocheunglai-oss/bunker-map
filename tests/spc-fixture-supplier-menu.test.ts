import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const fixturesPage = readFileSync(new URL("../app/spc/fixtures/page.tsx", import.meta.url), "utf8")
const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8")

test("fixture supplier input filters its own options without a separate search field", () => {
  assert.match(fixturesPage, /const \[supplierOptionQuery, setSupplierOptionQuery\] = useState\(""\)/)
  assert.match(fixturesPage, /const query = supplierOptionQuery\.trim\(\)\.toLowerCase\(\)/)
  assert.match(fixturesPage, /supplier\.toLowerCase\(\)\.includes\(query\)/)
  assert.match(fixturesPage, /updateGradeDraft\(fixture\.id, "supplierName", key, event\.target\.value\)[\s\S]*?setSupplierOptionQuery\(event\.target\.value\)/)
  assert.doesNotMatch(fixturesPage, /aria-label="Search suppliers"/)
})

test("fixture supplier menu remains open while focus moves inside the picker", () => {
  assert.match(fixturesPage, /event\.currentTarget\.contains\(event\.relatedTarget\)/)
  assert.doesNotMatch(fixturesPage, /window\.setTimeout\(\(\) => setSupplierMenuKey/)
  assert.match(fixturesPage, /<button[\s\S]*?className="spc-fixture-supplier-option"[\s\S]*?role="option"/)
  assert.match(fixturesPage, /aria-expanded=\{menuIsOpen\}/)
  assert.match(fixturesPage, /aria-controls=\{menuId\}/)
})

test("the open supplier menu stacks above fixture period controls", () => {
  assert.match(styles, /\.spc-fixture-section-filters\s*\{[^}]*z-index:\s*16;/)
  assert.match(styles, /\.spc-fixture-supplier-picker\.is-open\s*\{[^}]*z-index:\s*30;/)
  assert.match(styles, /\.spc-fixture-supplier-menu\s*\{[^}]*z-index:\s*31;/)
  assert.match(styles, /\.spc-fixture-supplier-options\s*\{[^}]*overflow-y:\s*auto;/)
  assert.match(styles, /button\.spc-fixture-supplier-option:focus-visible/)
})
