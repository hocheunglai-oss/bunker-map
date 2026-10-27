import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { setupAnnualNative,personA,personB,personC,literal,waitForBlock } from "./fixtures/attendance-annual-native.mjs"

const annualSignature="public.save_attendance_annual_confirmation_checked(uuid,integer,text,text,text,bigint)"
const json=value=>`${literal(JSON.stringify(value))}::jsonb`
const monthlyState=f=>f.owner.one("select coalesce(jsonb_agg(to_jsonb(c) order by person_id,year,month),'[]') from public.attendance_monthly_confirmations c;")
const raw=(person=personA,date="2025-09-15",user="ding-a")=>`insert into public.attendance_raw_punches(person_id,work_date,dingtalk_user_id,source_type,check_type,punch_time)
  values(${literal(person)},${literal(date)},${literal(user)},'DINGTALK','OnDuty',${literal(date+"T01:00:00Z")})`
async function use(run,options){const f=await setupAnnualNative(options);try{return await run(f)}finally{await f.close()}}
async function annualRow(f,person=personA,year=2026){return f.owner.one(`select to_jsonb(c) from public.attendance_annual_confirmations c where person_id=${literal(person)} and year=${year};`)}
async function fail(f,sql,pattern,options){await assert.rejects(f.command(sql,options),pattern)}
function annualSql(person,revision,year=2025){return `select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.save_attendance_annual_confirmation_checked(${literal(person)},${year},'confirmed','','native-editor',${revision}) t;`}

test("annual migration preserves existing monthly rows byte-for-byte and requires no legacy reinterpretation",()=>use(async f=>{
  await f.monthly({year:2025,month:1})
  await f.monthly({year:2025,month:12,status:"pending",note:"December draft"})
  const before=await monthlyState(f)
  await f.applyAnnual()
  assert.deepEqual(await monthlyState(f),before)
  assert.equal(await f.owner.one("select to_jsonb(count(*)) from public.attendance_annual_confirmations;"),0)
},{apply:false}))

test("cutover aborts atomically if an old tab has written any legacy annual row",()=>use(async f=>{
  await f.monthly({note:"annual-summary"})
  const before=await monthlyState(f)
  await assert.rejects(f.applyAnnual(),/Legacy annual confirmation appeared/)
  assert.equal(await f.owner.one("select to_jsonb(to_regclass('public.attendance_annual_confirmations') is null);"),true)
  assert.deepEqual(await monthlyState(f),before)
},{apply:false}))

test("cutover source/table lock timeouts happen before DDL and preserve every monthly row",()=>use(async f=>{
  await f.monthly({month:1})
  const before=await monthlyState(f)
  for(const lock of ["source","table"]){
    const holder=await f.session(`cutover-${lock}-holder`,false)
    try{
      await holder.query("begin;")
      await holder.query(lock==="source"
        ? "select 1 from private.attendance_source_revision_state where singleton for update;"
        : "lock table public.attendance_monthly_confirmations in access exclusive mode;")
      const started=Date.now()
      await assert.rejects(f.applyAnnual(),error=>error.code==="55P03"&&/lock timeout/.test(error.message))
      const elapsed=Date.now()-started
      assert.ok(elapsed>=4500&&elapsed<10000,`${lock} bounded lock wait was ${elapsed}ms`)
      await holder.query("commit;")
      assert.equal(await f.owner.one("select to_jsonb(to_regclass('public.attendance_annual_confirmations') is null);"),true)
      assert.deepEqual(await monthlyState(f),before)
      assert.equal(await f.owner.one("select to_jsonb(current_setting('lock_timeout'));"),"0")
    }finally{await holder.close()}
  }
},{apply:false}))

