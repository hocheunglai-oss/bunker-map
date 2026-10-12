import assert from "node:assert/strict"
import test from "node:test"
import { parserReviewFixture, originalVersion, reportId } from "./fixtures/parser-review-sql.mjs"
import * as parserReports from "../lib/parserReports.ts"

test("actual handler, Supabase query serializer and SQL preserve normal review workflow for both sources", async () => {
  for (const source of ["enquiryworksheet", "spc"]) {
    const f = await parserReviewFixture({ source, metadata: parserReports.pendingParserReportMetadata({ retained: "KEEP", aiFixOutput: "OLD AI" }) })
    try {
      assert.equal((await f.row()).updated_at, originalVersion, "initial/restore insert timestamps remain exact")
      const input = await f.input(), saved = await f.request(input)
      assert.equal(saved.status, 200)
      assert.equal(saved.body.report.correctedOutput, "MY CORRECTION")
      assert.equal(saved.body.report.note, "MY NOTE")
      assert.equal(saved.body.report.metadata.retained, "KEEP")
      assert.equal(saved.body.report.metadata.aiReviewState, "pending-ai")
      assert.equal(saved.body.report.updatedAt, "2099-10-12T00:00:00.123457+00:00")
      const completed = await f.request({ ...await f.input("review"), correctedOutput: "IGNORED HUMAN OVERWRITE", aiOutput: "AI SUGGESTION", aiSources: [{ url: "https://example.test/imo", title: "Synthetic IMO source" }] })
      assert.equal(completed.status, 200)
      assert.equal(completed.body.report.correctedOutput, "MY CORRECTION")
      assert.equal(completed.body.report.metadata.aiFixOutput, "AI SUGGESTION")
      assert.equal(completed.body.report.metadata.aiReviewState, "complete")
      assert.equal(completed.body.report.updatedAt, "2099-10-12T00:00:00.123458+00:00")
      assert.equal(completed.body.report.status, "reviewed")
      assert.ok(f.permissions.every(permission => permission.page === (source === "spc" ? "spc-parser-reports" : "parser-reports") && permission.access === "edit"))
    } finally { await f.close() }
  }
})

test("two actual-handler reads of the same version yield one SQL winner and one retained-draft conflict", async () => {
  for (const source of ["enquiryworksheet", "spc"]) {
    for (const [action, metadata, status] of [
      ["submit-ai", parserReports.pendingParserReportMetadata({}), "new"],
      ["review", parserReports.queuedAiParserReportMetadata({}, originalVersion, "ORIGINAL CORRECTION"), "new"],
      ["acknowledge", { aiReviewState: "ready" }, "reviewed"],
      ["acknowledge", { pendingUserReview: true }, "reviewed"],
    ]) {
      const f = await parserReviewFixture({ source, metadata, status })
      try {
        const input = await f.input(action), before = await f.state()
        f.controls.holdReads = 2
        const results = await Promise.all([f.request({ ...input, note: "WINNER NOTE", correctedOutput: "WINNER CORRECTION" }), f.request({ ...input, note: "LOSER NOTE", correctedOutput: "LOSER CORRECTION" })])
        assert.deepEqual(results.map(result => result.status), [200, 409], `${source} ${action}`)
        assert.equal(results[1].body.code, "PARSER_REPORT_CONFLICT")
        assert.match(results[1].body.message, /draft has been kept/)
        const after = await f.state()
        assert.equal(after.report.note, "WINNER NOTE")
        assert.equal(after.report.corrected_output, action === "submit-ai" ? "WINNER CORRECTION" : "ORIGINAL CORRECTION")
        assert.equal(after.audit.length, before.audit.length + 1, "failed CAS must not create an audit record")
        const replay = await f.request(input)
        assert.equal(replay.status, 409)
        assert.deepEqual(await f.state(), after, "a stale retry must not advance audit or backup markers")
      } finally { await f.close() }
    }
  }
})

test("missing, malformed, nullable and microsecond-truncated versions cannot write; permissions are checked first", async () => {
  const f = await parserReviewFixture()
  try {
    const input = await f.input(), before = await f.state()
    for (const value of [undefined, ""]) {
      assert.equal((await f.request({ ...input, expectedUpdatedAt: value })).status, 409)
    }
    for (const value of [null, 123, {}, "infinity", "not-a-date", "2099-02-30T00:00:00Z", "2099-10-12T24:00:00Z", "2099-10-12T00:00:00.1234567Z"]) {
      assert.equal((await f.request({ ...input, expectedUpdatedAt: value })).status, 400, JSON.stringify(value))
    }
    assert.equal((await f.request({ ...input, expectedUpdatedAt: new Date(input.expectedUpdatedAt).toISOString() })).status, 409)
    assert.deepEqual(await f.state(), before)
    assert.equal(f.requests.length, 1, "only the valid-but-stale opaque version needs a read")
    for (const [permission, status] of [["view", 403], ["anonymous", 401]]) {
      f.controls.permission = permission
      const clients = f.clients(), requests = f.requests.length
      assert.equal((await f.request({ ...input, expectedUpdatedAt: null })).status, status)
      assert.equal(f.clients(), clients); assert.equal(f.requests.length, requests)
    }
  } finally { await f.close() }
})

