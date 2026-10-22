import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { setupNativeCcinfo, literal, waitForBlock } from "./fixtures/native-postgres-ccinfo.mjs"
import { spcStemFixtureSql } from "./fixtures/spc-stem-sql.mjs"
import { createSpcStemRoute, enquiry, session, users, expectedVersion } from "./fixtures/spc-stem-api.mjs"
import { currentSpcWriteDefinition, nativeSpcPostgrestError } from "./fixtures/spc-write-conflicts-sql.mjs"

const supplierSession = { ...session, username: users[1].username, displayName: users[1].displayName, role: "SUPPLIER TRADER", userId: users[1].id }
const state = f => f.owner.one(`select jsonb_build_object(
  'enquiries',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.spc_enquiries t),
  'fixtures',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.spc_fixtures t),
  'outbox',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.spc_group_delivery_jobs t),
  'audit',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.audit_logs t),
  'epochs',(select coalesce(jsonb_agg(to_jsonb(t) order by mutation_id),'[]') from private.bunker_map_backup_mutations t));`)
const call = args => `select public.update_spc_fixture_with_enquiry(${literal(args.p_fixture_id)},${literal(args.p_actor_username)},${literal(args.p_expected_updated_at)},${literal(args.p_expected_status)},${literal(args.p_action)},${args.p_fixture == null ? "null" : literal(JSON.stringify(args.p_fixture))+"::jsonb"},${args.p_primary_supplier == null ? "null" : literal(args.p_primary_supplier)});`
async function trustedBegin(client, actor = supplierSession, action = "save-fixture") {
  await client.begin()
  await client.query(`do $$ begin perform set_config('request.headers',${literal(JSON.stringify({
    "x-bunker-admin-user":`spc:${actor.username}`,"x-bunker-admin-display-name":actor.displayName,
    "x-bunker-audit-actor-user-id":actor.userId,"x-bunker-admin-page-id":"spc-fixtures","x-bunker-audit-action":action,
  }))},true); end $$;`)
}
function app(f, options = {}) {
  const connection = f.session(`fixture-api-${randomUUID()}`)
  let captured, rpcCalls = 0
  const route = createSpcStemRoute({fixtureRoute: true, actor: options.actor || supplierSession, permission: options.permission,
    userLookupError: options.userLookupError,
    createClient: headers => ({
      from(table) {
        assert.equal(table,"spc_fixtures")
        let id
        const query = {
          select(){return query},eq(key,value){assert.equal(key,"id");id=value;return query},
          async single(){const data=await(await connection).one(`select to_jsonb(t) from public.spc_fixtures t where id=${literal(id)};`);await options.afterRead?.();return{data,error:null}},
        }
        return query
      },
      async rpc(name,args) {
        assert.equal(name,"update_spc_fixture_with_enquiry");captured=args;rpcCalls++
        await options.beforeRpc?.()
        const client=await connection
        await client.begin()
        await client.query(`do $$ begin perform set_config('request.headers',${literal(JSON.stringify(headers))},true); end $$;`)
        try {
          const data=await client.one(call(args))
          await client.query("commit;")
          if(options.loseResponse)throw new Error("Injected lost response after fixture commit")
          return {data,error:null}
        } catch(error){return{data:null,error:nativeSpcPostgrestError(error)}}
      },
    }),
  })
  return {...route,connection,captured:()=>captured,rpcCalls:()=>rpcCalls}
}
async function seed(f) {
  const enquiryId=randomUUID(),id=randomUUID()
  await f.owner.query(`insert into public.spc_enquiries(id,enquiry_number,title,status,notes,supplier_name,created_by_username,created_by_display_name,updated_at,stem_request_id,stem_source_updated_at,stem_supplier_username)
    values('${enquiryId}','SYNTHETIC-${enquiryId}','SYNTHETIC VESSEL','quoted',${literal(enquiry.notes)},'OLD SUPPLIER',${literal(session.username)},${literal(session.displayName)},'${expectedVersion}','${randomUUID()}','${expectedVersion}',${literal(users[1].username)});
    insert into public.spc_fixtures(id,enquiry_id,fixture_status,supplier_trader_user_id,supplier_trader_username,supplier_trader_display_name,buyer_trader_user_id,buyer_trader_username,buyer_trader_display_name,supplier_name,price)
    values('${id}','${enquiryId}','pending','${users[1].id}',${literal(users[1].username)},${literal(users[1].displayName)},'${users[0].id}',${literal(users[0].username)},${literal(users[0].displayName)},'OLD SUPPLIER','700');`)
  await f.owner.query(`insert into public.spc_group_delivery_jobs(enquiry_id,revision_number,event_type,message_text,status) values('${enquiryId}',1,'created','Synthetic already delivered enquiry','sent');`)
  const row=(await state(f)).fixtures.find(row=>row.id===id)
  return {id,enquiryId,action:"save",fixture:{expectedUpdatedAt:row.updated_at,expectedStatus:"pending",fixtureDate:"2026-10-15",
    supplierTrader:users[1].username,buyerTrader:users[0].username,account:"HONG KONG",earliestEta:"20 OCT",vesselName:"SYNTHETIC VESSEL",
    vlsfo:"500",supplierName:"NEW SUPPLIER",price:"777",barging:"10",commission:"SYNTHETIC"}}
}
test("native actual fixture API atomically saves, completes and version-protects deletion", {timeout:120000}, async t => {
  const f=await setupNativeCcinfo(spcStemFixtureSql())
  t.afterEach(async()=>{await Promise.all(f.sessions.filter(client=>client!==f.owner).map(client=>client.close()))})
  try {
    await t.test("save returns the committed joined row and preserves all non-editable source/STEM fields",async()=>{
      const payload=await seed(f),before=await state(f),route=app(f)
      const response=await route.patch(payload)
      assert.equal(response.status,200,JSON.stringify(response))
      assert.equal(response.body.fixture.price,"777");assert.equal(response.body.fixture.enquiryTitle,"SYNTHETIC VESSEL")
      assert.equal(route.rpcCalls(),1)
      const after=await state(f),source=after.enquiries.find(row=>row.id===payload.enquiryId),old=before.enquiries.find(row=>row.id===payload.enquiryId)
      assert.equal(source.supplier_name,"NEW SUPPLIER")
      assert.deepEqual(after.outbox,before.outbox)
      assert.deepEqual({...source,supplier_name:old.supplier_name,updated_at:old.updated_at},old)
      const changed=after.audit.filter(row=>row.request_context.action==="save-fixture")
      assert.equal(changed.length,2);assert.ok(changed.every(row=>row.request_context.actorUserId===undefined||row.request_context.actorUserId===supplierSession.userId))
      assert.ok(after.epochs.length>before.epochs.length)
    })
    await t.test("old clients, view-only and pending non-supplier callers fail before mutation",async()=>{
      const payload=await seed(f),before=await state(f)
      assert.equal((await app(f).patch({...payload,fixture:{...payload.fixture,expectedUpdatedAt:""}})).status,400)
      assert.equal((await app(f,{permission:"view"}).patch(payload)).status,403)
      assert.equal((await app(f,{actor:session}).patch(payload)).status,403)
      assert.deepEqual(await state(f),before)
    })
    await t.test("commit eligibility rejects an actor deactivated after preparation and returns locked canonical trader names",async()=>{
      const payload=await seed(f),before=await state(f)
      const denied=await app(f,{beforeRpc:()=>f.owner.query(`update public.spc_users set is_active=false where id='${supplierSession.userId}';`)}).patch(payload)
      assert.equal(denied.status,403,JSON.stringify(denied));assert.deepEqual(await state(f),before)
      await f.owner.query(`update public.spc_users set is_active=true where id='${supplierSession.userId}';`)
      const renamed=await app(f,{beforeRpc:()=>f.owner.query(`update public.spc_users set display_name='Canonical Renamed Buyer' where id='${users[0].id}';`)}).patch(payload)
      assert.equal(renamed.status,200,JSON.stringify(renamed));assert.equal(renamed.body.fixture.buyerTraderDisplayName,"Canonical Renamed Buyer")
      await f.owner.query(`update public.spc_users set display_name=${literal(users[0].displayName)} where id='${users[0].id}';`)
    })
    await t.test("source synchronization failure rolls back fixture/source/audit/backup together",async()=>{
      const payload=await seed(f)
      await f.owner.query(`create or replace function public.fail_fixture_source() returns trigger language plpgsql as $$ begin if new.id='${payload.enquiryId}'::uuid then raise exception 'Injected source synchronization failure'; end if;return new;end $$;
        create trigger fail_fixture_source before update on public.spc_enquiries for each row execute function public.fail_fixture_source();`)
      const before=await state(f),response=await app(f).patch({...payload,action:"complete"})
      assert.equal(response.status,500,JSON.stringify(response));assert.equal(response.body.message,"Failed to save SPC fixture.")
      assert.deepEqual(await state(f),before)
      await f.owner.query("drop trigger fail_fixture_source on public.spc_enquiries;")
    })
    await t.test("trigger-suppressed fixture update, source update and deletion fail closed with complete rollback",async()=>{
      for(const kind of ["fixture-update","source-update","fixture-delete"]) {
        const payload=await seed(f),table=kind==="source-update"?"spc_enquiries":"spc_fixtures",id=kind==="source-update"?payload.enquiryId:payload.id,operation=kind==="fixture-delete"?"delete":"update"
        await f.owner.query(`create or replace function public.suppress_fixture_operation() returns trigger language plpgsql as $$ begin
          if ${operation==="delete"?"old":"new"}.id='${id}'::uuid then return null;end if;return ${operation==="delete"?"old":"new"};end $$;
          create trigger suppress_fixture_operation before ${operation} on public.${table} for each row execute function public.suppress_fixture_operation();`)
        const before=await state(f),request=operation==="delete"?{id:payload.id,action:"delete",expectedUpdatedAt:payload.fixture.expectedUpdatedAt,expectedStatus:"pending"}:payload
        const response=await app(f).patch(request)
        assert.equal(response.status,409,JSON.stringify({kind,response}));assert.deepEqual(await state(f),before)
        await f.owner.query(`drop trigger suppress_fixture_operation on public.${table};`)
      }
    })
    await t.test("held stale editor cannot overwrite a concurrent completion",async()=>{
      const payload=await seed(f)
      let release,read;const hold=new Promise(resolve=>release=resolve),loaded=new Promise(resolve=>read=resolve)
      const stale=app(f,{afterRead:async()=>{read();await hold}}),pending=stale.patch(payload)
      await loaded
      assert.equal((await app(f).patch({...payload,action:"complete",fixture:{...payload.fixture,price:"888"}})).status,200)
      const committed=await state(f);release()
      assert.equal((await pending).status,409)
      assert.deepEqual(await state(f),committed)
      assert.equal(committed.fixtures.find(row=>row.id===payload.id).fixture_status,"completed")
    })
    await t.test("two native held fixture edits serialize and reject the stale loser without extra audit/fences",async()=>{
      const sample=await seed(f),prepared=app(f);await prepared.patch(sample)
      const payload=await seed(f),args={...prepared.captured(),p_fixture_id:payload.id,p_expected_updated_at:payload.fixture.expectedUpdatedAt}
      const writer=await f.session("held-fixture-writer"),observer=await f.session("fixture-lock-observer")
      await trustedBegin(writer);await writer.one(call(args))
      const second=app(f),pending=second.patch({...payload,fixture:{...payload.fixture,price:"999"}})
      await waitForBlock(observer,await second.connection,writer)
      await writer.query("commit;")
      const committed=await state(f)
      assert.equal((await pending).status,409)
      assert.deepEqual(await state(f),committed)
    })
    await t.test("lost fixture response retry fails stale without rewriting the committed completed row",async()=>{
      const payload=await seed(f),lost=app(f,{loseResponse:true})
      assert.equal((await lost.patch({...payload,action:"complete"})).status,500)
      const committed=await state(f)
      assert.equal((await app(f).patch({...payload,action:"complete"})).status,409)
      assert.deepEqual(await state(f),committed)
    })
    await t.test("STEM retry waits for source-first fixture completion and remains read-only",async()=>{
      const payload=await seed(f),prepared=app(f);await prepared.patch(payload)
      const latest=(await state(f)).fixtures.find(row=>row.id===payload.id)
      const args={...prepared.captured(),p_expected_updated_at:latest.updated_at,p_action:"complete"}
      const writer=await f.session("held-completion-before-stem-retry"),observer=await f.session("stem-retry-lock-observer")
      await trustedBegin(writer,supplierSession,"complete-fixture");await writer.one(call(args))
      const retry=await f.session("stem-retry-reader")
      await trustedBegin(retry,session,"set-enquiry-stem")
      const source=(await state(f)).enquiries.find(row=>row.id===payload.enquiryId)
      const pending=retry.one(`select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.stem_spc_enquiry_with_fixture('${source.id}',${literal(session.username)},'${source.stem_source_updated_at}','${source.stem_request_id}',${literal(source.stem_supplier_username)},null,null) t;`)
      await waitForBlock(observer,retry,writer)
      await writer.query("commit;")
      const committed=await state(f)
      assert.equal((await pending)[0].status,"quoted");await retry.query("commit;")
      assert.deepEqual(await state(f),committed)
    })
    await t.test("stale deletion cannot delete a newly completed fixture, while current completed deletion preserves source",async()=>{
      const payload=await seed(f),deletion={id:payload.id,action:"delete",expectedUpdatedAt:payload.fixture.expectedUpdatedAt,expectedStatus:"pending"}
      let release,prepared;const hold=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>prepared=resolve)
      const stale=app(f,{beforeRpc:async()=>{prepared();await hold}}),pending=stale.patch(deletion)
      await ready
      assert.equal((await app(f).patch({...payload,action:"complete"})).status,200)
      const committed=await state(f),row=committed.fixtures.find(row=>row.id===payload.id)
      release();assert.equal((await pending).status,409)
      assert.deepEqual(await state(f),committed)
      assert.equal((await app(f).patch({...deletion,expectedUpdatedAt:row.updated_at,expectedStatus:"completed"})).status,200)
      const after=await state(f)
      assert.equal(after.fixtures.some(row=>row.id===payload.id),false)
      assert.deepEqual(after.enquiries,committed.enquiries)
    })
    await t.test("pending deletion still requires assigned supplier, and a delete trigger failure is atomic",async()=>{
      const payload=await seed(f),deletion={id:payload.id,action:"delete",expectedUpdatedAt:payload.fixture.expectedUpdatedAt,expectedStatus:"pending"}
      const before=await state(f)
      assert.equal((await app(f,{actor:session}).patch(deletion)).status,403)
      assert.deepEqual(await state(f),before)
      await f.owner.query(`create function public.fail_fixture_delete() returns trigger language plpgsql as $$ begin if old.id='${payload.id}'::uuid then raise exception 'Injected fixture delete failure';end if;return old;end $$;
        create trigger fail_fixture_delete before delete on public.spc_fixtures for each row execute function public.fail_fixture_delete();`)
      assert.equal((await app(f).patch(deletion)).status,500)
      assert.deepEqual(await state(f),before)
      await f.owner.query("drop trigger fail_fixture_delete on public.spc_fixtures;")
    })
    await t.test("RPC is service-only invoker and aggregate undo cannot split a fixture save",async()=>{
      const flags=await f.owner.one(`select jsonb_build_object('definer',prosecdef,'config',proconfig,'anon',has_function_privilege('anon',oid,'execute'),'authenticated',has_function_privilege('authenticated',oid,'execute')) from pg_proc where proname='update_spc_fixture_with_enquiry';`)
      assert.equal(flags.definer,false);assert.equal(flags.anon,false);assert.equal(flags.authenticated,false)
      const log=(await state(f)).audit.find(row=>row.request_context.action==="save-fixture")
      const undo=await f.session("partial-fixture-undo"),before=await state(f)
      await undo.begin();await undo.query(`set local app.audit_undo_of_log_id='${log.id}';`)
      await assert.rejects(undo.query(`update public.${log.table_name} set updated_at=clock_timestamp() where id=${literal(log.record_pk.id)};`),/single-row undo/)
      assert.deepEqual(await state(f),before)
    })
  } finally {await f.close()}
})
test("fresh schema includes the exact additive fixture migration",()=>{
  assert.ok(fs.readFileSync(new URL("../supabase/spc_schema.sql",import.meta.url),"utf8").includes(currentSpcWriteDefinition("update_spc_fixture_with_enquiry")))
})
