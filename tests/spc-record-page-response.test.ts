import assert from "node:assert/strict"
import test from "node:test"
import { fetchSpcRecordPage, getSpcRecordHongKongDay, parseSpcRecordPage, parseSpcRecordCursor, spcRecordTimestampMicros, SpcRecordPageError, SPC_RECORD_READ_TIMEOUT_MS, SPC_RECORD_API_MAX_BYTES } from "../lib/spcRecordPageResponse"
const id = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`
const lost = (n = 1) => ({ id: id(n), title: "SYNTHETIC", vesselName: "SYNTHETIC", deliveryDate: null, formattedText: "SYNTHETIC", createdByDisplayName: "Synthetic", createdAt: "2026-10-16T03:00:00.123456Z", updatedAt: "2026-10-16T04:00:00.123456Z", meta: {} })
const page = (changes: Record<string, unknown> = {}) => ({ schema: "spc.record-page/v1", kind: "lost", day: null, checkedAt: "2026-10-16T04:00:00Z", pageSize: 250, totalCount: 1, pageCount: 1, pageIndex: 1, mainRevision: "a".repeat(64), nextCursor: null, enquiries: [lost()], ...changes })

test("verified empty is explicit and malformed success never becomes empty", () => {
  assert.deepEqual(parseSpcRecordPage(page({ totalCount: 0, pageCount: 0, pageIndex: 0, enquiries: [] }), "lost").enquiries, [])
  for (const bad of [null, {}, { enquiries: [] }, page({ enquiries: [] }), page({ totalCount: 251 }), page({ pageCount: 9 }), page({ nextCursor: {} }), page({ enquiries: [null] })]) assert.throws(() => parseSpcRecordPage(bad, "lost"), SpcRecordPageError)
})
test("raw versions retain microseconds and impossible calendar/primitive field shapes fail closed", () => {
  const verified = parseSpcRecordPage(page(), "lost")
  assert.equal(verified.enquiries[0].updatedAt, "2026-10-16T04:00:00.123456Z")
  assert.equal(spcRecordTimestampMicros("2026-10-16T04:00:00.123457Z") - spcRecordTimestampMicros("2026-10-16T04:00:00.123456Z"), BigInt(1))
  for (const bad of ["2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-01T24:00:00Z", 1]) assert.throws(() => spcRecordTimestampMicros(bad))
  for (const changes of [{ meta: [] }, { meta: { imo: ["1234567"] } }, { vesselName: {} }, { deliveryDate: "2026-02-30" }, { id: "wrong" }]) assert.throws(() => parseSpcRecordPage(page({ enquiries: [{ ...lost(), ...changes }] }), "lost"))
})
test("page counts, duplicate rows and raw timestamp ordering are fully validated", () => {
  assert.throws(() => parseSpcRecordPage(page({ totalCount: 2, enquiries: [lost(), lost()] }), "lost"))
  assert.throws(() => parseSpcRecordPage(page({ totalCount: 2, enquiries: [lost(2), lost(1)] }), "lost"))
  assert.equal(parseSpcRecordPage(page({ totalCount: 2, enquiries: [lost(1), lost(2)] }), "lost").enquiries.length, 2)
})
test("later-page cursor binds kind/day/revision and strict complete page position", () => {
  const cursor = { kind: "lost" as const, day: null, createdAt: "2026-10-16T04:00:00.123456Z", id: id(250), revision: "a".repeat(64) }
  const final = page({ totalCount: 251, pageCount: 2, pageIndex: 2 })
  assert.equal(parseSpcRecordPage(final, "lost", cursor).pageIndex, 2)
  assert.throws(() => parseSpcRecordPage(final, "lost"))
  assert.throws(() => parseSpcRecordPage(final, "lost", { ...cursor, revision: "b".repeat(64) }))
  assert.throws(() => parseSpcRecordCursor({ ...cursor, extra: "bad" }, "lost"))
  assert.throws(() => parseSpcRecordCursor({ ...cursor, day: "2026-10-16" }, "lost"))
})
test("Today day is bound to returned authoritative checkedAt, not client timezone", () => {
  assert.equal(getSpcRecordHongKongDay(new Date("2026-10-15T16:00:00Z")), "2026-10-16")
  assert.equal(getSpcRecordHongKongDay(new Date("2026-10-15T15:59:59.999Z")), "2026-10-15")
  const enquiry = { id: id(), enquiryNumber: "SYNTHETIC", vesselName: "SYNTHETIC", status: "sent", formattedText: "SYNTHETIC", createdByDisplayName: "Synthetic", createdAt: "2026-10-16T03:00:00Z", meta: {}, previousFixture: null, previousLost: null }
  const today = page({ kind: "today", day: "2026-10-16", enquiries: [enquiry] })
  assert.equal(parseSpcRecordPage(today, "today").enquiries[0].previousFixture, null)
  assert.throws(() => parseSpcRecordPage({ ...today, day: "2026-10-15" }, "today"))
})
test("HTML401/403 and409 are typed before body decoding", async () => {
  const original = globalThis.fetch
  try { for (const status of [401,403,409]) {
    globalThis.fetch = async () => new Response("<html>unavailable</html>", { status })
    await assert.rejects(fetchSpcRecordPage("lost"), error => error instanceof SpcRecordPageError && error.status === status)
  } } finally { globalThis.fetch = original }
})
test("30s deadline covers an ignored-abort fetch and an ignored-abort text body", async t => {
  const original = globalThis.fetch
  t.mock.timers.enable({ apis: ["setTimeout"] })
  try { for (const body of [false,true]) {
    globalThis.fetch = body ? async () => ({ ok: true, status: 200, text: () => new Promise<string>(() => {}) }) as Response : () => new Promise<Response>(() => {})
    const rejected = assert.rejects(fetchSpcRecordPage("lost"), /timed out/)
    await Promise.resolve(); await Promise.resolve()
    t.mock.timers.tick(SPC_RECORD_READ_TIMEOUT_MS)
    await rejected
  } } finally { t.mock.timers.reset(); globalThis.fetch = original }
})
test("owner abort rejects promptly even when fetch ignores AbortSignal", async () => {
  const original = globalThis.fetch, controller = new AbortController()
  try {
    globalThis.fetch = () => new Promise<Response>(() => {})
    const rejected = assert.rejects(fetchSpcRecordPage("lost", null, controller.signal), error => error instanceof Error && error.name === "AbortError")
    controller.abort(); await rejected
  } finally { globalThis.fetch = original }
})
test("oversized mapped envelope cannot become a platform payload failure or silent empty", async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(" ".repeat(SPC_RECORD_API_MAX_BYTES + 1))
    await assert.rejects(fetchSpcRecordPage("lost"), SpcRecordPageError)
  } finally { globalThis.fetch = original }
})
