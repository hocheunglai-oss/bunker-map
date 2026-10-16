import assert from "node:assert/strict"
import test from "node:test"
import {
  buildCcinfoIndexSearchFilter, CCINFO_INDEX_CONFIG, CCINFO_INDEX_MAX_QUERY_BYTES,
  CCINFO_INDEX_PAGE_SIZE, normalizeCcinfoIndexQuery,
  parseCcinfoIndexResult, type CcinfoIndexKind,
} from "../lib/ccinfoIndex"

const row = (index = 1, fields: Record<string, unknown> = {}) => ({
  id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`, name: "SYNTHETIC", notes: null,
  updated_at: "2026-10-16T07:30:00.123456+00:00", ...fields,
})
const result = (data: unknown, count: unknown, error: unknown = null) => ({ data, count, error })

test("CCINFO index searches are bounded quoted literal IMATCH, never a raw user regex or LIKE wildcard", () => {
  assert.equal(CCINFO_INDEX_PAGE_SIZE, 200)
  for (const kind of ["company", "country", "port"] as const) {
    const config = CCINFO_INDEX_CONFIG[kind]
    assert.equal(config.select.includes("updated_at"), true)
    assert.equal(config.orderFields.at(-1), "id")
    assert.equal(buildCcinfoIndexSearchFilter(kind, "   "), "")
    for (const query of [",", "_", "%", "*", "(", ")", '"', "\\", "(?i).*", "***=", "港口", "O'Brien"]) {
      const quoted = `"***=${query.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
      assert.equal(buildCcinfoIndexSearchFilter(kind, query), config.searchFields.map(field => `${field}.imatch.${quoted}`).join(","))
    }
  }
  assert.equal(normalizeCcinfoIndexQuery("  A, B  "), "A, B")
  assert.equal(normalizeCcinfoIndexQuery("a".repeat(CCINFO_INDEX_MAX_QUERY_BYTES)).length, CCINFO_INDEX_MAX_QUERY_BYTES)
  for (const value of ["a".repeat(CCINFO_INDEX_MAX_QUERY_BYTES + 1), "港".repeat(342), "A\0B", "A\nB", "A\tB", "\ud800"]) assert.throws(() => normalizeCcinfoIndexQuery(value))
})

test("complete exact-count pages retain raw PostgreSQL versions and signal a bounded out-of-range reload", () => {
  const first = parseCcinfoIndexResult(result(Array.from({ length: 200 }, (_, index) => row(index + 1)), 401), "company", 1)
  assert.equal(first.count, 401); assert.equal(first.page, 1); assert.equal(first.totalPages, 3)
  const last = parseCcinfoIndexResult(result([row(401)], 401), "country", 3)
  assert.equal(last.rows[0].updated_at, "2026-10-16T07:30:00.123456+00:00")
  assert.deepEqual(parseCcinfoIndexResult(result([], 200), "company", 2), { rows: [], count: 200, page: 1, totalPages: 1 })
  assert.deepEqual(parseCcinfoIndexResult(result([], 0), "company", 1), { rows: [], count: 0, page: 1, totalPages: 1 })
  assert.equal(parseCcinfoIndexResult(result([row(1, { country_name: null })], 1), "port", 1).rows[0].country_name, null)
})

test("SDK errors, unknown counts, incomplete pages and malformed/private rows never become verified empty results", () => {
  for (const invalid of [
    null, {}, [], result(null, 0), result([], null), result([], undefined), result([], NaN), result([], Infinity), result([], -1), result([], 0.5),
    result([], Number.MAX_SAFE_INTEGER + 1), result([], 0, { code: "PGRST100" }), result([], 0, false),
    result([], 1), result([row()], 0), result([row()], 201), result([row(), row()], 2),
    result([row(1, { id: "not-an-id" })], 1), result([row(1, { notes: undefined })], 1), result([row(1, { name: null })], 1),
    result([row(1, { updated_at: null })], 1), result([row(1, { updated_at: "2026-02-31T00:00:00Z" })], 1),
    result([row(1, { updated_at: "2026-10-16T24:00:00Z" })], 1), result([row(1, { updated_at: "2026-10-16T00:00:00.1234567Z" })], 1),
  ]) assert.throws(() => parseCcinfoIndexResult(invalid, "company", 1))
  assert.throws(() => parseCcinfoIndexResult(result([row()], 1), "port", 1), /could not be verified/)
  for (const page of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => parseCcinfoIndexResult(result([], 0), "company", page))
  assert.throws(() => parseCcinfoIndexResult(result([], 0), "not-kind" as CcinfoIndexKind, 1))
})
