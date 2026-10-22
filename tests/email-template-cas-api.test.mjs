import assert from "node:assert/strict"
import test from "node:test"
import { setupTemplateCas } from "./fixtures/email-template-cas-native.mjs"
import { templateCasApi } from "./fixtures/email-template-cas-api.mjs"

test("actual SDK, persistence library and POST handler preserve strict typed conflict/redaction contracts", async t => {
  const f = templateCasApi()
  const payloads = [
    { action: "save-template", template: f.template, expectedRevision: 1 },
    { action: "delete-template", id: "target", expectedRevision: 1 },
    { action: "save", templates: [f.template], expectedLibraryRevision: "a".repeat(64) },
  ]
  for (const payload of payloads) {
    for (const [name, error, expected, code] of [
      ["new business code", { code: "P0001", message: "EMAIL_TEMPLATE_CONFLICT" }, 409, "EMAIL_TEMPLATE_CONFLICT"],
      ["legacy exact marker", { code: "40001", message: "EMAIL_TEMPLATE_CONFLICT" }, 409, "EMAIL_TEMPLATE_CONFLICT"],
      ["independent uniqueness", { code: "23505", message: "private duplicate constraint" }, 409, "EMAIL_TEMPLATE_CONFLICT"],
      ["genuine serialization", { code: "40001", message: "could not serialize private operation" }, 500],
      ["unknown business error", { code: "P0001", message: "private unknown" }, 500],
      ["marker suffix", { code: "P0001", message: "EMAIL_TEMPLATE_CONFLICT: private-id" }, 500],
      ["marker prefix", { code: "P0001", message: "OTHER_EMAIL_TEMPLATE_CONFLICT" }, 500],
      ["wrong case", { code: "P0001", message: "email_template_conflict" }, 500],
      ["details only", { code: "P0001", message: "other", details: "EMAIL_TEMPLATE_CONFLICT" }, 500],
      ["wrong code", { code: "22023", message: "EMAIL_TEMPLATE_CONFLICT" }, 500],
      ["source pending remains independent", { code: "P0001", message: "OUTLOOK_TEMPLATE_SOURCE_SYNC_PENDING: private-id" }, 409, "OUTLOOK_TEMPLATE_SOURCE_SYNC_PENDING"],
      ["evidence stale remains independent", { code: "P0001", message: "OUTLOOK_TEMPLATE_RECIPIENT_EVIDENCE_STALE: private-id" }, 409, "OUTLOOK_TEMPLATE_RECIPIENT_EVIDENCE_STALE"],
    ]) await t.test(`${payload.action}: ${name}`, async () => {
      f.controls.rpcError = error
      const result = await f.request(payload)
      assert.equal(result.status, expected)
      if (code) assert.equal(result.body.code, code)
      else assert.deepEqual(result.body, { message: "Template action failed." })
      assert.doesNotMatch(JSON.stringify(result.body), /private|P0001|40001|23505|constraint|serialize/)
      if (code === "EMAIL_TEMPLATE_CONFLICT") assert.match(result.body.message, /Reload Outlook Templates/)
    })
  }
  for (const [permission, status] of [["anonymous", 401], ["view", 403]]) await t.test(`${permission} cannot reach any write RPC`, async () => {
    f.controls.permission = permission
    const before = f.requests.length
    for (const payload of [...payloads, { action: "repair-formatting" }]) assert.equal((await f.request(payload)).status, status)
    assert.equal(f.requests.length, before)
  })
  assert.ok(f.permissions.every(({ page, access }) => page === "email-templates" && access === "edit"))
})

test("actual native SQL errors travel through SDK/library/API once and cannot mutate stale templates", { timeout: 120000 }, async t => {
  const db = await setupTemplateCas()
  const f = templateCasApi(db)
  try {
    const cases = [
      ["stale save", { action: "save-template", template: f.template, expectedRevision: 2 }],
      ["stale delete", { action: "delete-template", id: "target", expectedRevision: 2 }],
      ["stale library", { action: "save", templates: [f.template], expectedLibraryRevision: "0".repeat(64) }],
    ]
    for (const [name, payload] of cases) await t.test(name, async () => {
      const calls = f.requests.length
      const result = await f.request(payload)
      assert.equal(result.status, 409)
      assert.equal(result.body.code, "EMAIL_TEMPLATE_CONFLICT")
      assert.equal(f.requests.length, calls + 1, "a POST conflict must not be retried by the SDK")
      const receipt = f.databaseStates.at(-1)
      assert.equal(receipt.code, "P0001")
      assert.equal(receipt.message, "EMAIL_TEMPLATE_CONFLICT")
      assert.deepEqual(receipt.after, receipt.before)
      assert.doesNotMatch(JSON.stringify(result.body), /private|expected revision|current revision/)
    })
    await t.test("formatting repair keeps a concurrent editor's row and redacts the conflict", async () => {
      await db.owner.query("update public.email_templates set body_text=' Body ' where id='target';")
      f.controls.beforeRpc = async path => {
        assert.equal(path, "/rest/v1/rpc/repair_email_templates_canonical")
        await db.owner.query("update public.email_templates set title='Concurrent editor' where id='target';")
      }
      try {
        const result = await f.request({ action: "repair-formatting" })
        assert.equal(result.status, 409)
        assert.equal(result.body.code, "EMAIL_TEMPLATE_CONFLICT")
        const receipt = f.databaseStates.at(-1)
        assert.equal(receipt.code, "P0001")
        assert.deepEqual(receipt.after, receipt.before)
        assert.equal(receipt.after.templates.find(row => row.id === "target").title, "Concurrent editor")
        assert.doesNotMatch(JSON.stringify(result.body), /private|target|Concurrent editor/)
      } finally { f.controls.beforeRpc = null }
    })
    await t.test("absent deletion stays successful without loading recipient certification", async () => {
      const before = await db.snapshot(), loads = f.recipientLoads()
      const result = await f.request({ action: "delete-template", id: "absent", expectedRevision: 1 })
      assert.equal(result.status, 200)
      assert.equal(result.body.id, "absent")
      assert.deepEqual(await db.snapshot(), before)
      assert.equal(f.recipientLoads(), loads)
    })
  } finally { await db.close() }
})
