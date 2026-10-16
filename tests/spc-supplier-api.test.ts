import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
// Infrastructure-only adapters; all tested validation/merge/ack paths are the real API and store.
import { createSupplierRoute, supplierMemoryDb } from "./fixtures/spc-supplier-api.mjs"

const empty = { key: "spc-supplier-overrides", payload: { records: [], barges: [], contacts: [] }, updated_at: "2026-10-01T00:00:00Z" }
const info = (paymentTerms = "30") => ({ paymentTerms, qualityClaimBar: "", supplierTrader: "", availableGrade: "", foBdn: "", goBdn: "" })
const routeFor = (db: ReturnType<typeof supplierMemoryDb>, options = {}) => createSupplierRoute({ createClient: db.client, ...options })
const saved = (db: ReturnType<typeof supplierMemoryDb>) => { const { stored } = db.state(); assert.ok(stored); return stored }
const baseline = async (route: ReturnType<typeof createSupplierRoute>, key = "SYNTHETICALPHA") => (await route.get()).body.records.find((row: { key: string }) => row.key === key).editVersions
const details = (expectedVersions: unknown, values = {}) => ({ action: "save", supplier: { key: "SYNTHETICALPHA", name: "SYNTHETIC ALPHA", info: info(), expectedVersions, requestId: randomUUID(), ...values } })
const contact = (expectedVersions: unknown, values = {}) => ({ action: "save-contacts", contacts: { supplierKey: "SYNTHETICALPHA", contacts: [{ id: "synthetic-person", role: "sales", name: "SYNTHETIC PERSON", mobile: "synthetic-number" }], expectedVersions, requestId: randomUUID(), ...values } })