test("annual and December confirmation coexist in both write orders without approval inheritance",()=>use(async f=>{
  await f.annual()
  const first=(await f.snapshot()).annual
  assert.deepEqual(await monthlyState(f),[])
  await f.monthly()
  assert.deepEqual((await f.snapshot()).annual,first)
  const december=await monthlyState(f)
  await f.annual({status:"pending",note:"year review"})
  assert.deepEqual(await monthlyState(f),december)
  await f.annual()
  await f.monthly({status:"pending"})
  const approvedAnnual=(await f.snapshot()).annual
  await f.monthly()
  assert.deepEqual((await f.snapshot()).annual,approvedAnnual)
}))

test("same annual confirmation is read-only idempotent and changed-note replacement conflicts",()=>use(async f=>{
  const first=await f.annual({note:"reviewed"})
  const before=await f.snapshot()
  assert.deepEqual(await f.annual({note:"reviewed",actor:"another-editor"}),first)
  assert.deepEqual(await f.snapshot(),before)
  await assert.rejects(f.annual({note:"different"}),/ATTENDANCE_ALREADY_CONFIRMED/)
  assert.deepEqual(await f.snapshot(),before)
}))

test("annual closed-year and source revision checks cannot be bypassed by direct service writes",()=>use(async f=>{
  const year=Number(new Intl.DateTimeFormat("en",{timeZone:"Asia/Hong_Kong",year:"numeric"}).format(new Date()))
  await assert.rejects(f.annual({year}),/Hong Kong year has closed/)
  await assert.rejects(f.annual({revision:-1}),/ATTENDANCE_SOURCE_CHANGED/)
  await fail(f,`insert into public.attendance_annual_confirmations(person_id,year,status,confirmed_at,confirmed_by,confirmed_source_revision,created_by,updated_by)
    values('${personA}',${year},'confirmed',clock_timestamp(),'bad',${await f.revision()},'bad','bad');`,/Hong Kong year has closed/)
  assert.deepEqual((await f.snapshot()).annual,[])
  await f.annual()
  const before=await monthlyState(f)
  await f.command(raw(personB,"2025-03-04","ding-b"))
  await assert.rejects(f.annual({person:personB,revision:2}),/ATTENDANCE_SOURCE_CHANGED/)
  assert.deepEqual(await monthlyState(f),before)
}))

test("old annual-summary monthly requests fail and monthly automatic cutoff remains independent",()=>use(async f=>{
  await f.annual()
  const annual=(await f.snapshot()).annual
  await assert.rejects(f.monthly({note:" annual-summary "}),/ATTENDANCE_ANNUAL_CONFIRMATION_SEPARATE/)
  await fail(f,`insert into public.attendance_monthly_confirmations(person_id,year,month,status,note,created_by,updated_by)
    values('${personA}',2025,12,'pending','annual-summary','old','old');`,/attendance_monthly_confirmations_not_annual/)
  await f.monthly({status:"pending"})
  const pending=await monthlyState(f)
  assert.deepEqual(await f.monthly({cutoff:"2000-01-01T00:00:00Z"}),[])
  assert.deepEqual(await monthlyState(f),pending)
  assert.equal((await f.monthly({cutoff:"2200-01-01T00:00:00Z"}))[0].status,"confirmed")
  assert.deepEqual((await f.snapshot()).annual,annual)
}))

