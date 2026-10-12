import assert from "node:assert/strict"
import test from "node:test"
import { buildPriceSetterChanges, confirmPriceSetterDeletion, confirmPriceSetterSave, priceSetterDeletionFallbacks, priceSetterDeletionSnapshot, priceSetterSnapshot, validatePriceSetterDeletion, validatePriceSetterSave } from "../lib/priceSetterMutation"

const port = { id: "11111111-1111-4111-8111-111111111111", name: "Basis", lat: 0, lng: 0, hsfo: 0, vlsfo: 800, mgo: null, hsfo_formula: null, vlsfo_formula: null, mgo_formula: null, updated_at: "2026-10-08" }

test("deletion baseline includes exact row kind/order, zero prices and only that port's reviewed overrides", () => {
  const expected=priceSetterDeletionSnapshot({...port,type:"port",display_order:0})
  assert.equal(expected.hsfo,0);assert.equal(expected.display_order,0);assert.equal(expected.type,"port")
  const expectedFallbacks=priceSetterDeletionFallbacks(port.name,{"basis::hsfo":"NA","other::mgo":"SE"})
  assert.deepEqual(expectedFallbacks,{"basis::hsfo":"NA"})
  const input={portId:port.id,expected,expectedFallbacks}
  assert.deepEqual(validatePriceSetterDeletion(input),input)
  for(const bad of [{...expected,type:"other"},{...expected,display_order:"1"},{...expected,display_order:1.5},{...expected,display_order:2147483648}])assert.throws(()=>priceSetterDeletionSnapshot(bad))
})

test("deletion cannot smuggle unrelated overrides or omit saved order/kind", () => {
  const input={portId:port.id,expected:priceSetterDeletionSnapshot(port),expectedFallbacks:{}}
  for(const bad of [{...input,expected:{...input.expected,type:undefined}},{...input,expectedFallbacks:{"other::hsfo":"NA"}},{...input,expectedFallbacks:{"basis::mgo":null}},{...input,expected:{...input.expected,type:"divider"},expectedFallbacks:{"basis::mgo":"SE"}}]) {
    // undefined is absent on the actual JSON wire.
    assert.throws(()=>validatePriceSetterDeletion(JSON.parse(JSON.stringify(bad))))
  }
})

test("deletion success requires the exact ID and an explicit replay flag; malformed replies are uncertain", () => {
  assert.deepEqual(confirmPriceSetterDeletion({deletedId:port.id,replayed:true},port.id),{deletedId:port.id,replayed:true})
  for(const bad of [null,[],{}, {deletedId:port.id},{deletedId:"wrong",replayed:false},{deletedId:port.id,replayed:false,extra:1}])assert.throws(()=>confirmPriceSetterDeletion(bad,port.id),/could not be confirmed/)
})

test("price save preserves numeric zero and treats only empty numeric fields as null", () => {
  const changes = buildPriceSetterChanges(port)
  assert.equal(changes.lat, 0); assert.equal(changes.lng, 0); assert.equal(changes.hsfo, 0)
  assert.equal(changes.mgo, null)
  assert.deepEqual(buildPriceSetterChanges({ ...port, lat: " 0 ", hsfo: "0", vlsfo: " ", mgo: "1e3" }), { ...changes, vlsfo: null, mgo: 1000 })
})

test("snapshot keeps the exact saved name/formulas for conflict detection while a new edit is normalized", () => {
  const original = { ...port, name: " Basis ", vlsfo_formula: "  Reference + 0  " }
  assert.equal(priceSetterSnapshot(original).name, " Basis ")
  assert.equal(priceSetterSnapshot(original).vlsfo_formula, "  Reference + 0  ")
  assert.equal(buildPriceSetterChanges(original).name, "Basis")
  assert.equal(buildPriceSetterChanges(original).vlsfo_formula, "Reference + 0")
})

test("invalid numbers, coordinates, negative prices and malformed formulas fail before a request", () => {
  for (const value of [NaN, Infinity, -Infinity, "NaN", "Infinity", "0x10", "word", {}, []]) assert.throws(() => buildPriceSetterChanges({ ...port, hsfo: value }))
  for (const [field, value] of [["hsfo", -1], ["lat", 91], ["lng", -181], ["mgo_formula", "not a formula"], ["name", " "], ["vlsfo_formula", "x".repeat(201)]] as const) assert.throws(() => buildPriceSetterChanges({ ...port, [field]: value }))
})

test("request contract refuses spoofed versions, identifiers, server timestamps and omitted fields", () => {
  const input = { portId: port.id, expected: priceSetterSnapshot(port), changes: buildPriceSetterChanges(port) }
  assert.deepEqual(validatePriceSetterSave(input), input)
  for (const bad of [null, [], { ...input, portId: "1" }, { ...input, recordedAt: "2026-10-01" }, { ...input, expected: { name: "Basis" } }, { ...input, changes: { ...input.changes, updated_at: "2026-10-01" } }, { ...input, changes: { ...input.changes, id: "other" } }]) assert.throws(() => validatePriceSetterSave(bad))
})

test("complete confirmation must agree with the requested prices, history and a real market date", () => {
  const changes = buildPriceSetterChanges(port)
  const result = { replayed: false, ports: [{ ...port }], history: { id: "history", port_id: port.id, hsfo: 0, vlsfo: 800, mgo: null, recorded_at: "2026-10-08T12:00:00.123456" } }
  assert.equal(confirmPriceSetterSave(result, port.id, changes, "2026-10-08").length, 1)
  for (const bad of [{ ...result, history: null }, { ...result, ports: [port, port] }, { ...result, ports: [{ ...port, hsfo: 99 }] }, { ...result, ports: [{ ...port, updated_at: "2026-02-30" }] }, { ...result, history: { ...result.history, hsfo: 99 } }, { ...result, history: { ...result.history, recorded_at: "2026-10-07T12:00:00" } }, { ...result, history: { ...result.history, recorded_at: "2026-10-08T25:00:00" } }, { ...result, ports: [port, { id: "wrong-linked-row" }] }]) {
    assert.throws(() => confirmPriceSetterSave(bad, port.id, changes), /could not be confirmed/)
  }
  assert.throws(() => confirmPriceSetterSave(result, port.id, changes, "2026-10-09"), /could not be confirmed/)
  assert.throws(() => priceSetterSnapshot({ ...port, updated_at: "2026-02-30" }))
})
