import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { setupNativeCcinfo, literal } from "./fixtures/native-postgres-ccinfo.mjs"
import { recordPagesFixtureSql, seedRecordPagesSql, recordPagesStateSql } from "./fixtures/spc-record-pages-sql.mjs"
import { createRecordPageRoute } from "./fixtures/spc-record-page-api.mjs"

const migrationPath = "supabase/migrations/20261022094634_stop_spc_record_page_business_conflict_retries.sql"
const migration = readFileSync(new URL("../" + migrationPath, import.meta.url), "utf8")
const original = readFileSync(new URL("../supabase/migrations/20261016125653_complete_spc_record_pages.sql", import.meta.url), "utf8")
const rpc = (kind, cursor = null, size = 250) => `select public.${kind === "lost" ? "read_spc_lost_record_page" : "read_spc_today_enquiry_page"}(${cursor ? literal(JSON.stringify(cursor)) + "::jsonb" : "null"},${size});`
const catalog = `select jsonb_agg(jsonb_build_object('oid',p.oid,'schema',n.nspname,'name',p.proname,'owner',p.proowner,'acl',p.proacl,'settings',p.proconfig,'stable',p.provolatile,'definer',p.prosecdef,'source',p.prosrc) order by n.nspname,p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='private' and p.proname like '%spc_record%') or (n.nspname='public' and p.proname in ('read_spc_lost_record_page','read_spc_today_enquiry_page'));`

