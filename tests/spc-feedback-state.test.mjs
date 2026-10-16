import assert from "node:assert/strict"
import test from "node:test"
import { feedbackRuntime, feedbackSchemaSql, feedbackSeedSql, feedbackStateSql, feedbackActor, feedbackId } from "./fixtures/spc-feedback-api.mjs"

test("actual feedback API and helper preserve reviews with exact timestamp CAS", { timeout: 120000 }, async t => {
  assert.ok(process.env.PGLITE_MODULE_PATH, "An explicitly configured isolated PGlite runtime is required")
  const { PGlite } = await import(process.env.PGLITE_MODULE_PATH), db = new PGlite()
  const f = feedbackRuntime((sql, params) => db.query(sql, params))
  try {
    await db.exec(feedbackSchemaSql() + feedbackSeedSql)
    const before = async () => (await db.query(feedbackStateSql)).rows
    await t.test("sign-in, View/edit and ADMIN review guards deny before database access", async () => {
      for (const actor of [null, { ...feedbackActor, permissions: { "spc-feedback": "none" } }, { ...feedbackActor, mustChangePassword: true }]) {
        f.controls.actor = actor
        for (const method of ["GET", "POST", "PATCH"]) {
          const count = f.calls.length, result = await f.send(method, {})
          assert.equal(result.status, actor ? 403 : 401)
          assert.equal(result.headers.get("cache-control"), "private, no-store"); assert.equal(f.calls.length, count)
        }
      }
      for (const actor of [{ ...feedbackActor, permissions: { "spc-feedback": "view" } }, { ...feedbackActor, role: "BUYER TRADER" }]) {
        f.controls.actor = actor
        const count = f.calls.length
        assert.equal((await f.send("PATCH", {})).status, 403); assert.equal(f.calls.length, count)
      }
      f.controls.actor = { ...feedbackActor }
    })
    await t.test("missing baseline and malformed requests fail without a write", async () => {
      const state = await before(), count = f.calls.length
      for (const body of [null, [], "wrong"]) assert.equal((await f.send("PATCH", body)).status, 400)
      assert.equal((await f.send("PATCH", { id: feedbackId, status: "CLOSED" })).status, 409)
      for (const expectedUpdatedAt of ["2026-02-30T00:00:00Z", "2026-10-16T00:00:00.1234567Z", 123]) {
        assert.equal((await f.send("PATCH", { id: feedbackId, status: "CLOSED", expectedUpdatedAt })).status, 400)
      }
      assert.equal(f.calls.length, count); assert.deepEqual(await before(), state)
    })
    let baseline
    await t.test("raw six-digit baseline updates one row and acknowledges exact submitted review", async () => {
      const read = await f.send()
      baseline = read.body.records[0].updatedAt
      assert.match(baseline, /\.123456[+Z]/)
      const result = await f.send("PATCH", { id: feedbackId, status: "COMPLETED", adminResponse: "  Review A completed  ", expectedUpdatedAt: baseline })
      assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.body.record.adminResponse, "Review A completed")
      assert.notEqual(result.body.record.updatedAt, baseline)
      assert.equal(result.headers.get("cache-control"), "private, no-store")
      assert.deepEqual(f.writes.at(-1).filters, [["id", feedbackId], ["updated_at", baseline]])
      assert.equal(f.writes.at(-1).affected, 1)
      assert.equal(f.auditHeaders.at(-1)["x-bunker-audit-action"], "review-feedback")
      assert.equal(f.auditHeaders.at(-1)["x-bunker-audit-target-id"], feedbackId)
    })
    await t.test("a second administrator's stale review returns 409 and leaves A's row unchanged", async () => {
      const state = await before()
      f.controls.actor = { ...feedbackActor, username: "admin-b@example.invalid", displayName: "Synthetic Admin B" }
      const result = await f.send("PATCH", { id: feedbackId, status: "REVIEWING", adminResponse: "Stale B", expectedUpdatedAt: baseline })
      assert.equal(result.status, 409); assert.deepEqual(await before(), state); assert.equal(f.writes.at(-1).affected, 0)
    })
    await t.test("missing rows and microsecond-truncated baselines never create or overwrite", async () => {
      const state = await before(), raw = (await f.send()).body.records[0].updatedAt
      for (const [id, expectedUpdatedAt] of [["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", raw], [feedbackId, "2026-10-16T00:00:00.123Z"]]) {
        assert.equal((await f.send("PATCH", { id, expectedUpdatedAt, status: "CLOSED" })).status, 409)
      }
      assert.deepEqual(await before(), state)
    })
    await t.test("non-admin reads are creator-filtered and allowed submissions retain ownership", async () => {
      f.controls.actor = { ...feedbackActor, role: "BUYER TRADER" }
      const result = await f.send()
      assert.equal(result.status, 200); assert.deepEqual(f.calls.at(-1).filters, [["created_by_user_id", feedbackActor.userId]])
      const created = await f.send("POST", { category: "SUGGESTION", title: "  New idea  ", message: "Details", area: "" })
      assert.equal(created.status, 201); assert.equal(created.body.record.title, "New idea")
      assert.equal(created.body.record.createdByUsername, feedbackActor.username); assert.equal(created.body.record.status, "NEW")
    })
    await t.test("database errors and absent read payload are unavailable, never verified empty", async () => {
      for (const fault of ["database", "null-read"]) {
        f.controls.fault = fault
        const result = await f.send()
        assert.equal(result.status, fault === "null-read" ? 503 : 500)
        assert.equal(Object.hasOwn(result.body, "records"), false)
        assert.doesNotMatch(result.body.message, /synthetic database|sql|psql|constraint/i)
      }
      f.controls.fault = ""
    })
    await t.test("altered acknowledgement identity/status/version is never returned as success", async () => {
      f.controls.actor = { ...feedbackActor }
      for (const patch of [{ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }, { status: "NEW" }, { reviewed_by_username: "wrong" }]) {
        const raw = (await f.send()).body.records.find(row => row.id === feedbackId).updatedAt
        f.controls.transformRow = row => ({ ...row, ...patch })
        const result = await f.send("PATCH", { id: feedbackId, expectedUpdatedAt: raw, status: "CLOSED", adminResponse: "Verified exact bytes" })
        assert.equal(result.status, 503)
        f.controls.transformRow = null
      }
    })
  } finally { await db.close() }
})
