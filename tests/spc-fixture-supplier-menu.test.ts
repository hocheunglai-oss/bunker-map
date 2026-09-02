import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const fixturesPage = readFileSync(new URL("../app/spc/fixtures/page.tsx", import.meta.url), "utf8")
const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8")

test("fixture supplier menu has an independent case-insensitive search", () => {
  assert.match(fixturesPage, /const \[supplierSearchQuery, setSupplierSearchQuery\] = useState\(""\)/)
  assert.match(fixturesPage, /const query = supplierSearchQuery\.trim\(\)\.toLowerCase\(\)/)
  assert.match(fixturesPage, /supplier\.toLowerCase\(\)\.includes\(query\)/)
  assert.match(fixturesPage, /type="search"[\s\S]*?aria-label="Search suppliers"[\s\S]*?value=\{supplierSearchQuery\}/)
  assert.match(fixturesPage, /onChange=\{\(event\) => setSupplierSearchQuery\(event\.target\.value\)\}/)
})

test("fixture supplier search remains open while focus moves inside the picker", () => {
  assert.match(fixturesPage, /event\.currentTarget\.contains\(event\.relatedTarget\)/)
  assert.doesNotMatch(fixturesPage, /window\.setTimeout\(\(\) => setSupplierMenuKey/)
  assert.match(fixturesPage, /<button[\s\S]*?className="spc-fixture-supplier-option"[\s\S]*?role="option"/)
  assert.match(fixturesPage, /aria-expanded=\{menuIsOpen\}/)
  assert.match(fixturesPage, /aria-controls=\{menuId\}/)
  assert.match(fixturesPage, /supplierMenuFocusSuppressionRef\.current = pickerKey/)
  assert.match(fixturesPage, /window\.requestAnimationFrame\(\(\) => supplierInput\?\.focus\(\)\)/)
})

test("the open supplier menu stacks above fixture period controls", () => {
  assert.match(styles, /\.spc-fixture-section-filters\s*\{[^}]*z-index:\s*16;/)
  assert.match(styles, /\.spc-fixture-supplier-picker\.is-open\s*\{[^}]*z-index:\s*30;/)
  assert.match(styles, /\.spc-fixture-supplier-menu\s*\{[^}]*z-index:\s*31;/)
  assert.match(styles, /\.spc-fixture-supplier-options\s*\{[^}]*overflow-y:\s*auto;/)
  assert.match(styles, /button\.spc-fixture-supplier-option:focus-visible/)
})
