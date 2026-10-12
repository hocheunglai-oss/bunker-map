import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { setup, basis, linked, chained, other } from "./fixtures/price-setter-sql.mjs"
import { priceSetterSnapshot } from "../lib/priceSetterMutation.ts"
import { validateMarketHistoryChange, confirmMarketHistoryChange } from "../lib/marketPriceHistory.ts"

const migration = readFileSync(new URL("../supabase/migrations/20261009025254_atomic_market_history_changes.sql",import.meta.url),"utf8")
const day="2026-10-08", names={hongkong:[basis],taiwan:[linked,chained]}
const price=(port_id,n=700)=>({port_id,hsfo:port_id===chained?null:n,vlsfo:n,mgo:n+100})

async function fixture() {
  const f=await setup()
  await f.db.exec(`update ports set hsfo_formula=null,vlsfo_formula=null,mgo_formula=null;
    update ports set name=case id when '${basis}' then 'Hong Kong' when '${linked}' then 'Kaohsiung' when '${chained}' then 'Taichung' else 'Dependent' end;
    update ports set vlsfo_formula='Kaohsiung + 0',updated_at='2026-10-07' where id='${other}'; ${migration}`)
  async function input(market="taiwan",operation="save",date=day) {
    const ports=(await f.db.query("select jsonb_agg(to_jsonb(p) order by id) as ports from ports p where id=any($1::uuid[])",[names[market]])).rows[0].ports
    const history=(await f.db.query("select * from price_history where port_id=any($1::uuid[]) and recorded_at >= $2::date and recorded_at < $2::date+1 order by id",[names[market],date])).rows
    // Use Postgres JSON encoding, exactly as PostgREST returns timestamp-without-zone.
    const rows=(await f.db.query("select coalesce(jsonb_agg(to_jsonb(h) order by id),'[]'::jsonb) as rows from price_history h where port_id=any($1::uuid[]) and recorded_at >= $2::date and recorded_at < $2::date+1",[names[market],date])).rows[0].rows
    assert.equal(history.length,rows.length)
    return validateMarketHistoryChange({day:date,operation,expectedPorts:ports.map(p=>({id:p.id,...priceSetterSnapshot(p)})),expectedRows:rows,values:operation==="save"?names[market].map(id=>price(id)):[]},market)
  }
  async function change(market,input) {
    const result=(await f.db.query("select public.change_market_price_history($1,$2::date,$3,$4::jsonb,$5::jsonb,$6::jsonb) as result",[market,input.day,input.operation,JSON.stringify(input.expectedPorts),JSON.stringify(input.expectedRows),JSON.stringify(input.values)])).rows[0].result
    confirmMarketHistoryChange(result,market,input)
    return result
  }
  return {...f,input,change}
}

test("one transaction saves both Taiwan ports, preserves zero and unrelated rows, and syncs latest roots/dependencies",async()=>{
  const f=await fixture();try{
    await f.db.exec(`insert into price_history(port_id,hsfo,vlsfo,mgo,recorded_at) values('${basis}',1,2,3,'2026-10-07 23:30:00')`)
    const before=await f.row(basis),input=await f.input();input.values[0].hsfo=0
    const result=await f.change("taiwan",input)
    assert.equal(result.replayed,false);assert.equal(result.rows.length,2)
    assert.equal((await f.row(linked)).hsfo,0);assert.equal((await f.row(other)).updated_at,day)
    assert.deepEqual(await f.row(basis),before)
    assert.equal((await f.db.query("select count(*) as n from price_history")).rows[0].n,3)
  }finally{await f.db.close()}
})

for(const failure of ["second_insert","duplicate_delete","root_update","dependent_update"]){
  test(`real SQL failure at ${failure} rolls back history, both current ports and linked dates`,async()=>{
    const f=await fixture();try{
      if(failure==="duplicate_delete")await f.db.exec(`insert into price_history(port_id,hsfo,recorded_at) values('${linked}',100,'2026-10-08 10:00:00'),('${linked}',200,'2026-10-08 11:00:00')`)
      const input=await f.input(),before=await f.state()
      const table=failure.endsWith("insert")||failure==="duplicate_delete"?"price_history":"ports"
      const action=failure==="second_insert"?"insert":failure==="duplicate_delete"?"delete":"update"
      const condition=failure==="second_insert"?`new.port_id='${chained}'`:failure==="root_update"?`new.id='${chained}'`:failure==="dependent_update"?`new.id='${other}'`:"true"
      await f.db.exec(`create function public.synthetic_fail() returns trigger language plpgsql as $$ begin if ${condition} then raise exception 'synthetic later failure'; end if; return new; end; $$; create trigger synthetic_fail before ${action} on public.${table} for each row execute function public.synthetic_fail();`)
      await assert.rejects(f.change("taiwan",input),/synthetic later failure/)
      assert.deepEqual(await f.state(),before)
    }finally{await f.db.close()}
  })
}

test("stale history/current-price snapshots conflict; a lost-response retry is a read-only no-op",async()=>{
  const f=await fixture();try{
    const stale=await f.input(),result=await f.change("taiwan",stale),before=await f.state()
    await f.db.exec("create function public.no_replay_write() returns trigger language plpgsql as $$ begin raise exception 'replay must not write'; end; $$; create trigger no_replay_write before insert or update or delete on price_history for each row execute function public.no_replay_write(); create trigger no_replay_write before update on ports for each row execute function public.no_replay_write();")
    assert.equal((await f.change("taiwan",stale)).replayed,true);assert.deepEqual(await f.state(),before)
    stale.values[0].vlsfo=900
    await assert.rejects(f.change("taiwan",stale),error=>error.code==="P0002")
    await f.db.exec("drop trigger no_replay_write on price_history;drop trigger no_replay_write on ports;")
    const changed=await f.input();await f.db.exec(`update ports set hsfo=999 where id='${linked}'`)
    changed.values[0].vlsfo=800
    const newer=await f.state();await assert.rejects(f.change("taiwan",changed),error=>error.code==="P0002");assert.deepEqual(await f.state(),newer)
    const same=await f.input();const afterExternalEdit=await f.state()
    // A same-day lost response never "repairs" independently changed current
    // prices. It acknowledges equal history only, without any write.
    assert.equal((await f.change("taiwan",same)).replayed,true)
    assert.deepEqual(await f.state(),afterExternalEdit)
    assert.equal(result.rows.length,2)
  }finally{await f.db.close()}
})

