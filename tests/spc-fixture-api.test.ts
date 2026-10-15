import assert from "node:assert/strict"
import test from "node:test"
import { createSpcStemRoute, expectedVersion, session, users } from "./fixtures/spc-stem-api.mjs"

const fixtureId = "ffffffff-ffff-4fff-8fff-ffffffffffff"
const enquiryId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const actor = { ...session, username: users[1].username, displayName: users[1].displayName, role: "SUPPLIER TRADER", userId: users[1].id }
const row = {
  id: fixtureId, enquiry_id: enquiryId, fixture_status: "pending", fixture_date: "2026-10-15",
  supplier_trader_user_id: users[1].id, supplier_trader_username: users[1].username, supplier_trader_display_name: users[1].displayName,
  buyer_trader_user_id: users[0].id, buyer_trader_username: users[0].username, buyer_trader_display_name: users[0].displayName,
  account: "HONG KONG", commission: "KEEP", earliest_eta: "20 OCT", vessel_name: "SYNTHETIC VESSEL", vessel_imo: "9999999",
  hsfo: null, vlsfo: "500", lsmgo: null, supplier_name: "OLD SUPPLIER", supplier_key: "old", price: "700", barging: "10",
  completed_at: null, completed_by_username: null, completed_by_display_name: null, created_at: expectedVersion, updated_at: expectedVersion,
}
const payload = {
  id: fixtureId, action: "save", fixture: { expectedUpdatedAt: expectedVersion, expectedStatus: "pending", fixtureDate: "2026-10-15",
    supplierTrader: users[1].username, buyerTrader: users[0].username, account: "HONG KONG", earliestEta: "20 OCT", vesselName: "SYNTHETIC VESSEL",
    vlsfo: "500", supplierName: "NEW SUPPLIER", price: "777.25", barging: "10", commission: "KEEP" },
}
type Options = {permission?:string;actor?:typeof actor|null;error?:{code:string;message:string};readError?:{code:string;message:string};ack?:(value:Record<string,unknown>)=>unknown;userLookupError?:Error}
function harness(options:Options = {}) {
  const calls:Array<Record<string,unknown>>=[],headers:Array<Record<string,string>>=[],reads:Array<string>=[]
  const route = createSpcStemRoute({ fixtureRoute: true, actor: Object.hasOwn(options,"actor") ? options.actor : actor,
    permission:options.permission,userLookupError:options.userLookupError,
    createClient: context => {
      headers.push(context)
      return {
        from(table:string){
          assert.equal(table,"spc_fixtures");reads.push(table)
          const query={select(){return query},eq(key:string,value:string){assert.equal(key,"id");assert.equal(value,fixtureId);return query},async single(){return {data:options.readError?null:structuredClone(row),error:options.readError||null}}}
          // Standalone updates/deletes deliberately do not exist in this adapter.
          return query
        },
        async rpc(name:string,args:Record<string,unknown>){
          assert.equal(name,"update_spc_fixture_with_enquiry");calls.push(args)
          if(options.error)return{data:null,error:options.error}
          const saved=args.p_action==="delete"?{id:fixtureId}:{...row,...args.p_fixture as object,
            fixture_status:args.p_action==="complete"?"completed":"pending",updated_at:"2026-10-15T02:03:04.654321Z",
            enquiry:{id:enquiryId,enquiry_number:"SPC-SYNTHETIC",title:"SYNTHETIC VESSEL"}}
          return {data:options.ack?options.ack(saved):saved,error:null}
        },
      }
    },
  })
  return{...route,calls,headers,reads}
}
test("fixture API preserves edit permission and requires the exact browser version/status before preparation",async()=>{
  for(const [options,status] of [[{actor:null},401],[{permission:"view"},403]] as const){const app=harness(options);assert.equal((await app.patch(payload)).status,status);assert.equal(app.headers.length,0)}
  for(const fixture of [{...payload.fixture,expectedUpdatedAt:""},{...payload.fixture,expectedUpdatedAt:"not-a-date"},{...payload.fixture,expectedStatus:""}]){
    const app=harness();const response=await app.patch({...payload,fixture});assert.equal(response.status,400);assert.match(response.body.message,/Refresh/);assert.equal(app.calls.length,0);assert.equal(app.reads.length,0)
  }
})
test("fixture API prepares existing business fields and sends one audited atomic RPC, returning its canonical acknowledgement",async()=>{
  const app=harness(),response=await app.patch(payload)
  assert.equal(response.status,200,JSON.stringify(response));assert.equal(response.body.fixture.id,fixtureId);assert.equal(response.body.fixture.enquiryTitle,"SYNTHETIC VESSEL")
  assert.equal(response.body.fixture.price,"777.25");assert.equal(response.body.fixture.vesselImo,"9999999");assert.equal(app.reads.length,1);assert.equal(app.calls.length,1)
  const args=app.calls[0],prepared=args.p_fixture as Record<string,unknown>
  assert.equal(args.p_expected_updated_at,expectedVersion);assert.equal(args.p_expected_status,"pending");assert.equal(args.p_action,"save");assert.equal(args.p_primary_supplier,"NEW SUPPLIER")
  assert.equal(prepared.commission,"KEEP");assert.equal(prepared.price,"777.25");assert.equal(prepared.supplier_trader_display_name,users[1].displayName)
  for(const protectedField of ["id","enquiry_id","fixture_status","vessel_imo","completed_at","completed_by_username","created_at","updated_at"])assert.equal(Object.hasOwn(prepared,protectedField),false,protectedField)
  assert.equal(app.headers[0]["x-bunker-audit-action"],"save-fixture");assert.equal(app.headers[0]["x-bunker-audit-actor-user-id"],actor.userId)
})
test("fixture API preserves real PostgREST conflict/permission/validation messages and statuses",async()=>{
  for(const [code,status] of [["40001",409],["42501",403],["22023",400]] as const){const app=harness({error:{code,message:"Synthetic refusal; refresh and review."}});const response=await app.patch(payload);assert.equal(response.status,status);assert.equal(response.body.message,"Synthetic refusal; refresh and review.");assert.equal(app.calls.length,1)}
  const unavailable=harness({userLookupError:new Error("Synthetic directory unavailable")});assert.equal((await unavailable.patch(payload)).status,500);assert.equal(unavailable.calls.length,0)
  const removed=harness({readError:{code:"PGRST116",message:"Singular response required"}}),response=await removed.patch(payload);assert.equal(response.status,409);assert.match(response.body.message,/no longer available.*Refresh/);assert.equal(removed.calls.length,0)
})
test("fixture API refuses missing, foreign, status-mismatched or unjoined acknowledgements",async()=>{
  const acknowledgements:NonNullable<Options["ack"]>[]=[()=>null,()=>[],()=>({}),value=>({...value,id:"foreign"}),value=>({...value,fixture_status:"completed"}),value=>({...value,enquiry:null})]
  for(const ack of acknowledgements){
    const response=await harness({ack}).patch(payload);assert.equal(response.status,500);assert.match(response.body.message,/saved fixture response was unavailable.*Refresh/)
  }
})
test("fixture deletion uses the same exact version/status RPC without prewriting or source mutation",async()=>{
  const app=harness(),response=await app.patch({id:fixtureId,action:"delete",expectedUpdatedAt:expectedVersion,expectedStatus:"completed"})
  assert.equal(response.status,200);assert.equal(response.body.id,fixtureId);assert.equal(app.reads.length,0);assert.equal(app.lookups(),0);assert.equal(app.calls.length,1)
  assert.deepEqual(app.calls[0],{p_fixture_id:fixtureId,p_actor_username:actor.username,p_expected_updated_at:expectedVersion,p_expected_status:"completed",p_action:"delete",p_fixture:null,p_primary_supplier:null})
  assert.equal(app.headers[0]["x-bunker-audit-action"],"delete-fixture")
  const old=harness();assert.equal((await old.patch({id:fixtureId,action:"delete"})).status,400);assert.equal(old.calls.length,0)
  assert.equal((await harness({ack:()=>({id:"foreign"})}).patch({id:fixtureId,action:"delete",expectedUpdatedAt:expectedVersion,expectedStatus:"completed"})).status,500)
})
