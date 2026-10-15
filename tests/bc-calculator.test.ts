import assert from "node:assert/strict"
import test from "node:test"
import { calculateBc, emptyBcCalculator, normalizeBcCalculator } from "../lib/bcCalculator"

test("BC weights each grade margin by quantity and includes lump sum once", () => {
  const values = emptyBcCalculator()
  values.grades[0] = { quantity: "200", buy: "886", sell: "940" }
  values.grades[1] = { quantity: "75", buy: "1200", sell: "1320" }
  assert.deepEqual(calculateBc(values).gradeTotals, [10800, 9000, 0])
  assert.equal(calculateBc(values).baseBc, 72)
  assert.equal(calculateBc(values).bc, 59.4)
  values.lumpsumBuy = "100"
  values.lumpsumSell = "375"
  assert.equal(calculateBc(values).baseBc, 73)
  assert.ok(Math.abs((calculateBc(values).bc || 0) - 60.225) < 1e-9)
})

test("BC needs a positive grade quantity and complete prices for used grades", () => {
  const values = emptyBcCalculator()
  assert.equal(calculateBc(values).bc, null)
  values.grades[0].quantity = "50"
  assert.equal(calculateBc(values).valid, false)
  values.grades[0].buy = "0"
  values.grades[0].sell = "25"
  assert.equal(calculateBc(values).bc, 20.625)
  values.grades[0].quantity = "-5"
  assert.equal(calculateBc(values).valid, false)
})

test("saved calculator values normalize without losing entered numbers", () => {
  const value = normalizeBcCalculator({ grades: [{ quantity: 200, buy: 886, sell: 940 }], lumpsumBuy: "10" })
  assert.equal(value.grades[0].quantity, "200")
  assert.equal(value.grades[1].quantity, "")
  assert.equal(value.lumpsumBuy, "10")
})
