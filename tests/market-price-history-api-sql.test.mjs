import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { transformSync } from "esbuild"
import * as history from "../lib/marketPriceHistory.ts"
import * as adminPages from "../lib/adminPages.ts"
import { priceSetterSnapshot } from "../lib/priceSetterMutation.ts"
import { setup,basis,linked,chained } from "./fixtures/price-setter-sql.mjs"

const migration=readFileSync(new URL("../supabase/migrations/20261012114634_atomic_market_history_changes.sql",import.meta.url),"utf8")
async function harness() {
  const f=await setup(),calls=[],headers=[],permissions=[]
  await f.db.exec(`update ports set hsfo_formula=null,vlsfo_formula=null,mgo_formula=null;
    update ports set name=case id when '${basis}' then 'Hong Kong' when '${linked}' then 'Kaohsiung' when '${chained}' then 'Taichung' else name end;${migration}`)
  const env={NEXT_PUBLIC_SUPABASE_URL:"https://example.test",SUPABASE_SERVICE_ROLE_KEY:"synthetic-only",NEXT_PUBLIC_SUPABASE_ANON_KEY:"synthetic-public"}
  const state={auth:null,damage:false}
  const modules={
    "next/server":{NextResponse:{json:Response.json.bind(Response)}},
    "@/lib/marketPriceHistory":history,
    "@/lib/adminPages":adminPages,
    "@/lib/adminAuth":{async requireAdminPagePermissionForRequest(_request,page,access){permissions.push({page,access});if(state.auth)throw Error(state.auth);return {username:"SERVER-EDITOR",displayName:"Editor",role:"BT"}}},
    "@supabase/supabase-js":{createClient(url,key,options){
      assert.equal(url,env.NEXT_PUBLIC_SUPABASE_URL);assert.equal(key,env.SUPABASE_SERVICE_ROLE_KEY);headers.push(options.global.headers)
      return {async rpc(name,args){
        assert.equal(name,"change_market_price_history");calls.push({name,args})
        try{
          const result=await f.db.query("select public.change_market_price_history($1,$2::date,$3,$4::jsonb,$5::jsonb,$6::jsonb) as result",[args.p_market,args.p_day,args.p_operation,JSON.stringify(args.p_expected_ports),JSON.stringify(args.p_expected_rows),JSON.stringify(args.p_values)])
          return {data:state.damage?{}:result.rows[0].result,error:null}
        }catch(error){return {data:null,error:{code:error.code,message:error.message}}}
      }}
    }}
  }
  function load(file){
    const loaded={exports:{}},code=transformSync(readFileSync(new URL(file,import.meta.url),"utf8"),{loader:"ts",format:"cjs",target:"node24"}).code
    new Function("require","module","exports","process",code)(name=>{assert.ok(Object.hasOwn(modules,name));return modules[name]},loaded,loaded.exports,{env})
    return loaded.exports
  }
  modules["@/lib/adminAudit"]=load("../lib/adminAudit.ts")
  const route=load("../app/api/admin/price-history/route.ts")
  await f.db.exec("set role service_role")
  return {...f,calls,headers,permissions,control:state,
    async input(market="taiwan",operation="save"){
      const ids=market==="taiwan"?[linked,chained]:[basis]
      const ports=(await f.db.query("select jsonb_agg(to_jsonb(p) order by id) as data from ports p where id=any($1::uuid[])",[ids])).rows[0].data
      const rows=(await f.db.query("select coalesce(jsonb_agg(to_jsonb(h) order by id),'[]'::jsonb) as data from price_history h where port_id=any($1::uuid[]) and recorded_at::date='2026-10-08'",[ids])).rows[0].data
      return {day:"2026-10-08",operation,expectedPorts:ports.map(p=>({id:p.id,...priceSetterSnapshot(p)})),expectedRows:rows,values:operation==="delete"?[]:ids.map(id=>({port_id:id,hsfo:id===chained?null:0,vlsfo:800,mgo:1000}))}
    },async request(input,market="taiwan"){
      const response=await route.POST(new Request("https://example.test/api/admin/price-history?market="+market,{method:"POST",headers:{"Content-Type":"application/json",Referer:"https://example.test/admin/usermanagement","x-bunker-admin-user":"SPOOFED"},body:JSON.stringify(input)}))
      return {status:response.status,headers:response.headers,body:await response.json()}
    }
  }
}

