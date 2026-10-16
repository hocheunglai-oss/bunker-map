import assert from "node:assert/strict"
import test from "node:test"
import { parseSpcFeedbackList, parseSpcFeedbackRecord, parseSpcFeedbackResponse, spcFeedbackTimestampMicros, verifySpcFeedbackReview } from "../lib/spcFeedbackShared"

const record = () => ({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", category: "PROBLEM", status: "NEW",
  title: "Synthetic issue", message: "Synthetic details", area: "", adminResponse: "", createdByUsername: "user",
  createdByDisplayName: "", reviewedByDisplayName: "", createdAt: "2026-10-16T00:00:00.123456Z", updatedAt: "2026-10-16T00:00:00.123456Z" })

test("feedback versions retain microseconds, offsets and strict calendar validity", () => {
  const value = spcFeedbackTimestampMicros("2026-10-16T00:00:00.123456Z")
  assert.equal(spcFeedbackTimestampMicros("2026-10-16T08:00:00.123456+08:00"), value)
  assert.equal(spcFeedbackTimestampMicros("2026-10-16T00:00:00.123457Z") - value, BigInt(1))
  for (const invalid of [null, "", "0000-01-01T00:00:00Z", "2026-02-30T00:00:00Z", "2025-02-29T00:00:00Z", "2026-10-16T24:00:00Z", "2026-10-16T00:00:00.1234567Z", "2026-10-16T00:00:00+16:00"]) {
    assert.throws(() => spcFeedbackTimestampMicros(invalid))
  }
  assert.doesNotThrow(() => spcFeedbackTimestampMicros("2024-02-29T00:00:00Z"))
})

test("feedback DTO rejects malformed records, duplicates and invalid dates instead of false empty", () => {
  assert.deepEqual(parseSpcFeedbackRecord(record()), record())
  // Match PostgreSQL char_length rather than rejecting valid astral characters
  // solely because JavaScript counts their UTF-16 surrogate pairs twice.
  assert.equal(parseSpcFeedbackRecord({ ...record(), message: "😀".repeat(4000) }).message.length, 8000)
  assert.deepEqual(parseSpcFeedbackList({ records: [] }), [])
  for (const value of [null, [], {}, { records: {} }, { records: [record(), record()] }, { records: Array(251).fill(record()) }]) {
    assert.throws(() => parseSpcFeedbackList(value))
  }
  for (const patch of [{ id: "wrong" }, { category: "wrong" }, { status: "wrong" }, { message: "" }, { title: " " },
    { area: null }, { adminResponse: "x".repeat(2001) }, { createdAt: "bad" }, { updatedAt: "2026-10-15T00:00:00Z" }]) {
    assert.throws(() => parseSpcFeedbackResponse({ record: { ...record(), ...patch } }))
  }
})

test("review acknowledgement must be the exact id/draft and a strictly newer microsecond version", () => {
  const original = parseSpcFeedbackRecord(record()), expected = { id: original.id, expectedUpdatedAt: original.updatedAt, status: original.status, adminResponse: original.adminResponse }
  const fresh = { ...original, updatedAt: "2026-10-16T00:00:00.123457Z" }
  assert.equal(verifySpcFeedbackReview(fresh, expected), fresh)
  for (const patch of [{ updatedAt: original.updatedAt }, { updatedAt: "2026-10-16T00:00:00.123455Z" },
    { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }, { id: original.id.toUpperCase() }, { adminResponse: "changed" }]) {
    assert.throws(() => verifySpcFeedbackReview({ ...fresh, ...patch }, expected))
  }
})
