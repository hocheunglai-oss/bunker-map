import assert from "node:assert/strict"
import test from "node:test"
import { buildPriceSetterFuelChanges, priceSetterFuelEdit, priceSetterFuelInput } from "../lib/priceSetterFuelInputs"

const port = { name: "Dalian", lat: 0, lng: 0, hsfo: 100, vlsfo: 200, mgo: 300,
  hsfo_formula: null, vlsfo_formula: "Hong Kong + 5", mgo_formula: null }

test("mixed-fuel inputs show each fuel's own source and preserve numeric zero", () => {
  assert.deepEqual(priceSetterFuelInput(port, "hsfo"), { isFormula: false, value: 100 })
  assert.deepEqual(priceSetterFuelInput(port, "vlsfo"), { isFormula: true, value: "Hong Kong + 5" })
  assert.deepEqual(priceSetterFuelInput({ ...port, mgo: 0 }, "mgo"), { isFormula: false, value: 0 })
  assert.deepEqual(priceSetterFuelInput({ ...port, name: "Vizag" }, "vlsfo"), { isFormula: true, value: "Hong Kong + 5" })
})

test("fuel edits clear only that fuel's alternative; formula, direct and empty transitions cannot revive old prices", () => {
  let row = { ...port, ...priceSetterFuelEdit("mgo", "Hong Kong - -5") }
  assert.equal(row.mgo, null); assert.equal(row.mgo_formula, "Hong Kong - -5")
  assert.equal(row.hsfo, 100); assert.equal(row.vlsfo_formula, port.vlsfo_formula)
  row = { ...row, ...priceSetterFuelEdit("mgo", "0") }
  assert.equal(buildPriceSetterFuelChanges(row).mgo, 0); assert.equal(row.mgo_formula, null)
  row = { ...row, ...priceSetterFuelEdit("mgo", "") }
  assert.equal(buildPriceSetterFuelChanges(row).mgo, null); assert.equal(row.mgo_formula, null)
})

test("partial numeric/formula drafts retain exact text and Save rejects invalid values", () => {
  for (const draft of ["-", ".", "1e", "1e-", "3.4.5", " Hong Kong + ", "NaN", "0x10"]) {
    const row = { ...port, ...priceSetterFuelEdit("hsfo", draft) }
    assert.equal(priceSetterFuelInput(row, "hsfo", draft).value, draft)
    assert.throws(() => buildPriceSetterFuelChanges(row))
  }
  const row = { ...port, ...priceSetterFuelEdit("hsfo", "1e-2") }
  assert.equal(buildPriceSetterFuelChanges(row).hsfo, 0.01)
  assert.equal(buildPriceSetterFuelChanges({ ...port, ...priceSetterFuelEdit("hsfo", "1e+3") }).hsfo, 1000)
  for (const reference of ["E + 0", "123 + 5", "1e + 3"]) {
    const edited = { ...port, ...priceSetterFuelEdit("hsfo", reference) }
    assert.equal(buildPriceSetterFuelChanges(edited).hsfo_formula, reference)
    assert.equal(edited.hsfo, null)
  }
  const oversized = "X".repeat(10000)
  const oversizedRow = { ...port, ...priceSetterFuelEdit("hsfo", oversized) }
  assert.equal(priceSetterFuelInput(oversizedRow, "hsfo", oversized).value, oversized)
  assert.throws(() => buildPriceSetterFuelChanges(oversizedRow), /no longer than 200/)
})

test("clearing a formula with an older direct price remains blank, including failed Save drafts", () => {
  for (const draft of ["", " "]) {
    const row = { ...port, ...priceSetterFuelEdit("vlsfo", draft) }
    assert.equal(priceSetterFuelInput(row, "vlsfo", draft).value, draft)
    const saved = buildPriceSetterFuelChanges(row)
    assert.equal(saved.vlsfo, null); assert.equal(saved.vlsfo_formula, null)
  }
})

test("direct-only rows do not acquire a new formula workflow or silently clear their saved quote", () => {
  const row = { ...port, name: "Hong Kong", vlsfo_formula: null }
  const text = "Dalian + 5"
  const edited = { ...row, ...priceSetterFuelEdit("hsfo", text, false) }
  assert.equal(edited.hsfo_formula, null)
  assert.deepEqual(priceSetterFuelInput(edited, "hsfo", text, false), { isFormula: false, value: text })
  assert.throws(() => buildPriceSetterFuelChanges(edited), /must be a number/)
})

test("Taiwan defaults use the report's shared basis; a direct/blank edit cannot silently save an ignored quote", () => {
  for (const name of ["Keelung", "Suao", "Hualien"]) {
    for (const label of [name, name.toUpperCase(), ` ${name} `]) {
      const row = { ...port, name: label, vlsfo_formula: null }
      for (const fuel of ["vlsfo", "mgo"] as const) {
        assert.deepEqual(priceSetterFuelInput(row, fuel), { isFormula: true, value: "taichung + 0" })
        assert.equal(buildPriceSetterFuelChanges(row)[`${fuel}_formula`], "taichung + 0")
        for (const value of ["0", "123", "", " "]) {
          const edited = { ...row, ...priceSetterFuelEdit(fuel, value) }
          assert.deepEqual(priceSetterFuelInput(edited, fuel, value), { isFormula: true, value })
          assert.throws(() => buildPriceSetterFuelChanges(edited, { [fuel]: value }), /uses a formula/)
        }
        const edited = { ...row, ...priceSetterFuelEdit(fuel, "Taichung + 10") }
        assert.equal(buildPriceSetterFuelChanges(edited, { [fuel]: "Taichung + 10" })[`${fuel}_formula`], "Taichung + 10")
      }
      assert.equal(priceSetterFuelInput(row, "hsfo").value, 100)
    }
  }
})
