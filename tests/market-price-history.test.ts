import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { transformSync } from "esbuild"
import * as history from "../lib/marketPriceHistory"

const khh="11111111-1111-4111-8111-111111111111",txg="22222222-2222-4222-8222-222222222222",record="33333333-3333-4333-8333-333333333333"
const port=(id:string,name:string)=>({id,name,lat:null,lng:null,hsfo:600,vlsfo:800,mgo:1000,hsfo_formula:null,vlsfo_formula:null,mgo_formula:null,updated_at:"2026-10-07"})
const input=()=>({day:"2026-10-08",operation:"save",expectedPorts:[port(khh,"Kaohsiung"),port(txg,"Taichung")],expectedRows:[],values:[{port_id:khh,hsfo:0,vlsfo:800,mgo:1000},{port_id:txg,hsfo:null,vlsfo:850,mgo:1050}]})
function success(body: ReturnType<typeof input>) {
  return {market:"taiwan",day:body.day,operation:body.operation,replayed:false,ports:body.expectedPorts,rows:body.values.map((value,index)=>({...value,id:index?record:khh,recorded_at:body.day+"T12:00:00"}))}
}

test("market history validation binds both Taiwan ports/products, preserves zero and rejects malformed dates/prices/scope",()=>{
  const valid=history.validateMarketHistoryChange(input(),"taiwan")
  assert.equal(valid.values[0].hsfo,0)
  assert.equal(history.historyPrice(" 1.25e2 "),125)
  for(const price of [true,{},undefined,-1,"NaN","Infinity","12x","0x20",Infinity])assert.throws(()=>history.historyPrice(price))
  for(const bad of [null,{}, {...input(),day:"2026-02-30"},{...input(),day:"2026-10-08T12:00:00"},{...input(),values:input().values.slice(1)},{...input(),values:[input().values[0],input().values[0]]},{...input(),values:input().values.map(row=>({...row,hsfo:1}))},{...input(),expectedPorts:[port(khh,"Hong Kong"),port(txg,"Taichung")]},{...input(),user:"spoofed"}])assert.throws(()=>history.validateMarketHistoryChange(bad,"taiwan"))
  assert.throws(()=>history.validateMarketHistoryChange(input(),"hongkong"))
  assert.throws(()=>history.parseHistoryMarket("__proto__"))
})

test("saved history snapshots reject duplicates, unknown ports, wrong days, incomplete fields and invalid timestamps",()=>{
  const ports=input().expectedPorts,row={id:record,port_id:khh,hsfo:0,vlsfo:null,mgo:1000,recorded_at:"2026-10-08T23:30:00.000001"}
  assert.equal(history.parseHistoryRows([row],ports,"2026-10-08")[0].recorded_at,row.recorded_at)
  for(const rows of [[row,row],[{...row,port_id:record}],[{...row,recorded_at:"2026-02-30T12:00:00"}],[{...row,recorded_at:"2026-10-08T23:30:00Z"}],[{...row,hsfo:"0"}],[{...row,extra:true}]])assert.throws(()=>history.parseHistoryRows(rows,ports,"2026-10-08"))
  assert.throws(()=>history.parseHistoryRows([row],ports,"2026-10-09"))
})

test("history response validation refuses malformed/partial/wrong-day successes before advancing the UI baseline",()=>{
  const body=history.validateMarketHistoryChange(input(),"taiwan"),result=success(input())
  assert.equal(history.confirmMarketHistoryChange(result,"taiwan",body).rows.length,2)
  for(const invalid of [null,{}, {...result,replayed:undefined},{...result,rows:result.rows.slice(1)},{...result,ports:result.ports.slice(1)},{...result,day:"2026-10-09"},{...result,rows:result.rows.map(row=>({...row,vlsfo:999}))},{...result,rows:result.rows.map(row=>({...row,recorded_at:"2026-10-08T00:00:00"}))}])assert.throws(()=>history.confirmMarketHistoryChange(invalid,"taiwan",body),/could not be confirmed/)
})

