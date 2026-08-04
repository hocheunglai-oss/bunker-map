import assert from "node:assert/strict"
import test from "node:test"
import { isSpcUserInCategory } from "../lib/spcUserCategories"

test("a designated admin appears in both Admin and Supplier Trader categories", () => {
  const michelle = { role: "ADMIN", isSupplierTrader: true }

  assert.equal(isSpcUserInCategory(michelle, "ADMIN"), true)
  assert.equal(isSpcUserInCategory(michelle, "SUPPLIER TRADER"), true)
  assert.equal(isSpcUserInCategory(michelle, "BUYER TRADER"), false)
})

test("an admin without the designation stays out of Supplier Trader", () => {
  const admin = { role: "ADMIN", isSupplierTrader: false }

  assert.equal(isSpcUserInCategory(admin, "ADMIN"), true)
  assert.equal(isSpcUserInCategory(admin, "SUPPLIER TRADER"), false)
})
