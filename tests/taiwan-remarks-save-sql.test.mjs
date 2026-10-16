import assert from "node:assert/strict"
import test from "node:test"
import { setupTaiwanRemarks, change } from "./fixtures/taiwan-remarks-sql.mjs"

test("Taiwan atomic save preserves all three notice rows/newlines and never changes report publication", async () => {
  const f=await setupTaiwanRemarks()
  try{
    const result=await f.call([change(3,'{"active":false}',null,false),change(2),change(1,"MEMO\nSECOND MEMO")])
    assert.equal(result.replayed,false);assert.deepEqual(result.rows.map(row=>row.id),[1,2,3])
    const state=await f.state();assert.equal(state.remarks.find(row=>row.id===101).content,'UNCHANGED PUBLICATION')
    assert.equal(state.audit.length,3);assert.ok(state.audit.every(row=>row.actor_id==='SYNTHETIC EDITOR'&&row.request_context.action==='taiwan_remarks_save'))
    assert.equal(state.fence.epoch,1)
    assert.equal((await f.call([change(1,"MEMO\nSECOND MEMO"),change(2),change(3,'{"active":false}',null,false)])).replayed,true)
    assert.deepEqual(await f.state(),state,'lost-ack replay causes no audit or backup mutation')
  }finally{await f.db.close()}
})
test("stale/deleted/absent/null baselines reject the entire changed-row set, retaining winner and audit/epoch", async () => {
  for(const mode of ['stale','deleted','inserted','null']){
    const f=await setupTaiwanRemarks()
    try{
      if(mode==='stale')await f.call([change(2,'WINNER')])
      if(mode==='deleted')await f.db.exec('delete from remarks where id=2')
      if(mode==='inserted')await f.db.exec("insert into remarks values(3,'WINNER')")
      if(mode==='null')await f.db.exec('update remarks set content=null where id=2')
      const before=await f.state()
      const conflicting=mode==='inserted'?change(3,'LOSER',null,false):change(2,'LOSER')
      await assert.rejects(f.call([change(1,'MUST NOT PARTIALLY SAVE'),conflicting]),error=>error.code==='40001')
      assert.deepEqual(await f.state(),before,mode)
    }finally{await f.db.close()}
  }
})
test("native SQL input contract and service-only ACL fail closed without writes", async () => {
  const f=await setupTaiwanRemarks()
  try{
    const before=await f.state()
    for(const value of [null,{},[],[null],[change(),change()],[{id:2,content:'NO BASELINE'}],[{...change(),id:101}], [{...change(),expected:{id:2,exists:false,content:'OLD'}}]]){
      await assert.rejects(f.call(value),error=>error.code==='22023');assert.deepEqual(await f.state(),before)
    }
    await f.db.exec('reset role')
    const acl=(await f.db.query("select not prosecdef invoker,proconfig,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') authenticated,has_function_privilege('service_role',oid,'execute') service from pg_proc where oid='public.save_taiwan_remarks(jsonb)'::regprocedure")).rows[0]
    assert.equal(acl.invoker,true);assert.equal(acl.anon,false);assert.equal(acl.authenticated,false);assert.equal(acl.service,true);assert.ok(acl.proconfig.includes('search_path=""'))
    for(const role of ['anon','authenticated']){await f.db.exec('set role '+role);await assert.rejects(f.call([change()]),error=>error.code==='42501');await f.db.exec('reset role')}
    await f.db.exec("set role service_role;select set_config('request.headers','{}',false)")
    await assert.rejects(f.call([change()]),error=>error.code==='42501')
  }finally{await f.db.close()}
})
test("late remarks failure and suppressed or altered writes roll back every notice and backup marker", async () => {
  for(const body of ["raise exception 'LATE FAILURE';","return null;","new.content := 'ALTERED';return new;"]){
    const f=await setupTaiwanRemarks()
    try{
      await f.db.exec(`reset role;create function public.synthetic_notice_fault() returns trigger language plpgsql as $$begin if new.id=2 then ${body} end if;return new;end$$;create trigger z_synthetic_notice_fault before update on remarks for each row execute function public.synthetic_notice_fault();set role service_role;`)
      const before=await f.state();await assert.rejects(f.call([change(1,'FIRST'),change(2,'SECOND')]))
      assert.deepEqual(await f.state(),before)
    }finally{await f.db.close()}
  }
})
test("suppressed, altered or failed audit INSERT cannot acknowledge a notice save",async()=>{
  for(const body of ["return null;","raise exception 'AUDIT FAILURE';","new.actor_id:='WRONG';return new;","new.after_row:='{}';return new;","new.request_context:='{}';return new;"]){
    const f=await setupTaiwanRemarks()
    try{
      await f.db.exec(`reset role;create function public.synthetic_audit_fault() returns trigger language plpgsql as $$begin ${body} end$$;create trigger z_synthetic_audit_fault before insert on audit_logs for each row execute function public.synthetic_audit_fault();set role service_role;`)
      const before=await f.state();await assert.rejects(f.call([change(1,'FIRST'),change(2,'SECOND')]))
      assert.deepEqual(await f.state(),before)
    }finally{await f.db.close()}
  }
})