function harness(options:{auth?:string;error?:{code:string;message:string};data?:unknown;serviceKey?:boolean;throwRpc?:boolean}={}) {
  const events:string[]=[],calls:{name:string;args:Record<string,unknown>}[]=[]
  const session={username:"SERVER-EDITOR",role:"BT"}
  const modules:Record<string,unknown>={
    "next/server":{NextResponse:{json:Response.json.bind(Response)}},
    "@/lib/marketPriceHistory":history,
    "@/lib/adminAuth":{async requireAdminPagePermissionForRequest(request:Request,page:string,access:string){
      assert.equal(new URL(request.url).searchParams.get("market"),"taiwan");assert.equal(page,"taiwan-price-history");assert.equal(access,request.method === "GET" ? "view" : "edit")
      events.push("auth");if(options.auth)throw Error(options.auth);return session
    }},
    "@/lib/adminAudit":{
      createAdminAuditContext(value:unknown,request:unknown,page:string){assert.equal(value,session);assert.equal(request,undefined);assert.equal(page,"taiwan-price-history");events.push("audit");return {page}},
      createAdminAuditedSupabaseClient(context:unknown,config:unknown){assert.deepEqual(context,{page:"taiwan-price-history"});assert.deepEqual(config,{useServiceRole:true});events.push("client");return {async rpc(name:string,args:Record<string,unknown>){
        calls.push({name,args});events.push("rpc");if(options.throwRpc)throw Error("PRIVATE secret detail")
        return {data:Object.hasOwn(options,"data")?options.data:success(input()),error:options.error??null}
      }}}
    }
  }
  const loaded={exports:{} as {POST:(request:Request)=>Promise<Response>;GET:(request:Request)=>Promise<Response>}}
  const code=transformSync(readFileSync(new URL("../app/api/admin/price-history/route.ts",import.meta.url),"utf8"),{loader:"ts",format:"cjs",target:"node24"}).code
  new Function("require","module","exports","process",code)((name:string)=>{assert.ok(Object.hasOwn(modules,name));return modules[name]},loaded,loaded.exports,{env:{SUPABASE_SERVICE_ROLE_KEY:options.serviceKey===false?"":"synthetic-only"}})
  return {events,calls,async read(market="taiwan") {
    const response=await loaded.exports.GET(new Request("https://example.test/api/admin/price-history?market="+market))
    return {status:response.status,body:await response.json(),headers:response.headers}
  },async request(body:unknown=input(),config:RequestInit={},market="taiwan"){
    const response=await loaded.exports.POST(new Request("https://example.test/api/admin/price-history?market="+market,{method:"POST",headers:{"Content-Type":"application/json",Referer:"https://example.test/admin/usermanagement"},body:JSON.stringify(body),...config}))
    return {status:response.status,body:await response.json(),headers:response.headers}
  }}
}

test("history endpoint requires this market's Edit permission before body parsing or privileged client creation",async()=>{
  for(const [auth,status] of [["Unauthorized",401],["Forbidden",403]] as const){
    const app=harness({auth}),result=await app.request(null,{body:"{bad"})
    assert.equal(result.status,status);assert.deepEqual(app.events,["auth"]);assert.deepEqual(app.calls,[])
    assert.match(result.headers.get("Cache-Control")!,/private, no-store/)
  }
  const app=harness();assert.equal((await app.request(input(),{},"other")).status,400);assert.deepEqual(app.events,[])
})

test("history read validates complete scalar snapshots and requires View permission before creating a privileged client",async()=>{
  const data={market:"taiwan",ports:input().expectedPorts,rows:[]}
  const app=harness({data}),result=await app.read()
  assert.equal(result.status,200);assert.deepEqual(result.body,data)
  assert.deepEqual(app.calls,[{name:"read_market_price_history",args:{p_market:"taiwan"}}])
  assert.match(result.headers.get("Cache-Control")!,/private, no-store/)
  for(const [auth,status] of [["Unauthorized",401],["Forbidden",403]] as const){
    const app=harness({auth});assert.equal((await app.read()).status,status);assert.deepEqual(app.events,["auth"])
  }
  for(const data of [null,{}, {market:"hongkong",ports:input().expectedPorts,rows:[]},{market:"taiwan",ports:[],rows:[]}]) {
    assert.equal((await harness({data}).read()).status,503)
  }
  assert.equal((await harness().read("unknown")).status,400)
  for(const options of [{error:{code:"PRIVATE",message:"PRIVATE"}},{serviceKey:false},{throwRpc:true}]) {
    const result=await harness(options).read();assert.equal(result.status,503);assert.doesNotMatch(JSON.stringify(result.body),/PRIVATE/)
  }
})

test("history endpoint sends exactly one scoped audited RPC and validates the entire success response",async()=>{
  const app=harness(),result=await app.request()
  assert.equal(result.status,200);assert.deepEqual(app.events,["auth","audit","client","rpc"])
  assert.deepEqual(app.calls,[{name:"change_market_price_history",args:{p_market:"taiwan",p_day:input().day,p_operation:"save",p_expected_ports:input().expectedPorts,p_expected_rows:[],p_values:input().values}}])
  for(const data of [null,{}, {...success(input()),rows:[]}])assert.equal((await harness({data}).request()).status,503)
})

test("history endpoint bounds actual streamed bytes and rejects malformed/oversized/incomplete requests without writes",async()=>{
  const requests: RequestInit[] = [{body:"{bad"},{body:" ".repeat(131073)},{headers:{"Content-Type":"text/plain"}},{headers:{"Content-Type":"application/json","Content-Length":"131073"}}]
  for(const config of requests){
    const app=harness();assert.equal((await app.request(input(),config)).status,400);assert.deepEqual(app.calls,[])
  }
  const app=harness();assert.equal((await app.request({...input(),values:[]})).status,400);assert.deepEqual(app.calls,[])
})

test("history errors distinguish conflicts from uncertain saves and never disclose internal details",async()=>{
  for(const [code,status] of [["P0002",409],["22023",400],["P0001",503]] as const){
    const result=await harness({error:{code,message:"PRIVATE database detail"}}).request()
    assert.equal(result.status,status);assert.doesNotMatch(JSON.stringify(result.body),/PRIVATE/)
    if(code==="P0002")assert.equal(result.body.code,"HISTORY_CONFLICT")
  }
  for(const options of [{serviceKey:false},{throwRpc:true}]){
    const result=await harness(options).request();assert.equal(result.status,503);assert.match(result.body.message,/draft is still here/);assert.doesNotMatch(JSON.stringify(result.body),/PRIVATE/)
  }
})
