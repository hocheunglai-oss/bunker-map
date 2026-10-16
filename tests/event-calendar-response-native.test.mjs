import assert from "node:assert/strict"
import test from "node:test"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { setupNativeCcinfo, literal } from "./fixtures/native-postgres-ccinfo.mjs"
import { parseEventCalendarResponse } from "../lib/eventCalendarResponse.ts"
import { getEventCalendarEventVersions, getEventCalendarSettingVersions, getEventCalendarStoreVersion, mutateEventCalendarStore } from "../lib/eventCalendarStore.ts"
const require=createRequire(import.meta.url)
const initial=()=>({events:[{id:"synthetic",title:"SYNTHETIC EVENT",startDate:"2026-10-16",endDate:"2026-10-16",people:["OL"],tags:[]}],people:["OL"],emailRecipientsText:"office@example.test"})
const fixture=`create role service_role;create table public.office_calendar_store(key text primary key,payload jsonb,updated_at timestamptz not null default clock_timestamp());grant select,insert,update on public.office_calendar_store to service_role;`
const envelope=payload=>({payload,protocolVersion:2,eventVersions:getEventCalendarEventVersions(payload),settingVersions:getEventCalendarSettingVersions(payload),storeVersion:getEventCalendarStoreVersion(payload)})
function adapter(session,log){return{from(table){assert.equal(table,"office_calendar_store");let values,expected;const q={select(){return q},eq(field,value){if(field==="updated_at")expected=value;return q},update(value){values=value;return q},async maybeSingle(){
  if(values){log.writes++;const data=await session.one(`with changed as(update public.office_calendar_store set payload=${literal(JSON.stringify(values.payload))}::jsonb,updated_at=${literal(values.updated_at)}::timestamptz where key='event-calendar' and updated_at=${literal(expected)}::timestamptz returning payload)select coalesce((select jsonb_build_object('payload',payload) from changed),'null'::jsonb);`);return{data,error:null}}
  log.reads++;return{data:await session.one("select coalesce((select jsonb_build_object('payload',payload,'updated_at',updated_at) from public.office_calendar_store where key='event-calendar'),'null'::jsonb);"),error:null}
}};return q}}}
test("native PostgreSQL: actual calendar GET and decoder preserve valid/empty/absent semantics without writes; real CAS replies verify",{timeout:60000},async t=>{
  const f=await setupNativeCcinfo(fixture),log={reads:0,writes:0}
  t.diagnostic(`Owned native fixture ${f.root}; ${f.version}; runtime ${f.runtimeSha256}`)
  try{
    const readSession=await f.session("calendar-readonly");await readSession.query("set default_transaction_read_only=on;")
    const client=adapter(readSession,log)
    const modules={"next/server":{NextResponse:{json:Response.json}},"@supabase/supabase-js":{createClient:()=>client},"@/lib/adminAuth":{getAdminSession:async()=>({authenticated:true}),hasAdminPagePermission:()=>true},"@/lib/adminAudit":{createAdminAuditContext:()=>({}),createAdminAuditedSupabaseClient:()=>{assert.fail("GET must not construct a writer")}},"@/lib/calendarStaff":{}}
    const bundled=await build({absWorkingDir:process.cwd(),entryPoints:["app/api/office-calendar-store/[key]/route.ts"],bundle:true,write:false,platform:"node",format:"cjs",target:"node24",logLevel:"silent",plugins:[{name:"native-read-transport",setup(b){b.onResolve({filter:/^(?:next\/server|@supabase\/supabase-js|@\/lib\/(adminAuth|adminAudit|calendarStaff))$/},args=>({path:args.path,external:true}))}}]})
    const mod={exports:{}};new Function("require","module","exports","process",bundled.outputFiles[0].text)(name=>modules[name]??require(name),mod,mod.exports,{env:{NEXT_PUBLIC_SUPABASE_URL:"https://synthetic.invalid",SUPABASE_SERVICE_ROLE_KEY:"synthetic-only"}})
    const request=()=>mod.exports.GET(new Request("https://synthetic.invalid/api/office-calendar-store/event-calendar"),{params:Promise.resolve({key:"event-calendar"})})
    for(const payload of[null,{},initial(),{events:[],people:[],emailRecipientsText:""},{events:[]},{events:"BROKEN",people:"BROKEN",emailRecipientsText:{}},{events:[],people:[null]}]){
      await f.owner.query(`insert into public.office_calendar_store(key,payload)values('event-calendar',${literal(JSON.stringify(payload))}::jsonb)on conflict(key)do update set payload=excluded.payload;`)
      const state=()=>f.owner.one("select to_jsonb(t) from public.office_calendar_store t where key='event-calendar';")
      const before=await state(),response=await request(),malformed=typeof payload?.events==="string"||payload?.people?.includes(null)
      assert.equal(response.status,malformed?500:200)
      if(!malformed)await parseEventCalendarResponse(await response.json())
      assert.deepEqual(await state(),before,"actual GET must leave payload and updated_at byte-equivalent")
    }
    assert.equal(log.writes,0)
    const first=initial();await f.owner.query(`update public.office_calendar_store set payload=${literal(JSON.stringify(first))}::jsonb where key='event-calendar';`)
    const writer1=adapter(await f.session("calendar-writer-one"),log),writer2=adapter(await f.session("calendar-writer-two"),log),versions=getEventCalendarSettingVersions(first)
    const people=await mutateEventCalendarStore(writer1,{operation:"people",settings:{people:["CY"]},expectedSettingVersions:versions})
    await parseEventCalendarResponse({success:true,...envelope(people)},{operation:"people",events:[],eventIds:[],settings:{people:["CY"]}})
    const cleared=await mutateEventCalendarStore(writer2,{operation:"settings",settings:{emailRecipientsText:""},expectedSettingVersions:versions,confirmEmailRecipientsClear:true})
    await parseEventCalendarResponse({success:true,...envelope(cleared)},{operation:"settings",events:[],eventIds:[],settings:{emailRecipientsText:""}})
    assert.deepEqual(cleared.people,["CY"]);assert.equal(cleared.emailRecipientsText,"")
    const before=await f.owner.one("select to_jsonb(t) from public.office_calendar_store t where key='event-calendar';")
    await assert.rejects(mutateEventCalendarStore(writer1,{operation:"settings",settings:{emailRecipientsText:"stale@example.test"},expectedSettingVersions:versions}),error=>error.code==="EVENT_CALENDAR_CONFLICT")
    assert.deepEqual(await f.owner.one("select to_jsonb(t) from public.office_calendar_store t where key='event-calendar';"),before)
    t.diagnostic(`Actual read-only API reads ${log.reads}; local isolated CAS writes ${log.writes}; stale write refused`)
  }finally{await f.close();t.diagnostic("Owned sessions closed and native server stopped.")}
})
