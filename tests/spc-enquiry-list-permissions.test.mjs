import assert from "node:assert/strict"
import test from "node:test"
import { createEnquiryListRoute } from "./fixtures/spc-enquiry-list-api.mjs"
import { todayEnquiry } from "./fixtures/spc-today-enquiries-api.mjs"
const records = "scope=records&status=cancelled&limit=250"

test("Lost Record View/Edit reads cancelled records without hidden New Enquiry permission", async () => {
  for (const permission of ["view", "edit"]) {
    const h = createEnquiryListRoute({ permissions: { "spc-lost-record": permission, "spc-buyer-enquiries": "none" }, rows: [todayEnquiry(1, { status: "cancelled" }), todayEnquiry(2, { status: "open" }), todayEnquiry(3, { status: "cancelled", created_by_username: "colleague@example.test" })] })
    const r = await h.get(records)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.enquiries.map(row => row.id), [todayEnquiry(1).id, todayEnquiry(3).id])
    assert.deepEqual(h.requiredPermissions, [["spc-lost-record", "view"]])
    assert.deepEqual(h.queries[0].filters, [["status", "cancelled"]])
    assert.match(r.cache, /private.*no-store/)
  }
})

test("Lost Record none cannot be replaced by New Enquiry Edit; unsigned and blank username deny before DB", async () => {
  for (const options of [{ permissions: { "spc-lost-record": "none", "spc-buyer-enquiries": "edit" }, status: 403 }, { authenticated: false, permissions: { "spc-lost-record": "view" }, status: 401 }, { username: "", permissions: { "spc-lost-record": "view" }, status: 401 }]) {
    const h = createEnquiryListRoute(options), r = await h.get(records)
    assert.equal(r.status, options.status); assert.equal(h.queries.length, 0)
  }
})

test("Lost Record-only permission cannot expand into open/all history, cursors, bootstrap or ambiguous requests", async () => {
  const queries = ["scope=records", "scope=records&status=open", "scope=records&status=quoted", "scope=records&status=cancelled&createdAfter=2026-10-01T00%3A00%3A00Z", "scope=records&status=cancelled&updatedAfter=2026-10-01T00%3A00%3A00Z", "scope=records&status=cancelled&bootstrap=1", "scope=records&status=cancelled&other=1", "scope=records&status=cancelled&status=open", "scope=records&status=cancelled&scope=mine", "scope=records&status=cancelled&limit=0", "scope=records&status=cancelled&limit=251", "scope=records&status=cancelled&limit=NaN", "scope=records&status=cancelled&limit=1.5"]
  for (const query of queries) for (const buyerPermission of ["none", "view"]) {
    const h = createEnquiryListRoute({ permissions: { "spc-lost-record": "view", "spc-buyer-enquiries": buyerPermission } }), r = await h.get(query)
    assert.equal(r.status, 400, query); assert.equal(h.queries.length, 0, query)
  }
})

test("own feed retains buyer View requirement and exact current-owner filter", async () => {
  for (const query of ["", "scope=mine"]) {
    const h = createEnquiryListRoute({ permissions: { "spc-buyer-enquiries": "view", "spc-lost-record": "none" }, rows: [todayEnquiry(1), todayEnquiry(2, { created_by_username: "colleague@example.test" })] }), r = await h.get(query)
    assert.equal(r.status, 200); assert.equal(r.body.enquiries.length, 1)
    assert.deepEqual(h.requiredPermissions, [["spc-buyer-enquiries", "view"]])
    assert.deepEqual(h.queries[0].filters, [["created_by_username", "synthetic@example.test"]])
  }
  const h = createEnquiryListRoute({ permissions: { "spc-lost-record": "edit" } })
  assert.equal((await h.get("scope=mine")).status, 403); assert.equal(h.queries.length, 0)
})

test("shared and legacy Speed Board scope retain BOTH buyer View and Chrome View", async () => {
  for (const query of ["scope=shared", "createdAfter=2026-07-23T09%3A20%3A00.000Z"]) {
    const h = createEnquiryListRoute({ permissions: { "spc-buyer-enquiries": "view", "spc-chrome-extension": "view" }, rows: [todayEnquiry(1), todayEnquiry(2, { created_by_username: "colleague@example.test" })] }), r = await h.get(query)
    assert.equal(r.status, 200); assert.equal(r.body.enquiries.length, 2)
    assert.equal(h.queries[0].filters.some(([key]) => key === "created_by_username"), false)
    for (const permissions of [{ "spc-buyer-enquiries": "view" }, { "spc-chrome-extension": "view", "spc-lost-record": "edit" }]) {
      const denied = createEnquiryListRoute({ permissions })
      assert.equal((await denied.get(query)).status, 403); assert.equal(denied.queries.length, 0)
    }
  }
})

test("own bootstrap remains buyer-Edit only and unsupported scope never queries DB", async () => {
  for (const permission of ["view", "edit"]) {
    const h = createEnquiryListRoute({ permissions: { "spc-buyer-enquiries": permission } }), r = await h.get("scope=mine&bootstrap=1")
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.supplierTraders, permission === "edit" ? ["SYNTHETIC"] : [])
    assert.deepEqual(r.body.buyerLostReasons, permission === "edit" ? ["UNKNOWN"] : [])
  }
  const h = createEnquiryListRoute({ permissions: { "spc-buyer-enquiries": "edit", "spc-lost-record": "edit" } })
  assert.equal((await h.get("scope=unsupported")).status, 400); assert.equal(h.queries.length, 0)
})