test("duplicate re-report between a review read and write advances its version even with the same request timestamp", async () => {
  for (const source of ["enquiryworksheet", "spc"]) {
    const f = await parserReviewFixture({ source, metadata: parserReports.queuedAiParserReportMetadata({}, originalVersion, "ORIGINAL CORRECTION") })
    try {
      const input = await f.input("review")
      f.controls.beforeRpc = () => f.upsert()
      const result = await f.request(input)
      assert.equal(result.status, 409)
      const row = await f.row()
      assert.equal(row.updated_at, "2099-10-12T00:00:00.123457+00:00")
      assert.equal(row.duplicate_count, 2)
      assert.equal(row.metadata.aiReviewState, "pending-user")
      assert.equal(row.status, "new")
      assert.equal(row.corrected_output, "ORIGINAL CORRECTION")
      assert.equal(row.note, "ORIGINAL NOTE")
      const next = await f.request(await f.input())
      assert.equal(next.status, 200)
      assert.equal((await f.row()).updated_at, "2099-10-12T00:00:00.123458+00:00")
    } finally { await f.close() }
  }
})

test("audit undo restores business values with a fresh version and cannot make an old draft current again", async () => {
  const f = await parserReviewFixture({ metadata: parserReports.pendingParserReportMetadata({ retained: "ORIGINAL" }) })
  try {
    const old = await f.input(), before = await f.row()
    assert.equal((await f.request(old)).status, 200)
    const change = (await f.state()).audit.at(-1)
    await f.db.query("select public.undo_audit_log($1::uuid,'SYNTHETIC UNDO','Synthetic Undo')", [change.id])
    const restored = await f.row(), state = await f.state()
    assert.deepEqual({ ...restored, updated_at: before.updated_at }, before)
    assert.equal(restored.updated_at, "2099-10-12T00:00:00.123458+00:00")
    const undo = state.audit.find(record => record.undo_of_log_id === change.id)
    assert.ok(undo)
    assert.equal(undo.after_row.updated_at, restored.updated_at)
    assert.equal(undo.after_row.corrected_output, before.corrected_output)
    assert.equal((await f.request(old)).status, 409)
    assert.deepEqual(await f.state(), state)
  } finally { await f.close() }
})

test("RPC enforces exact current stage including legacy strict JSON types without touching other sources", async () => {
  for (const [metadata, status, action] of [
    [{}, "new", "review"], [{ aiReviewState: "pending-ai" }, "new", "submit-ai"],
    [{ aiReviewState: "complete" }, "reviewed", "acknowledge"],
    [{ pendingUserReview: "true" }, "reviewed", "acknowledge"],
    [{ aiReviewState: true }, "reviewed", "acknowledge"],
  ]) {
    const f = await parserReviewFixture({ metadata, status })
    try {
      const before = await f.state()
      await assert.rejects(f.rpc("save_parser_report_review", {
        p_id: reportId, p_source: f.source, p_expected_updated_at: before.report.updated_at, p_action: action,
        p_corrected_output: "DIRECT CORRECTION", p_note: "DIRECT NOTE", p_metadata: action === "submit-ai"
          ? parserReports.queuedAiParserReportMetadata(metadata, originalVersion, "DIRECT CORRECTION")
          : parserReports.completedParserReportMetadata(metadata, originalVersion),
      }), error => error.code === "P0002")
      assert.deepEqual(await f.state(), before)
    } finally { await f.close() }
  }
  for (const metadata of [{}, { aiReviewState: null }, { pendingReview: true }, []]) {
    const f = await parserReviewFixture({ metadata })
    try { assert.equal((await f.request(await f.input())).status, 200, "legacy pending-user metadata keeps the existing JS interpretation") }
    finally { await f.close() }
  }
})

test("a large correction and metadata use a short database URL and bounded RPC body, not query predicates", async () => {
  const f = await parserReviewFixture({ metadata: { savedContext: "X".repeat(30000) } })
  try {
    const result = await f.request({ ...await f.input(), correctedOutput: "C".repeat(20000), note: "N".repeat(2000) })
    assert.equal(result.status, 200)
    assert.equal(result.body.report.correctedOutput.length, 20000)
    assert.equal(result.body.report.metadata.savedContext.length, 30000)
    assert.ok(f.requests.every(request => request.url.length < 1000))
    const write = f.requests.find(request => request.method === "POST")
    assert.equal(write.body.p_metadata.savedContext.length, 30000)
    assert.equal(write.body.p_expected_updated_at, originalVersion)
  } finally { await f.close() }
})

