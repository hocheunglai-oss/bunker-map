import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { streamAuditLogRows } from "../lib/backupAuditLogExport.ts"
import { literal, setupNativeCcinfo } from "./fixtures/native-postgres-ccinfo.mjs"

const ROWS = 80003
const PAGE_SIZE = 500
const DEEP_OFFSET = 60000
const hash = () => createHash("sha256")
const fixtureSql = `
  create role service_role nologin nobypassrls;
  grant usage on schema public to service_role;
  create table public.audit_logs (
    id uuid primary key,
    occurred_at timestamptz not null,
    table_name text not null,
    operation text not null,
    changed_fields text[] not null,
    before_row jsonb,
    after_row jsonb
  );
  alter table public.audit_logs enable row level security;
  create policy synthetic_read on public.audit_logs for select to service_role using (true);
  grant select on public.audit_logs to service_role;
  insert into public.audit_logs
  select md5('FCUNO SYNTHETIC AUDIT ' || n::text)::uuid,
    timestamptz '2026-01-01 00:00:00+00' + n * interval '1 second',
    'synthetic_records', 'UPDATE', array['value','note'],
    jsonb_build_object('value',n - 1,'note','SYNTHETIC BEFORE','nullable',null),
    jsonb_build_object('value',n,'note','SYNTHETIC AFTER α 港口','preserved',true,
      'padding',repeat('fixture-',8))
  from generate_series(1,${ROWS}) as n;
  analyze public.audit_logs;
`

const directRead = async operation => {
  const result = await operation()
  if (result.error) throw result.error
  return result.data
}

function digestRows(hasher, rows) {
  for (const row of rows) hasher.update(JSON.stringify(row)).update("\n")
}

function allPlanNodes(plan) {
  return [plan, ...(plan.Plans || []).flatMap(allPlanNodes)]
}