test("annual table and RPC are private, audited, fenced and do not themselves change source revision",()=>use(async f=>{
  const privileges=await f.owner.one(`select jsonb_build_object(
    'rls',(select relrowsecurity from pg_class where oid='public.attendance_annual_confirmations'::regclass),
    'anonSelect',has_table_privilege('anon','public.attendance_annual_confirmations','select'),
    'authenticatedInsert',has_table_privilege('authenticated','public.attendance_annual_confirmations','insert'),
    'anonRpc',has_function_privilege('anon','${annualSignature}','execute'),
    'authenticatedRpc',has_function_privilege('authenticated','${annualSignature}','execute'),
    'serviceRpc',has_function_privilege('service_role','${annualSignature}','execute'),
    'serviceEvidence',has_function_privilege('service_role','private.assert_attendance_annual_evidence(uuid,integer)','execute'));`)
  assert.deepEqual(privileges,{rls:true,anonSelect:false,authenticatedInsert:false,anonRpc:false,authenticatedRpc:false,serviceRpc:true,serviceEvidence:false})
  const before=await f.snapshot()
  await f.annual({actor:"actual-annual-actor"})
  const after=await f.snapshot()
  assert.equal(after.revision,before.revision)
  assert.notDeepEqual(after.fence,before.fence)
  const logs=after.audit.filter(a=>a.table_name==="attendance_annual_confirmations")
  assert.equal(logs.length,1)
  assert.equal(logs[0].actor_id,"actual-annual-actor")
  assert.equal(logs[0].request_context.action,"attendance-annual-confirmation-save")
  assert.equal(logs[0].request_context.confirmationKind,"annual")
  assert.equal(logs[0].request_context.month,undefined)
  const inventory=await f.owner.one("select public.get_bunker_map_backup_inventory();")
  assert.ok(inventory.tables.includes("attendance_annual_confirmations"))
  assert.ok(!inventory.unfencedTables.includes("attendance_annual_confirmations"))
  assert.equal(inventory.annualConfirmationColumns.length,12)
}))

test("failed annual transaction rolls back approval, audit and backup epoch together",()=>use(async f=>{
  const before=await f.snapshot()
  await fail(f,`${annualSql(personA,await f.revision())} select 1/0;`,/division by zero/)
  assert.deepEqual(await f.snapshot(),before)
}))

test("raw/leave/adjustment/work-mode/entitlement source edits reopen only the annual approval and affected month",()=>use(async f=>{
  await f.monthly()
  const december=await monthlyState(f)
  const edits=[
    raw(),
    `insert into public.attendance_leave_entries(person_id,leave_date) values('${personA}','2025-09-16')`,
    `insert into public.attendance_monthly_adjustments(person_id,year,month) values('${personA}',2025,9)`,
    `insert into public.attendance_work_mode_overrides(person_id,work_date) values('${personA}','2025-09-17')`,
    `insert into public.attendance_work_mode_policies(id,person_id,effective_from,effective_to) values('${randomUUID()}','${personA}','2025-09-01','2025-09-30')`,
    `insert into public.attendance_entitlements(person_id,year,allowance_units) values('${personA}',2025,15)`,
  ]
  for(const [index,sql]of edits.entries()){
    await f.annual()
    await f.command(sql)
    assert.equal((await annualRow(f,personA,2025)).status,"pending",String(index))
    if(index<edits.length-1)assert.deepEqual(await monthlyState(f),december,"non-December range keeps December")
  }
}))

test("effective-calendar changes and seed transitions reopen annual-only future-state fixtures",()=>use(async f=>{
  await f.command(`insert into public.office_calendar_store values('event-calendar','{"events":[]}');`)
  await f.seedFutureApproval()
  await f.command(`update public.office_calendar_store set payload=${json({events:[{id:"hk",title:"PUBLIC HOLIDAY - HONG KONG",startDate:"2026-09-01",people:["VL"]}]})} where key='event-calendar';`)
  assert.equal((await annualRow(f)).status,"pending")
  await f.seedFutureApproval()
  await f.command(`update public.office_calendar_store set payload='{}' where key='event-calendar';`)
  assert.equal((await annualRow(f)).status,"pending")
}))

test("unknown and null-person failed syncs find annual-only owners; precise manifests keep others",()=>use(async f=>{
  for(const mode of ["null-person","unknown","manifest"]){
    await f.seedFutureApproval(personA)
    await f.seedFutureApproval(personB)
    const scope=mode==="null-person"?{unknown:false,affected:[{person_id:null,work_date:"2026-09-15"}]}:{unknown:true,affected:[]}
    const manifest=mode==="manifest"?{[personB]:"ding-b"}:{}
    await f.command(`insert into public.attendance_sync_runs(window_from,window_to,status,completed_at,people_requested,requested_people,failure_scope)
      values('2026-09-15T00:00:00Z','2026-09-16T00:00:00Z','partial',clock_timestamp(),${Object.keys(manifest).length},${json(manifest)},${json(scope)});`)
    assert.equal((await annualRow(f,personB)).status,"pending")
    assert.equal((await annualRow(f,personA)).status,mode==="manifest"?"confirmed":"pending")
  }
}))

