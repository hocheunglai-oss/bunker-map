import assert from "node:assert/strict"
import test from "node:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { setupNativeCcinfo, literal, waitForBlock } from "./fixtures/native-postgres-ccinfo.mjs"
import { recordPagesFixtureSql, seedRecordPagesSql, recordPagesStateSql } from "./fixtures/spc-record-pages-sql.mjs"
import { createRecordPageRoute } from "./fixtures/spc-record-page-api.mjs"
import { todayEnquiry, todayFixture, todayNotes, todayId } from "./fixtures/spc-today-enquiries-api.mjs"

const q = value => value === null ? "null" : literal(value)
const insert = (table, row) => `insert into public.${table}(${Object.keys(row).join(",")}) values(${Object.values(row).map(q).join(",")});`
const reset = "delete from public.spc_fixtures;delete from public.spc_enquiries;"
function rpcSql(kind, cursor = null, size = 250) { return `select public.${kind === "lost" ? "read_spc_lost_record_page" : "read_spc_today_enquiry_page"}(${cursor ? literal(JSON.stringify(cursor)) + "::jsonb" : "null"},${size});` }
function nativeApp(service, kind, capture = []) {
  return createRecordPageRoute({ kind, fetchResponse: async ({ args }) => {
    try {
      const source = await service.one(rpcSql(kind, args.p_cursor, args.p_page_size)); capture.push(source); return Response.json(source)
    } catch (error) { return Response.json({ code: error.code || "08006", message: error.message }, { status: 503 }) }
  } })
}

