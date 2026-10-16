import assert from "node:assert/strict"
import test from "node:test"
import { setupNativeCcinfo, literal, waitForBlock } from "./fixtures/native-postgres-ccinfo.mjs"
import { templateWritePolicySql, verifiedTruth, emptyResolution, inputTemplate } from "./fixtures/outlook-template-write-policy.mjs"
const save=(row,revision)=>`select public.save_email_template_canonical(${literal(JSON.stringify(row))}::jsonb,${revision},null);`
const state=f=>f.owner.one(`select jsonb_build_object('templates',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.email_templates t),'audit',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.audit_logs t),'fence',public.get_bunker_map_backup_export_fence());`)
async function fixture(options){const f=await setupNativeCcinfo(templateWritePolicySql(options));f.truth=verifiedTruth();await f.owner.query(`insert into private.synthetic_exchange_truth values(${literal(JSON.stringify(f.truth))}::jsonb);`);return f}
async function mutation(f,row,revision){const s=await f.session("canonical-save");try{await s.begin();await s.query(save(row,revision));await s.query("commit;")}finally{await s.close()}}
test("native old trigger rejects ordinary pending queue; repaired trigger INSERT/UPDATE preserve real audit and backup fence",{timeout:120000},async()=>{
  const old=await fixture({repaired:false});try{await assert.rejects(mutation(old,inputTemplate(emptyResolution(old.truth)),0),error=>error.code==="55000");assert.equal((await state(old)).templates.length,0)}finally{await old.close()}
  const f=await fixture();try{const row=inputTemplate(emptyResolution(f.truth));await mutation(f,row,0);await mutation(f,{...row,body_html:"<p>Changed body</p>"},1);const final=await state(f);assert.equal(final.templates[0].revision,2);assert.equal(final.audit.length,2);assert.equal(final.fence.ready,true);assert.equal((await f.owner.one("select count(*)::int from private.bunker_map_backup_mutations;") ),2)}finally{await f.close()}
})
test("native repaired trigger still blocks stale, future, infinite, corrupt, failed and mismatched certification atomically",{timeout:120000},async()=>{
  const f=await fixture();try{for(const overrides of [{latestCertificationAt:new Date(Date.now()-37*3600000).toISOString()},{latestCertificationAt:new Date(Date.now()+6*60000).toISOString()},{latestCertificationAt:"infinity"},{latestCertificationAt:"bad-date"},{integrityValid:false},{latestCertificationHasProjectionEvidence:false},{latestProjectionSnapshotSha256:"b".repeat(64)},{queue:{failed:1,terminalFailed:0}},{queue:{failed:0,terminalFailed:1}}]){const truth={...f.truth,...overrides};await f.owner.query(`update private.synthetic_exchange_truth set value=${literal(JSON.stringify(truth))}::jsonb;`);const before=await state(f);await assert.rejects(mutation(f,inputTemplate(emptyResolution(f.truth)),0),error=>error.code==="55000");assert.deepEqual(await state(f),before)}}finally{await f.close()}
})
test("native recipient evidence remains exact and trigger-only ACL unchanged",{timeout:120000},async()=>{
  const f=await fixture();try{const before=await state(f);const resolution=emptyResolution(f.truth);resolution.sourceFingerprint="b".repeat(64);await assert.rejects(mutation(f,inputTemplate(resolution),0),error=>error.code==="40001");assert.deepEqual(await state(f),before);const acl=await f.owner.one(`select jsonb_build_object('anon',has_function_privilege('anon','private.prepare_outlook_template_truth_write()','EXECUTE'),'authenticated',has_function_privilege('authenticated','private.prepare_outlook_template_truth_write()','EXECUTE'),'service',has_function_privilege('service_role','private.prepare_outlook_template_truth_write()','EXECUTE'));`);assert.deepEqual(acl,{anon:false,authenticated:false,service:false})}finally{await f.close()}
})
test("native waiting canonical writer serializes; cancelled waiter rolls back without audit/fence or revision changes",{timeout:120000},async()=>{
  const f=await fixture();try{
    const row=inputTemplate(emptyResolution(f.truth));await mutation(f,row,0)
    const first=await f.session("first-writer"),second=await f.session("waiting-writer"),observer=await f.session("observer",false)
    await first.begin();await first.query(save({...row,title:"First writer"},1));await second.begin()
    const pending=second.query(save({...row,title:"Second writer"},2)).then(()=>null,error=>error)
    await waitForBlock(observer,second,first,"advisory");await first.query("commit;");assert.equal(await pending,null);await second.query("commit;")
    assert.equal((await state(f)).templates[0].revision,3)
    const blocker=await f.session("blocker"),cancelled=await f.session("cancelled-writer")
    const before=await state(f);await blocker.begin();await blocker.query("select pg_advisory_xact_lock(hashtextextended('email_templates_canonical_write',0));");await cancelled.begin();await cancelled.query("set local statement_timeout='250ms';")
    const cancellation=cancelled.query(save({...row,title:"Must roll back"},3)).then(()=>null,error=>error)
    await waitForBlock(observer,cancelled,blocker,"advisory");assert.equal((await cancellation).code,"57014");await blocker.query("rollback;")
    assert.deepEqual(await state(f),before)
  }finally{await f.close()}
})
