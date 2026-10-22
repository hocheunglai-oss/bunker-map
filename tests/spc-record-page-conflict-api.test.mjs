import assert from "node:assert/strict"
import test from "node:test"
import { createRecordPageRoute } from "./fixtures/spc-record-page-api.mjs"

test("only the named non-retryable record-page business conflict returns refresh409", async () => {
  for (const kind of ["lost", "today"]) {
    const app = createRecordPageRoute({ kind, queryError: { code: "P0001", message: "SPC_RECORD_PAGE_REFRESH_REQUIRED" } })
    const response = await app.get()
    assert.equal(response.status, 409)
    assert.equal(response.body.code, "REFRESH_REQUIRED")
    assert.equal(response.body.message, "The record list changed. Refresh after saving or discarding your drafts.")
    assert.equal(response.body.enquiries, undefined)
    assert.equal(app.queries.length, 1)
    assert.match(response.cache, /private.*no-store/)
  }
})

test("app-first rollout preserves only the two exact legacy record-page conflicts", async () => {
  for (const kind of ["lost", "today"]) for (const message of [
    "The record list changed. Refresh before browsing another page.",
    "The complete record page could not be verified.",
  ]) {
    const app = createRecordPageRoute({ kind, queryError: { code: "40001", message } })
    const response = await app.get()
    assert.equal(response.status, 409)
    assert.equal(response.body.code, "REFRESH_REQUIRED")
    assert.equal(response.body.message, "The record list changed. Refresh after saving or discarding your drafts.")
    assert.equal(response.body.enquiries, undefined)
    assert.equal(app.queries.length, 1)
    assert.match(response.cache, /private.*no-store/)
  }
})

test("genuine serialization and unnamed database exceptions stay fail-closed unavailable", async () => {
  for (const kind of ["lost", "today"]) for (const error of [
    { code: "40001", message: "could not serialize access due to concurrent update" },
    { code: "40001", message: "the record list changed. refresh before browsing another page." },
    { code: "40001", message: "The record list changed. Refresh before browsing another page. private detail" },
    { code: "40001", message: "Prefix: The complete record page could not be verified." },
    { code: "40001", message: "serialization failure", details: "The record list changed. Refresh before browsing another page." },
    { code: "P0001", message: "The record list changed. Refresh before browsing another page." },
    { code: "P0001", message: "The complete record page could not be verified." },
    { code: "P0001", message: "OTHER_BUSINESS_RULE" },
    { code: "P0001", message: "SPC_RECORD_PAGE_REFRESH_REQUIRED_EXTRA" },
    { code: "42501", message: "private database details" },
    { code: "57014", message: "statement timeout" },
    { code: "08006", message: "connection lost" },
  ]) {
    const app = createRecordPageRoute({ kind, queryError: error }), response = await app.get()
    assert.equal(response.status, 503, `${kind}: ${error.code}/${error.message}`)
    assert.equal(response.body.code, "COMPLETE_READ_UNAVAILABLE")
    assert.equal(response.body.enquiries, undefined)
    assert.equal(app.queries.length, 1)
    assert.doesNotMatch(response.body.message, /private database details|OTHER_BUSINESS_RULE/)
  }
})

test("named message alone cannot turn another SQLSTATE into a refresh conflict", async () => {
  for (const code of ["40001", "42501", "08006"]) {
    const response = await createRecordPageRoute({ queryError: { code, message: "SPC_RECORD_PAGE_REFRESH_REQUIRED" } }).get()
    assert.equal(response.status, 503)
    assert.equal(response.body.code, "COMPLETE_READ_UNAVAILABLE")
  }
})
