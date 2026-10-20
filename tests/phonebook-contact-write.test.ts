import assert from "node:assert/strict"
import test from "node:test"
import { phonebookContactUndoPatch, validPhonebookContactVersion, verifiedPhonebookContactRow, phonebookContactReadResult } from "../lib/phonebookContactWrite"

test("contact Undo restores mutable fields but never old identity, timestamps or unexpected columns", () => {
  const patch = phonebookContactUndoPatch({ id: "old-id", source_key: "old-source", created_at: "old-created", updated_at: "old-version", arbitrary: "hidden", full_name: "CONTACT", mobile_1: null, favorite: false, company_source_id: "original-company", search_text: "contact" })
  assert.deepEqual(patch, { full_name: "CONTACT", company_source_id: "original-company", mobile_1: null, favorite: false, search_text: "contact" })
  assert.deepEqual(phonebookContactUndoPatch({ updated_at: "old-version" }), {})
})

test("contact revision validation accepts exact server microsecond strings and rejects missing/malformed revisions", () => {
  for (const version of ["2026-10-20T12:00:00.123456Z", "2026-10-20T12:00:00.123457+00:00", "2026-10-20T20:00:00+08:00"]) {
    assert.equal(validPhonebookContactVersion(version), true)
  }
  for (const value of [undefined, null, "", "2026-10-20", "not-a-date", "2026-10-20T12:00:00.1234567Z", 42, {}, []]) assert.equal(validPhonebookContactVersion(value), false)
})

test("a returned contact needs the expected identity and essential saved-row fields", () => {
  const saved = { id: "contact", full_name: "SYNTHETIC", favorite: false, updated_at: "2026-10-20T12:00:00.123456Z" }
  assert.equal(verifiedPhonebookContactRow(saved, "contact"), true)
  for (const bad of [null, undefined, false, 0, "", [], "contact", { id: "contact" }, { ...saved, id: "other" }, { ...saved, full_name: null }, { ...saved, favorite: "false" }, { ...saved, updated_at: undefined }]) assert.equal(verifiedPhonebookContactRow(bad, "contact"), false)
})

test("recovery distinguishes a verified zero-row array from null, empty, primitive or malformed replies", () => {
  const row = { id: "contact", full_name: "SYNTHETIC", favorite: false, updated_at: "2026-10-20T12:00:00.123456Z" }
  assert.deepEqual(phonebookContactReadResult([], "contact"), { kind: "missing" })
  assert.deepEqual(phonebookContactReadResult([row], "contact"), { kind: "contact", contact: row })
  for (const value of [null, undefined, false, 0, "", row, {}, [null], [false], [{ ...row, id: "other" }], [row, row]]) assert.equal(phonebookContactReadResult(value, "contact").kind, "unverified")
})
