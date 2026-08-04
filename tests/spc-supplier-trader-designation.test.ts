import assert from "node:assert/strict"
import test from "node:test"
import { isActiveSupplierTraderOption } from "../lib/spcUsers"

test("an active admin can remain selectable as a supplier trader", () => {
  assert.equal(
    isActiveSupplierTraderOption({ isActive: true, isSupplierTrader: true }),
    true,
  )
})

test("inactive and non-trading users stay out of supplier trader lists", () => {
  assert.equal(
    isActiveSupplierTraderOption({ isActive: false, isSupplierTrader: true }),
    false,
  )
  assert.equal(
    isActiveSupplierTraderOption({ isActive: true, isSupplierTrader: false }),
    false,
  )
})
