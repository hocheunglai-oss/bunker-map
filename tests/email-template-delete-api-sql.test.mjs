import assert from "node:assert/strict"
import test from "node:test"
import { templateDeletionFixture } from "./fixtures/email-template-delete-sql.mjs"

test("actual Outlook deletion API, persistence, audit and backup-fence contract", async t => {
  const fixture = await templateDeletionFixture()
  try {
    await t.test("anonymous and View-only users cannot delete or invoke the database", async () => {
      const before = await fixture.state()
      for (const [permission, status] of [["anonymous", 401], ["view", 403]]) {
        fixture.controls.permission = permission
        assert.equal((await fixture.request()).status, status)
        assert.deepEqual(await fixture.state(), before)
        assert.equal(fixture.requests.length, 0)
      }
      fixture.controls.permission = "edit"
    })
    await t.test("missing expected version is rejected before the database", async () => {
      assert.equal((await fixture.request({ expectedRevision: null })).status, 409)
      assert.equal(fixture.requests.length, 0)
    })
    await t.test("stale revision cannot delete the current row or create an audit event", async () => {
      const before = await fixture.state()
      const result = await fixture.request({ expectedRevision: 2 })
      assert.equal(result.status, 409)
      assert.equal(result.body.code, "EMAIL_TEMPLATE_CONFLICT")
      assert.deepEqual(await fixture.state(), before)
    })
    await t.test("deletion does not need recipient-map availability and records exactly one auditable deletion", async () => {
      const before = await fixture.state()
      assert.equal((await fixture.request()).status, 200)
      const after = await fixture.state()
      assert.deepEqual(after.templates.map(row => row.id), ["remaining"])
      assert.equal(after.audit.length, 1)
      assert.equal(after.audit[0].operation, "DELETE")
      assert.equal(after.audit[0].actor_id, "SC")
      assert.equal(after.audit[0].before_row.id, "target")
      assert.equal(after.audit[0].after_row, null)
      assert.ok(after.fence.epoch > before.fence.epoch)
      assert.equal(fixture.recipientLoads(), 0)
      assert.equal((await fixture.get("target")).status, 404)
      assert.equal((await fixture.get("remaining")).status, 200)
    })
    await t.test("duplicate and unknown deletions are safe no-ops with no additional audit", async () => {
      const before = await fixture.state()
      assert.equal((await fixture.request()).status, 200)
      assert.equal((await fixture.request({ id: "unknown" })).status, 200)
      assert.deepEqual(await fixture.state(), before)
    })
    await t.test("the final template remains protected; deletion is atomic on failure", async () => {
      const before = await fixture.state()
      assert.equal((await fixture.request({ id: "remaining" })).status, 500)
      assert.deepEqual(await fixture.state(), before)
    })
    await t.test("failure does not leak database internals or mutate data", async () => {
      const before = await fixture.state()
      fixture.controls.rpcError = { code: "XX000", message: "Synthetic private database diagnostic" }
      const result = await fixture.request({ id: "remaining" })
      assert.equal(result.status, 500)
      assert.deepEqual(result.body, { message: "Template action failed." })
      assert.deepEqual(await fixture.state(), before)
      fixture.controls.rpcError = null
    })
    assert.ok(fixture.permissions.every(item => item.page === "email-templates" && ["edit", "view"].includes(item.access)))
  } finally { await fixture.close() }
})
