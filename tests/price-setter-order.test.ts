import assert from "node:assert/strict"
import test from "node:test"
import { confirmPriceSetterOrder, insertVisiblePort, moveVisiblePort, priceSetterOrderSnapshot, validatePriceSetterReorder } from "../lib/priceSetterOrder"

const ids = Array.from({ length: 5 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`)
test("filtered reordering moves visible IDs through their slots without moving hidden rows", () => {
  assert.deepEqual(moveVisiblePort(ids, [ids[1], ids[3]], ids[3], ids[1]), [ids[0], ids[3], ids[2], ids[1], ids[4]])
  assert.deepEqual(moveVisiblePort(ids, ids, ids[0], ids[3]), [ids[1], ids[2], ids[3], ids[0], ids[4]])
  assert.deepEqual(moveVisiblePort(ids, ids, ids[2], ids[2]), ids)
  for (const visible of [[ids[0], ids[0]], [ids[3], ids[1]], ["missing"]]) assert.throws(() => moveVisiblePort(ids, visible, ids[0], ids[1]), /Reload saved/)
  assert.deepEqual(ids[0], "00000000-0000-4000-8000-000000000001")
})

test("order snapshots retain null/duplicate/gapped positions but reject invalid IDs or positions", () => {
  assert.deepEqual(priceSetterOrderSnapshot(ids.map((id, i) => ({ id, display_order: i < 2 ? 10 : null }))), ids.map((id, i) => [id, i < 2 ? 10 : null]))
  for (const rows of [[{ id: "bad" }], [{ id: ids[0] }, { id: ids[0] }], [{ id: ids[0], display_order: 1.5 }], [{ id: ids[0], display_order: "1" }], [{ id: ids[0], display_order: 2147483648 }]]) assert.throws(() => priceSetterOrderSnapshot(rows), /Reload saved/)
})

test("explicit insertion always matches the indicated side, with hidden rows left in their full-list slots", () => {
  for (const visible of [ids, [ids[0], ids[2], ids[4]], [ids[1], ids[3]]]) {
    for (const from of visible) for (const target of visible) for (const edge of ["before", "after"] as const) {
      const result = insertVisiblePort(ids, visible, from, target, edge)
      assert.deepEqual(new Set(result), new Set(ids))
      ids.forEach((id, index) => { if (!visible.includes(id)) assert.equal(result[index], id) })
      const sequence = result.filter(id => visible.includes(id))
      if (from === target) assert.deepEqual(result, ids)
      else {
        assert.equal(sequence.indexOf(from), sequence.indexOf(target) + (edge === "after" ? 1 : -1))
        assert.deepEqual(sequence.filter(id => id !== from), visible.filter(id => id !== from))
      }
    }
  }
  assert.deepEqual(insertVisiblePort(ids, ids, ids[0], ids[4], "after"), [...ids.slice(1), ids[0]])
  assert.deepEqual(insertVisiblePort(ids, ids, ids[4], ids[0], "before"), [ids[4], ...ids.slice(0, 4)])
  assert.deepEqual(insertVisiblePort(ids, ids, ids[1], ids[2], "before"), ids, "adjacent no-op does not need a save")
  for (const visible of [[ids[0], ids[0]], [ids[3], ids[1]], ["missing"]]) assert.throws(() => insertVisiblePort(ids, visible, ids[0], ids[1], "before"), /Reload saved/)
  assert.throws(() => insertVisiblePort(ids, ids, ids[0], ids[1], "sideways" as "before"), /Reload saved/)
})

test("reorder request is a bounded permutation with no unrelated writable fields", () => {
  const input = { operation: "reorder", expected: ids.map(id => [id, null]), order: [...ids].reverse() }
  assert.deepEqual(validatePriceSetterReorder(input), input)
  for (const invalid of [null, [], {}, { ...input, operation: "delete" }, { ...input, extra: true }, { ...input, expected: [] }, { ...input, expected: [[ids[0], undefined]], order: [ids[0]] }, { ...input, order: ids.slice(1) }, { ...input, order: [ids[0], ids[0], ...ids.slice(2)] }, { ...input, expected: [[ids[0], null, "spoof"]] }]) assert.throws(() => validatePriceSetterReorder(invalid), /Reload saved/)
})

test("complete reorder permutations above the Data API row cap are not arbitrarily refused",()=>{
  const ids=Array.from({length:2501},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,"0")}`)
  const input={operation:"reorder",expected:ids.map(id=>[id,null]),order:[...ids].reverse()}
  assert.deepEqual(validatePriceSetterReorder(input),input)
})

test("order success must confirm every ID and position in the requested sequence", () => {
  const order = ids.map((id, i) => [id, i + 1])
  for (const replayed of [false, true]) assert.deepEqual(confirmPriceSetterOrder({ order, replayed }, ids), order)
  for (const result of [null, {}, { order }, { order: [...order].reverse(), replayed: false }, { order: order.slice(1), replayed: false }, { order: [...order.slice(0, 4), [ids[4], 9]], replayed: true }]) assert.throws(() => confirmPriceSetterOrder(result, ids), /could not be confirmed/)
})
