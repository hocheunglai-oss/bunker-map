import assert from "node:assert/strict"
import test from "node:test"
import { createRecordPageRoute } from "./fixtures/spc-record-page-api.mjs"
import { todayEnquiry, todayId, todayNotes } from "./fixtures/spc-today-enquiries-api.mjs"
import { readFileSync } from "node:fs"
import { transformSync } from "esbuild"

test("actual routes plus SDK reach251/1001/5001 records once in250-size pages, not a total cap", async () => {
  for (const kind of ["lost", "today"]) for (const count of [251, 1001, 5001]) {
    const rows = Array.from({ length: count }, (_, n) => todayEnquiry(n + 1, { status: kind === "lost" ? "cancelled" : "open" }))
    const h = createRecordPageRoute({ kind, enquiries: rows }), seen = []; let cursor
    do {
      const { status, body, cache } = await h.get({ cursor })
      assert.equal(status, 200); assert.match(cache, /private.*no-store/)
      assert.equal(body.totalCount, count); assert.equal(body.pageCount, Math.ceil(count / 250)); assert.equal(body.pageIndex, Math.floor(seen.length / 250) + 1)
      assert.equal(body.enquiries.length, Math.min(250, count - seen.length)); seen.push(...body.enquiries.map(row => row.id)); cursor = body.nextCursor
    } while (cursor)
    assert.equal(new Set(seen).size, count); assert.deepEqual([...seen].sort(), rows.map(row => row.id).sort())
    assert.equal(h.queries.length, Math.ceil(count / 250)); assert.ok(h.queries.every(query => query.p_page_size === 250))
  }
})

test("new Lost GET authorizes View/Edit before any audit transport and retains raw versions", async () => {
  for (const permission of ["view", "edit"]) for (const role of ["BUYER TRADER", "SUPPLIER TRADER", "ADMIN"]) {
    const h = createRecordPageRoute({ role, permission, enquiries: [todayEnquiry(1, { status: "cancelled", updated_at: "2026-10-16T03:00:00.123456Z" })] }), r = await h.get()
    assert.equal(r.status, 200); assert.equal(r.body.enquiries[0].updatedAt, "2026-10-16T03:00:00.123456Z"); assert.equal(h.queries.length, 1)
  }
  for (const options of [{ permission: "none", expected: 403 }, { authenticated: false, expected: 401 }]) {
    const h = createRecordPageRoute(options), r = await h.get({ rawQuery: "pageSize=invalid&cursor={}" })
    assert.equal(r.status, options.expected); assert.equal(h.queries.length, 0); assert.equal(h.contexts.length, 0)
  }
})

test("page request parser denies malformed sizes, duplicate parameters and tampered cursors before RPC", async () => {
  for (const rawQuery of ["pageSize=0", "pageSize=251", "pageSize=-1", "pageSize=NaN", "pageSize=1.1", "pageSize=1&pageSize=2", "cursor={}", "cursor=null", "cursor={}&cursor={}"]) {
    const h = createRecordPageRoute(), r = await h.get({ rawQuery }); assert.equal(r.status, 400, rawQuery); assert.equal(h.queries.length, 0)
  }
  const h = createRecordPageRoute({ enquiries: Array.from({ length: 251 }, (_, n) => todayEnquiry(n + 1, { status: "cancelled" })) })
  const first = (await h.get()).body
  for (const cursor of [{ ...first.nextCursor, revision: "b".repeat(64) }, { ...first.nextCursor, id: todayId(9999) }]) {
    const r = await h.get({ cursor }); assert.equal(r.status, 409); assert.equal(r.body.code, "REFRESH_REQUIRED"); assert.equal(r.body.enquiries, undefined)
  }
})

test("source shape/count/order/identity failures and malformed200 never produce verified empty", async () => {
  const control = createRecordPageRoute({ enquiries: [todayEnquiry(1, { status: "cancelled" })] })
  let source
  await createRecordPageRoute({ enquiries: [], rpcSource: args => { assert.equal(args.p_page_size, 250); return {} } }).get()
  const capture = createRecordPageRoute({ fetchResponse: () => Response.json(source) })
  const publicPage = (await control.get()).body
  source = { ...publicPage, schema: "spc.record-page-source/v1", rows: [todayEnquiry(1, { status: "cancelled" })], fixtures: [], lost: [], sourceCounts: { rows: 1, fixtures: 0, lost: 0 } }
  const valid = structuredClone(source)
  for (const bad of [null, {}, [], { ...valid, sourceCounts: { ...valid.sourceCounts, rows: 2 } }, { ...valid, rows: [null] }, { ...valid, rows: [{ ...valid.rows[0], notes: {} }] }, { ...valid, rows: [{ ...valid.rows[0], status: "open" }] }, { ...valid, pageIndex: 2 }, { ...valid, rows: [] }]) {
    source = bad; const r = await capture.get(); assert.equal(r.status, 503); assert.equal(r.body.code, "COMPLETE_READ_UNAVAILABLE"); assert.equal(r.body.enquiries, undefined)
  }
})