test("Taiwan day deletion rolls back if a root update fails; multi-root transitive dates use the latest surviving root",async()=>{
  const f=await fixture();try{
    await f.change("taiwan",await f.input())
    await f.db.exec(`insert into ports(id,name,vlsfo_formula,mgo_formula,updated_at) values
      ('55555555-5555-4555-8555-555555555555','Transitive','Dependent + 0','Taichung + 0','2026-10-07');
      insert into price_history(port_id,vlsfo,mgo,recorded_at) values('${linked}',900,1000,'2026-10-09 12:00:00'),('${chained}',950,1050,'2026-10-10 12:00:00');`)
    const deletion=await f.input("taiwan","delete"),before=await f.state()
    await f.db.exec(`create function public.synthetic_delete_fail() returns trigger language plpgsql as $$ begin if new.id='${chained}' then raise exception 'later delete sync failure';end if;return new;end;$$;
      create trigger synthetic_delete_fail before update on ports for each row execute function public.synthetic_delete_fail();`)
    await assert.rejects(f.change("taiwan",deletion),/later delete sync failure/);assert.deepEqual(await f.state(),before)
    await f.db.exec("drop trigger synthetic_delete_fail on ports;")
    await f.change("taiwan",deletion)
    const transitive=await f.row("55555555-5555-4555-8555-555555555555")
    assert.equal(transitive.updated_at,"2026-10-10")
    assert.equal((await f.row(other)).updated_at,"2026-10-09")
  }finally{await f.db.close()}
})

test("duplicate cleanup retains newest IDs; deleting a day uses remaining latest prices and clears final unsupported prices",async()=>{
  const f=await fixture();try{
    await f.db.exec(`insert into price_history(id,port_id,hsfo,vlsfo,mgo,recorded_at) values
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','${basis}',100,200,300,'2026-10-08 11:00:00.000001'),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','${basis}',200,300,400,'2026-10-08 11:00:00.000002'),
      ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','${basis}',50,60,70,'2026-10-07 23:30:00');`)
    const saved=await f.change("hongkong",await f.input("hongkong"))
    assert.equal(saved.rows[0].id,"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
    const deletion=await f.input("hongkong","delete")
    await f.change("hongkong",deletion)
    assert.equal((await f.row()).hsfo,50);assert.equal((await f.row()).updated_at,"2026-10-07")
    assert.equal((await f.change("hongkong",deletion)).replayed,true)
    await f.change("hongkong",await f.input("hongkong","delete","2026-10-07"))
    const current=await f.row();assert.equal(current.hsfo,null);assert.equal(current.updated_at,null)
  }finally{await f.db.close()}
})

test("deleting Taiwan is atomic and never removes another market/day; historical saves do not replace a newer current price",async()=>{
  const f=await fixture();try{
    await f.change("taiwan",await f.input())
    await f.db.exec(`insert into price_history(port_id,hsfo,vlsfo,mgo,recorded_at) values('${linked}',800,900,1000,'2026-10-09 23:30:00'),('${chained}',null,950,1050,'2026-10-09 23:30:00'),('${basis}',1,2,3,'2026-10-08 12:00:00')`)
    const history=await f.input();history.values[0].hsfo=750
    await f.change("taiwan",history)
    assert.equal((await f.row(linked)).hsfo,800);assert.equal((await f.row(linked)).updated_at,"2026-10-09")
    await f.change("taiwan",await f.input("taiwan","delete"))
    assert.equal((await f.db.query("select count(*) as n from price_history")).rows[0].n,3)
    assert.equal((await f.row(linked)).hsfo,800)
  }finally{await f.db.close()}
})

test("RPC is invoker/service-only, rejects malformed/cross-market inputs and respects timestamp-without-zone across session zones",async()=>{
  const f=await fixture();try{
    const meta=(await f.db.query("select prosecdef,proconfig from pg_proc where oid='public.change_market_price_history(text,date,text,jsonb,jsonb,jsonb)'::regprocedure")).rows[0]
    assert.equal(meta.prosecdef,false);assert.ok(meta.proconfig.includes('search_path=""'))
    for(const role of ["anon","authenticated"]){
      assert.equal((await f.db.query("select has_function_privilege($1,'public.change_market_price_history(text,date,text,jsonb,jsonb,jsonb)','EXECUTE') as allowed",[role])).rows[0].allowed,false)
    }
    const input=await f.input()
    for(const bad of [{...input,values:[price(basis)]},{...input,values:[price(linked),price(linked)]},{...input,values:[price(linked),{...price(chained),hsfo:1}]},{...input,expectedPorts:[]},{...input,expectedRows:[{id:"fake"}]}]){
      const before=await f.state();await assert.rejects(f.change("taiwan",bad));assert.deepEqual(await f.state(),before)
    }
    for(const zone of ["America/Los_Angeles","Pacific/Kiritimati"]){
      await f.db.exec(`set timezone='${zone}'`)
      const result=await f.change("taiwan",await f.input())
      assert.ok(result.rows.every(row=>row.recorded_at===day+"T12:00:00"))
    }
  }finally{await f.db.close()}
})