// This is a synthetic engine/algorithm regression, not a production backup,
// restore or timing promise. It uses one private UNIX-socket-only cluster and
// the actual streaming helper; existing SDK tests separately prove REST syntax.
test("native audit cursor export preserves complete history while avoiding deep OFFSET work", { timeout: 120000 }, async t => {
  const fixture = await setupNativeCcinfo(fixtureSql)
  try {
    const reader = await fixture.session("synthetic-audit-readonly")
    await reader.query("begin isolation level repeatable read read only; set local statement_timeout='15s';")
    const identity = await reader.one(`select jsonb_build_object(
      'role',current_user,'readOnly',current_setting('transaction_read_only'),
      'select',has_table_privilege(current_user,'public.audit_logs','select'),
      'insert',has_table_privilege(current_user,'public.audit_logs','insert'),
      'update',has_table_privilege(current_user,'public.audit_logs','update'),
      'delete',has_table_privilege(current_user,'public.audit_logs','delete'));`)
    assert.deepEqual(identity, { role: "service_role", readOnly: "on", select: true, insert: false, update: false, delete: false })

    await t.test("80,003 actual SQL rows match the old ordered export exactly with bounded sequential pages", async () => {
      const legacyHash = hash(), cursorHash = hash()
      let legacyCount = 0, legacyPages = 0, legacyLast = null
      // Execute the previous OFFSET algorithm against the same immutable
      // synthetic snapshot; compare full rows, not merely IDs or a row count.
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const rows = await reader.one(`select coalesce(jsonb_agg(to_jsonb(page) order by id),'[]'::jsonb)
          from (select * from public.audit_logs order by id asc limit ${PAGE_SIZE} offset ${offset}) as page;`)
        assert.ok(rows.length <= PAGE_SIZE)
        for (const row of rows) {
          assert.ok(legacyLast === null || row.id > legacyLast)
          legacyLast = row.id
        }
        legacyPages += 1
        legacyCount += rows.length
        digestRows(legacyHash, rows)
        if (rows.length < PAGE_SIZE) break
      }

      let cursorCount = 0, cursorPages = 0, cursorLast = null
      let readInFlight = false, writerInFlight = false, maximumBatch = 0
      const exported = await streamAuditLogRows({
        pageSize: PAGE_SIZE,
        retryRead: directRead,
        readPage: async (after, limit) => {
          assert.equal(readInFlight, false, "Only one database page is in flight")
          assert.equal(writerInFlight, false, "Compression/writer backpressure completes before fetching another page")
          assert.equal(after, cursorLast, "The next request starts strictly after the last appended row")
          assert.equal(limit, PAGE_SIZE)
          readInFlight = true
          try {
            const where = after === null ? "" : `where id > ${literal(after)}::uuid`
            const data = await reader.one(`select coalesce(jsonb_agg(to_jsonb(page) order by id),'[]'::jsonb)
              from (select * from public.audit_logs ${where} order by id asc limit ${limit}) as page;`)
            cursorPages += 1
            maximumBatch = Math.max(maximumBatch, data.length)
            assert.ok(data.length <= PAGE_SIZE)
            return { data, error: null }
          } finally { readInFlight = false }
        },
        appendRows: async rows => {
          assert.equal(readInFlight, false)
          assert.equal(writerInFlight, false)
          writerInFlight = true
          try {
            for (const row of rows) {
              assert.ok(cursorLast === null || row.id > cursorLast, "No duplicate or descending UUID can enter the archive")
              cursorLast = row.id
            }
            digestRows(cursorHash, rows)
            cursorCount += rows.length
            await Promise.resolve()
          } finally { writerInFlight = false }
        },
      })
      const previousDigest = legacyHash.digest("hex"), repairedDigest = cursorHash.digest("hex")
      assert.equal(legacyCount, ROWS)
      assert.equal(cursorCount, ROWS)
      assert.equal(exported, ROWS)
      assert.equal(cursorPages, Math.ceil(ROWS / PAGE_SIZE))
      assert.equal(legacyPages, cursorPages)
      assert.equal(maximumBatch, PAGE_SIZE)
      assert.equal(cursorLast, legacyLast)
      assert.equal(repairedDigest, previousDigest, "Every ordered field of every source row is retained")
      const countAfter = await reader.one("select to_jsonb(count(*)) from public.audit_logs;")
      assert.equal(countAfter, ROWS, "Neither reader changes or deletes history")
      t.diagnostic(JSON.stringify({ syntheticRows: ROWS, pageSize: PAGE_SIZE, pages: cursorPages,
        oldOrderedSha256: previousDigest, repairedOrderedSha256: repairedDigest, maximumBatch,
        sourceRowsUnchanged: true, productionDataTouched: false }))
    })

    await t.test("deep cursor page uses its primary-key bound and visits only returned rows", async () => {
      const after = await reader.one(`select to_jsonb(id::text) from public.audit_logs order by id asc limit 1 offset ${DEEP_OFFSET - 1};`)
      const oldQuery = `select * from public.audit_logs order by id asc limit ${PAGE_SIZE} offset ${DEEP_OFFSET}`
      const newQuery = `select * from public.audit_logs where id > ${literal(after)}::uuid order by id asc limit ${PAGE_SIZE}`
      const oldPlan = JSON.parse((await reader.query(`explain (analyze,buffers,format json) ${oldQuery};`)).join("\n"))[0]
      const newPlan = JSON.parse((await reader.query(`explain (analyze,buffers,format json) ${newQuery};`)).join("\n"))[0]
      const oldScan = allPlanNodes(oldPlan.Plan).find(node => node["Index Name"] === "audit_logs_pkey")
      const newScan = allPlanNodes(newPlan.Plan).find(node => node["Index Name"] === "audit_logs_pkey")
      assert.ok(oldScan, "The baseline traverses the existing UUID primary-key index")
      assert.ok(newScan, "The repair uses the same existing index; no new production index is required")
      assert.equal(oldScan["Actual Loops"], 1)
      assert.equal(newScan["Actual Loops"], 1)
      assert.equal(oldScan["Actual Rows"], DEEP_OFFSET + PAGE_SIZE)
      assert.equal(newScan["Actual Rows"], PAGE_SIZE)
      assert.equal(oldScan["Index Cond"], undefined)
      assert.ok(newScan["Index Cond"].includes(after) && newScan["Index Cond"].includes("id >"))
      assert.ok(oldScan["Actual Rows"] / newScan["Actual Rows"] >= 100,
        "A deep page avoids at least 100x previously visited rows; no timing threshold is asserted")
      const actualOld = await reader.one(`select coalesce(jsonb_agg(to_jsonb(page) order by id),'[]'::jsonb) from (${oldQuery}) as page;`)
      const actualNew = await reader.one(`select coalesce(jsonb_agg(to_jsonb(page) order by id),'[]'::jsonb) from (${newQuery}) as page;`)
      assert.deepEqual(actualNew, actualOld, "Reduced traversal must return exactly the same deep page")
      t.diagnostic(JSON.stringify({ deepOffset: DEEP_OFFSET, pageSize: PAGE_SIZE,
        oldIndexRowsVisited: oldScan["Actual Rows"], cursorIndexRowsVisited: newScan["Actual Rows"],
        cursorIndexCondition: newScan["Index Cond"], rowVisitReduction: oldScan["Actual Rows"] / newScan["Actual Rows"],
        oldExecutionMsInformationalOnly: oldPlan["Execution Time"], cursorExecutionMsInformationalOnly: newPlan["Execution Time"] }))
    })
    await reader.query("rollback;")
    t.diagnostic(JSON.stringify({ cluster: fixture.root, runtime: fixture.version,
      runtimeSha256: fixture.runtimeSha256, fixtureSha256: fixture.fixtureSha256,
      helperSha256: hash().update(readFileSync(new URL("../lib/backupAuditLogExport.ts", import.meta.url))).digest("hex"),
      testSha256: hash().update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
      productionDataTouched: false }))
  } finally {
    await fixture.close()
    assert.ok(fixture.sessions.every(session => session.closed))
    assert.equal(existsSync(join(fixture.data, "postmaster.pid")), false)
    t.diagnostic("All owned sessions closed and synthetic PostgreSQL server stopped; no hosted access or archive deletion.")
  }
})
