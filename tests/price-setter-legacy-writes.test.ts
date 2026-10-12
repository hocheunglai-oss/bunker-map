import assert from "node:assert/strict"
import test from "node:test"
import { priceSetterLegacyWriteMessage } from "../lib/priceSetterLegacyWrites"

const body = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer

test("old Price Setter direct price/history/settings writes require refresh, not another unchecked mutation", () => {
  assert.match(priceSetterLegacyWriteMessage("pricesetter", "ports", "PATCH")!, /Refresh/)
  for (const method of ["POST", "PATCH", "DELETE"]) {
    assert.ok(priceSetterLegacyWriteMessage("pricesetter", "price_history", method))
    assert.ok(priceSetterLegacyWriteMessage("pricesetter", "remarks", method, body({ id: 105, content: "{}" })))
  }
  for (const value of [null, [], {}, { id: "101", content: "{}" }, { id: 101, content: null }, { id: 101, content: "{}", extra: true }, [{ id: 101, content: "{}" }, { id: 105, content: "{}" }]]) {
    assert.ok(priceSetterLegacyWriteMessage("pricesetter", "remarks", "POST", body(value)))
  }
  assert.ok(priceSetterLegacyWriteMessage("pricesetter", "remarks", "POST", new TextEncoder().encode("{broken").buffer))
})

test("legacy report and port upserts/deletions are blocked; notice edits and reads remain compatible", () => {
  for (const id of [101, 102, 103, 104]) {
    const row = { id, content: JSON.stringify({ reportDate: "09 Oct 2026" }) }
    assert.ok(priceSetterLegacyWriteMessage("pricesetter", "remarks", "POST", body(row)))
    assert.ok(priceSetterLegacyWriteMessage("pricesetter", "remarks", "POST", body([row])))
    assert.ok(priceSetterLegacyWriteMessage("taiwan-remarks", "remarks", "POST", body(row)))
  }
  for (const table of ["ports", "price_history", "remarks"]) for (const method of ["GET", "HEAD"]) assert.equal(priceSetterLegacyWriteMessage("pricesetter", table, method), null)
  assert.ok(priceSetterLegacyWriteMessage("pricesetter", "ports", "POST"))
  assert.ok(priceSetterLegacyWriteMessage("pricesetter", "ports", "DELETE"))
  for (const page of ["taiwan-remarks", "ccinfo", "phonebook", "outlook-addressbook"]) assert.equal(priceSetterLegacyWriteMessage(page, "ports", "PATCH"), null)
})

test("Taiwan Remarks permits only exact notice upserts, not an alternative privileged snapshot/settings writer", () => {
  for (const id of [1, 2, 3]) for (const value of [{ id, content: "NOTICE" }, [{ id, content: "NOTICE" }]]) {
    assert.equal(priceSetterLegacyWriteMessage("taiwan-remarks", "remarks", "POST", body(value)), null)
  }
  assert.equal(priceSetterLegacyWriteMessage("taiwan-remarks", "remarks", "POST", body([{ id: 1, content: "" }, { id: 2, content: "" }, { id: 3, content: "{}" }])), null)
  for (const method of ["PATCH", "DELETE"]) assert.ok(priceSetterLegacyWriteMessage("taiwan-remarks", "remarks", method, body({ id: 1, content: "" })))
  for (const value of [null, [], {}, { id: "1", content: "" }, { id: 1, content: null }, { id: 1, content: "", extra: true }, { id: 105, content: "{}" }, [{ id: 1, content: "" }, { id: 101, content: "{}" }]]) {
    assert.ok(priceSetterLegacyWriteMessage("taiwan-remarks", "remarks", "POST", body(value)))
  }
  assert.ok(priceSetterLegacyWriteMessage("taiwan-remarks", "remarks", "POST", new TextEncoder().encode("{broken").buffer))
})

test("old market history and snapshot writers are fenced after migration while reads remain compatible", () => {
  for (const page of ["hongkong-price-history", "taiwan-price-history"]) {
    for (const table of ["ports", "price_history"]) {
      for (const method of ["POST", "PATCH", "DELETE"]) assert.ok(priceSetterLegacyWriteMessage(page, table, method))
      for (const method of ["GET", "HEAD"]) assert.equal(priceSetterLegacyWriteMessage(page, table, method), null)
    }
    assert.ok(priceSetterLegacyWriteMessage(page, "remarks", "POST", body({ id: page.startsWith("taiwan") ? 101 : 102, content: "{}" })))
    for (const id of [1, 2, 3, 103, 104, 105, page.startsWith("taiwan") ? 102 : 101]) {
      assert.ok(priceSetterLegacyWriteMessage(page, "remarks", "POST", body({ id, content: "{}" })))
    }
    for (const method of ["PATCH", "DELETE"]) assert.ok(priceSetterLegacyWriteMessage(page, "remarks", method, body({ id: 101, content: "{}" })))
  }
})
