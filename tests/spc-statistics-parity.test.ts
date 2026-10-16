import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { statisticsRuntime,statisticsReadClient,statisticsData,statisticsWire } from "./fixtures/spc-statistics-api.mjs"

const legacy=readFileSync(new URL("./fixtures/spc-statistics-legacy.ts.txt",import.meta.url),"utf8")
test("legacy statistics oracle is exact pinned live497a source, not current Git HEAD",()=>{assert.equal(createHash("sha256").update(legacy).digest("hex"),"a99526956532837718f69e971ad9050bda4f5689dde3a77ca24ed0c18338a6bd")})
test("pure reference projection exactly matches existing canonical reference loader",async()=>{
  const data=statisticsData(1),buyer=data.users[0]
  data.users.push({...buyer,id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",username:"inactive@example.test",display_name:"  Inactive Display  ",role:"supplier_trader",is_active:false})
  const stores=[null,{}, {userRoles:"bad",userProfiles:"bad"},
    {userRoles:[null,{userId:buyer.id,username:"other@example.test",role:"CUSTOM ROLE"},{userId:"unrelated",username:buyer.username,role:"SUPPLIER TRADER"},{userId:buyer.id,username:"other@example.test",role:"ADMIN"}],userProfiles:[null,{userId:buyer.id,username:"other@example.test",office:" france "},{userId:"unrelated",username:buyer.username,office:" singapore "},{userId:buyer.id,username:"other@example.test",office:" hong   kong "}]},
    {userRoles:[{userId:buyer.id,username:buyer.username,role:7}],userProfiles:[{userId:buyer.id,username:buyer.username,office:7},{userId:"bad"}]},
  ]
  for(const assignments of stores){const client=statisticsReadClient({...data,roles:assignments?.userRoles||[],profiles:assignments?.userProfiles||[]},undefined);const runtime=statisticsRuntime({client});const users=runtime.load("@/lib/spcUsers");const expected=await users.listSpcUserReferenceOptions();assert.deepEqual(users.projectSpcUserReferenceOptions(data.users,assignments),expected)}
})
test("all existing financial/import/native/year/90-day/grade parsing semantics match pinned legacy",async()=>{
  const data=statisticsData(9)
  Object.assign(data.fixtures[0],{hsfo:"100-200",vlsfo:"80 CST MAX 50",lsmgo:"25.5",supplier_name:"HSFO: BP / VLSFO: SENTEK / LSMGO: VITOL"})
  Object.assign(data.fixtures[1],{hsfo:"1,000",vlsfo:"120 CST MAX 30-50",lsmgo:null,supplier_name:"UNKNOWN SUPPLIER"})
  data.fixtures[2].enquiry!.enquiry_number="SPCIMP-TEST";data.enquiries[2].enquiry_number="SPCIMP-TEST"
  data.fixtures[3].fixture_date="2025-12-31"
  data.fixtures[4].created_at="2026-07-18T15:59:59.999Z"
  data.enquiries[4].created_at="2026-07-18T15:59:59.999Z"
  data.fixtures[5].created_at="2026-10-16T15:59:59.001Z"
  data.enquiries[5].created_at="2026-10-16T15:59:59.001Z"
  Object.assign(data.fixtures[6],{hsfo:null,vlsfo:null,lsmgo:null,supplier_name:null})
  data.buyerEnquiryNumbers=data.buyerEnquiryNumbers.filter(number=>number!==data.enquiries[7].enquiry_number)
  data.users[0].is_active=false
  for(const year of ["2026","2025","2000","2100"]){
    const legacyClient=statisticsReadClient(data,undefined),old=statisticsRuntime({client:legacyClient,legacySource:legacy})
    const client=statisticsReadClient(data,async(_name:string,args:Record<string,unknown>)=>{const filtered=structuredClone(data);filtered.fixtures=filtered.fixtures.filter(f=>f.fixture_date>=`${args.p_first_fixture_year}-01-01`&&f.fixture_date<=`${args.p_last_fixture_year}-12-31`);filtered.enquiries=filtered.enquiries.filter(e=>e.created_at>=String(args.p_window_start)&&e.created_at<=String(args.p_window_end));return {data:statisticsWire(filtered,args),error:null}})
    const current=statisticsRuntime({client});const expected=await old.get({year}),actual=await current.get({year})
    assert.equal(expected.status,200);assert.equal(actual.status,200);assert.deepEqual(actual.body,expected.body)
  }
})
