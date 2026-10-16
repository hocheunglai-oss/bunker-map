import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { setupNativeCcinfo, literal, waitForBlock } from "./fixtures/native-postgres-ccinfo.mjs"
import { statisticsFixtureSql, seedStatisticsSql, statisticsCall, statisticsStateSql } from "./fixtures/spc-statistics-sql.mjs"
import { statisticsRuntime } from "./fixtures/spc-statistics-api.mjs"

test("native statistics actual API is complete and reads one concurrent MVCC snapshot", { timeout:120000 }, async t => {
  const f=await setupNativeCcinfo(statisticsFixtureSql())
  console.log(JSON.stringify({statisticsFixtureRoot:f.root,nativeVersion:f.version,runtimeSha256:f.runtimeSha256}))
  const app=()=>statisticsRuntime({client:{async rpc(name,args){assert.equal(name,"read_spc_statistics_source");const reader=await f.session("statistics-rpc");try{return {data:await reader.one(`select public.read_spc_statistics_source(${args.p_first_fixture_year},${args.p_last_fixture_year},${literal(args.p_window_start)},${literal(args.p_window_end)});`),error:null}}catch(error){return {data:null,error:new Error(error.message)}}finally{await reader.close()}}}})
  try {
    await t.test("5001-row actual SQL→library→API totals with unchanged table tuples", async()=>{
      await f.owner.query(seedStatisticsSql(5001));const before=await f.owner.one(statisticsStateSql)
      const result=await app().get();assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.sourceCounts.graphFixtures,5001)
      assert.equal(result.body.workload[0].enquiries,5001);assert.equal(result.body.monthlyVolume[9].currentYearVolume,500100)
      assert.deepEqual(await f.owner.one(statisticsStateSql),before)
      await f.owner.query("delete from public.spc_fixtures;delete from public.spc_enquiries;delete from public.audit_logs;")
    })
    await t.test("held read includes either complete old state or complete new state, never mixed inputs",async()=>{
      await f.owner.query(seedStatisticsSql())
      // Fixture-only gate delays a SELECT through the user relation. The shipped
      // read RPC is unchanged. A writer commits all five source changes while
      // the STABLE function's first SELECT is waiting on an advisory lock.
      await f.owner.query(`alter table public.spc_users rename to statistics_users_base;
        create function public.statistics_gate() returns boolean language plpgsql volatile as $$ begin
          if current_setting('statistics.test_gate',true)='1' then perform pg_advisory_xact_lock(554890016); end if;return true;end $$;
        create view public.spc_users with(security_invoker=true) as select * from public.statistics_users_base where public.statistics_gate();
        grant select on public.spc_users to service_role;`)
      const writer=await f.session("statistics-writer",false),reader=await f.session("statistics-held-reader"),observer=await f.session("statistics-observer",false)
      try {
        await writer.query("begin; select pg_advisory_xact_lock(554890016);")
        await reader.query("set statistics.test_gate='1';")
        const held=reader.one(`select ${statisticsCall};`)
        await waitForBlock(observer,reader,writer,"advisory")
        await writer.query(`update public.spc_fixtures set hsfo='200';update public.spc_enquiries set created_at='2026-10-17T04:50:00Z';
          update public.statistics_users_base set display_name='Renamed Buyer' where username='buyer@example.test';
          update public.office_calendar_store set payload=jsonb_set(payload,'{userProfiles,0,office}','"SINGAPORE"');
          delete from public.audit_logs;commit;`)
        const old=await held
        assert.equal(old.fixtures[0].hsfo,"100");assert.equal(old.enquiries.length,1);assert.equal(old.buyerEnquiryNumbers.length,1)
        assert.equal(old.users.find(u=>u.username==='buyer@example.test').display_name,"Synthetic Buyer");assert.equal(old.profiles[0].office,"HONG KONG")
        const fresh=await observer.one(`select ${statisticsCall};`)
        assert.equal(fresh.fixtures[0].hsfo,"200");assert.equal(fresh.enquiries.length,0);assert.equal(fresh.buyerEnquiryNumbers.length,0)
        assert.equal(fresh.users.find(u=>u.username==='buyer@example.test').display_name,"Renamed Buyer");assert.equal(fresh.profiles[0].office,"SINGAPORE")
        const next=await app().get();assert.equal(next.status,200);assert.equal(next.body.monthlyVolume[9].currentYearVolume,200);assert.equal(next.body.workload[0].enquiries,0);assert.equal(next.body.volumeByOffice[0].label,"SINGAPORE")
      }finally{await writer.close();await reader.close();await observer.close();await f.owner.query("drop view public.spc_users;drop function public.statistics_gate();alter table public.statistics_users_base rename to spc_users;")}
    })
    await t.test("native READ ONLY execution and resource-budget failures preserve source tuples",async()=>{
      const reader=await f.session("statistics-readonly");try{const before=await f.owner.one(statisticsStateSql);await reader.query("begin read only;");await reader.one(`select ${statisticsCall};`);await reader.query("commit;");assert.deepEqual(await f.owner.one(statisticsStateSql),before)}finally{await reader.close()}
      await f.owner.query("update public.spc_fixtures set vessel_name=repeat('x',1048577);")
      const before=await f.owner.one(statisticsStateSql),result=await app().get();assert.equal(result.status,500);assert.match(result.body.message,/no partial totals/);assert.deepEqual(await f.owner.one(statisticsStateSql),before)
    })
  }finally{
    await f.close()
    assert.equal(existsSync(join(f.data,"postmaster.pid")),false)
    assert.ok(f.sessions.every(session=>session.closed))
    assert.match(readFileSync(join(f.root,"server.log"),"utf8"),/database system is shut down/)
    console.log(JSON.stringify({statisticsFixtureRoot:f.root,ownedSessionsClosed:f.sessions.length,postmasterPidAbsent:true,shutdownConfirmed:true}))
  }
})