test("failed-sync year boundary does not reopen the following annual year",()=>use(async f=>{
  await f.seedFutureApproval(personA,2026)
  await f.seedFutureApproval(personA,2027)
  await f.command(`insert into public.attendance_sync_runs(window_from,window_to,status,completed_at,people_requested,requested_people,failure_scope)
    values('2026-12-31T00:00:00Z','2026-12-31T16:00:00Z','failed',clock_timestamp(),1,
      ${json({[personA]:"ding-a"})},'{"unknown":true,"affected":[]}');`)
  assert.equal((await annualRow(f,personA,2026)).status,"pending")
  assert.equal((await annualRow(f,personA,2027)).status,"confirmed")
}))

test("open correction blocks annual approval for both original and incoming person across all months",()=>use(async f=>{
  const rawId=await f.command(raw()+" returning to_jsonb(id);")
  await f.command(`insert into private.attendance_dingtalk_punch_anomalies(existing_raw_punch_id,kind,incoming_source_record_key,
    incoming_person_id,incoming_dingtalk_user_id,incoming_check_type,incoming_punch_time,incoming_work_date)
    values('${rawId}','changed-user','${"a".repeat(64)}','${personB}','ding-b','OnDuty','2025-02-03T01:00:00Z','2025-02-03');`,{owner:true})
  await assert.rejects(f.annual(),/ATTENDANCE_DINGTALK_ANOMALY_OPEN/)
  await assert.rejects(f.annual({person:personB}),/ATTENDANCE_DINGTALK_ANOMALY_OPEN/)
  assert.equal((await f.annual({person:personC}))[0].status,"confirmed")
  await f.command("insert into private.attendance_dingtalk_punch_anomaly_resolutions(anomaly_id,resolved_by,resolution_note) select id,'reviewer','Reviewed synthetic observation' from private.attendance_dingtalk_punch_anomalies;",{owner:true})
  assert.equal((await f.annual())[0].status,"confirmed")
}))

test("unresolved omission outside December blocks annual but not December monthly",()=>use(async f=>{
  const rawId=await f.command(raw()+" returning to_jsonb(id);")
  await f.command(`insert into private.attendance_dingtalk_missing_punch_anomalies(existing_raw_punch_id,observed_window_from,observed_window_to)
    values('${rawId}','2025-09-15T00:00:00Z','2025-09-16T00:00:00Z');`,{owner:true})
  await assert.rejects(f.annual(),/ATTENDANCE_DINGTALK_ANOMALY_OPEN/)
  assert.equal((await f.monthly())[0].status,"confirmed")
}))

test("actual checked correction import reopens both annual person/years without rewriting December",()=>use(async f=>{
  const initial={person_id:personA,source_record_key:"a".repeat(64),source_record_id:"synthetic-shared-id",
    dingtalk_user_id:"ding-a",check_type:"OnDuty",punch_time:"2025-09-15T01:00:00Z",work_date:"2025-09-15",
    source_type:"DINGTALK",raw_payload:{}}
  await f.command(`select public.insert_attendance_raw_punches_checked(${json([initial])});`)
  await f.annual()
  await f.annual({person:personB,year:2024})
  await f.monthly()
  const december=await monthlyState(f)
  const incoming={...initial,person_id:personB,dingtalk_user_id:"ding-b",source_record_key:"b".repeat(64),
    punch_time:"2024-02-05T01:00:00Z",work_date:"2024-02-05"}
  const result=await f.command(`select public.insert_attendance_raw_punches_checked(${json([incoming])});`)
  assert.equal(result.anomaly_count,1)
  assert.equal((await annualRow(f,personA,2025)).status,"pending")
  assert.equal((await annualRow(f,personB,2024)).status,"pending")
  assert.deepEqual(await monthlyState(f),december)
}))

