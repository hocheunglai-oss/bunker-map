import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync, existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { setupNativeCcinfo, literal } from "./fixtures/native-postgres-ccinfo.mjs"
import { spcStemFixtureSql } from "./fixtures/spc-stem-sql.mjs"
import { createRecordStateRoute, lostRow, presentationRow, recordVersion, reviewPayload } from "./fixtures/spc-record-state-api.mjs"

const migration=readFileSync(new URL("../supabase/migrations/20260713064655_spc_presentation_readme.sql",import.meta.url),"utf8")
const visual=readFileSync(new URL("../supabase/migrations/20260714045014_add_spc_presentation_visual_copy.sql",import.meta.url),"utf8")
const fixtureSql=spcStemFixtureSql()+migration.slice(0,migration.indexOf("insert into public.spc_presentation_chunks"))+
  "alter table public.spc_presentation_chunks add column chapter_label text not null default 'CHAPTER 1';"+
  visual.slice(0,visual.indexOf("update public.spc_presentation_chunks"))+
  "select public.audit_enable_table('public.spc_presentation_chunks');"+
  "create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.spc_presentation_chunks for each statement execute function private.record_bunker_map_backup_mutation();"
const state=f=>f.owner.one("select jsonb_build_object('enquiries',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.spc_enquiries t),'chunks',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.spc_presentation_chunks t),'audit',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.audit_logs t),'epochs',(select coalesce(jsonb_agg(to_jsonb(t) order by mutation_id),'[]') from private.bunker_map_backup_mutations t));")
async function seed(f,kind){
  const row=kind==="lost"?lostRow:presentationRow,id=randomUUID()
  const values={...row,id,...(kind==="lost"?{enquiry_number:"SPC-"+id}:{slug:"synthetic-"+id,video_path:id+"/video-original.mp4"})}
  const table=kind==="lost"?"spc_enquiries":"spc_presentation_chunks"
  const fields=Object.entries(values).map(([key,value])=>[key,Array.isArray(value)?(key==="key_points"?"'{}'::text[]":"'[]'::jsonb"):value===null?"null":typeof value==="number"?String(value):literal(value)])
  await f.owner.query("insert into public."+table+"("+fields.map(([k])=>k).join(",")+") values("+fields.map(([,v])=>v).join(",")+");")
  return {id,expectedUpdatedAt:recordVersion}
}
function nativeApp(f,kind="lost",options={}){
  const connection=f.session("record-state-"+randomUUID()),removes=[]
  const app=createRecordStateRoute({kind,...options,createClient:headers=>({
    storage:{from(){return{remove:async paths=>{removes.push(paths);return{data:paths,error:null}},list:async(_id,input)=>({data:[{name:input.search,metadata:{size:321}}],error:null}),createSignedUrls:async paths=>{
      if(options.loseMediaAck){options.loseMediaAck=false;return{data:null,error:{message:"Synthetic response loss after commit"}}}
      return{data:paths.map(path=>({path,signedUrl:"https://synthetic.invalid/"+path})),error:null}
    }}}},
    from(table){
      if(table==="spc_lost_reason_options") {const q={select(){return q},eq(){return q},order(){return q},then(resolve,reject){return Promise.resolve({data:[{reason:"OTHER"},{reason:"SUPPLIER NO AVAILS"}],error:null}).then(resolve,reject)}};return q}
      assert.ok(["spc_enquiries","spc_presentation_chunks"].includes(table))
      let action="read",payload;const filters=[]
      const query={select(){return query},eq(key,value){assert.ok(["id","updated_at","status","revision"].includes(key));filters.push([key,value]);return query},
        update(value){action="update";payload=value;return query},delete(){action="delete";return query},
        single(){return run(true)},maybeSingle(){return run(false)},then(resolve,reject){return run(false,true).then(resolve,reject)}}
      async function run(single,many=false){
        const client=await connection,where=filters.map(([key,value])=>key+"="+literal(value)).join(" and ")
        if(action==="read"){
          const rows=await client.one("select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public."+table+" t where "+where+";")
          await options.afterRead?.()
          return{data:many?rows:rows[0]||null,error:single&&rows.length!==1?{code:"PGRST116",message:"Singular response required"}:null}
        }
        await options.beforeWrite?.()
        await client.begin()
        await client.query("do $$ begin perform set_config('request.headers',"+literal(JSON.stringify(headers))+",true);end $$;")
        try{
          const mutation=action==="delete"?"delete from public."+table+" t where "+where+" returning to_jsonb(t) as row":
            "update public."+table+" t set "+Object.entries(payload).map(([key,value])=>{assert.ok(["notes","updated_at","video_path","video_mime_type","video_bytes","narration_path","narration_mime_type","narration_bytes","media_version","revision","updated_by_username"].includes(key));return key+"="+literal(value)}).join(",")+" where "+where+" returning to_jsonb(t) as row"
          const rows=await client.one("with changed as ("+mutation+") select coalesce(jsonb_agg(row),'[]') from changed;")
          // Match PostgREST singular-return semantics: zero rows condemns the
          // transaction, including statement-level audit/backup effects.
          if(single&&rows.length!==1){await client.query("rollback;");return{data:null,error:{code:"PGRST116",message:"Singular response required"}}}
          await client.query("commit;")
          return{data:many?rows:rows[0]||null,error:null}
        }catch(error){return{data:null,error:{code:error.code,message:error.message}}}
      }
      return query
    },
  })})
  return {...app,removes}
}
test("actual lost-record/presentation API on isolated PostgreSQL 17.6 preserves stale-state, audit and backup boundaries",async t=>{
  const f=await setupNativeCcinfo(fixtureSql)
  try{
    await t.test("a stale lost draft cannot overwrite a newer review; fresh acknowledged version can save again",async()=>{
      const baseline=await seed(f,"lost"),app=nativeApp(f)
      const latest=await app.mutate(reviewPayload(baseline));assert.equal(latest.status,200,JSON.stringify(latest))
      const before=await state(f),stale=await app.mutate(reviewPayload({...baseline,spcComments:"Stale comment"}))
      assert.equal(stale.status,409);assert.deepEqual(await state(f),before)
      const fresh=await app.mutate(reviewPayload({...baseline,expectedUpdatedAt:latest.body.review.updatedAt,spcComments:"Next comment"}))
      assert.equal(fresh.status,200);assert.equal(fresh.body.review.meta.spcComments,"Next comment")
    })
    await t.test("two overlapping review requests keep the committed winner and reject the held loser",async()=>{
      const baseline=await seed(f,"lost");let release,read
      const held=new Promise(resolve=>release=resolve),loaded=new Promise(resolve=>read=resolve)
      const a=nativeApp(f,"lost",{afterRead:async()=>{read();await held}}),pending=a.mutate(reviewPayload({...baseline,spcComments:"Held stale draft"}))
      await loaded
      const b=await nativeApp(f).mutate(reviewPayload({...baseline,spcComments:"Winning review"}));assert.equal(b.status,200)
      const committed=await state(f);release()
      assert.equal((await pending).status,409);assert.deepEqual(await state(f),committed)
    })
    await t.test("a held review cannot write after status changes from cancelled",async()=>{
      const baseline=await seed(f,"lost");let release,read
      const held=new Promise(resolve=>release=resolve),loaded=new Promise(resolve=>read=resolve)
      const pending=nativeApp(f,"lost",{afterRead:async()=>{read();await held}}).mutate(reviewPayload(baseline))
      await loaded;await f.owner.query("update public.spc_enquiries set status='sent' where id="+literal(baseline.id)+";")
      const committed=await state(f);release();assert.equal((await pending).status,409);assert.deepEqual(await state(f),committed)
    })
    await t.test("stale presentation DELETE preserves the new revision and never removes its media",async()=>{
      const baseline=await seed(f,"presentation")
      await f.owner.query("update public.spc_presentation_chunks set revision=2,title='New revision',video_path='new-media.mp4' where id="+literal(baseline.id)+";")
      const before=await state(f),app=nativeApp(f,"presentation"),result=await app.mutate({action:"delete",id:baseline.id,revision:1})
      assert.equal(result.status,409);assert.deepEqual(await state(f),before);assert.deepEqual(app.removes,[])
    })
    await t.test("current presentation DELETE preserves physical media and audited/fenced semantics",async()=>{
      const baseline=await seed(f,"presentation"),before=await state(f),app=nativeApp(f,"presentation")
      assert.equal((await app.mutate({action:"delete",id:baseline.id,revision:1})).status,200)
      const after=await state(f);assert.equal(after.chunks.length,before.chunks.length-1);assert.equal(after.audit.length,before.audit.length+1);assert.ok(after.epochs.length>before.epochs.length)
      assert.deepEqual(app.removes,[])
      assert.equal(after.audit.at(-1).request_context.actorUserId,undefined)
      assert.equal(after.audit.at(-1).actor_user_id,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      const again=await app.mutate({action:"delete",id:baseline.id,revision:1});assert.equal(again.status,409);assert.deepEqual(await state(f),after);assert.equal(app.removes.length,0)
    })
    await t.test("trigger-suppressed review UPDATE and presentation DELETE refuse success and roll back audit/fence",async()=>{
      for(const kind of ["lost","presentation"]){
        const baseline=await seed(f,kind),table=kind==="lost"?"spc_enquiries":"spc_presentation_chunks",operation=kind==="lost"?"update":"delete"
        await f.owner.query("create or replace function public.suppress_record_state() returns trigger language plpgsql as $$ begin return null;end $$;create trigger suppress_record_state before "+operation+" on public."+table+" for each row execute function public.suppress_record_state();")
        const before=await state(f),app=nativeApp(f,kind),result=await app.mutate(kind==="lost"?reviewPayload(baseline):{action:"delete",id:baseline.id,revision:1})
        assert.equal(result.status,409,JSON.stringify(result));assert.deepEqual(await state(f),before);assert.deepEqual(app.removes,[])
        await f.owner.query("drop trigger suppress_record_state on public."+table+";")
      }
    })
    await t.test("actual media completion commits once and a lost-ack replay is read-only with exact bytes/path",async()=>{
      const baseline=await seed(f,"presentation"),app=nativeApp(f,"presentation",{loseMediaAck:true}),payload={action:"complete-upload",id:baseline.id,revision:1,kind:"video",path:baseline.id+"/video-new.mp4",mimeType:"video/mp4"}
      assert.equal((await app.mutate(payload)).status,500)
      const committed=await state(f),row=committed.chunks.find(row=>row.id===baseline.id)
      assert.equal(row.video_path,payload.path);assert.equal(row.video_bytes,321);assert.equal(row.revision,2);assert.equal(row.media_version,2)
      const replay=await app.mutate(payload);assert.equal(replay.status,200,JSON.stringify(replay));assert.equal(replay.body.chunk.videoBytes,321);assert.equal(replay.body.chunk.revision,2)
      assert.deepEqual(await state(f),committed);assert.deepEqual(app.removes,[])
      await f.owner.query("update public.spc_presentation_chunks set revision=3,title='Later colleague edit' where id="+literal(baseline.id)+";")
      const newer=await state(f);assert.equal((await app.mutate(payload)).status,409);assert.deepEqual(await state(f),newer);assert.equal(app.removes.length,0)
    })
    await t.test("audit INSERT exception rolls back each operation without physical media removal",async()=>{
      for(const kind of ["lost","presentation"]){
        const baseline=await seed(f,kind)
        await f.owner.query("create or replace function public.fail_record_audit() returns trigger language plpgsql as $$ begin raise exception 'Synthetic audit failure';end $$;create trigger fail_record_audit before insert on public.audit_logs for each row execute function public.fail_record_audit();")
        const before=await state(f),app=nativeApp(f,kind),result=await app.mutate(kind==="lost"?reviewPayload(baseline):{action:"delete",id:baseline.id,revision:1})
        assert.ok(result.status>=400,JSON.stringify(result));assert.deepEqual(await state(f),before);assert.deepEqual(app.removes,[])
        await f.owner.query("drop trigger fail_record_audit on public.audit_logs;")
      }
    })
    await t.test("narration completion and replay preserve the existing video without cleanup side effects",async()=>{
      const baseline=await seed(f,"presentation"),app=nativeApp(f,"presentation",{loseMediaAck:true}),payload={action:"complete-upload",id:baseline.id,revision:1,kind:"narration",path:baseline.id+"/narration-new.mp3",mimeType:"audio/mpeg"}
      assert.equal((await app.mutate(payload)).status,500)
      const committed=await state(f),replay=await app.mutate(payload);assert.equal(replay.status,200);assert.equal(replay.body.chunk.narrationPath,payload.path);assert.equal(replay.body.chunk.narrationBytes,321);assert.equal(replay.body.chunk.videoPath,baseline.id+"/video-original.mp4")
      assert.deepEqual(await state(f),committed);assert.deepEqual(app.removes,[])
    })
  }finally{await f.close();assert.equal(existsSync(f.data+"/postmaster.pid"),false);t.diagnostic("Closed owned PostgreSQL 17.6 fixture: "+f.root)}
})
