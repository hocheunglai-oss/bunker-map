import assert from "node:assert/strict"
import test from "node:test"
import { setupNativePricing, waitForBlock, literal } from "./fixtures/native-postgres-pricing.mjs"
import { taiwanRemarksMigration, change } from "./fixtures/taiwan-remarks-sql.mjs"
const call=changes=>`select public.save_taiwan_remarks(${literal(JSON.stringify(changes))}::jsonb);`
test("native Taiwan remarks serialize competitors and respect publication/backup lock order",{timeout:120000},async t=>{
  const f=await setupNativePricing()
  try{
    await f.owner.query(taiwanRemarksMigration)
    await t.test('competing captured baselines wait then reject without overwriting winner',async()=>{
      const a=await f.session('notice-winner'),b=await f.session('notice-stale'),observer=await f.session('notice-observer')
      await a.begin();await a.one(call([change(2,'WINNER','Second notice')]))
      await b.begin();const pending=b.one(call([change(1,'MUST ROLLBACK','First notice'),change(2,'LOSER','Second notice')]))
      await waitForBlock(observer,b,a,'relation');await a.query('commit;')
      await assert.rejects(pending,error=>error.code==='40001')
      const after=await f.state();assert.equal(after.remarks.find(row=>row.id===1).content,'First notice');assert.equal(after.remarks.find(row=>row.id===2).content,'WINNER')
      assert.equal(after.audit.filter(row=>row.table_name==='remarks').length,1)
    })
    await t.test('active backup exclusive fence blocks BEFORE remarks table lock',async()=>{
      const backup=await f.session('held-backup'),writer=await f.session('notice-after-backup'),observer=await f.session('fence-observer')
      await backup.begin();await backup.query('select pg_advisory_xact_lock(730261052372033133::bigint);')
      await writer.begin();const pending=writer.one(call([change(2,'AFTER BACKUP','WINNER')]))
      await waitForBlock(observer,writer,backup,'advisory')
      const locks=await observer.one(`select jsonb_build_object('remarksHeld',exists(select 1 from pg_locks where pid=${writer.pid} and relation='public.remarks'::regclass and granted));`)
      assert.equal(locks.remarksHeld,false);await backup.query('commit;');assert.equal((await pending).replayed,false);await writer.query('commit;')
    })
    await t.test('independent row edits serialize without a needless stale conflict',async()=>{
      const a=await f.session('independent-notice-a'),b=await f.session('independent-notice-b'),observer=await f.session('independent-observer')
      await a.begin();await a.one(call([change(2,'INDEPENDENT TWO','AFTER BACKUP')]))
      await b.begin();const pending=b.one(call([change(1,'INDEPENDENT ONE','First notice')]))
      await waitForBlock(observer,b,a,'relation');await a.query('commit;');assert.equal((await pending).replayed,false);await b.query('commit;')
    })
    await t.test('cancellation while waiting rolls back without touching notices, audit or backup markers',async()=>{
      const blocker=await f.session('cancel-notice-blocker'),writer=await f.session('cancelled-notice'),observer=await f.session('cancel-notice-observer',false)
      await blocker.begin();await blocker.query('lock table public.remarks in share row exclusive mode;')
      const before=await f.state();await writer.begin();const pending=writer.one(call([change(2,'MUST NOT SAVE','INDEPENDENT TWO')]))
      const rejected=assert.rejects(pending,error=>error.code==='57014')
      try{
        await waitForBlock(observer,writer,blocker,'relation');await observer.query(`select pg_cancel_backend(${writer.pid});`)
        await rejected
      }finally{await blocker.query('rollback;')}
      assert.deepEqual(await f.state(),before)
    })
    await t.test('publication holding its canonical ordered locks releases without a cycle',async()=>{
      const publication=await f.session('held-publication'),writer=await f.session('notice-after-publication'),observer=await f.session('publication-observer')
      await publication.begin();await publication.query('lock table public.ports in share row exclusive mode;lock table public.price_history in share row exclusive mode;lock table public.remarks in share row exclusive mode;')
      await writer.begin();const pending=writer.one(call([change(2,'AFTER PUBLICATION','INDEPENDENT TWO')]))
      await waitForBlock(observer,writer,publication,'relation');await publication.query('commit;');assert.equal((await pending).replayed,false);await writer.query('commit;')
    })
    await t.test('suppressed second mutation rolls back first notice, audit and epoch together',async()=>{
      await f.owner.query("create function public.suppress_notice() returns trigger language plpgsql as $$begin if new.id=2 then return null;end if;return new;end$$;create trigger z_suppress_notice before update on public.remarks for each row execute function public.suppress_notice();")
      const before=await f.state(),writer=await f.session('failed-second-notice');await writer.begin()
      await assert.rejects(writer.one(call([change(1,'UNCOMMITTED','INDEPENDENT ONE'),change(2,'SUPPRESSED','AFTER PUBLICATION')])),error=>error.code==='40001')
      assert.deepEqual(await f.state(),before);await f.owner.query('drop trigger z_suppress_notice on public.remarks;')
    })
    await t.test('lost acknowledgement retry is read-only and survives native dump/restore',async()=>{
      await Promise.all(f.sessions.filter(session=>session!==f.owner).map(session=>session.close()))
      const writer=await f.session('notice-replay');await writer.begin();const before=await f.state()
      assert.equal((await writer.one(call([change(2,'AFTER PUBLICATION','OLD BASELINE')]))).replayed,true);await writer.query('commit;');assert.deepEqual(await f.state(),before)
      const restored=await f.dumpAndRestore();await restored.service.begin();assert.equal((await restored.service.one(call([change(2,'AFTER PUBLICATION','OLD BASELINE')]))).replayed,true);await restored.service.query('commit;')
    })
    await t.test('suppressed/altered/genuine failing audit inserts roll back notices and backup markers',async()=>{
      await Promise.all(f.sessions.filter(session=>session!==f.owner).map(session=>session.close()))
      for(const body of ["return null;","new.actor_id:='WRONG';return new;","raise exception 'GENUINE AUDIT FAILURE';"]){
        await f.owner.query(`create or replace function public.fail_notice_audit() returns trigger language plpgsql as $$begin ${body} end$$;create trigger z_fail_notice_audit before insert on public.audit_logs for each row execute function public.fail_notice_audit();`)
        const before=await f.state(),writer=await f.session('failed-native-audit');await writer.begin()
        await assert.rejects(writer.one(call([change(1,'MUST ROLLBACK','INDEPENDENT ONE'),change(2,'MUST ROLLBACK TWO','AFTER PUBLICATION')])))
        assert.deepEqual(await f.state(),before);await f.owner.query('drop trigger z_fail_notice_audit on public.audit_logs;')
      }
    })
  }finally{await f.close()}
})
