import assert from "node:assert/strict"
import test from "node:test"
import { setupUsageSql, usageScaleSql, usageMigration } from "./fixtures/openai-usage-sql.mjs"
import { parseOpenAiUsageReport } from "../lib/openAiUsageReport.ts"
import { usageRouteHarness } from "./fixtures/openai-usage-report.ts"

test("actual usage SQL and actual API aggregate ALL10001 events, including older pages, errors and tokens", async () => {
  const f = await setupUsageSql()
  try {
    await f.db.exec(usageScaleSql)
    for (const days of [7,30,90]) {
      const report = parseOpenAiUsageReport(await f.report(days),days)
      assert.equal(report.totals.requests,10001); assert.equal(report.totals.totalTokens,1010000); assert.equal(report.totals.errors,1)
      assert.equal(report.pages[0].pageId,'older'); assert.equal(report.pages[0].pagePath,'/api/ecosystem/knowledge-extract')
      assert.equal(report.pages[0].totalTokens,1000000); assert.equal(report.recent.length,20)
      const route=usageRouteHarness(async period=>({data:await f.report(period),error:null})), response=await route.send(days)
      assert.equal(response.status,200); const actual=await response.json();assert.equal(actual.totals.requests,10001);assert.equal(actual.totals.totalTokens,1010000)
    }
  } finally { await f.db.close() }
})

test("usage SQL handles empty/zero counters, exact windows, future exclusion and deterministic equal-timestamp paths/recent", async () => {
  const f=await setupUsageSql()
  try {
    assert.deepEqual(parseOpenAiUsageReport(await f.report(7),7).totals,{requests:0,errors:0,inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningTokens:0,totalTokens:0,webSearchCalls:0})
    await f.db.exec(`insert into openai_usage_events(occurred_at,page_id,page_path,feature,status) values
      (statement_timestamp()-interval '1 day','same','/admin/old','z','success'),
      (statement_timestamp()-interval '1 day','same','/spc/enquiries','a','success'),
      (statement_timestamp()-interval '8 days','older','/admin','old','error'),
      (statement_timestamp()-interval '31 days','oldest','/admin','old','success'),
      (statement_timestamp()-interval '91 days','excluded','/admin','old','success'),
      (statement_timestamp()+interval '1 day','future','/admin','old','success');`)
    for(const [days,count] of [[7,2],[30,3],[90,4]]){
      const report=parseOpenAiUsageReport(await f.report(days),days);assert.equal(report.totals.requests,count)
      assert.equal(report.pages.find(p=>p.pageId==='same').pagePath,'/spc/enquiries');assert.equal(report.recent[0].page_path,'/spc/enquiries')
      assert.deepEqual(report.pages.find(p=>p.pageId==='same').features,['a','z']);assert.equal(report.pages.every(p=>p.tokenPercentage===0),true)
    }
    for(const bad of [null,0,8,365]) await assert.rejects(f.report(bad),e=>e.code==='22023')
  }finally{await f.db.close()}
})

test("usage SQL rejects unsafe summed bigint totals, not silently rounded numbers; invoker read-only ACL holds", async()=>{
  const f=await setupUsageSql()
  try{
    await f.db.exec(`insert into openai_usage_events(page_id,page_path,feature,status,total_tokens) values('safe','/admin','','success',9007199254740991);`)
    assert.equal(parseOpenAiUsageReport(await f.report(30),30).totals.totalTokens,Number.MAX_SAFE_INTEGER)
    await f.db.exec(`insert into openai_usage_events(page_id,page_path,feature,status,total_tokens) values('safe','/admin','','success',1);`)
    await assert.rejects(f.report(30),e=>e.code==='22003')
    const metadata=(await f.db.query(`select prosecdef,provolatile,proconfig,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') authenticated,has_function_privilege('service_role',oid,'execute') service from pg_proc where oid='public.get_openai_usage_report(integer)'::regprocedure`)).rows[0]
    assert.equal(metadata.prosecdef,false);assert.equal(metadata.provolatile,'s');assert.equal(metadata.anon,false);assert.equal(metadata.authenticated,false);assert.equal(metadata.service,true)
    assert.ok(metadata.proconfig.includes('statement_timeout=15s'))
    assert.match(usageMigration,/make_interval\(secs=>p_days\*86400\)/)
    await f.db.exec(`truncate openai_usage_events;begin read only;set local role service_role;`)
    assert.equal((await f.report(30)).totals.requests,0);await f.db.exec('rollback;')
  }finally{await f.db.close()}
})
