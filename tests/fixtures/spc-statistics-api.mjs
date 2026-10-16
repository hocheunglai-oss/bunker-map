import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { transformSync } from "esbuild"
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../.."),require=createRequire(import.meta.url)
export const statisticsActor={authenticated:true,username:"buyer@example.test",displayName:"Synthetic Buyer",role:"ADMIN",userId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
export const statisticsNow="2026-10-16T04:50:00.000Z"
export function statisticsData(count=1) {
  const id=(kind,n)=>{const h=createHash("md5").update(kind+"-"+n).digest("hex");return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)}
  const enquiries=Array.from({length:count},(_,n)=>({id:id("enquiry",n+1),enquiry_number:"SPC-SYNTHETIC-"+(n+1),title:"Synthetic Vessel",created_by_username:statisticsActor.username,created_by_display_name:statisticsActor.displayName,created_at:statisticsNow}))
  return {fixtures:enquiries.map((e,n)=>({id:id("fixture",n+1),fixture_status:"completed",fixture_date:"2026-10-16",supplier_trader_username:"supplier@example.test",supplier_trader_display_name:"Synthetic Supplier",buyer_trader_username:statisticsActor.username,buyer_trader_display_name:statisticsActor.displayName,account:"HONG KONG",vessel_name:"Synthetic Vessel",hsfo:"100",vlsfo:null,lsmgo:null,supplier_name:"SYNTHETIC SUPPLIER",supplier_key:"SYNTHETICSUPPLIER",created_at:statisticsNow,enquiry:{enquiry_number:e.enquiry_number,created_by_username:e.created_by_username,created_by_display_name:e.created_by_display_name,created_at:e.created_at}})),enquiries,
    users:[{id:statisticsActor.userId,username:statisticsActor.username,display_name:statisticsActor.displayName,role:"buyer_trader",is_active:true},{id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",username:"supplier@example.test",display_name:"Synthetic Supplier",role:"supplier_trader",is_active:true}],buyerEnquiryNumbers:enquiries.map(e=>e.enquiry_number),roles:[],profiles:[{userId:statisticsActor.userId,username:statisticsActor.username,office:"HONG KONG"}]}
}
export function statisticsWire(data,args) {
  return {schema:"fcuno.spc-statistics-source/v1",complete:true,bounds:{firstFixtureYear:args.p_first_fixture_year,lastFixtureYear:args.p_last_fixture_year,windowStart:args.p_window_start,windowEnd:args.p_window_end},...structuredClone(data),counts:Object.fromEntries(Object.entries(data).map(([key,value])=>[key,value.length]))}
}
export function statisticsReadClient(data, rpc) {
  return {rpc,from(table){
    const tables={spc_fixtures:data.fixtures,spc_enquiries:data.enquiries,spc_users:data.users,spc_identity_links:[],office_calendar_store:[{key:"spc-permission-groups",payload:{userRoles:data.roles,userProfiles:data.profiles}}],audit_logs:data.buyerEnquiryNumbers.map(number=>({actor_id:"spc:buyer@example.test",request_context:{pageId:"spc-buyer-enquiries"},table_schema:"public",table_name:"spc_enquiries",operation:"INSERT",enquiry_number:number}))}
    assert.ok(Object.hasOwn(tables,table),"Unexpected fixture table "+table)
    const filters=[],orders=[];let from=0,to=Infinity
    const q={select(){return q},eq(key,value){filters.push(row=>row[key]===value);return q},gte(key,value){filters.push(row=>row[key]>=value);return q},lte(key,value){filters.push(row=>row[key]<=value);return q},like(key,value){filters.push(row=>String(row[key]).startsWith(value.slice(0,-1)));return q},contains(key,value){filters.push(row=>Object.entries(value).every(([field,v])=>row[key]?.[field]===v));return q},order(key,{ascending=true}={}){orders.push([key,ascending]);return q},range(a,b){from=a;to=b;return q},async maybeSingle(){return {data:tables[table].filter(row=>filters.every(test=>test(row)))[0]||null,error:null}},then(resolve,reject){return Promise.resolve().then(()=>({data:structuredClone(tables[table].filter(row=>filters.every(test=>test(row))).sort((a,b)=>{for(const[key,asc]of orders){const delta=String(a[key]).localeCompare(String(b[key]));if(delta)return asc?delta:-delta}return 0}).slice(from,to+1)),error:null})).then(resolve,reject)}}
    return q
  }}
}
/**
 * Real route/cache/library/user projection, synthetic identity and transport only.
 * @param {{client:unknown,permission?:string,now?:string,legacySource?:string|null}} options
 */
export function statisticsRuntime({client,permission="view",now=statisticsNow,legacySource=null}={}) {
  const state={permission,now:Date.parse(now)},cache=new Map(),headers=[],authChecks=[]
  const NativeDate=Date
  class FixtureDate extends NativeDate { constructor(...args){super(...(args.length?args:[state.now]))}static now(){return state.now} }
  const mocks={"next/server":{NextResponse:{json:Response.json.bind(Response)}},"@supabase/supabase-js":{createClient(_url,_key,options){headers.push(options?.global?.headers||{});return client}},"@/lib/spcAuth":{async requireSpcPagePermission(page,access){authChecks.push([page,access]);assert.deepEqual([page,access],["spc-statistics","view"]);if(state.permission==="signed-out")throw Error("Unauthorized");if(state.permission==="none")throw Error("Forbidden");return statisticsActor}}}
  function load(name,parent=root){
    if(Object.hasOwn(mocks,name))return mocks[name]
    if(!name.startsWith("@/")&&!name.startsWith("."))return require(name)
    const unresolved=name.startsWith("@/")?join(root,name.slice(2)):resolve(parent,name),file=["",".ts",".json",".js"].map(ext=>unresolved+ext).find(existsSync)
    assert.ok(file,"Unresolved "+name);if(file.endsWith(".json"))return JSON.parse(readFileSync(file,"utf8"))
    if(cache.has(file))return cache.get(file).exports
    const mod={exports:{}};cache.set(file,mod)
    const source=legacySource&&name==="@/lib/spcStatistics"?legacySource:readFileSync(file,"utf8")
    const code=transformSync(source,{loader:"ts",format:"cjs",target:"node24"}).code
    new Function("require","module","exports","process","Date",code)(request=>load(request,dirname(file)),mod,mod.exports,{env:{NEXT_PUBLIC_SUPABASE_URL:"https://synthetic.invalid",SUPABASE_SERVICE_ROLE_KEY:"synthetic-only-no-remote"}},FixtureDate)
    return mod.exports
  }
  const route=load("@/app/api/spc/statistics/route")
  return {state,headers,authChecks,load,async get({year="2026",refresh=false}={}){const response=await route.GET(new Request(`https://synthetic.invalid/api/spc/statistics?year=${year}${refresh?"&refresh=1":""}`));return {status:response.status,headers:Object.fromEntries(response.headers),body:await response.json()}}}
}