test("native record-page business conflicts do not impersonate serialization failures", { timeout: 90_000 }, async t => {
  const f = await setupNativeCcinfo(recordPagesFixtureSql({ includeBusinessConflictFix: false }))
  async function failure(kind, cursor, expected = "P0001") {
    const service = await f.session("conflict-" + kind)
    try {
      await assert.rejects(service.one(rpc(kind, cursor)), error => {
        assert.equal(error.code, expected)
        if (expected === "P0001") assert.match(error.message, /SPC_RECORD_PAGE_REFRESH_REQUIRED/)
        return true
      })
    } finally { await service.close() }
  }
  try {
    await f.owner.query(seedRecordPagesSql(251))
    const beforeCatalog = await f.owner.one(catalog), beforeState = await f.owner.one(recordPagesStateSql)
    const beforePage = await f.owner.one(rpc("lost"))
    await t.test("migration source fence rejects independent drift before replacing the reader", async () => {
      const definition = await f.owner.one("select to_jsonb(pg_get_functiondef('private.read_spc_record_page(text,jsonb,integer)'::regprocedure));")
      const sourceDigest = await f.owner.one("select to_jsonb(md5(prosrc)) from pg_proc where oid='private.read_spc_record_page(text,jsonb,integer)'::regprocedure;")
      assert.equal(sourceDigest, "800d72588abf62d2a11f3edff4067617")
      assert.ok(definition.includes("AS $function$\n"))
      await f.owner.query(`${definition.replace("AS $function$\n", () => "AS $function$\n-- synthetic independently changed source\n")};`)
      const driftedCatalog = await f.owner.one(catalog), driftedState = await f.owner.one(recordPagesStateSql)
      const migrationOwner = await f.session("record-page-migration-owner", false)
      try {
        await assert.rejects(migrationOwner.query(`begin;${migration}commit;`), error => error.code === "55000" && /SPC_RECORD_PAGE_SOURCE_MISMATCH/.test(error.message))
        assert.deepEqual(await f.owner.one(catalog), driftedCatalog)
        assert.deepEqual(await f.owner.one(recordPagesStateSql), driftedState)
      } finally {
        await migrationOwner.close()
        await f.owner.query(`${definition};`)
      }
    })
    await f.owner.query("begin;" + migration + "commit;")
    await t.test("only three intentional business raises change; all function metadata and successful contents remain identical", async () => {
      const after = await f.owner.one(catalog)
      assert.equal(after.length, beforeCatalog.length)
      for (let i = 0; i < after.length; i++) {
        const a = after[i], b = beforeCatalog[i]
        const expected = b.name === "read_spc_record_page" ? b.source.replaceAll("errcode='40001',message='The record list changed. Refresh before browsing another page.'", "errcode='P0001',message='SPC_RECORD_PAGE_REFRESH_REQUIRED',detail='The record list changed. Refresh before browsing another page.'").replaceAll("errcode='40001',message='The complete record page could not be verified.'", "errcode='P0001',message='SPC_RECORD_PAGE_REFRESH_REQUIRED',detail='The complete record page could not be verified.'") : b.source
        assert.equal(a.source, expected, b.name)
        assert.deepEqual({ ...a, source: undefined }, { ...b, source: undefined })
        if (b.name === "read_spc_record_page") {
          assert.equal((b.source.match(/errcode='40001'/g) || []).length, 3)
          assert.equal((a.source.match(/errcode='P0001',message='SPC_RECORD_PAGE_REFRESH_REQUIRED'/g) || []).length, 3)
          assert.doesNotMatch(a.source, /errcode='40001'/)
        }
      }
      const afterPage = await f.owner.one(rpc("lost"))
      assert.deepEqual({ ...afterPage, checkedAt: undefined }, { ...beforePage, checkedAt: undefined })
      assert.deepEqual(await f.owner.one(recordPagesStateSql), beforeState)
    })
    await t.test("malformed, cross-kind, old-day and stale cursor guards raise the namedP0001", async () => {
      const page = await f.owner.one(rpc("lost"))
      for (const cursor of [{}, { ...page.nextCursor, kind: "today" }, { ...page.nextCursor, day: "1999-01-01" }, { ...page.nextCursor, revision: "a".repeat(64) }, { ...page.nextCursor, id: "ffffffff-ffff-ffff-ffff-ffffffffffff" }]) await failure("lost", cursor)
      await failure("today", { ...page.nextCursor, kind: "today", day: "1999-01-01" })
    })
    await t.test("real content edits invalidate the old cursor without changing other data on failure", async () => {
      const page = await f.owner.one(rpc("lost"))
      await f.owner.query(`update public.spc_enquiries set title='Synthetic revised content' where id=${literal(page.rows[0].id)};`)
      const state = await f.owner.one(recordPagesStateSql)
      await failure("lost", page.nextCursor)
      assert.deepEqual(await f.owner.one(recordPagesStateSql), state)
    })
    await t.test("actual native error through SDK and API yields one refresh409 and no partial rows", async () => {
      const page = await f.owner.one(rpc("lost")), service = await f.session("native-sdk-business-conflict")
      try {
        let captured
        const app = createRecordPageRoute({ fetchResponse: async () => {
          try { return Response.json(await service.one(rpc("lost", { ...page.nextCursor, revision: "a".repeat(64) }))) }
          catch (error) { captured = error; return Response.json({ code: error.code, message: error.message.includes("SPC_RECORD_PAGE_REFRESH_REQUIRED") ? "SPC_RECORD_PAGE_REFRESH_REQUIRED" : error.message }, { status: 400 }) }
        } })
        const response = await app.get()
        assert.equal(captured?.code, "P0001")
        assert.equal(response.status, 409)
        assert.equal(response.body.code, "REFRESH_REQUIRED")
        assert.equal(response.body.enquiries, undefined)
        assert.equal(app.queries.length, 1)
      } finally { await service.close() }
    })
    await t.test("page-count guard remains fail-closed with the same named business code", async () => {
      const definition = await f.owner.one("select to_jsonb(pg_get_functiondef('private.spc_record_main_page(text,timestamptz,uuid,integer,timestamptz,timestamptz)'::regprocedure));")
      try {
        await f.owner.query("create or replace function private.spc_record_main_page(p_kind text,p_created timestamptz,p_id uuid,p_size integer,p_start timestamptz,p_end timestamptz) returns setof public.spc_enquiries language sql stable security invoker set search_path='' as $$select e.* from public.spc_enquiries e where false;$$;")
        await failure("lost", null)
      } finally { await f.owner.query(definition) }
    })
    await t.test("invalid argument and role restrictions are unchanged", async () => {
      for (const role of ["anon", "authenticated"]) {
        const service = await f.session("denied-" + role, false)
        try { await service.query("set role " + role + ";"); await assert.rejects(service.one(rpc("lost")), error => error.code === "42501") } finally { await service.close() }
      }
      const service = await f.session("invalid-page-size")
      try { await assert.rejects(service.one(rpc("lost", null, 251)), error => error.code === "22023") } finally { await service.close() }
    })
  } finally {
    await f.close()
    assert.equal(existsSync(join(f.data, "postmaster.pid")), false)
    assert.ok(f.sessions.every(s => s.closed))
    console.log(JSON.stringify({ fixture: f.root, migrationSha256: createHash("sha256").update(migration).digest("hex"), originalMigrationSha256: createHash("sha256").update(original).digest("hex"), runtimeSha256: f.runtimeSha256, cleanup: "all owned sessions/cluster closed; no TCP listener", hostedPostgrestRetry: "not executed against production" }))
  }
})
