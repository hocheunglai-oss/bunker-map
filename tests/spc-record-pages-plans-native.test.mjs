import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setupNativeCcinfo, literal } from "./fixtures/native-postgres-ccinfo.mjs"
import { recordPagesFixtureSql, seedRecordPagesSql } from "./fixtures/spc-record-pages-sql.mjs"

function nodes(plan) { return [plan, ...(plan.Plans || []).flatMap(nodes)] }
test("native100000-row shallow/deep and conservative candidate plans are inspected, not index existence only", { timeout: 120_000 }, async () => {
  const f = await setupNativeCcinfo(recordPagesFixtureSql()), plans = {}
  const explain = async (key, sql) => {
    // psql emits EXPLAIN's JSON value over multiple physical lines.
    const result = JSON.parse((await f.owner.query("explain(analyze,buffers,format json) " + sql)).join("\n"))
    assert.equal(result.length, 1); assert.ok(result[0].Plan); assert.ok(Number.isFinite(result[0]["Execution Time"]))
    plans[key] = result[0]; return result[0]
  }
  try {
    await f.owner.query(seedRecordPagesSql(100_000) + "update public.spc_enquiries set created_at=date_trunc('second',created_at);analyze public.spc_enquiries;")
    const boundary = await f.owner.one("select jsonb_build_object('created',created_at,'id',id) from public.spc_enquiries order by created_at desc,id offset 28000 limit 1;")
    const stamp = literal(boundary.created) + "::timestamptz", id = literal(boundary.id) + "::uuid"
    const shallow = await explain("lostShallow", "select e.* from public.spc_enquiries e where e.status='cancelled' order by e.created_at desc,e.id limit 250;")
    const deep = await explain("lostDeepBoundedBranches", `select page.* from((select e.* from public.spc_enquiries e where e.status='cancelled' and e.created_at<${stamp} order by e.created_at desc,e.id limit 250)union all(select e.* from public.spc_enquiries e where e.status='cancelled' and e.created_at=${stamp} and e.id>${id} order by e.id limit 250))page order by created_at desc,id limit 250;`)
    for (const plan of [shallow, deep]) {
      assert.equal(plan.Plan["Actual Rows"], 250); assert.ok(nodes(plan.Plan).some(node => node["Index Name"] === "spc_record_cancelled_page_idx"))
      assert.ok(nodes(plan.Plan).every(node => (node["Rows Removed by Filter"] || 0) < 1000), "deep seeks must not filter28000 preceding rows")
    }
    const range = await f.owner.one("select jsonb_build_object('start',date_trunc('day',min(created_at)),'end',date_trunc('day',max(created_at))+interval'1day') from public.spc_enquiries;")
    const today = await explain("todayDeepTuple", `select e.* from public.spc_enquiries e where e.created_at>=${literal(range.start)} and e.created_at<${literal(range.end)} and(e.created_at,e.id)>(${stamp},${id})order by e.created_at,e.id limit 250;`)
    assert.ok(nodes(today.Plan).some(node => node["Index Name"] === "spc_record_today_page_idx"))
    const ascii = await explain("asciiIdentity", "select id from public.spc_enquiries where private.spc_record_ascii_name(vessel_name)='synthetic vessel 54321';")
    const imo = await explain("knownImo", "select id from public.spc_enquiries where status='cancelled' and private.spc_record_imo_selector(notes)->>'imo'='1054321';")
    assert.ok(nodes(ascii.Plan).some(node => node["Index Name"] === "spc_record_enquiry_ascii_idx")); assert.equal(ascii.Plan["Actual Rows"], 1)
    assert.ok(nodes(imo.Plan).some(node => node["Index Name"] === "spc_record_enquiry_imo_idx")); assert.equal(imo.Plan["Actual Rows"], 1)
    await explain("actualPublicLostStatement", "select public.read_spc_lost_record_page(null,250);")
    await explain("actualDeepMainFunction", `select * from private.spc_record_main_page('lost',${stamp},${id},250,null,null);`)
    const unknown = await explain("worstCaseUnknownNameCandidates", "select count(*) from private.spc_record_lost_ids('{}','{}',true);")
    assert.equal(unknown.Plan["Actual Rows"], 1)
    const candidateCount = await f.owner.one("select to_jsonb(count(*)) from private.spc_record_lost_ids('{}','{}',true);"); assert.equal(candidateCount, 100_000)
    const data = { scope: "owned synthetic PostgreSQL17.6 only; not hosted performance", runtimeSha256: f.runtimeSha256, fixtureSha256: f.fixtureSha256, rows: 100_000, repeatedTimestamps: true, candidateCount, plans }
    const output = process.env.SPC_RECORD_EVIDENCE_DIR
    if (output) {
      assert.match(output, /^\/private\/tmp\/fcuno-spc-list-completeness-[a-zA-Z0-9-]+$/)
      writeFileSync(join(output, "backend-native-plans.json"), JSON.stringify(data, null, 2) + "\n")
    }
    console.log(JSON.stringify({ summary: Object.fromEntries(Object.entries(plans).map(([key, plan]) => [key, { milliseconds: plan["Execution Time"], rows: plan.Plan["Actual Rows"], filtered: nodes(plan.Plan).reduce((sum, node) => sum + (node["Rows Removed by Filter"] || 0), 0), indexes: nodes(plan.Plan).flatMap(node => node["Index Name"] ? [node["Index Name"]] : []) }])), hostedPerformance: "UNVERIFIED" }))
  } finally { await f.close(); assert.equal(existsSync(join(f.data, "postmaster.pid")), false); assert.ok(f.sessions.every(session => session.closed)); console.log(JSON.stringify({ fixture: f.root, cleanup: "all owned sessions/cluster closed" })) }
})