test("non-UTC database timestamps retain every microsecond and are sent back without Date normalization", async () => {
  const f = await parserReviewFixture()
  try {
    await f.db.exec("set time zone 'Asia/Hong_Kong'")
    const input = await f.input()
    assert.equal(input.expectedUpdatedAt, "2099-10-12T08:00:00.123456+08:00")
    assert.equal((await f.request({ ...input, expectedUpdatedAt: originalVersion })).status, 409, "an equivalent instant is not the exact opened opaque token")
    const result = await f.request(input)
    assert.equal(result.status, 200)
    assert.equal(result.body.report.updatedAt, "2099-10-12T08:00:00.123457+08:00")
  } finally { await f.close() }
})

test("service-only execution, browser RLS, invalid RPC inputs and late SQL failures leave state intact", async () => {
  const f = await parserReviewFixture()
  try {
    const before = await f.state()
    const privileges = (await f.db.query(`select rolname,
      has_function_privilege(rolname,'public.save_parser_report_review(uuid,text,timestamptz,text,text,text,jsonb)','EXECUTE') as execute,
      has_table_privilege(rolname,'public.parser_reports','UPDATE') as update
      from pg_roles where rolname in ('anon','authenticated','service_role') order by rolname`)).rows
    assert.deepEqual(privileges.map(row => [row.rolname,row.execute,row.update]), [["anon",false,false],["authenticated",false,false],["service_role",true,true]])
    const definition = (await f.db.query("select prosecdef,proconfig from pg_proc where oid='public.save_parser_report_review(uuid,text,timestamptz,text,text,text,jsonb)'::regprocedure")).rows[0]
    assert.equal(definition.prosecdef, false)
    assert.ok(definition.proconfig.includes('search_path=""'))
    for (const role of ["anon", "authenticated"]) {
      await f.db.exec(`reset role; set role ${role};`)
      await assert.rejects(f.db.query("select * from parser_reports"), error => error.code === "42501")
      await assert.rejects(f.rpc("save_parser_report_review", { p_id: reportId, p_source: f.source, p_expected_updated_at: originalVersion, p_action: "submit-ai", p_corrected_output: "X", p_note: "", p_metadata: parserReports.queuedAiParserReportMetadata({}, originalVersion, "X") }), error => error.code === "42501")
      await f.db.exec("reset role; set role service_role;")
    }
    const args = { p_id: reportId, p_source: f.source, p_expected_updated_at: originalVersion, p_action: "submit-ai", p_corrected_output: "X", p_note: "", p_metadata: parserReports.queuedAiParserReportMetadata({}, originalVersion, "X") }
    for (const invalid of [{ p_id: null }, { p_source: null }, { p_source: "other" }, { p_expected_updated_at: null }, { p_expected_updated_at: "infinity" }, { p_action: "other" }, { p_corrected_output: " " }, { p_corrected_output: "X".repeat(20001) }, { p_note: "X".repeat(2001) }, { p_metadata: [] }]) {
      await assert.rejects(f.rpc("save_parser_report_review", { ...args, ...invalid }), error => error.code === "22023")
    }
    await assert.rejects(f.rpc("save_parser_report_review", { ...args, p_source: "spc" }), error => error.code === "P0002")
    await assert.rejects(f.rpc("save_parser_report_review", { ...args, p_id: "22222222-2222-4222-8222-222222222222" }), error => error.code === "P0002")
    assert.deepEqual(await f.state(), before)
    await f.db.exec("reset role; create function public.synthetic_parser_failure() returns trigger language plpgsql as $$ begin raise exception 'SYNTHETIC LATE FAILURE'; end; $$; create trigger z_synthetic_parser_failure after update on parser_reports for each row execute function public.synthetic_parser_failure(); set role service_role;")
    assert.equal((await f.request(await f.input())).status, 500)
    assert.deepEqual(await f.state(), before, "later SQL failure rolls back report, audit and backup marker together")
  } finally { await f.close() }
})

test("zero-row/deleted report and damaged RPC response cannot produce a false successful save", async () => {
  for (const mode of ["deleted", "wrong-source", "damage"]) {
    const f = await parserReviewFixture()
    try {
      const input = await f.input()
      if (mode === "deleted") f.controls.beforeRpc = () => f.db.query("delete from parser_reports where id=$1::uuid", [reportId])
      if (mode === "wrong-source") f.controls.beforeRpc = () => f.db.query("update parser_reports set source='spc' where id=$1::uuid", [reportId])
      if (mode === "damage") f.controls.damage = true
      const result = await f.request(input)
      assert.equal(result.status, mode === "damage" ? 500 : 409)
      assert.notEqual(result.body.success, true)
      if (mode === "damage") assert.equal((await f.row()).corrected_output, "MY CORRECTION", "an uncertain response can follow a commit, so the UI must retain rather than auto-retry/discard the draft")
    } finally { await f.close() }
  }
})
