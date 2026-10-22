import assert from "node:assert/strict"
import test from "node:test"
import { cases, sdkWriteHarness } from "./fixtures/spc-write-conflicts-api.mjs"

for (const [domain, message, details, oldDetails, kind] of cases) for (const legacy of [false, true]) {
  test(`${domain} ${legacy ? "legacy" : "new"} exact ${kind}: ${message}`, async () => {
    const app = sdkWriteHarness(domain, { code: legacy ? "40001" : "P0001", message, details: legacy ? oldDetails : details })
    const result = await app.patch()
    assert.equal(result.status, 409, JSON.stringify(result))
    if (domain === "supplier" && kind === "conflict") {
      assert.equal(app.posts(), 4, "only genuine baseline contention uses the four application attempts")
      assert.match(result.body.message, /Other supplier changes/)
    } else {
      assert.equal(app.posts(), 1, "unconfirmed writes and non-supplier conflicts are never CAS-retried")
      assert.equal(result.body.message, message)
    }
    assert.deepEqual(Object.keys(result.body), ["message"], "no SQL diagnostics or internal markers are exposed")
  })
}

for (const domain of ["supplier", "stem", "fixture"]) {
  const sample = cases.find(row => row[0] === domain)
  for (const [label, error] of [
    ["genuine serialization", { code: "40001", message: "could not serialize access due to concurrent update; private diagnostic" }],
    ["unknown P0001", { code: "P0001", message: "private database diagnostic" }],
    ["wrong detail", { code: "P0001", message: sample[1], details: sample[2] + " extra" }],
    ["wrong message", { code: "P0001", message: sample[1] + " extra", details: sample[2] }],
    ["wrong message case", { code: "P0001", message: sample[1].toLowerCase(), details: sample[2] }],
    ["wrong SQLSTATE", { code: "XX000", message: sample[1], details: sample[2] }],
    ["legacy with wrong details", { code: "40001", message: sample[1], details: "private diagnostic" }],
    ["other domain marker", { code: "P0001", message: sample[1], details: domain === "stem" ? "SPC_FIXTURE_CONFLICT" : "SPC_STEM_CONFLICT" }],
  ]) test(`${domain} ${label} remains unconfirmed and redacted without retry`, async () => {
    const app = sdkWriteHarness(domain, error), result = await app.patch()
    assert.equal(result.status, 500, JSON.stringify(result)); assert.equal(app.posts(), 1)
    assert.equal(result.body.message, { supplier: "Failed to save supplier.", stem: "Failed to update SPC enquiry.", fixture: "Failed to save SPC fixture." }[domain])
    assert.equal(JSON.stringify(result.body).includes("private"), false)
  })
  for (const [options, status] of [[{ actor: null }, 401], [{ permission: "view" }, 403]]) test(`${domain} auth still rejects before RPC (${status})`, async () => {
    const app = sdkWriteHarness(domain, null, options), result = await app.patch()
    assert.equal(result.status, status); assert.equal(app.posts(), 0)
  })
}

test("supplier new exact contention rebases once then acknowledges one save", async () => {
  const app = sdkWriteHarness("supplier", attempt => attempt === 1 ? { code: "P0001", message: cases[0][1], details: cases[0][2] } : null)
  assert.equal((await app.patch()).status, 200); assert.equal(app.posts(), 2)
})
