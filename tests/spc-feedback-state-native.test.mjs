import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { setupNativeCcinfo, literal, waitForBlock } from "./fixtures/native-postgres-ccinfo.mjs"
import { feedbackRuntime, feedbackSchemaSql, feedbackSeedSql, feedbackId } from "./fixtures/spc-feedback-api.mjs"

test("native actual feedback API rechecks a held review version and preserves independent rows", { timeout: 120000 }, async t => {
  const f = await setupNativeCcinfo(feedbackSchemaSql() + feedbackSeedSql)
  console.log(JSON.stringify({ feedbackFixtureRoot: f.root, nativeVersion: f.version }))
  const adapter = reader => feedbackRuntime(async (sql, params) => {
    const bound = sql.replace(/\$(\d+)/g, (_match, number) => literal(params[Number(number) - 1]))
    // A data-modifying CTE must remain top-level in native PostgreSQL.
    const statement = bound.startsWith("with changed as (")
      ? bound.replace("select to_jsonb(t) as record from changed t", "select coalesce(jsonb_agg(jsonb_build_object('record',to_jsonb(t))),'[]') from changed t")
      : "select coalesce(jsonb_agg(to_jsonb(result)),'[]') from (" + bound + ") result"
    return { rows: await reader.one(statement + ";") }
  })
  try {
    await t.test("raw microsecond CAS is preserved through actual route/helper and native PostgreSQL", async () => {
      const reader = await f.session("feedback-native-api")
      try {
        const app = adapter(reader), read = await app.send(), original = read.body.records[0]
        assert.match(original.updatedAt, /\.123456[+Z]/)
        const saved = await app.send("PATCH", { id: feedbackId, expectedUpdatedAt: original.updatedAt, status: "PLANNED", adminResponse: "Native verified review" })
        assert.equal(saved.status, 200, JSON.stringify(saved))
        assert.notEqual(saved.body.record.updatedAt, original.updatedAt)
        const state = await f.owner.one("select to_jsonb(t) from public.spc_feedback t where id=" + literal(feedbackId) + ";")
        assert.equal((await app.send("PATCH", { id: feedbackId, expectedUpdatedAt: original.updatedAt, status: "CLOSED" })).status, 409)
        assert.deepEqual(await f.owner.one("select to_jsonb(t) from public.spc_feedback t where id=" + literal(feedbackId) + ";"), state)
      } finally { await reader.close() }
    })
    await t.test("held writer wins; stale waiting update returns 409 while another row can save", async () => {
      const secondId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
      await f.owner.query("insert into public.spc_feedback select " + literal(secondId) +
        "::uuid,category,title,message,area,status,admin_response,created_by_user_id,created_by_username,created_by_display_name,reviewed_by_username,reviewed_by_display_name,created_at,updated_at from public.spc_feedback where id=" + literal(feedbackId) + ";")
      const writer = await f.session("feedback-held-writer", false), reader = await f.session("feedback-held-api"), other = await f.session("feedback-other-api"), observer = await f.session("feedback-observer", false)
      try {
        const app = adapter(reader), initial = (await app.send()).body.records
        await writer.query("begin;update public.spc_feedback set status='COMPLETED',admin_response='Concurrent committed review' where id=" + literal(feedbackId) + ";")
        const held = app.send("PATCH", { id: feedbackId, expectedUpdatedAt: initial.find(row => row.id === feedbackId).updatedAt, status: "REVIEWING", adminResponse: "Stale pending review" })
        await waitForBlock(observer, reader, writer, "transactionid")
        const separate = await adapter(other).send("PATCH", { id: secondId, expectedUpdatedAt: initial.find(row => row.id === secondId).updatedAt, status: "CLOSED", adminResponse: "Independent row" })
        assert.equal(separate.status, 200, JSON.stringify(separate))
        await writer.query("commit;")
        const result = await held
        assert.equal(result.status, 409); assert.equal(app.writes.at(-1).affected, 0)
        const row = await observer.one("select to_jsonb(t) from public.spc_feedback t where id=" + literal(feedbackId) + ";")
        assert.equal(row.status, "COMPLETED"); assert.equal(row.admin_response, "Concurrent committed review")
      } finally { await writer.close(); await reader.close(); await other.close(); await observer.close() }
    })
    await t.test("suppressed UPDATE produces conflict, not a false successful acknowledgement", async () => {
      await f.owner.query("create function public.feedback_test_suppress() returns trigger language plpgsql as $$ begin return null;end $$;create trigger feedback_test_suppress before update on public.spc_feedback for each row execute function public.feedback_test_suppress();")
      const reader = await f.session("feedback-suppressed-api")
      try {
        const app = adapter(reader), original = (await app.send()).body.records.find(row => row.id === feedbackId)
        const result = await app.send("PATCH", { id: feedbackId, expectedUpdatedAt: original.updatedAt, status: "NEW", adminResponse: "Must not save" })
        assert.equal(result.status, 409); assert.equal(app.writes.at(-1).affected, 0)
        assert.equal((await app.send()).body.records.find(row => row.id === feedbackId).adminResponse, original.adminResponse)
      } finally { await reader.close() }
    })
  } finally {
    await f.close()
    assert.equal(existsSync(join(f.data, "postmaster.pid")), false)
    assert.ok(f.sessions.every(session => session.closed))
    assert.match(readFileSync(join(f.root, "server.log"), "utf8"), /database system is shut down/)
    console.log(JSON.stringify({ feedbackFixtureRoot: f.root, ownedSessionsClosed: f.sessions.length, postmasterPidAbsent: true, shutdownConfirmed: true }))
  }
})