test("supplier baselines are stable effective-source hashes, independent of generatedAt", async () => {
  const db = supplierMemoryDb(), route = routeFor(db)
  const first = await baseline(route), second = await baseline(route)
  assert.deepEqual(first, second)
  assert.ok(Object.values(first).every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)))
})
test("simultaneous first-row different-section saves retain both operations", async () => {
  const db = supplierMemoryDb({ holdReads: true }), left = routeFor(db), right = routeFor(db)
  // Capture from a separate non-held read adapter to avoid consuming the held mutation reads.
  const expected = await baseline(routeFor(supplierMemoryDb()))
  const responses = await Promise.all([left.patch(details(expected)), right.patch(contact(expected))])
  assert.deepEqual(responses.map(result => result.status), [200, 200])
  const { stored, audits, rpcCalls } = db.state()
  assert.ok(stored)
  assert.equal(stored.payload.records[0].info.paymentTerms, "30")
  assert.equal(stored.payload.contacts[0].contacts[0].name, "SYNTHETIC PERSON")
  assert.equal(audits, 2); assert.equal(rpcCalls, 3)
})
test("unrelated supplier writes merge; same section stale edit conflicts", async () => {
  const db = supplierMemoryDb({ initial: empty }), route = routeFor(db), expected = await baseline(route)
  assert.equal((await route.patch(details(expected))).status, 200)
  const committed = db.state()
  assert.equal((await route.patch(details(expected, { info: info("90") }))).status, 409)
  assert.deepEqual(db.state(), committed)
  const beta = await baseline(route, "SYNTHETICBETA")
  assert.equal((await route.patch(details(beta, { key: "SYNTHETICBETA", name: "SYNTHETIC BETA" }))).status, 200)
  assert.equal(saved(db).payload.records.length, 2)
})
test("lost acknowledgement retry returns one durable operation without another audit", async () => {
  const db = supplierMemoryDb({ loseResponse: true }), route = routeFor(db), expected = await baseline(route), payload = details(expected)
  assert.equal((await route.patch(payload)).status, 500)
  const state = db.state(), retry = await route.patch(payload)
  assert.equal(retry.status, 200); assert.equal(retry.body.mutation.replayed, true)
  assert.deepEqual(db.state(), state)
  const mismatched = structuredClone(payload); mismatched.supplier.info.paymentTerms = "99"
  assert.equal((await route.patch(mismatched)).status, 409)
  assert.deepEqual(db.state(), state)
})
test("create collision, missing baseline, unknown action, view-only and malformed arrays cannot mutate", async () => {
  const db = supplierMemoryDb(), route = routeFor(db), expected = await baseline(route)
  const requests = [details(undefined), details(expected, { key: "" }), { action: "surprise", supplier: details(expected).supplier },
    contact(expected, { contacts: null }), contact(expected, { contacts: [null] }), contact(expected, { contacts: [{ role: "invalid", name: "X", mobile: "" }] }),
    contact(expected, { contacts: [{ role: "sales", name: "", mobile: "" }] })]
  for (const payload of requests) assert.ok((await route.patch(payload)).status >= 400)
  assert.equal((await routeFor(db, { permission: "view" }).patch(details(expected))).status, 403)
  assert.equal(db.state().audits, 0); assert.equal(db.state().stored, null)
})
test("incomplete optional sources do not permit clearing fleet/contact data", async () => {
  const db = supplierMemoryDb(), route = routeFor(db, { optionalUnavailable: true }), expected = await baseline(route)
  assert.equal(expected.barges, null); assert.equal(expected.contacts, null)
  assert.equal((await route.patch(contact(expected, { contacts: [] }))).status, 409)
  assert.equal((await route.patch(details(expected))).status, 200)
  assert.equal(saved(db).payload.contacts.length, 0)
})
test("rename and delete guard every affected section and preserve tombstones", async () => {
  const db = supplierMemoryDb(), route = routeFor(db), old = await baseline(route)
  assert.equal((await route.patch(contact(old))).status, 200)
  assert.equal((await route.patch(details(old, { name: "SYNTHETIC RENAMED" }))).status, 409)
  assert.equal((await route.patch({ action: "delete", key: "SYNTHETICALPHA", expectedVersions: old, requestId: randomUUID() })).status, 409)
  const latest = await baseline(route)
  const renamed = await route.patch(details(latest, { name: "SYNTHETIC RENAMED" }))
  assert.equal(renamed.status, 200)
  const record = renamed.body.records.find((row: { key: string }) => row.key === "SYNTHETICRENAMED")
  assert.equal(record.contacts.length, 1)
  const deletion = { action: "delete", key: record.key, expectedVersions: record.editVersions, requestId: randomUUID() }
  assert.equal((await route.patch(deletion)).status, 200)
  assert.equal((await route.patch(deletion)).body.mutation.replayed, true)
  assert.ok(saved(db).payload.records.filter((row: { deleted?: boolean }) => row.deleted).length === 2)
  assert.equal((await route.patch(details(undefined, { key: "" }))).status, 409)
})
test("atomic audit failure cannot return success or alter the store", async () => {
  const db = supplierMemoryDb({ initial: empty, auditFailure: true }), route = routeFor(db), expected = await baseline(route), before = db.state().stored
  assert.equal((await route.patch(details(expected))).status, 500)
  assert.deepEqual(db.state().stored, before); assert.equal(db.state().audits, 0)
})
test("rename materializes actual workbook-backed children with unchanged IDs and business fields", async () => {
  const db = supplierMemoryDb(), route = routeFor(db, { sheetChildren: true })
  const original = (await route.get()).body.records.find((row: { key: string }) => row.key === "SYNTHETICALPHA")
  assert.equal(original.barges.length, 1); assert.equal(original.contacts.length, 1)
  const renamed = await route.patch(details(original.editVersions, { name: "SYNTHETIC RENAMED" }))
  assert.equal(renamed.status, 200)
  const fresh = (await route.get()).body.records.find((row: { key: string }) => row.key === "SYNTHETICRENAMED")
  const dataOnly = (rows: Array<Record<string, unknown>>) => rows.map(row => Object.fromEntries(Object.entries(row).filter(([field]) => field !== "source")))
  assert.deepEqual(dataOnly(fresh.barges), dataOnly(original.barges))
  assert.deepEqual(dataOnly(fresh.contacts), dataOnly(original.contacts))
  assert.equal((await route.get()).body.records.some((row: { key: string }) => row.key === "SYNTHETICALPHA"), false)
})
