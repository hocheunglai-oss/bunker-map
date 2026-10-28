import assert from "node:assert/strict"
import test from "node:test"
import {createHash} from "node:crypto"
import {setupCertificationAudit,source,migrationPath,originalAudit,originalVersion,auditSupportSql,literal,json,setActor,resolution,context,runId}from"./fixtures/outlook-certification-audit-native.mjs"
import {setupAtomicEligibility}from"./fixtures/outlook-atomic-eligibility-native.mjs"
import {seedRealisticActivationVolume}from"./fixtures/outlook-atomic-eligibility-volume.mjs"
import {createAuditConsumers}from"./fixtures/audit-log-consumers.mjs"

test("native certification refresh preserves audit evidence without copying unchanged template bodies",{timeout:120000},async t=>{
  const f=await setupCertificationAudit()
  try{
    const before=await f.metadata()
    await f.apply()
    const repaired=await f.owner.one(`select jsonb_object_agg(proname,pg_get_functiondef(oid))from pg_proc where oid in ('public.audit_table_changes()'::regprocedure,'public.email_templates_manage_version()'::regprocedure);`)
    await t.test("migration preserves function identities, ACL, configuration and table shape",async()=>{
      assert.deepEqual(await f.metadata(),before)
      assert.equal(await f.owner.one("select to_jsonb(count(*))from pg_attribute where attrelid='public.email_templates'::regclass and attnum>0 and not attisdropped;"),19)
      for(const role of["anon","authenticated","service_role"])assert.equal(await f.owner.one(`select to_jsonb(has_function_privilege(${literal(role)},'public.undo_audit_log_noncredential(uuid,text,text)','execute'));`),false)
    })
    const insert=async(id,html="<p>Unchanged synthetic body 中文</p>",text="Unchanged synthetic text")=>f.owner.query(`insert into public.email_templates(id,title,slug,body_html,body_text,recipient_resolution)values(${literal(id)},'Synthetic',${literal(id)},${html===null?"null":literal(html)},${text===null?"null":literal(text)},${json(resolution("00000000-0000-4000-8000-000000000000"))});`)
    const refresh=async(id,extra="",actor,ctx)=>f.owner.query(`begin;${setActor(actor,ctx)}update public.email_templates set recipient_resolution=${json(resolution())}${extra} where id=${literal(id)};commit;`)
    await t.test("certification-only update retains exact resolution, context and unchanged-body checksums",async()=>{
      await insert("compact")
      await refresh("compact")
      const [a]=await f.audit();assert.equal(a.record_pk.id,"compact");assert.deepEqual(a.changed_fields,["recipient_resolution","revision"])
      assert.equal(a.before_row.revision,1);assert.equal(a.after_row.revision,2)
      assert.deepEqual(a.after_row.recipient_resolution,resolution());assert.equal(a.request_context.certificationRunId,runId)
      for(const row of[a.before_row,a.after_row]){assert.equal(Object.hasOwn(row,"body_html"),false);assert.equal(Object.hasOwn(row,"body_text"),false)}
      for(const [key,value]of[["body_html","<p>Unchanged synthetic body 中文</p>"],["body_text","Unchanged synthetic text"]])assert.deepEqual(a.request_context.auditRepresentation.omittedUnchangedFields[key],{isNull:false,byteLength:Buffer.byteLength(value),sha256:createHash("sha256").update(value).digest("hex")})
      assert.equal(a.request_context.auditRepresentation.kind,"outlook-certification-refresh-v1");assert.equal(a.request_context.auditRepresentation.undoable,false)
      assert.equal(a.actor_id,"system:outlook-template-recipient-truth");assert.ok(a.request_context.correlationId)
      const app=createAuditConsumers({rows:[a]})
      const listed=await app.request("www","?table=outlooktemplates&details=1")
      assert.equal(listed.status,200);assert.equal(listed.body.logs.length,1)
      assert.equal(listed.body.logs[0].undoable,false);assert.match(listed.body.logs[0].summary,/template content is unchanged/)
      assert.match(listed.body.logs[0].details.join(" "),/not duplicated snapshots/)
      const rejected=await app.request("www","","POST",{action:"undo",id:a.id})
      assert.equal(rejected.status,400);assert.equal(app.undoCalls(),0)
      const session=await f.session("derived-undo")
      await assert.rejects(session.query(`select public.undo_audit_log(${literal(a.id)}::uuid,'synthetic','Synthetic');`),/cannot be undone independently/)
      assert.deepEqual((await f.audit())[0],a)
    })
    await t.test("ordinary content changes and forged labels always retain full bodies",async()=>{
      for(const [id,extra,actor,ctx]of[
        ["human","", "synthetic-human",context()],
        ["html",",body_html='changed'",undefined,undefined],
        ["text",",body_text='changed'",undefined,undefined],
        ["subject",",subject='changed'",undefined,undefined],
        ["recipients",",to_recipients='changed@example.invalid'",undefined,undefined],
        ["tags",",tags=array['changed']",undefined,undefined],
        ["mismatched-proof","",undefined,{...context(),sourceFingerprint:"b".repeat(64)}],
        ["spoofed-marker","","synthetic-human",{...context(),auditRepresentation:{kind:"outlook-certification-refresh-v1"}}],
      ]){await insert(id);await refresh(id,extra,actor,ctx);const a=(await f.audit()).find(a=>a.record_pk.id===id);assert.ok(Object.hasOwn(a.before_row,"body_html"),id);assert.ok(Object.hasOwn(a.after_row,"body_text"),id);assert.equal(Object.hasOwn(a.request_context,"auditRepresentation"),false,id)}
    })
    await t.test("future table columns participate in the typed equality guard",async()=>{
      await f.owner.query("alter table public.email_templates add column synthetic_future_business_field text,add column synthetic_future_json_field json default '{}';")
      await insert("future");await refresh("future",",synthetic_future_business_field='must be audited'")
      const a=(await f.audit()).find(a=>a.record_pk.id==="future");assert.equal(a.after_row.synthetic_future_business_field,"must be audited");assert.ok(a.changed_fields.includes("synthetic_future_business_field"));assert.ok(Object.hasOwn(a.after_row,"body_html"))
      await insert("future-json-unchanged");await refresh("future-json-unchanged")
      assert.equal((await f.audit()).find(a=>a.record_pk.id==="future-json-unchanged").request_context.auditRepresentation.kind,"outlook-certification-refresh-v1")
      await insert("future-json-changed");await refresh("future-json-changed",`,synthetic_future_json_field='{"recorded":true}'::json`)
      const changed=(await f.audit()).find(a=>a.record_pk.id==="future-json-changed");assert.deepEqual(changed.after_row.synthetic_future_json_field,{recorded:true});assert.ok(Object.hasOwn(changed.after_row,"body_html"))
      await f.owner.query("alter table public.email_templates drop column synthetic_future_business_field,drop column synthetic_future_json_field;")
    })
    await t.test("null and empty bodies are distinct and unchanged no-op revisions stay unchanged",async()=>{
      await insert("null",null,"");await refresh("null")
      const a=(await f.audit()).find(a=>a.record_pk.id==="null");assert.deepEqual(a.request_context.auditRepresentation.omittedUnchangedFields.body_html,{isNull:true,sha256:null,byteLength:null});assert.equal(a.request_context.auditRepresentation.omittedUnchangedFields.body_text.byteLength,0)
      const count=(await f.audit()).length;const before=await f.owner.one("select to_jsonb(t)from public.email_templates t where id='null';");await refresh("null");assert.equal((await f.audit()).length,count);assert.deepEqual(await f.owner.one("select to_jsonb(t)from public.email_templates t where id='null';"),before)
    })
    await t.test("ordinary full-snapshot content undo remains functional with exact audit linkage",async()=>{
      await insert("undo");await refresh("undo",",body_html='new html'","synthetic-human")
      const a=(await f.audit()).find(a=>a.record_pk.id==="undo");const undoId=await f.owner.one(`select to_jsonb(public.undo_audit_log(${literal(a.id)}::uuid,'synthetic-human','Synthetic'));`)
      assert.equal(await f.owner.one("select to_jsonb(body_html)from public.email_templates where id='undo';"),"<p>Unchanged synthetic body 中文</p>")
      const undone=(await f.audit()).find(a=>a.id===undoId);assert.equal(undone.undo_of_log_id,a.id);assert.ok(Object.hasOwn(undone.after_row,"body_html"));assert.equal((await f.audit()).find(x=>x.id===a.id).undone_by_log_id,undoId)
    })
    await t.test("insert/delete and unrelated tables retain exact full audit representation",async()=>{
      await f.owner.query(`begin;${setActor()}insert into public.email_templates(id,title,slug,body_html)values('insert-delete','Synthetic','insert-delete','full html');delete from public.email_templates where id='insert-delete';commit;`)
      const rows=(await f.audit()).filter(a=>a.record_pk.id==="insert-delete");assert.equal(rows.length,2);assert.equal(rows.find(a=>a.operation==="INSERT").after_row.body_html,"full html");assert.equal(rows.find(a=>a.operation==="DELETE").before_row.body_html,"full html")
      await f.owner.query(`create table public.synthetic_other(id text primary key,value text);select public.audit_enable_table('public.synthetic_other');begin;${setActor()}insert into public.synthetic_other values('other','old');update public.synthetic_other set value='new';commit;`)
      const other=(await f.audit()).find(a=>a.table_name==="synthetic_other"&&a.operation==="UPDATE");assert.deepEqual(other.before_row,{id:"other",value:"old"});assert.deepEqual(other.after_row,{id:"other",value:"new"})
    })
    await t.test("485-template realistic large-body refresh benchmark compares actual installed triggers",async()=>{
      const bytes=(i,n,label)=>`left((select string_agg(md5('${label}-${i}:'||n::text),'')from generate_series(1,${Math.ceil(n/32)})n),${n})`
      const size=(i,total,max)=>i===0?max:Math.floor((total-max)/484)+(i<=(total-max)%484?1:0)
      for(let first=0;first<485;first+=50){const rows=[];for(let i=first;i<Math.min(first+50,485);i++)rows.push(`('bench-${i}','Synthetic','bench-${i}',${bytes(i,size(i,5422514,783673),"html")},${bytes(i,size(i,5062489,780979),"text")},${json(resolution("00000000-0000-4000-8000-000000000000"))})`);await f.owner.query(`insert into public.email_templates(id,title,slug,body_html,body_text,recipient_resolution)values${rows.join(",")};`)}
      const volume=await f.owner.one("select jsonb_build_object('templates',count(*),'htmlBytes',sum(octet_length(body_html)),'maxHtmlBytes',max(octet_length(body_html)),'textBytes',sum(octet_length(body_text)))from public.email_templates where id like 'bench-%';")
      assert.deepEqual(volume,{templates:485,htmlBytes:5422514,maxHtmlBytes:783673,textBytes:5062489})
      const measure=()=>f.owner.one(`begin;${setActor()}do $$declare started timestamptz:=clock_timestamp();begin update public.email_templates set recipient_resolution=${json(resolution())} where id like 'bench-%';perform set_config('synthetic.elapsed_ms',(extract(epoch from clock_timestamp()-started)*1000)::text,true);end;$$;select jsonb_build_object('elapsedMs',current_setting('synthetic.elapsed_ms')::numeric,'rows',(select count(*)from public.audit_logs where record_pk->>'id'like'bench-%'),'auditBytes',(select sum(octet_length(before_row::text)+octet_length(after_row::text)+octet_length(request_context::text))from public.audit_logs where record_pk->>'id'like'bench-%'),'templateHash',(select md5(string_agg((to_jsonb(t)-array['created_at','updated_at'])::text,''order by id))from public.email_templates t where id like 'bench-%'));rollback;`,{timeoutMs:30000})
      await f.owner.query(originalAudit+originalVersion);const baseline=await measure()
      await f.owner.query(repaired.audit_table_changes+";\n"+repaired.email_templates_manage_version+";\n");const optimized=await measure()
      assert.equal(baseline.rows,485);assert.equal(optimized.rows,485);assert.equal(optimized.templateHash,baseline.templateHash)
      assert.ok(optimized.auditBytes<baseline.auditBytes/8,"Unchanged bodies must not be copied into refresh history")
      t.diagnostic(JSON.stringify({kind:"native-template-audit-benchmark",volume,baseline,optimized,elapsedRatio:optimized.elapsedMs/baseline.elapsedMs,auditByteRatio:optimized.auditBytes/baseline.auditBytes}))
    })
    await t.test("a failed refresh statement is still fully atomic",async()=>{
      const before=await f.audit();const session=await f.session("rollback-refresh")
      await assert.rejects(session.query(`begin;${setActor()}update public.email_templates set recipient_resolution=${json(resolution())} where id like'bench-%';select 1/0;commit;`),/division by zero/)
      await session.close();assert.deepEqual(await f.audit(),before)
    })
    await t.test("migration refuses drift instead of overwriting an unreviewed function",async()=>{
      const session=await f.session("drift-migration",false)
      await assert.rejects(session.query(`begin;${source(migrationPath)}commit;`),/requires the reviewed trigger/)
      await session.close()
    })
  }finally{await f.close()}
})

