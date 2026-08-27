import assert from "node:assert/strict"
import test from "node:test"
import { isActiveSupplierTraderOption } from "../lib/spcUsers"

test("only an active user with the Supplier Trader role is selectable", () => {
  assert.equal(
    isActiveSupplierTraderOption({ isActive: true, role: "SUPPLIER TRADER" }),
    true,
  )
})

test("inactive Supplier Traders and other roles stay out of supplier trader lists", () => {
  assert.equal(
    isActiveSupplierTraderOption({ isActive: false, role: "SUPPLIER TRADER" }),
    false,
  )
  assert.equal(
    isActiveSupplierTraderOption({ isActive: true, role: "BUYER TRADER" }),
    false,
  )
  assert.equal(
    isActiveSupplierTraderOption({ isActive: true, role: "ADMIN" }),
    false,
  )
})
