import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { transformSync } from "esbuild"
import { setupReportPublicationApp } from "./fixtures/report-publication-app.mjs"
import { taiwanRemarksMigration, change } from "./fixtures/taiwan-remarks-sql.mjs"
import * as validation from "../lib/publicReportValidation.ts"
import * as operational from "../lib/taiwanOperationalNotice.ts"
import * as fallbacks from "../lib/reportFallbackKeys.ts"

test("actual public reader keeps saved remarks private until the existing coherent Publish, while notices remain overlays",async()=>{
  const f=await setupReportPublicationApp()
  try{
    assert.equal((await f.publish(await f.input())).status,200)
    const audit=readFileSync(new URL('../supabase/audit_log.sql',import.meta.url),'utf8')
    const start=audit.indexOf('create table if not exists public.audit_logs ('),end=audit.indexOf('create or replace function public.audit_pk_where(')
    assert.ok(start>=0&&end>start)
    await f.db.exec(`reset role;create table public.office_calendar_store(key text primary key,payload jsonb);${audit.slice(start,end)}${taiwanRemarksMigration}
      create trigger bunker_audit_log after insert or update or delete on public.remarks for each row execute function public.audit_table_changes();
      set role service_role;select set_config('request.headers','{"x-bunker-admin-user":"SERVER-EDITOR","x-bunker-admin-page-id":"taiwan-remarks"}',false);`)
    const modules={
      'next/cache':{unstable_cache:fn=>fn},'@/lib/publicReportValidation':validation,'@/lib/taiwanOperationalNotice':operational,'@/lib/reportFallbackKeys':fallbacks,
      '@supabase/supabase-js':{createClient(){return {from(table){assert.equal(table,'remarks');return {select(columns){assert.equal(columns,'id,content');return {async in(column,ids){assert.equal(column,'id');return {data:(await f.db.query('select id,content from public.remarks where id=any($1::integer[])',[ids])).rows,error:null}}}}}}}}},
    }
    const loaded={exports:{}},code=transformSync(readFileSync(new URL('../lib/publicMarketData.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code
    new Function('require','module','exports','process',code)(name=>{assert.ok(name in modules,name);return modules[name]},loaded,loaded.exports,{env:{NEXT_PUBLIC_SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-only'}})
    const read=()=>loaded.exports.getPublicReportData('taiwan'),before=await read()
    await f.db.query('select public.save_taiwan_remarks($1::jsonb)',[JSON.stringify([change(1,'SAVED NEW REMARK\nSECOND LINE','Remark\nSecond line'),change(2,'LIVE NEW NOTICE\nSECOND NOTICE','Special notice\nSecond line')])])
    const saved=await read()
    assert.equal(saved.snapshot.remark,before.snapshot.remark,'Save alone cannot republish the remark')
    assert.equal(saved.specialNotice,'LIVE NEW NOTICE\nSECOND NOTICE')
    assert.deepEqual(saved.snapshot.rows,before.snapshot.rows);assert.equal(saved.snapshot.reportDate,before.snapshot.reportDate)
    const publish=await f.publish(await f.input());assert.equal(publish.status,200)
    const published=await read()
    assert.equal(published.snapshot.remark,'SAVED NEW REMARK\nSECOND LINE')
    assert.deepEqual(published.snapshot.rows,before.snapshot.rows);assert.equal(published.snapshot.reportDate,'08 Oct 2026')
  }finally{await f.db.close()}
})