test("real whole daily certification retains both complete proofs with the compact refresh audit",{timeout:120000},async t=>{
  const f=await setupAtomicEligibility({baseline:false})
  try{
    await f.owner.query(auditSupportSql)
    const {packet,volume}=await seedRealisticActivationVolume(f)
    await f.owner.query("begin;"+source("supabase/migrations/20261023081749_bound_atomic_outlook_full_proof_budget.sql")+source("supabase/migrations/20261028042019_index_outlook_snapshot_validation.sql")+"commit;")
    const beforeProofFunctions=await f.metadata()
    const state=()=>f.owner.one(`select jsonb_build_object(${[
      ["templates","email_templates","id"],["certifications","outlook_exchange_sync_certifications","run_id"],["ledger","outlook_exchange_truth_ledger","ledger_sequence"],["audit","audit_logs","id"],["queue","outlook_exchange_sync_queue","id"],
    ].map(([label,table,key])=>`'${label}',(select jsonb_build_object('count',count(*),'hash',md5(string_agg(md5(to_jsonb(t)::text),''order by ${key})))from public.${table} t)`).join(",")});`)
    const daily={...packet,summary:{...packet.summary,executionMode:"full",readOnlyVerification:false}}
    const measure=async()=>{
      const initial=await state()
      await f.owner.query("begin;set local track_functions='all';set local statement_timeout='20s';update public.outlook_exchange_sync_lock set expires_at=clock_timestamp()+interval'120 seconds',sync_mode='full';")
      const start=performance.now(),result=await f.commitProof(daily,{session:f.owner,atomicFull:true}),elapsedMs=performance.now()-start
      const calls=await f.owner.one("select jsonb_object_agg(funcname,jsonb_build_object('calls',calls,'totalMs',total_time))from pg_stat_xact_user_functions;")
      const evidence=await f.owner.one("select jsonb_build_object('rows',count(*),'compactRows',count(*)filter(where request_context#>>'{auditRepresentation,kind}'='outlook-certification-refresh-v1'),'auditBytes',sum(octet_length(before_row::text)+octet_length(after_row::text)+octet_length(request_context::text)))from public.audit_logs where actor_id='system:outlook-template-recipient-truth'and request_context->>'certificationRunId'="+literal(packet.run)+";")
      // Each actual certification has its own clock timestamps. Compare every
      // other byte and independently require those timestamps to bind to that
      // very certification (rather than incorrectly expecting two clocks equal).
      const outputHash=await f.owner.one("select to_jsonb(md5(string_agg((to_jsonb(t)-array['created_at','updated_at','recipient_resolution'])::text||(recipient_resolution-array['resolvedAt','certifiedAt'])::text,''order by id)))from public.email_templates t;")
      assert.equal(await f.owner.one("select to_jsonb(count(*))from public.email_templates t join public.outlook_exchange_sync_certifications c on c.run_id=(t.recipient_resolution->>'certificationRunId')::uuid where c.run_id="+literal(packet.run)+"::uuid and(t.recipient_resolution->>'certifiedAt')::timestamptz=c.certified_at and(t.recipient_resolution->>'resolvedAt')::timestamptz>=c.certified_at and t.updated_at>=c.certified_at;"),485)
      assert.equal(result.certified,true);assert.equal(result.atomicTemplateActivation,true);assert.equal(result.executionMode,"full");assert.equal(result.readOnlyVerification,false);assert.equal(result.templateReconciliation.updatedTemplates,485)
      assert.equal(calls.verify_outlook_exchange_truth_ledger.calls,2);assert.equal(calls.verify_outlook_exchange_truth_ledger_without_group_smtp_guard.calls,2)
      assert.equal(evidence.rows,485)
      await f.owner.query("rollback;");assert.deepEqual(await state(),initial)
      return{elapsedMs,evidence,outputHash,calls}
    }
    let baseline,optimized
    await t.test("old full daily path is measured without substituting any proof",async()=>{baseline=await measure();assert.equal(baseline.evidence.compactRows,0)})
    await t.test("repaired daily path preserves every proof call, recipient result and atomic rollback",async()=>{
      await f.owner.query("begin;"+source(migrationPath)+"commit;")
      assert.deepEqual(await f.metadata(),beforeProofFunctions)
      optimized=await measure();assert.equal(optimized.evidence.compactRows,485);assert.equal(optimized.outputHash,baseline.outputHash)
      assert.equal(optimized.calls.outlook_exchange_truth_sha256.calls,baseline.calls.outlook_exchange_truth_sha256.calls)
      assert.equal(optimized.calls.outlook_exchange_truth_snapshot_is_valid.calls,baseline.calls.outlook_exchange_truth_snapshot_is_valid.calls)
      t.diagnostic(JSON.stringify({kind:"native-whole-daily-audit-benchmark",volume,baseline,optimized,limitation:"Synthetic PostgreSQL17.6 timing is not a hosted timing or database-restart cure claim; both complete byte proofs execute."}))
    })
    await t.test("post-refresh historical corruption still rejects and rolls back every new audit and activation",async()=>{
      await f.owner.query(`alter table public.outlook_exchange_truth_snapshots disable trigger user;
        create function private.synthetic_audit_proof_corruption()returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$begin
          update public.outlook_exchange_truth_snapshots set item_counts=item_counts||'{"contacts":1}'where snapshot_sha256=(select snapshot_sha256 from public.outlook_exchange_truth_snapshots where canonical_json like '%syntheticHistoryVersion%'order by created_at limit 1);return null;end;$$;
        create trigger zzz_synthetic_audit_proof_corruption after update on public.email_templates for each statement execute function private.synthetic_audit_proof_corruption();
        update public.outlook_exchange_sync_lock set expires_at=clock_timestamp()+interval'120 seconds',sync_mode='full';`)
      const initial=await state()
      await assert.rejects(f.commitProof(daily,{session:await f.session("corrupted-daily-proof"),atomicFull:true}),/did not settle|TRUTH_UNAVAILABLE|TRUTH_INVALID/)
      assert.deepEqual(await state(),initial)
    })
  }finally{await f.close()}
})