test("actual history endpoint/audit constructor/SQL commit one market day and reconcile replay without writes",async()=>{
  const f=await harness();try{
    const input=await f.input(),saved=await f.request(input)
    assert.equal(saved.status,200);history.confirmMarketHistoryChange(saved.body,"taiwan",input)
    assert.equal((await f.row(linked)).hsfo,0);assert.equal((await f.row(chained)).vlsfo,800)
    assert.equal(f.calls.length,1);assert.deepEqual(f.permissions,[{page:"taiwan-price-history",access:"edit"}])
    assert.equal(f.headers[0]["x-bunker-admin-user"],"SERVER-EDITOR")
    assert.equal(f.headers[0]["x-bunker-admin-page-id"],"taiwan-price-history")
    assert.equal(f.headers[0]["x-bunker-admin-page-path"],"/admin/taiwanpricehistory")
    assert.match(saved.headers.get("Cache-Control"),/private, no-store/)
    const before=await f.state(),replay=await f.request(input)
    assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assert.deepEqual(await f.state(),before)
    input.values[0].hsfo=1
    const conflict=await f.request(input);assert.equal(conflict.status,409);assert.equal(conflict.body.code,"HISTORY_CONFLICT");assert.deepEqual(await f.state(),before)
    const hk=await f.request(await f.input("hongkong"),"hongkong")
    assert.equal(hk.status,200);assert.equal(f.headers.at(-1)["x-bunker-admin-page-id"],"hongkong-price-history")
  }finally{await f.db.close()}
})

test("real later SQL failure is a safe uncertain result with no partial changes; damaged response can safely retry",async()=>{
  const f=await harness();try{
    const input=await f.input(),before=await f.state()
    await f.db.exec(`reset role;create function public.synthetic_history_fail() returns trigger language plpgsql as $$ begin if new.port_id='${chained}' then raise exception 'PRIVATE SQL FAILURE';end if;return new;end;$$;
      create trigger synthetic_history_fail before insert on public.price_history for each row execute function public.synthetic_history_fail();set role service_role;`)
    const failure=await f.request(input);assert.equal(failure.status,503);assert.doesNotMatch(JSON.stringify(failure.body),/PRIVATE|SQL FAILURE/);assert.deepEqual(await f.state(),before)
    await f.db.exec("reset role;drop trigger synthetic_history_fail on price_history;set role service_role;")
    f.control.damage=true
    assert.equal((await f.request(input)).status,503)
    const committed=await f.state();f.control.damage=false
    const retry=await f.request(input);assert.equal(retry.status,200);assert.equal(retry.body.replayed,true);assert.deepEqual(await f.state(),committed)
  }finally{await f.db.close()}
})

test("history delete commits both Taiwan rows atomically; View/anonymous never create a privileged client or reach SQL",async()=>{
  const f=await harness();try{
    await f.request(await f.input())
    const deletion=await f.input("taiwan","delete")
    for(const [auth,status] of [["Forbidden",403],["Unauthorized",401]]){
      f.control.auth=auth;const calls=f.calls.length,clients=f.headers.length,before=await f.state()
      assert.equal((await f.request(deletion)).status,status);assert.equal(f.calls.length,calls);assert.equal(f.headers.length,clients);assert.deepEqual(await f.state(),before)
    }
    f.control.auth=null
    const result=await f.request(deletion)
    assert.equal(result.status,200);assert.deepEqual(result.body.rows,[])
    assert.equal((await f.row(linked)).hsfo,null);assert.equal((await f.row(chained)).updated_at,null)
    assert.equal((await f.request(deletion)).body.replayed,true)
  }finally{await f.db.close()}
})