test("actual record RPC, SDK and API coherent completeness, adversarial parity and fail-closed budgets", { timeout: 180_000 }, async t => {
  const f = await setupNativeCcinfo(recordPagesFixtureSql())
  const now = await f.owner.one("select jsonb_build_object('day',(statement_timestamp() at time zone 'Asia/Hong_Kong')::date,'start',((statement_timestamp() at time zone 'Asia/Hong_Kong')::date::timestamp at time zone 'Asia/Hong_Kong')+interval '1 hour');")
  const target = (n = 1, overrides = {}) => todayEnquiry(n, { created_at: now.start, updated_at: now.start, ...overrides })
  async function expectedFailure(sql, code = "54000") {
    const service = await f.session("expected-read-failure")
    try { await assert.rejects(service.one(sql), error => error.code === code) } finally { await service.close() }
  }
  try {
    await t.test("Today native+SDK+API251/1001/5001 all reachable including repeated raw timestamps and exclusive next midnight", async () => {
      for (const count of [251, 1001, 5001]) {
        await f.owner.query(reset + seedRecordPagesSql(count, "open"))
        await f.owner.query("update public.spc_enquiries set created_at=date_trunc('second',created_at);")
        const outside = target(999999, { created_at: `${now.day}T00:00:00+08:00` })
        outside.created_at = new Date(Date.parse(outside.created_at) + 86_400_000).toISOString()
        await f.owner.query(insert("spc_enquiries", outside))
        const service = await f.session("today-reachability"), app = nativeApp(service, "today"), seen = []; let cursor
        try {
          do {
            const r = await app.get({ cursor }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.totalCount, count); assert.equal(r.body.pageIndex, Math.floor(seen.length / 250) + 1)
            seen.push(...r.body.enquiries.map(row => row.id)); cursor = r.body.nextCursor
          } while (cursor)
          assert.equal(seen.length, count); assert.equal(new Set(seen).size, count); assert.equal(seen.includes(outside.id), false)
        } finally { await service.close() }
      }
    })

    await t.test("service-only STABLE INVOKER ACL, empty search_path, scoped timeout and READ ONLY preserve tuple/audit/fence", async () => {
      const functions = await f.owner.one("select jsonb_agg(jsonb_build_object('name',p.proname,'stable',p.provolatile,'definer',p.prosecdef,'settings',p.proconfig,'anon',has_function_privilege('anon',p.oid,'execute'),'authenticated',has_function_privilege('authenticated',p.oid,'execute'),'service',has_function_privilege('service_role',p.oid,'execute'),'public',(select count(*) from aclexplode(p.proacl) a where a.grantee=0))) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('read_spc_lost_record_page','read_spc_today_enquiry_page');")
      assert.equal(functions.length, 2)
      for (const fn of functions) { assert.equal(fn.stable, "s"); assert.equal(fn.definer, false); assert.equal(fn.anon, false); assert.equal(fn.authenticated, false); assert.equal(fn.public, 0); assert.equal(fn.service, true); assert.ok(fn.settings.includes('search_path=""')); assert.ok(fn.settings.includes("statement_timeout=15s")) }
      for (const role of ["anon", "authenticated"]) {
        const denied = await f.session("deny-" + role, false)
        try { await denied.query("set role " + role + ";"); await assert.rejects(denied.one(rpcSql("today")), error => error.code === "42501") } finally { await denied.close() }
      }
      const service = await f.session("readonly"), before = await f.owner.one(recordPagesStateSql)
      try {
        await service.query("begin read only;"); await service.one(rpcSql("today")); await service.one(rpcSql("lost"))
        const locks = await f.owner.one(`select coalesce(jsonb_agg(jsonb_build_object('type',locktype,'mode',mode)),'[]') from pg_locks where pid=${service.pid};`)
        assert.equal(locks.some(lock => lock.type === "advisory" || lock.type === "tuple" || (lock.type === "relation" && lock.mode !== "AccessShareLock")), false)
        await service.query("commit;"); assert.deepEqual(await f.owner.one(recordPagesStateSql), before)
      } finally { await service.close() }
    })

    await t.test("relevant completed and lost history behind1001 unrelated newer rows is found", async () => {
      await f.owner.query(reset + insert("spc_enquiries", target()))
      await f.owner.query(seedRecordPagesSql(1002, "cancelled") .replaceAll("md5('record-'||n)", "md5('history-'||n)").replaceAll("statement_timestamp() from", "'2020-01-01'::timestamptz from").replace("+interval '1 hour'+n*interval '1 millisecond'", "-interval '2 days'+n*interval '1 millisecond'"))
      await f.owner.query("insert into public.spc_fixtures select md5('fixture-'||n)::uuid,md5('history-'||n)::uuid,'completed','2020-01-01','Synthetic supplier','Synthetic buyer','UNRELATED VESSEL '||n,to_char(2000000+n,'FM0000000'),'UNRELATED','1','0','2020-01-01','2019-01-01' from generate_series(1,1002)n;")
      await f.owner.query("update public.spc_fixtures set vessel_name='RENAMED VESSEL',vessel_imo='1234567',completed_at='2010-01-01',supplier_name='FOUND BEYOND1001' where enquiry_id=md5('history-1')::uuid;")
      await f.owner.query("update public.spc_enquiries set vessel_name='RENAMED VESSEL',notes='---SPC_META---'||json_build_object('imo','1234567','outcomeAt','January 1, 2010 00:00:00 GMT','lostReason','FOUND BEYOND1001')::text where id=md5('history-1')::uuid;")
      const service = await f.session("past1001"), captures = []
      try {
        const r = await nativeApp(service, "today", captures).get(); assert.equal(r.status, 200, JSON.stringify(r.body))
        assert.equal(r.body.enquiries[0].previousFixture.supplier, "FOUND BEYOND1001"); assert.equal(r.body.enquiries[0].previousLost.buyerReason, "FOUND BEYOND1001")
        assert.ok(captures[0].fixtures.some(row => row.supplier_name === "FOUND BEYOND1001")); assert.ok(captures[0].lost.some(row => row.notes.includes("FOUND BEYOND1001")))
      } finally { await service.close() }
    })

    await t.test("native candidate supersets preserve actual TS Unicode, unsupported JSON, metadata and Date.parse semantics", async () => {
      const trim = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
      const corpus = [
        { name: "same IMO rename", candidateName: "RENAMED VESSEL" },
        { name: "different known IMO", fixtureImo: "7654321", notes: todayNotes("7654321") },
        { name: "missing IMO fallback", fixtureImo: null, notes: todayNotes("") },
        { name: "missing target IMO", targetNotes: todayNotes("") },
        { name: "Unicode target newer compatibility glyph", targetName: "\u{1ccd6} SYNTHETIC VESSEL", candidateName: "A SYNTHETIC VESSEL", fixtureImo: null, notes: todayNotes("") },
        { name: "Unicode candidate newer compatibility glyph", targetName: "A SYNTHETIC VESSEL", candidateName: "\u{1ccd6} SYNTHETIC VESSEL", fixtureImo: null, notes: todayNotes("") },
        { name: "joined name legacy fallback", targetName: "A SYNTHETIC VESSEL", candidateName: "", parentName: "\u{1ccd6} SYNTHETIC VESSEL", fixtureImo: null, notes: todayNotes("") },
        { name: "whitespace own name never uses parent", candidateName: "   ", parentName: "SYNTHETIC VESSEL", fixtureImo: null, notes: todayNotes("") },
        { name: "first marker not last", notes: '---SPC_META---{"imo":"7654321"}---SPC_META---{"imo":"1234567"}' },
        { name: "last duplicate JSON key", notes: '---SPC_META---{"imo":"1234567","imo":"7654321"}' },
        { name: "string only IMO", notes: '---SPC_META---{"imo":1234567}' },
        { name: "all ECMAScript trim", notes: "---SPC_META---" + trim + '{"imo":" IMO 1-234-567 "}' + trim },
        { name: "NUL unrelated metadata", notes: '---SPC_META---{"imo":"1234567","other":"\\u0000"}' },
        { name: "lone surrogate selected IMO", notes: '---SPC_META---{"imo":"\\ud8001234567"}' },
        { name: "NUL selected IMO", notes: '---SPC_META---{"imo":"\\u00001234567"}' },
        { name: "array JSON", notes: '---SPC_META---["1234567"]' },
        { name: "null JSON", notes: '---SPC_META---null' },
        { name: "malformed JSON", notes: '---SPC_META---{"imo":' },
        { name: "no marker", notes: "legacy plain text" },
        { name: "blank normalized name", targetName: "--!!", candidateName: "--!!", fixtureImo: null, notes: todayNotes("") },
        { name: "legacy outcome Date.parse", notes: todayNotes("1234567", { outcomeAt: "October 15, 2010 02:00:00 GMT", lostReason: "LEGACY DATE" }) },
        { name: "later outcome", notes: todayNotes("1234567", { outcomeAt: "2100-01-01" }) },
      ]
      for (const [index, item] of corpus.entries()) {
        const main = target(1, { vessel_name: item.targetName ?? "SYNTHETIC VESSEL", notes: item.targetNotes ?? todayNotes("1234567") })
        const history = target(2, { vessel_name: item.parentName ?? item.candidateName ?? "SYNTHETIC VESSEL", status: "cancelled", notes: item.notes ?? todayNotes("1234567"), created_at: "2009-01-01T00:00:00+00:00", updated_at: "2010-01-01T00:00:00+00:00" })
        const fixture = todayFixture(3, { vessel_name: item.candidateName ?? "SYNTHETIC VESSEL", vessel_imo: Object.hasOwn(item, "fixtureImo") ? item.fixtureImo : "1234567", enquiry: { vessel_name: history.vessel_name } })
        const stored = { ...fixture, enquiry_id: history.id }; delete stored.enquiry
        await f.owner.query(reset + insert("spc_enquiries", main) + insert("spc_enquiries", history) + insert("spc_fixtures", stored))
        const service = await f.session("parity-" + index), app = nativeApp(service, "today")
        try {
          const expected = app.load("@/lib/spcTodayEnquiries").mapSpcTodayEnquiries([main], [fixture], [history])[0]
          const actual = await app.get(); assert.equal(actual.status, 200, item.name + JSON.stringify(actual.body))
          assert.deepEqual(actual.body.enquiries[0].previousFixture, expected.previousFixture, item.name + " fixture")
          assert.deepEqual(actual.body.enquiries[0].previousLost, expected.previousLost, item.name + " lost")
        } finally { await service.close() }
      }
    })

    await t.test("equal parsed outcome times preserve latest raw review/completion source order", async () => {
      const a = target(2, { status: "cancelled", created_at: "2009-01-01T00:00:00Z", updated_at: "2011-01-01T01:00:00Z", notes: todayNotes("1234567", { outcomeAt: "2010-01-01T00:30:00Z", lostReason: "EARLIER REVIEW" }) })
      const b = target(3, { status: "cancelled", created_at: "2009-01-01T00:00:00Z", updated_at: "2011-01-01T02:00:00Z", notes: todayNotes("1234567", { outcomeAt: "2010-01-01T00:30:00Z", lostReason: "LATEST REVIEW" }) })
      const fixtureA = todayFixture(4, { enquiry_id: a.id, completed_at: "2010-01-01T01:00:00.123455Z", supplier_name: "EARLIER RAW COMPLETION" }); delete fixtureA.enquiry
      const fixtureB = todayFixture(5, { enquiry_id: b.id, completed_at: "2010-01-01T01:00:00.123456Z", supplier_name: "LATEST RAW COMPLETION" }); delete fixtureB.enquiry
      await f.owner.query(reset + insert("spc_enquiries", target()) + insert("spc_enquiries", a) + insert("spc_enquiries", b) + insert("spc_fixtures", fixtureA) + insert("spc_fixtures", fixtureB))
      const service = await f.session("parsed-time-ties")
      try {
        const r = await nativeApp(service, "today").get(); assert.equal(r.status, 200)
        assert.equal(r.body.enquiries[0].previousLost.buyerReason, "LATEST REVIEW"); assert.equal(r.body.enquiries[0].previousFixture.supplier, "LATEST RAW COMPLETION")
      } finally { await service.close() }
    })

    await t.test("snapshot held across main/count/candidates observes old coherent page, then refreshed new page", async () => {
      await f.owner.query(reset + insert("spc_enquiries", target()))
      const service = await f.session("held-snapshot")
      try {
        await f.owner.query("begin;lock table public.spc_fixtures in access exclusive mode;")
        const pending = service.one(rpcSql("today")); await waitForBlock(f.owner, service, f.owner, "relation", "spc_fixtures")
        await f.owner.query(insert("spc_enquiries", target(2)) + insert("spc_enquiries", target(3, { created_at: "2010-01-01T00:00:00Z", updated_at: "2010-01-01T00:00:00Z", status: "cancelled" })))
        await f.owner.query("commit;")
        const held = await pending, current = await service.one(rpcSql("today"))
        assert.equal(held.totalCount, 1); assert.equal(held.rows.length, 1); assert.equal(held.lost.length, 0)
        assert.equal(current.totalCount, 2); assert.equal(current.rows.length, 2); assert.equal(current.lost.length, 1)
      } finally { await f.owner.query("rollback;"); await service.close() }
    })

    await t.test("native stale revision, below-max same-count update, delete/reinsert and cursor tampering reject", async () => {
      await f.owner.query(reset + seedRecordPagesSql(251))
      const original = await f.owner.one(rpcSql("lost")), cursor = original.nextCursor
      await f.owner.query(`update public.spc_enquiries set title='CONTENT CHANGED' where id=${literal(original.rows.at(-1).id)};`)
      await expectedFailure(rpcSql("lost", cursor), "P0001")
      const refreshed = await f.owner.one(rpcSql("lost"))
      await f.owner.query(`delete from public.spc_enquiries where id=${literal(refreshed.rows[0].id)};` + seedRecordPagesSql(1).replaceAll("'record-'", "'replacement-'"))
      await expectedFailure(rpcSql("lost", refreshed.nextCursor), "P0001")
      const current = await f.owner.one(rpcSql("lost"))
      for (const change of [{ kind: "today" }, { day: "1999-01-01" }, { revision: "a".repeat(64) }, { id: todayId(9999999) }]) await expectedFailure(rpcSql("lost", { ...current.nextCursor, ...change }), "P0001")
      await expectedFailure(rpcSql("lost", { ...current.nextCursor, id: current.rows[0].id, createdAt: current.rows[0].created_at }), "22023")
    })

    await t.test("raw1MiB, escaped1MiB, complete candidate32MiB guards fail without writes/false absence", async () => {
      for (const oversized of ["x".repeat(1_048_577), "\\".repeat(600_000)]) {
        await f.owner.query(reset + insert("spc_enquiries", target(1, { notes: oversized })))
        const before = await f.owner.one(recordPagesStateSql); await expectedFailure(rpcSql("today")); assert.deepEqual(await f.owner.one(recordPagesStateSql), before)
      }
      await f.owner.query(reset + insert("spc_enquiries", target(1, { vessel_name: "\u{1ccd6} SYNTHETIC" })))
      await f.owner.query("insert into public.spc_enquiries select md5('budget-'||n)::uuid,'SYNTHETIC-'||n,'HISTORY','HISTORY','SG','VLSFO','500',null,null,'cancelled',repeat('x',20000),'synthetic@example.test','Synthetic','2000-01-01','2000-01-01' from generate_series(1,1800)n;")
      const before = await f.owner.one(recordPagesStateSql), service = await f.session("budget-api")
      try { const r = await nativeApp(service, "today").get(); assert.equal(r.status, 503); assert.equal(r.body.code, "COMPLETE_READ_UNAVAILABLE"); assert.equal(r.body.enquiries, undefined) } finally { await service.close() }
      assert.deepEqual(await f.owner.one(recordPagesStateSql), before)
    })

    await t.test("outer statement timeout cancellation becomes API unavailable; function setting alone is not hosted proof", async () => {
      await f.owner.query(reset + insert("spc_enquiries", target()))
      const service = await f.session("timed-read")
      try {
        await f.owner.query("begin;lock table public.spc_fixtures in access exclusive mode;")
        await service.query("set statement_timeout='80ms';")
        const before = await f.owner.one(recordPagesStateSql), r = await nativeApp(service, "today").get()
        assert.equal(r.status, 503); assert.equal(r.body.code, "COMPLETE_READ_UNAVAILABLE"); assert.match(service.stderr, /57014/)
        await f.owner.query("rollback;"); assert.deepEqual(await f.owner.one(recordPagesStateSql), before)
      } finally { await f.owner.query("rollback;"); await service.close() }
    })
  } finally {
    await f.close(); assert.equal(existsSync(join(f.data, "postmaster.pid")), false); assert.ok(f.sessions.every(s => s.closed))
    console.log(JSON.stringify({ recordPageFixture: f.root, runtimeSha256: f.runtimeSha256, fixtureSha256: f.fixtureSha256, cleanup: "all owned sessions/cluster closed; no TCP listener", hostedTimeout: "UNVERIFIED" }))
  }
})