test("actual complete-window omission reconciliation reopens annual approval outside December",()=>use(async f=>{
  const initial={person_id:personA,source_record_key:"c".repeat(64),source_record_id:"synthetic-omission",
    dingtalk_user_id:"ding-a",check_type:"OnDuty",punch_time:"2025-09-15T01:00:00Z",work_date:"2025-09-15",
    source_type:"DINGTALK",raw_payload:{}}
  await f.command(`select public.insert_attendance_raw_punches_checked(${json([initial])});`)
  await f.annual()
  await f.monthly()
  const december=await monthlyState(f)
  const result=await f.command(`select public.reconcile_attendance_dingtalk_punch_window(
    ${json([{person_id:personA,dingtalk_user_id:"ding-a"}])},'2025-09-15T00:00:00Z',
    '2025-09-16T00:00:00Z',array[]::text[],true);`)
  assert.equal(result.missing_count,1)
  assert.equal((await annualRow(f,personA,2025)).status,"pending")
  assert.deepEqual(await monthlyState(f),december)
}))

test("real full-year evidence helper rejects 2026 unresolved sync and mismatched historical identity",()=>use(async f=>{
  await f.command(`insert into public.attendance_sync_runs(window_from,window_to,status,completed_at,people_requested,requested_people,failure_scope)
    values('2026-09-15T00:00:00Z','2026-09-16T00:00:00Z','partial',clock_timestamp(),1,
      ${json({[personA]:"ding-a"})},'{"unknown":true,"affected":[]}');`)
  await fail(f,`select private.assert_attendance_annual_evidence('${personA}',2026);`,/ATTENDANCE_SYNC_INCOMPLETE/,{owner:true})
  await f.command(raw(personB,"2026-09-17","wrong-identity"))
  await fail(f,`select private.assert_attendance_annual_evidence('${personB}',2026);`,/ATTENDANCE_DINGTALK_IDENTITY_MISMATCH/,{owner:true})
  // This does not claim a current-year RPC approval; the closed-year guard remains active.
  await assert.rejects(f.annual({person:personC,year:2026}),/Hong Kong year has closed/)
}))

test("source commit after checked annual write invalidates approval without deadlock",()=>use(async f=>{
  await f.monthly()
  const december=await monthlyState(f), revision=await f.revision()
  const confirmation=await f.session("annual-first"), writer=await f.session("source-after")
  await confirmation.begin()
  await confirmation.query(annualSql(personA,revision))
  await writer.begin()
  const writing=writer.query(raw()+";")
  await waitForBlock(f.owner,writer,confirmation)
  await confirmation.query("commit;")
  await writing
  await writer.query("commit;")
  assert.equal((await annualRow(f,personA,2025)).status,"pending")
  assert.deepEqual(await monthlyState(f),december)
}))

test("source commit before annual write rejects the stale browser revision",()=>use(async f=>{
  const revision=await f.revision()
  const writer=await f.session("source-first"), confirmation=await f.session("annual-after")
  await writer.begin()
  await writer.query(raw()+";")
  await confirmation.begin()
  const confirming=confirmation.query(annualSql(personA,revision))
  await waitForBlock(f.owner,confirmation,writer)
  await writer.query("commit;")
  await assert.rejects(confirming,/ATTENDANCE_SOURCE_CHANGED/)
  assert.deepEqual((await f.snapshot()).annual,[])
}))

