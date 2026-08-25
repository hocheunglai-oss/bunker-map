import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8")

test("SPC mobile enquiry composer stays compact and touch friendly", () => {
  assert.match(
    css,
    /\.spc-enquiry-raw textarea\s*\{[^}]*height:\s*132px;[^}]*min-height:\s*132px;/,
  )
  assert.match(css, /\.spc-enquiry-command-row button\s*\{[^}]*min-height:\s*42px;/)
  assert.match(css, /\.fc-admin-scope \.fc-admin-mobile-menu\s*\{[^}]*min-height:\s*44px;/)
})

test("SPC mobile ledgers expose horizontal navigation and keep the key column visible", () => {
  assert.match(css, /SWIPE SIDEWAYS TO VIEW ALL COLUMNS/)
  assert.match(
    css,
    /\.spc-fixture-ledger-panel \.spc-table-wrap,\s*\.spc-supplier-ledger-panel \.spc-table-wrap\s*\{[^}]*overflow-x:\s*auto;/,
  )
  assert.match(
    css,
    /\.spc-table\.spc-fixture-table th:first-child,[\s\S]*?\.spc-table\.spc-supplier-ledger-table td:first-child\s*\{[^}]*position:\s*sticky;[^}]*left:\s*0;/,
  )
})
