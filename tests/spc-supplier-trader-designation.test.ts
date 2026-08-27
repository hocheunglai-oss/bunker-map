import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { isActiveSupplierTraderOption } from "../lib/spcUsers"

const spcUsers = readFileSync(new URL("../lib/spcUsers.ts", import.meta.url), "utf8")
const userManagement = readFileSync(
  new URL("../app/spc/usermanagement/page.tsx", import.meta.url),
  "utf8",
)

test("an active designated supplier trader is selectable", () => {
  assert.equal(
    isActiveSupplierTraderOption({ isActive: true, isSupplierTrader: true }),
    true,
  )
})

test("inactive and non-designated users stay out of supplier trader lists", () => {
  assert.equal(
    isActiveSupplierTraderOption({ isActive: false, isSupplierTrader: true }),
    false,
  )
  assert.equal(
    isActiveSupplierTraderOption({ isActive: true, isSupplierTrader: false }),
    false,
  )
})

test("only Admin can receive the optional supplier trader designation", () => {
  assert.match(
    spcUsers,
    /role === "SUPPLIER TRADER" \|\|\s*\(role === "ADMIN" && profile\?\.isSupplierTrader === true\)/,
  )
  assert.match(
    spcUsers,
    /role === "ADMIN" && typeof input\.isSupplierTrader === "boolean"/,
  )
  assert.match(
    userManagement,
    /userDraft\.role === "ADMIN" \? \([\s\S]*?Include in Supplier Trader lists/,
  )
})