test("Today excludes following HK midnight and preserves legacy Date.parse and first-marker metadata", async () => {
  const target = todayEnquiry(1)
  const h = createRecordPageRoute({ kind: "today", enquiries: [target, todayEnquiry(2, { created_at: "2026-10-16T16:00:00Z" }), todayEnquiry(3, { created_at: "2026-10-15T16:00:00Z" }), todayEnquiry(4, { status: "cancelled", created_at: "2026-10-15T01:00:00Z", updated_at: "2026-10-16T03:00:00Z", notes: todayNotes("1234567", { outcomeAt: "October 15, 2026 02:00:00 GMT", lostReason: "LEGACY DATE" }) })] })
  const r = await h.get(); assert.equal(r.status, 200); assert.deepEqual(r.body.enquiries.map(row => row.id), [todayId(3), todayId(1)]); assert.equal(r.body.enquiries[1].previousLost.buyerReason, "LEGACY DATE")
})

test("mapped4,000,000 UTF8-byte envelope rejects explicitly well below platform4.5MB", async () => {
  const h = createRecordPageRoute({ enquiries: Array.from({ length: 250 }, (_, n) => todayEnquiry(n + 1, { status: "cancelled", notes: "漢".repeat(7000) })) })
  const r = await h.get(); assert.equal(r.status, 503); assert.equal(r.body.code, "COMPLETE_READ_UNAVAILABLE"); assert.equal(r.body.enquiries, undefined)
})

test("blank notes format actual vessel and delivery date, not snake-case fallbacks", async () => {
  for (const kind of ["lost", "today"]) {
    const h = createRecordPageRoute({ kind, enquiries: [todayEnquiry(1, { status: kind === "lost" ? "cancelled" : "open", notes: null, title: "REF-42", vessel_name: "ALPHA", delivery_date: "2026-10-23", port: "SG" })] })
    const r = await h.get(); assert.equal(r.status, 200); assert.equal(r.body.enquiries[0].formattedText, "ALPHA / SG / 2026-10-23 / VLSFO 500")
  }
})

test("actual SDK fetch and SDK body stalls respect30s API deadline even ignoring AbortSignal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  try {
    for (const bodyStall of [false, true]) {
      const h = createRecordPageRoute({ fetchResponse: bodyStall ? async () => ({ ok: true, status: 200, headers: new Headers(), text: () => new Promise(() => {}) }) : () => new Promise(() => {}) })
      const pending = h.get(); for (let i = 0; i < 20; i++) await Promise.resolve()
      t.mock.timers.tick(30_000)
      const r = await pending; assert.equal(r.status, 503); assert.equal(r.body.code, "COMPLETE_READ_UNAVAILABLE"); assert.equal(r.body.enquiries, undefined)
      assert.equal(h.queries.length, 1); assert.equal(h.queries[0].signal.aborted, true)
    }
  } finally { t.mock.timers.reset() }
})

test("request abort fences ignored-abort SDK reads without pretending to cancel hosted PG", async () => {
  const controller = new AbortController(), h = createRecordPageRoute({ fetchResponse: () => new Promise(() => {}) })
  const pending = h.get({ signal: controller.signal }); for (let i = 0; i < 10; i++) await Promise.resolve()
  controller.abort(); const r = await pending; assert.equal(r.status, 503); assert.equal(h.queries[0].signal.aborted, true); assert.equal(r.body.enquiries, undefined)
})

test("generic privileged proxy denies both record RPCs before auth/service credentials", async () => {
  const source = readFileSync(new URL("../app/api/admin/supabase/route.ts", import.meta.url), "utf8")
  const code = transformSync(source, { loader: "ts", format: "cjs", target: "node24" }).code
  const mod = { exports: {} }; let privileged = 0
  new Function("require", "module", "exports", "process", code)(name => name === "next/server" ? { NextResponse: { json: Response.json.bind(Response) } } : new Proxy({}, { get: () => () => { privileged++; throw Error("Privileged operation must not execute") } }), mod, mod.exports, { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid" } })
  for (const rpc of ["read_spc_lost_record_page", "read_spc_today_enquiry_page"]) for (const method of ["GET", "POST"]) for (const page of ["ccinfo", "pricesetter"]) {
    const params = new URLSearchParams({ target: `https://synthetic.invalid/rest/v1/rpc/${rpc}` })
    const r = await mod.exports[method](new Request(`https://app.synthetic.invalid/api/admin/supabase?${params}`, { method, headers: { "x-bunker-admin-page-id": page } }))
    assert.equal(r.status, 403); assert.equal(privileged, 0)
  }
})
