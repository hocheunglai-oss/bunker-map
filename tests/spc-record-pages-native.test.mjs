import assert from "node:assert/strict"
import test from "node:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { setupNativeCcinfo, literal } from "./fixtures/native-postgres-ccinfo.mjs"
import { recordPagesFixtureSql,seedRecordPagesSql,recordPagesStateSql } from "./fixtures/spc-record-pages-sql.mjs"

test("native complete record pages and existing writer counterexample",{timeout:120000},async t=>{
 const f=await setupNativeCcinfo(recordPagesFixtureSql())
 try {
  await t.test("all251/1001/5001 main records are reachable once, exact counts and cursor exhaustion",async()=>{
   for(const count of[251,1001,5001]){
    await f.owner.query("delete from public.spc_enquiries;"+seedRecordPagesSql(count)+"update public.spc_enquiries set created_at=date_trunc('second',created_at);")
    const service=await f.session("record-pages-"+count),seen=[];let cursor=null
    try{do{
      const r=await service.one(`select public.read_spc_lost_record_page(${cursor?literal(JSON.stringify(cursor))+"::jsonb":"null"},250);`)
      assert.equal(r.totalCount,count);assert.equal(r.pageCount,Math.ceil(count/250));assert.equal(r.pageIndex,Math.floor(seen.length/250)+1)
      assert.equal(r.rows.length,Math.min(250,count-seen.length));
      for(let i=1;i<r.rows.length;i++){const a=r.rows[i-1],b=r.rows[i];assert.ok(Date.parse(a.created_at)>Date.parse(b.created_at)||(a.created_at===b.created_at&&a.id<b.id))}
      seen.push(...r.rows.map(x=>x.id));cursor=r.nextCursor
    }while(cursor);assert.equal(new Set(seen).size,count)}finally{await service.close()}
   }
  })
  await t.test("actual now() writer repeats transaction timestamp; content revision still detects both changes",async()=>{
   const old=await f.owner.one("select public.read_spc_lost_record_page(null,250);")
   const id=old.rows[0].id
   await f.owner.query(`begin;update public.spc_enquiries set notes='FIRST' where id=${literal(id)};`)
   const a=await f.owner.one(`select jsonb_build_object('version',(select updated_at from public.spc_enquiries where id=${literal(id)}),'page',public.read_spc_lost_record_page(null,250));`)
   await f.owner.query(`update public.spc_enquiries set notes='SECOND' where id=${literal(id)};`)
   const b=await f.owner.one(`select jsonb_build_object('version',(select updated_at from public.spc_enquiries where id=${literal(id)}),'page',public.read_spc_lost_record_page(null,250));`)
   assert.equal(a.version,b.version);assert.notEqual(a.page.mainRevision,b.page.mainRevision);await f.owner.query("rollback;")
  })
  await t.test("READ ONLY role execution preserves tuple/content state",async()=>{
   const before=await f.owner.one(recordPagesStateSql),service=await f.session("record-pages-readonly")
   try{await service.query("begin read only;");await service.one("select public.read_spc_lost_record_page(null,250);");await service.query("commit;");assert.deepEqual(await f.owner.one(recordPagesStateSql),before)}finally{await service.close()}
  })
 }finally{await f.close();assert.equal(existsSync(join(f.data,"postmaster.pid")),false);assert.ok(f.sessions.every(s=>s.closed));console.log(JSON.stringify({recordPageFixture:f.root,cleanup:"all owned sessions/cluster closed"}))}
})
