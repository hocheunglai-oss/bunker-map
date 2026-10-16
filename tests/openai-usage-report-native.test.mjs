import assert from "node:assert/strict"
import test from "node:test"
import { setupNativeCcinfo, waitForBlock } from "./fixtures/native-postgres-ccinfo.mjs"
import { usageFixtureSql, usageScaleSql, usageMigration } from "./fixtures/openai-usage-sql.mjs"
import { parseOpenAiUsageReport } from "../lib/openAiUsageReport.ts"
import { usageRouteHarness } from "./fixtures/openai-usage-report.ts"

test("native PostgreSQL usage reporting is complete, exact, read-only and single-snapshot under a concurrent commit",{timeout:120000},async t=>{
  const f=await setupNativeCcinfo(usageFixtureSql)
  const report=(client,days=30)=>client.one(`select public.get_openai_usage_report(${days});`)
  try{
    const service=await f.session('usage-reader')
    await t.test('full10001 event DB-to-actual-route totals retain the omitted older page',async()=>{
      await f.owner.query(usageScaleSql)
      const before=await f.owner.one("select jsonb_build_object('rows',count(*),'ids',sum(id),'tokens',sum(total_tokens)) from openai_usage_events;")
      for(const days of [7,30,90]){
        const route=usageRouteHarness(async period=>({data:await report(service,period),error:null})),response=await route.send(days)
        assert.equal(response.status,200)
        const result=parseOpenAiUsageReport(await response.json(),days)
        assert.equal(result.totals.requests,10001);assert.equal(result.totals.totalTokens,1010000);assert.equal(result.totals.errors,1)
        assert.equal(result.pages[0].pageId,'older');assert.equal(result.recent.length,20)
      }
      assert.deepEqual(await f.owner.one("select jsonb_build_object('rows',count(*),'ids',sum(id),'tokens',sum(total_tokens)) from openai_usage_events;"),before)
    })
    await t.test('actual role timezone and production seconds expression preserve24-hour days across BOTH DST transitions',async()=>{
      await service.query("set timezone='America/New_York';")
      for(const days of [7,30,90]){
        const result=parseOpenAiUsageReport(await report(service,days),days)
        assert.equal(Date.parse(result.generatedAt)-Date.parse(result.since),days*86400000)
      }
      const expression=usageMigration.match(/make_interval\(secs=>p_days\*86400\)/)?.[0].replace('p_days','7')
      assert.ok(expression,'Test the actual production interval expression, not a substitute interval')
      const result=await service.one(`select jsonb_build_object(
        'spring',extract(epoch from ('2026-03-09T12:00:00-04:00'::timestamptz-('2026-03-09T12:00:00-04:00'::timestamptz-${expression}))),
        'fall',extract(epoch from ('2026-11-02T12:00:00-05:00'::timestamptz-('2026-11-02T12:00:00-05:00'::timestamptz-${expression}))));`)
      assert.deepEqual(result,{spring:604800,fall:604800})
      await service.query("set timezone='UTC';")
    })
    await t.test('held concurrent insertion cannot split totals/groups/recent between snapshots',async()=>{
      await f.owner.query("truncate openai_usage_events;insert into openai_usage_events(page_id,page_path,feature,status,total_tokens) values('before','/admin','','success',3);")
      // Owner-only fixture lock controls timing; never broaden telemetry writer ACL.
      const writer=await f.session('usage-concurrent-writer',false),reader=await f.session('usage-snapshot-reader'),observer=await f.session('usage-observer',false)
      await writer.query("begin;lock table openai_usage_events in access exclusive mode;insert into openai_usage_events(page_id,page_path,feature,status,total_tokens) values('committing','/spc/enquiries','','success',7);")
      const pending=report(reader)
      try{await waitForBlock(observer,reader,writer,'relation');await writer.query('commit;')}finally{if(!writer.closed)await writer.query('rollback;')}
      const captured=parseOpenAiUsageReport(await pending,30)
      assert.equal(captured.totals.requests,1);assert.equal(captured.totals.totalTokens,3);assert.equal(captured.pages.length,1);assert.equal(captured.recent.length,1)
      const next=parseOpenAiUsageReport(await report(reader),30);assert.equal(next.totals.requests,2);assert.equal(next.totals.totalTokens,10)
    })
    await t.test('unsafe summed BIGINTs fail before a rounded/partial successful response',async()=>{
      await f.owner.query("truncate openai_usage_events;insert into openai_usage_events(page_id,page_path,feature,status,total_tokens) values('safe','/admin','','success',9007199254740991);")
      assert.equal(parseOpenAiUsageReport(await report(service),30).totals.totalTokens,Number.MAX_SAFE_INTEGER)
      await f.owner.query("insert into openai_usage_events(page_id,page_path,feature,status,total_tokens) values('safe','/admin','','success',1);")
      const failed=await f.session('usage-overflow')
      await assert.rejects(report(failed),error=>error.code==='22003')
      const route=usageRouteHarness(async()=>{try{return{data:await report(await f.session('usage-overflow-api')),error:null}}catch{return{data:null,error:{message:'unsafe'}}}})
      assert.equal((await route.send()).status,503)
    })
    await t.test('service-only stable invoker ACL/config and table/index grants are unchanged; READ ONLY works',async()=>{
      await f.owner.query('truncate openai_usage_events;')
      const meta=await f.owner.one(`select jsonb_build_object('definer',p.prosecdef,'volatility',p.provolatile,'config',p.proconfig,
        'anon',has_function_privilege('anon',p.oid,'execute'),'authenticated',has_function_privilege('authenticated',p.oid,'execute'),
        'service',has_function_privilege('service_role',p.oid,'execute'),'rls',(select relrowsecurity from pg_class where oid='openai_usage_events'::regclass),
        'anonTable',has_table_privilege('anon','openai_usage_events','select'),'authTable',has_table_privilege('authenticated','openai_usage_events','select'),
        'indexes',(select count(*) from pg_index where indrelid='openai_usage_events'::regclass and indisvalid))
        from pg_proc p where p.oid='public.get_openai_usage_report(integer)'::regprocedure;`)
      assert.equal(meta.definer,false);assert.equal(meta.volatility,'s');assert.equal(meta.anon,false);assert.equal(meta.authenticated,false);assert.equal(meta.service,true)
      assert.equal(meta.rls,true);assert.equal(meta.anonTable,false);assert.equal(meta.authTable,false);assert.equal(meta.indexes,3)
      assert.ok(meta.config.includes('statement_timeout=15s'));assert.ok(meta.config.some(value=>value==='search_path=""'))
      for(const role of ['anon','authenticated']){const denied=await f.session('usage-denied-'+role,false);await denied.query('set role '+role+';');await assert.rejects(report(denied),error=>error.code==='42501')}
      await service.query('begin read only;');assert.equal((await report(service)).totals.requests,0);await service.query('commit;')
      const invalid=await f.session('usage-invalid-period');await assert.rejects(report(invalid,8),error=>error.code==='22023')
    })
    await t.test('native pg_dump/restore retains the exact reporting RPC and private reader privileges',async()=>{
      await Promise.all(f.sessions.filter(session=>session!==f.owner).map(session=>session.close()))
      const restored=await f.dumpAndRestore()
      assert.equal(parseOpenAiUsageReport(await report(restored.service),30).totals.requests,0)
      const acl=await restored.owner.one("select jsonb_build_object('anon',has_function_privilege('anon','public.get_openai_usage_report(integer)','execute'),'service',has_function_privilege('service_role','public.get_openai_usage_report(integer)','execute'));")
      assert.deepEqual(acl,{anon:false,service:true})
    })
  }finally{await f.close()}
})
