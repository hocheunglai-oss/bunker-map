import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createClient } from "@supabase/supabase-js"
import { transformSync } from "esbuild"
import { streamAuditLogRows } from "../lib/backupAuditLogExport"

const id = (number: number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`
const row = (number: number) => ({ id: id(number), table_name: "synthetic", before_row: { unicode: "α", preserved: true }, after_row: { number }, extension: [null, false, "kept"] })
const directRead = async (operation: () => PromiseLike<{ data: unknown; error: unknown }>) => {
  const result = await operation()
  if (result.error) throw result.error
  return result.data
}

function pages(results: unknown[], pageSize = 2) {
  const reads: Array<{ after: string | null; limit: number }> = [], written: unknown[] = []
  return { reads, written,
    run: (appendRows = async (batch: unknown[]) => { written.push(...batch) }) => streamAuditLogRows({
      readPage: async (after, limit) => { reads.push({ after, limit }); return { data: results[reads.length - 1], error: null } },
      retryRead: directRead, appendRows, pageSize,
    }),
  }
}

test("cursor export retains every field exactly once in canonical UUID order, including a short last page", async () => {
  const rows = Array.from({ length: 5 }, (_, index) => row(index + 1)), f = pages([rows.slice(0, 2), rows.slice(2, 4), rows.slice(4)])
  assert.equal(await f.run(), 5)
  assert.deepEqual(f.reads, [{ after: null, limit: 2 }, { after: id(2), limit: 2 }, { after: id(4), limit: 2 }])
  assert.deepEqual(f.written, rows)
  assert.equal(createHash("sha256").update(JSON.stringify(f.written)).digest("hex"), createHash("sha256").update(JSON.stringify(rows)).digest("hex"))
})

test("empty and exact-multiple tables terminate only on a genuinely short page", async () => {
  const empty = pages([[]])
  assert.equal(await empty.run(async () => assert.fail("No empty writer call")), 0)
  assert.equal(empty.reads.length, 1)
  const exact = pages([[row(1), row(2)], [row(3), row(4)], []])
  assert.equal(await exact.run(), 4)
  assert.equal(exact.reads.length, 3)
  assert.deepEqual(exact.reads[2], { after: id(4), limit: 2 })
})

test("null, malformed, oversized, unordered and duplicate pages fail closed before writing the bad page", async () => {
  const invalid: unknown[] = [null, undefined, {}, [null], [[]], ["row"], [{}], [{ id: null }], [{ id: 1 }], [{ id: "bad" }],
    [row(2), row(1)], [row(1), row(1)], [row(1), row(2), row(3)]]
  for (const result of invalid) {
    const f = pages([result])
    await assert.rejects(() => f.run(), /audit-log backup/i)
    assert.equal(f.written.length, 0)
    assert.equal(f.reads.length, 1)
  }
  for (const next of [[row(2)], [row(1)], [{ ...row(2), id: id(2).toUpperCase() }]]) {
    const f = pages([[row(1), row(2)], next])
    await assert.rejects(() => f.run(), /order did not advance/)
    assert.deepEqual(f.written, [row(1), row(2)])
    assert.equal(f.reads.length, 2)
  }
})

test("uppercase UUIDs use the same PostgreSQL UUID order without altering the original rows", async () => {
  const first = { ...row(10), id: id(10).toUpperCase() }, last = row(11)
  const f = pages([[first], [last], []], 1)
  assert.equal(await f.run(), 2)
  assert.deepEqual(f.written, [first, last])
  assert.deepEqual(f.reads.map((item) => item.after), [null, id(10), id(11)])
})

test("invalid page sizes cannot issue a database request", async () => {
  for (const size of [0, -1, 501, 1.5, NaN, Infinity]) {
    const f = pages([[]], size)
    await assert.rejects(() => f.run(), /page size/)
    assert.equal(f.reads.length, 0)
  }
})

test("the existing retry wrapper recreates the same cursor query and writes only the successful response", async () => {
  const reads: Array<string | null> = [], saved: unknown[] = [], names: string[] = []
  let failures = 0
  const count = await streamAuditLogRows({
    readPage: async (after) => {
      reads.push(after)
      if (after === id(2) && !failures++) return { data: null, error: Error("Synthetic transient read failure") }
      return { data: after === null ? [row(1), row(2)] : [row(3)], error: null }
    },
    retryRead: async (operation, name) => {
      names.push(name)
      try { return await directRead(operation) } catch { return directRead(operation) }
    },
    appendRows: async (batch) => { saved.push(...batch) }, pageSize: 2,
  })
  assert.equal(count, 3)
  assert.deepEqual(reads, [null, id(2), id(2)])
  assert.deepEqual(saved, [row(1), row(2), row(3)])
  assert.equal(names.length, 2)
})

const statementTimeout = { code: "57014", message: "canceling statement due to statement timeout" }

test("an audit statement timeout retries the same cursor using smaller pages, without losing the tail or changing the hash", async () => {
  const rows = Array.from({ length: 1500 }, (_, i) => row(i + 1)), saved: unknown[] = []
  const reads: Array<[string | null, number]> = []
  const count = await streamAuditLogRows({
    readPage: async (after, limit) => {
      reads.push([after, limit])
      if (after === id(500) && limit > 125) return { data: null, error: statementTimeout }
      const start = after === null ? 0 : rows.findIndex(r => r.id === after) + 1
      return { data: rows.slice(start, start + limit), error: null }
    },
    retryRead: directRead, appendRows: async batch => { saved.push(...batch) }, pageSize: 500,
  })
  assert.deepEqual(reads.slice(0, 5), [[null, 500], [id(500), 500], [id(500), 250], [id(500), 125], [id(625), 125]])
  assert.deepEqual(reads.at(-1), [id(1500), 125], "an exact multiple still requires a final empty read")
  assert.equal(count, rows.length)
  assert.equal(createHash("sha256").update(JSON.stringify(saved)).digest("hex"), createHash("sha256").update(JSON.stringify(rows)).digest("hex"))
})

test("persistent statement timeouts have a bounded number of smaller reads; never return partial success", async () => {
  const limits: number[] = []
  await assert.rejects(() => streamAuditLogRows({
    readPage: async (after, limit) => { assert.equal(after, null); limits.push(limit); return { data: null, error: statementTimeout } },
    retryRead: directRead, appendRows: async () => assert.fail("Failed read cannot be written"), pageSize: 500,
  }), error => error === statementTimeout)
  assert.deepEqual(limits, [500, 250, 125, 62])
})

test("cancellation by an operator, permissions, malformed errors and writer errors are not retried as timeouts", async () => {
  for (const fault of [{ code: "57014", message: "canceling statement due to user request" },
    { code: "42501", message: "permission denied" }, { message: statementTimeout.message }, Error("network failure")]) {
    let reads = 0
    await assert.rejects(() => streamAuditLogRows({
      readPage: async () => { reads++; return { data: null, error: fault } }, retryRead: directRead,
      appendRows: async () => assert.fail("Failed read cannot be written"), pageSize: 500,
    }), error => error === fault)
    assert.equal(reads, 1)
  }
  const f = pages([[row(1), row(2)], [row(3)]])
  await assert.rejects(() => f.run(async () => { throw Error("Synthetic writer failure") }), /writer failure/)
  assert.equal(f.reads.length, 1)
  const writerTimeout = pages([[row(1), row(2)]])
  await assert.rejects(() => writerTimeout.run(async () => { throw statementTimeout }), error => error === statementTimeout)
  assert.equal(writerTimeout.reads.length, 1)
})

test("writer backpressure bounds live pages and next cursor is independent of downstream mutation", async () => {
  const first = [row(1), row(2)], second = [row(3)]
  const f = pages([first, second])
  let release!: () => void, reached!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve }), ready = new Promise<void>((resolve) => { reached = resolve })
  let writes = 0
  const result = f.run(async (batch) => {
    if (++writes === 1) {
      reached(); await gate
      ;(batch[1] as { id: string }).id = id(999)
    }
  })
  await ready
  assert.equal(f.reads.length, 1)
  release()
  assert.equal(await result, 3)
  assert.equal(f.reads[1].after, id(2))
})

type TableConfig = { table: string; order?: Array<{ column: string; ascending: boolean }>; omitColumns?: string[] }
type TestClient = ReturnType<typeof clientFor>["client"]
const auditConfig: TableConfig = { table: "audit_logs", order: [{ column: "id", ascending: true }] }

function actualProductionReader() {
  const source = readFileSync(new URL("../app/api/backups/bunker-map-drive/route.ts", import.meta.url), "utf8")
  const slice = (start: string, end: string) => {
    const from = source.indexOf(start), to = source.indexOf(end, from)
    assert.ok(from > 0 && to > from)
    return source.slice(from, to)
  }
  const code = transformSync([
    slice("function getErrorMessage", "function getSupabaseClient"),
    slice("function isRetryableSupabaseReadError", "async function callTruthRpc"),
    slice("async function streamTableRows", "async function streamPrivateAttendanceRows"),
  ].join("\n"), { loader: "ts", format: "cjs", target: "node24" }).code
  return new Function("streamAuditLogRows", "BACKUP_EXPORT_PAGE_SIZE", "SUPABASE_BACKUP_READ_ATTEMPTS", "SUPABASE_BACKUP_READ_RETRY_DELAY_MS", "SUPABASE_BACKUP_READ_MAX_RETRY_DELAY_MS", `${code}\nreturn streamTableRows;`)(
    streamAuditLogRows, 500, 6, 0, 0,
  ) as (client: TestClient, config: TableConfig, append: (rows: unknown[]) => Promise<void>) => Promise<void>
}

function clientFor(rows: Array<Record<string, unknown>>, responseFor?: (url: URL) => Response | undefined) {
  const requests: URL[] = []
  const client = createClient("https://backup-audit-fixture.invalid", "synthetic-only-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input) => {
      const url = new URL(String(input))
      requests.push(url)
      assert.equal(url.origin, "https://backup-audit-fixture.invalid")
      const response = responseFor?.(url)
      if (response) return response
      const after = url.searchParams.get("id")?.slice(3)
      const eligible = after ? rows.filter((row) => String(row.id).toLowerCase() > after) : rows
      const offset = Number(url.searchParams.get("offset") || 0)
      return new Response(JSON.stringify(eligible.slice(offset, offset + Number(url.searchParams.get("limit")))), { headers: { "content-type": "application/json" } })
    } },
  })
  return { client, requests }
}

test("actual route and Supabase SDK request indexed UUID pages without offsets, preserving 1,003 records", async () => {
  const rows = Array.from({ length: 1003 }, (_, index) => row(index + 1)), f = clientFor(rows), saved: unknown[] = []
  await actualProductionReader()(f.client, auditConfig, async (batch) => { saved.push(...batch) })
  assert.deepEqual(saved, rows)
  assert.equal(f.requests.length, 3)
  for (const [index, request] of f.requests.entries()) {
    assert.equal(request.pathname, "/rest/v1/audit_logs")
    assert.equal(request.searchParams.get("select"), "*")
    assert.equal(request.searchParams.get("order"), "id.asc")
    assert.equal(request.searchParams.get("limit"), "500")
    assert.equal(request.searchParams.has("offset"), false)
    assert.equal(request.searchParams.get("id"), index ? `gt.${id(index * 500)}` : null)
  }
})

test("actual route handles a typed HTTP 500 from PostgREST and resumes without skipping or duplicating records", async () => {
  const rows = Array.from({ length: 1003 }, (_, i) => row(i + 1)), saved: unknown[] = []
  const f = clientFor(rows, url => {
    if (url.searchParams.get("id") === `gt.${id(500)}` && url.searchParams.get("limit") === "500") {
      return Response.json(statementTimeout, { status: 500 })
    }
  })
  await actualProductionReader()(f.client, auditConfig, async batch => { saved.push(...batch) })
  assert.deepEqual(saved, rows)
  assert.deepEqual(f.requests.map(url => [url.searchParams.get("id"), url.searchParams.get("limit")]), [
    [null, "500"], [`gt.${id(500)}`, "500"], [`gt.${id(500)}`, "250"],
    [`gt.${id(750)}`, "250"], [`gt.${id(1000)}`, "250"],
  ])
})

test("actual route retains credential redaction and refuses unsupported audit ordering before transport", async () => {
  const secretRow = { ...row(1), table_name: "admin_users", before_row: { name: "Synthetic", password_hash: "synthetic-secret" }, after_row: { password_hash: "synthetic-secret", active: true }, changed_fields: ["password_hash", "active"] }
  const f = clientFor([secretRow]), saved: unknown[] = []
  await actualProductionReader()(f.client, auditConfig, async (batch) => { saved.push(...batch) })
  assert.deepEqual(saved, [{ ...secretRow, before_row: { name: "Synthetic" }, after_row: { active: true }, changed_fields: ["active"] }])
  assert.equal(secretRow.before_row.password_hash, "synthetic-secret", "source object is not mutated")
  for (const order of [undefined, [], [{ column: "id", ascending: false }], [{ column: "occurred_at", ascending: true }], [{ column: "id", ascending: true }, { column: "id", ascending: true }]]) {
    const rejected = clientFor([])
    await assert.rejects(() => actualProductionReader()(rejected.client, { table: "audit_logs", order }, async () => assert.fail("No writes")), /unique UUID key order/)
    assert.equal(rejected.requests.length, 0)
  }
})

test("non-audit tables retain their existing pagination and compound ordering", async () => {
  const rows = Array.from({ length: 501 }, (_, index) => ({ id: index + 1, group_id: index, contact_id: index + 2 })), f = clientFor(rows), saved: unknown[] = []
  const config = { table: "shared_addressbook_group_members", order: [{ column: "group_id", ascending: true }, { column: "contact_id", ascending: true }] }
  await actualProductionReader()(f.client, config, async (batch) => { saved.push(...batch) })
  assert.deepEqual(saved, rows)
  assert.deepEqual(f.requests.map((url) => url.searchParams.get("offset")), ["0", "500"])
  assert.ok(f.requests.every((url) => url.searchParams.get("order") === "group_id.asc,contact_id.asc" && !url.searchParams.has("id")))
})