test("direct annual row writes acquire revision before row locks and preserve source truth",()=>use(async f=>{
  await f.annual()
  const source=await f.session("source-lock-first"),reset=await f.session("direct-annual-reset")
  await source.begin()
  await source.query(raw()+";")
  await reset.begin()
  const resetting=reset.query(`update public.attendance_annual_confirmations
    set status='pending',confirmed_at=null,confirmed_by=null,updated_by='reviewer'
    where person_id='${personA}' and year=2025;`)
  await waitForBlock(f.owner,reset,source)
  await source.query("commit;")
  await resetting
  await reset.query("commit;")
  assert.equal((await annualRow(f,personA,2025)).status,"pending")
}))

test("an unchanged old approval is never relabelled with a newer unrelated source revision",()=>use(async f=>{
  await f.annual()
  const before=(await f.snapshot()).annual
  await f.command(raw(personB,"2025-05-07","ding-b"))
  await assert.rejects(f.annual(),/ATTENDANCE_ALREADY_CONFIRMED/)
  assert.deepEqual((await f.snapshot()).annual,before)
}))

test("stale annual Undo cannot revive approval or mark its audit record undone",()=>use(async f=>{
  await f.monthly()
  const december=await monthlyState(f)
  await f.annual()
  await f.command(`do $$ begin perform set_config('app.audit_actor_id','delete-reviewer',true); end $$;
    delete from public.attendance_annual_confirmations where person_id='${personA}';`)
  const id=await f.owner.one("select to_jsonb(id) from public.audit_logs where table_name='attendance_annual_confirmations' and operation='DELETE';")
  await f.command(raw(personB,"2025-04-03","ding-b"))
  await fail(f,`select public.undo_audit_log_noncredential('${id}','undoer','Undo reviewer');`,/ATTENDANCE_SOURCE_CHANGED/,{owner:true})
  assert.equal(await f.owner.one(`select to_jsonb(undone_at is null) from public.audit_logs where id='${id}';`),true)
  assert.deepEqual((await f.snapshot()).annual,[])
  assert.deepEqual(await monthlyState(f),december)
}))

test("same-revision annual Undo and native isolated recovery preserve independent monthly and private guards",()=>use(async f=>{
  await f.monthly({status:"pending",note:"December pending"})
  await f.annual()
  const annual=(await f.snapshot()).annual
  await f.command(`do $$ begin perform set_config('app.audit_actor_id','delete-reviewer',true); end $$;
    delete from public.attendance_annual_confirmations where person_id='${personA}';`)
  const id=await f.owner.one("select to_jsonb(id) from public.audit_logs where table_name='attendance_annual_confirmations' and operation='DELETE';")
  await f.command(`select to_jsonb(public.undo_audit_log_noncredential('${id}','undoer','Undo reviewer'));`,{owner:true})
  assert.deepEqual((await f.snapshot()).annual,annual)
  const before=await f.snapshot(), restored=await f.dumpAndRestore()
  const result=await restored.owner.one(`select jsonb_build_object(
    'annual',(select coalesce(jsonb_agg(to_jsonb(c) order by person_id,year),'[]') from public.attendance_annual_confirmations c),
    'monthly',(select coalesce(jsonb_agg(to_jsonb(c) order by person_id,year,month),'[]') from public.attendance_monthly_confirmations c),
    'revision',public.attendance_source_revision(),
    'rls',(select relrowsecurity from pg_class where oid='public.attendance_annual_confirmations'::regclass),
    'anonRpc',has_function_privilege('anon','${annualSignature}','execute'),
    'serviceRpc',has_function_privilege('service_role','${annualSignature}','execute'),
    'triggerCount',(select count(*) from pg_trigger where tgrelid='public.attendance_annual_confirmations'::regclass and not tgisinternal));`)
  assert.deepEqual(result.annual,before.annual)
  assert.deepEqual(result.monthly,before.monthly)
  assert.equal(Number(result.revision),before.revision)
  assert.equal(result.rls,true)
  assert.equal(result.anonRpc,false)
  assert.equal(result.serviceRpc,true)
  assert.equal(Number(result.triggerCount),5)
}))
