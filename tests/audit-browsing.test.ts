import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { createAuditConsumers, supplierAuditRow } from "./fixtures/audit-log-consumers.mjs"
import {
  AuditBrowsingError, auditBrowseDigest, compareAuditBrowsePositions, loadAuditBrowseKeyring,
  openAuditBrowseCursor, sealAuditBrowseCursor, startAuditBrowseGeneration,
} from "../lib/auditBrowsingCursor"
import { createAuditBrowsingTransport } from "../lib/auditBrowsingTransport"
import { createClient } from "@supabase/supabase-js"
import { readAuditBrowsingBatch } from "../lib/auditBrowsingSource"

const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,"0")}`
function row(n: number, patch: Record<string, unknown> = {}) {
  const base = supplierAuditRow(id(n))
  return { ...base, occurred_at: new Date(Date.UTC(2026,9,20,1)-n*1000).toISOString(), actor_id:"reader@example.invalid", actor_name:"Synthetic Reader",
    record_pk:{key:"event-calendar"}, before_row:{key:"event-calendar"}, after_row:{key:"event-calendar"}, request_context:{pageId:"event-calendar"}, ...patch }
}
const key = (n: number) => Buffer.alloc(32,n).toString("base64url") // Explicitly synthetic test material only.
const ring = loadAuditBrowseKeyring(JSON.stringify({activeKid:"test-a",keys:[{kid:"test-a",keyBase64url:key(1)}]}))
const binding = {scope:"www" as const,viewerId:id(1),permissionDigest:auditBrowseDigest("view"),filterDigest:auditBrowseDigest("all"),pageSize:1}
async function allPages(app: ReturnType<typeof createAuditConsumers>, scope: string, filters: string) {
  const records: Array<Record<string, unknown>> = [], states: string[] = []
  let cursor: string | null = null
  const seen = new Set<string>()
  for(let attempt=0; attempt<100; attempt++) {
    const response = await app.request(scope, filters + (cursor ? `&cursor=${encodeURIComponent(cursor)}`:""))
    assert.equal(response.status,200,JSON.stringify(response.body)); const page=response.body
    assert.equal(page.totalMatches,null); assert.equal(page.pageInfo.consistency,"live-keyset")
    assert.equal(page.pageInfo.returnedMatches,page.logs.length)
    for(const record of page.logs) { assert.equal(seen.has(record.id),false);seen.add(record.id); records.push(record) }
    states.push(page.pageInfo.state)
    if(page.pageInfo.state==="exhausted") { assert.equal(page.pageInfo.hasMoreMatches,false);assert.equal(page.pageInfo.nextCursor,null);return {records,states} }
    assert.equal(page.pageInfo.hasMoreMatches,page.pageInfo.state==="more"?true:null)
    assert.notEqual(page.pageInfo.nextCursor,cursor); cursor=page.pageInfo.nextCursor
  }
  throw new Error("Traversal did not terminate")
}

test("all9 saved audit browsing omissions are repaired by actual routes and canonical presenters", async () => {
  let cases=0
  for(const scope of ["www","spc"]) {
    const pageId=scope==="www"?"event-calendar":"spc-suppliers", wrongPage=scope==="www"?"task-calendar":"spc-user-management"
    const wrongKey=scope==="www"?"task-calendar":"spc-permission-groups", rightKey=scope==="www"?"event-calendar":"spc-supplier-overrides"
    const rows=[...Array.from({length:201},(_,i)=>row(i+1,{actor_id:scope==="spc"?"spc:reader@example.invalid":"reader@example.invalid",record_pk:{key:wrongKey},after_row:{key:wrongKey},request_context:{pageId:wrongPage}})),row(202,{actor_id:scope==="spc"?"spc:reader@example.invalid":"reader@example.invalid",record_pk:{key:rightKey},after_row:{key:rightKey},request_context:{pageId}})]
    const app=createAuditConsumers({rows});const result=await allPages(app,scope,`?page=${pageId}&limit=100`)
    assert.deepEqual(result.records.map(record=>record.id),[id(202)]);cases++
    for(const actor of [scope==="spc"?"spc:reader@example.invalid":"reader@example.invalid","Synthetic Reader"]) {
      const record=row(1,{actor_id:scope==="spc"?"spc:READER@example.invalid":"READER@example.invalid",record_pk:{key:rightKey},after_row:{key:rightKey},request_context:{pageId}})
      const result=await allPages(createAuditConsumers({rows:[record]}),scope,`?actor=${encodeURIComponent(actor)}`)
      assert.deepEqual(result.records.map(record=>record.id),[id(1)]);cases++
    }
  }
  for(const limit of [100,150]) {
    const rows=[...Array.from({length:limit*2+1},(_,i)=>row(i+1,{table_name:"admin_role_defaults",operation:"INSERT",after_row:{role:"SYNTHETIC"+i},request_context:{pageId:"user-management"}})),row(limit*2+2,{table_name:"admin_users",operation:"INSERT",after_row:{username:"new@example.invalid"},request_context:{pageId:"user-management"}})]
    const result=await allPages(createAuditConsumers({rows}),"www",`?page=user-management&operation=INSERT&limit=${limit}`)
    assert.deepEqual(result.records.map(record=>record.id),[id(limit*2+2)]);cases++
  }
  const result=await allPages(createAuditConsumers({rows:Array.from({length:200},(_,i)=>row(i+1))}),"www","?page=event-calendar&limit=150")
  assert.equal(result.records.length,200);assert.deepEqual(result.states,["more","exhausted"]);cases++
  assert.equal(cases,9)
})

test("lower provider caps and repeated zero-match scan-pending remain resumable through exhaustion", async () => {
  const rows=[...Array.from({length:1201},(_,i)=>row(i+1,{request_context:{pageId:"task-calendar"}})),row(1202),row(1203)]
  const result=await allPages(createAuditConsumers({rows,providerCap:17}),"www","?page=event-calendar&limit=1")
  assert.deepEqual(result.records.map(record=>record.id),[id(1202),id(1203)])
  assert.ok(result.states.filter(state=>state==="scan-pending").length>10)
  assert.equal(result.states.at(-1),"exhausted")
})

test("scope, Unicode actor equality and mapped SPC names use final JavaScript predicates", async () => {
  for(const actor of ["\u00a0Mixed É\u00a0","e\u0301","İ","Σ","ß"]) {
    const result=await allPages(createAuditConsumers({rows:[row(1,{actor_id:"OTHER",actor_name:actor})]}),"www",`?actor=${encodeURIComponent(actor.trim().toLowerCase())}`)
    assert.equal(result.records.length,1)
  }
  const mapped=createAuditConsumers({rows:[row(1,{actor_id:"spc:READER@example.invalid",request_context:{pageId:"spc-suppliers"}})],users:[{username:"reader@example.invalid",displayName:"Mapped Reader"}]})
  assert.equal((await allPages(mapped,"spc","?actor=Mapped%20Reader")).records.length,1)
  const hidden=createAuditConsumers({rows:[row(1,{actor_id:"reader@example.invalid",request_context:{pageId:"spc-suppliers"}})]})
  assert.equal((await allPages(hidden,"www","?limit=1")).records.length,0)
  assert.equal((await allPages(hidden,"spc","?limit=1")).records.length,1)
})

test("required current actor names beyond a provider cap remain complete and mapping changes restart", async () => {
  const users=[...Array.from({length:30},(_,index)=>({username:`other-${index}@example.invalid`,displayName:`Other ${index}`})),{username:"reader@example.invalid",displayName:"Current Display Name"}]
  const rows=[row(1,{actor_id:"spc:reader@example.invalid",actor_name:"OLD RECORDED NAME",request_context:{pageId:"spc-suppliers"}})]
  const result=await allPages(createAuditConsumers({rows,users,providerCap:1}),"spc","?actor=Current%20Display%20Name")
  assert.equal(result.records.length,1);assert.equal(result.records[0].actorName,"Current Display Name")
  const ambiguous=createAuditConsumers({rows,users:[{username:"READER@example.invalid",displayName:"One"},{username:"reader@example.invalid",displayName:"Different"}]})
  assert.equal((await ambiguous.request("spc")).status,503)
})

test("full source preserves empty-after/null-before coalescing and parser source classification", async () => {
  for(const scope of ["www","spc"]) {
    const records=[row(1,{table_name:"parser_reports",after_row:{source:scope==="spc"?"spc":"www"},request_context:{}}),row(2,{table_name:"parser_reports",before_row:{source:"spc"},after_row:{},request_context:{}})]
    const result=await allPages(createAuditConsumers({rows:records}),scope,"?limit=100")
    assert.deepEqual(result.records.map(record=>record.id),scope==="spc"?[id(1)]:[id(1),id(2)])
  }
  const result=await allPages(createAuditConsumers({rows:[row(1,{table_name:"price_history",after_row:{port_id:7},request_context:{}})],ports:[{id:7,name:"Hong Kong"}]}),"www","?page=hongkong-price-history")
  assert.equal(result.records[0].pageId,"hongkong-price-history")
})

test("actual GET browsing includes every public attendance table and both Outlook template sources", async () => {
  const tables=["attendance_people","attendance_team_assignments","attendance_leave_entries","attendance_manual_overrides","attendance_work_mode_policies","attendance_work_mode_overrides","attendance_entitlements","attendance_monthly_adjustments","attendance_monthly_confirmations","attendance_reminder_dispatches"]
  const rows=tables.map((table_name,index)=>row(index+1,{table_name,before_row:null,after_row:{name:"SYNTHETIC",id:1},request_context:{}}))
  const attendance=await allPages(createAuditConsumers({rows,providerCap:2}),"www","?page=attendance-record&limit=2")
  assert.equal(attendance.records.length,tables.length);assert.ok(attendance.records.every(record=>record.pageId==="attendance-record"))
  const templates=[row(1,{table_name:"email_templates",after_row:{title:"Synthetic template"},request_context:{}}),row(2,{table_schema:"app",table_name:"outlook_template_insertion_attempts",operation:"INSERT",after_row:{templateTitle:"Synthetic insertion"},request_context:{}})]
  assert.equal((await allPages(createAuditConsumers({rows:templates,providerCap:1}),"www","?page=email-templates&limit=1")).records.length,2)
})

test("required Outlook reservation/terminal correlation is not silently truncated by a lower provider cap", async () => {
  const operationId=id(80), shared={table_schema:"app",table_name:"outlook_template_insertion_attempts",operation:"INSERT",request_context:{pageId:"email-templates"}}
  const terminal=row(1,{...shared,record_pk:{operationId,phase:"terminal"},after_row:{operationId,phase:"terminal",outcome:"inserted"}})
  const reservation=row(2,{...shared,record_pk:{operationId,phase:"reserved"},after_row:{operationId,phase:"reserved",templateTitle:"SYNTHETIC RESERVED TITLE"}})
  const result=await allPages(createAuditConsumers({rows:[terminal,reservation],providerCap:1}),"www","?page=email-templates&limit=1")
  assert.equal(result.records.length,2)
  assert.match(String(result.records[0].summary),/Inserted Outlook template "SYNTHETIC RESERVED TITLE"/)
  assert.match(String(result.records[1].summary),/completed as inserted/)
})

test("ordinary compact index and bounded raw full mode preserve summaries without crossing cursor modes", async () => {
  const rows = [row(1,{table_name:"email_templates",changed_fields:["title","body_html"],before_row:{id:1,title:"Before",body_html:"<p>private html</p>",body_text:"private text"},after_row:{id:1,title:"After",body_html:"<p>new private html</p>",body_text:"new private text"},request_context:{pageId:"email-templates"}}),row(2)]
  const index = await createAuditConsumers({rows}).request("www","?limit=1")
  assert.equal(index.status,200)
  assert.deepEqual(index.body.logs[0].details,[])
  assert.equal(Object.hasOwn(index.body.logs[0],"beforeRow"),false)
  const full = await createAuditConsumers({rows}).request("www","?limit=1&details=1&browse=1")
  assert.equal(full.status,200)
  assert.equal(full.body.logs.length,1)
  assert.equal(full.body.pageInfo.state,"scan-pending")
  assert.equal(full.body.logs[0].beforeRow.body_html,"<p>private html</p>")
  assert.equal(full.body.logs[0].afterRow.body_text,"new private text")
  assert.equal(full.body.logs[0].summary,index.body.logs[0].summary)
  assert.ok(full.body.logs[0].details.length>0)
  for (const [token,query] of [[index.body.pageInfo.nextCursor,"?limit=1&details=1&browse=1"],[full.body.pageInfo.nextCursor,"?limit=1"]]) {
    const app=createAuditConsumers({rows})
    assert.equal((await app.request("www",query+"&cursor="+encodeURIComponent(token))).status,400)
    assert.equal(app.reads(),0)
  }
  assert.equal((await allPages(createAuditConsumers({rows}),"www","?limit=100&details=1&browse=1")).records.length,2)
})

test("bare legacy full activity feeds exactly match the frozen production GET oracle", async () => {
  const oracle=readFileSync(new URL("./fixtures/admin-audit-legacy-route.txt",import.meta.url))
  assert.equal(createHash("sha256").update(oracle).digest("hex"),"145c9e8269181e2b19750c9080ae22c24dd7037553b95ab7ca0396490fdacc71")
  const rows=[...Array.from({length:250},(_,i)=>row(i+1,{table_name:"email_templates",after_row:{title:"Unrelated new template",body_html:"<p>private</p>"},request_context:{pageId:"email-templates"}})),
    ...Array.from({length:75},(_,i)=>row(1000+i,{table_name:"cc_companies",after_row:{id:id(1000+i),name:"CCINFO "+i},request_context:{pageId:"ccinfo"}})),
    ...Array.from({length:170},(_,i)=>row(2000+i,{table_name:"shared_addressbook_contacts",changed_fields:["primary_email"],before_row:{display_name:"Old contact",primary_email:"old@example.invalid"},after_row:{id:id(2000+i),display_name:"Contact "+i,primary_email:"new@example.invalid"},request_context:{pageId:"outlook-addressbook"}})),
    row(900,{table_name:"cc_companies",before_row:{name:"Before empty"},after_row:{},request_context:{pageId:"ccinfo"}}),
    row(901,{table_name:"cc_countries",before_row:null,after_row:{name:null,unknown:[false,0,"",null]},request_context:{pageId:"ccinfo"}})]
  const users=[{username:"filter@example.invalid",displayName:"Managed Filter User"}]
  const queries=["?table=ccinfo&limit=60&details=1","?table=outlookaddressbook&limit=160&details=1", "?page=outlook-addressbook&limit=3&details=1", "?table=outlooktemplates&limit=2&details=1", "?table=ccinfo&operation=UPDATE&limit=4&details=1", "?table=ccinfo&actor=READER@example.invalid&limit=4&details=1", "?page=all&operation=DELETE&details=1"]
  for(const providerCap of [1000,17])for(const query of queries){
    const current=await createAuditConsumers({rows,users,providerCap,keyring:""}).request("www",query)
    const expected=await createAuditConsumers({rows,users,providerCap,keyring:"",legacyOracle:true}).request("www",query)
    assert.equal(current.status,200,JSON.stringify(current.body))
    assert.deepEqual(current,expected,query+" providerCap="+providerCap)
    assert.equal(Object.hasOwn(current.body,"pageInfo"),false)
    if(providerCap===1000&&query.includes("table=ccinfo&limit=60"))assert.equal(current.body.logs.length,60)
    if(providerCap===1000&&query.includes("table=outlookaddressbook")){
      assert.equal(current.body.logs.length,150)
      assert.equal(current.body.logs.slice(0,80).length,80)
    }
  }
  const legacy=createAuditConsumers({rows,keyring:"",identityAvailable:false})
  assert.equal((await legacy.request("www","?table=ccinfo&limit=60&details=1")).status,200)
  const invalidCursor=createAuditConsumers({rows,keyring:"",identityAvailable:false})
  assert.equal((await invalidCursor.request("www","?table=ccinfo&details=1&cursor=unusable")).status,400)
  assert.equal(invalidCursor.reads(),0)
  const bounded=createAuditConsumers({rows,keyring:""})
  assert.equal((await bounded.request("www","?details=1&browse=1")).status,503)
  assert.equal(bounded.reads(),0)
  assert.equal((await createAuditConsumers({rows,keyring:"",identityAvailable:false}).request("www",`?id=${id(1)}&details=1&cursor=unusable`)).status,200)
})

test("auth is checked before any source read; key failure is503, detail/Undo behavior remains independent", async () => {
  for(const scope of ["www","spc"]) for(const options of [{signedIn:false},{permission:"none"}]) {
    const app=createAuditConsumers({rows:[row(1)],keyring:"",...options})
    assert.equal((await app.request(scope)).status,options.signedIn===false?401:403);assert.equal(app.reads(),0)
  }
  for (const scope of ["www", "spc"]) {
    const view = createAuditConsumers({ rows: [row(1)], role: "USER", permission: "view", keyring: "" })
    assert.equal((await view.request(scope, "", "POST", { action: "undo", id: id(1) })).status, 403)
    assert.equal(view.reads(), 0, "View-only Undo must be denied before any audit DB access")
    assert.equal(view.undoCalls(), 0)
  }
  const app=createAuditConsumers({rows:[row(1)],keyring:""})
  assert.equal((await app.request("www")).status,503);assert.equal(app.reads(),0)
  assert.equal((await app.request("www",`?id=${id(1)}`)).status,200)
  const ordinary=createAuditConsumers({rows:[row(1,{table_name:"phonebook_companies",before_row:{id:id(1),name:"BEFORE"},after_row:{id:id(1),name:"AFTER"},request_context:{pageId:"phonebook"}})],keyring:""})
  assert.equal((await ordinary.request("www","","POST",{action:"undo",id:id(1)})).status,200);assert.equal(ordinary.undoCalls(),1)
})

test("retired MFA history and investigation identifiers stay ADMIN-only in list and detail", async () => {
  const records=[row(1,{actor_id:"spc:reader@example.invalid",table_schema:"app",table_name:"spc_mfa_test_events",request_context:{pageId:"spc-mfa-test",sourceIp:"203.0.113.1",requestId:"private"}}),
    row(2,{actor_id:"spc:reader@example.invalid",table_schema:"app",table_name:"spc_user_management_events",request_context:{pageId:"spc-user-management",sourceIp:"203.0.113.1",requestId:"private"}})]
  for(const role of ["ADMIN","BUYER TRADER"]) {
    const app=createAuditConsumers({rows:records,role,permission:"view"})
    const result=await allPages(app,"spc","?limit=100")
    assert.deepEqual(result.records.map(record=>record.id),role==="ADMIN"?[id(1),id(2)]:[id(2)])
    assert.equal(result.records.at(-1)?.sourceIp,role==="ADMIN"?"203.0.113.1":null)
    const detail=await app.request("spc",`?id=${id(1)}`);assert.equal(detail.status,role==="ADMIN"?200:404)
    const management=await app.request("spc",`?id=${id(2)}`);assert.equal(management.body.log.sourceIp,role==="ADMIN"?"203.0.113.1":null)
  }
})

test("cursor rejects copied scope/viewer/permission/filter, tampering, expiry and mapping changes", async () => {
  const rows=[row(1),row(2)], first=await createAuditConsumers({rows}).request("www","?limit=1")
  const token=first.body.pageInfo.nextCursor;assert.ok(token)
  for(const [options,scope,query] of [[{},"spc","?limit=1"],[{viewerId:id(99)},"www","?limit=1"],[{role:"VIEWER",permission:"view"},"www","?limit=1"],[{},"www","?limit=2"],[{},"www","?limit=1&actor=Other"],[{ports:[{id:1,name:"Changed map"}]},"www","?limit=1"]] as const) {
    const app=createAuditConsumers({rows,...options});assert.equal((await app.request(scope,query+"&cursor="+encodeURIComponent(token))).status,400)
  }
  const malformed=createAuditConsumers({rows});assert.equal((await malformed.request("www","?limit=1&cursor="+encodeURIComponent(token+"x"))).status,400);assert.equal(malformed.reads(),0)
  const generation=startAuditBrowseGeneration(auditBrowseDigest("map"),1000000)
  generation.position=generation.watermark={occurredAt:"2026-10-20T01:00:00.123456+00:00",id:id(1)}
  const encrypted=sealAuditBrowseCursor(generation,binding,ring,1000001)
  assert.equal(encrypted.includes(id(1)),false);assert.equal(Buffer.from(encrypted.split(".")[3],"base64url").includes(Buffer.from(generation.position.occurredAt)),false)
  assert.deepEqual(openAuditBrowseCursor(encrypted,binding,ring,1000002),generation)
  assert.throws(()=>openAuditBrowseCursor(encrypted,binding,ring,1900000),error=>error instanceof AuditBrowsingError&&error.status===400)
  const rotated=loadAuditBrowseKeyring(JSON.stringify({activeKid:"test-b",keys:[{kid:"test-a",keyBase64url:key(1)},{kid:"test-b",keyBase64url:key(2)}]}))
  const renewed=sealAuditBrowseCursor(openAuditBrowseCursor(encrypted,binding,rotated,1000002),binding,rotated,1000003)
  assert.equal(renewed.split(".")[1],"test-b");assert.equal(openAuditBrowseCursor(renewed,binding,rotated,1000004).expiresAt,generation.expiresAt)
  assert.throws(()=>loadAuditBrowseKeyring(JSON.stringify({activeKid:"test",keys:[{kid:"test",keyBase64url:"bad"}]})),error=>error instanceof AuditBrowsingError&&error.status===503)
  assert.throws(()=>loadAuditBrowseKeyring(JSON.stringify({activeKid:"test-b",keys:[{kid:"test-a",keyBase64url:key(1)},{kid:"test-b",keyBase64url:key(1)}]})),error=>error instanceof AuditBrowsingError&&error.status===503)
})

test("actual SDK constructs exact-count strict multi-key continuation, keeps microseconds and detects contradictory cap responses", async () => {
  const position={occurredAt:"2026-10-20T01:00:00.123456+00:00",id:id(8)}
  const source=row(9,{occurred_at:"2026-10-20T01:00:00.123455+00:00"})
  let rawUrl: URL | undefined, prefer=""
  const client=createClient("https://synthetic.invalid","synthetic",{global:{fetch:async(input,init)=>{
    rawUrl=new URL(String(input));prefer=new Headers(init?.headers).get("prefer")||""
    return new Response(JSON.stringify([source]),{headers:{"Content-Type":"application/json","Content-Range":"0-0/2"},status:206})
  }}})
  const result=await readAuditBrowsingBatch(client,position,250)
  assert.equal(result.exhausted,false);assert.equal(result.records[0].occurredAt,source.occurred_at)
  assert.equal(rawUrl?.searchParams.get("order"),"occurred_at.desc,id.desc");assert.match(prefer,/count=exact/)
  assert.ok(rawUrl?.searchParams.getAll("or").some(value=>value.includes(position.occurredAt)&&value.includes("id.lt."+position.id)))
  assert.equal(compareAuditBrowsePositions({occurredAt:"2026-10-20T09:00:00.123456+08:00",id:id(8)},position),0)
  const contradictory=createClient("https://synthetic.invalid","synthetic",{global:{fetch:async()=>new Response("[]",{headers:{"Content-Type":"application/json","Content-Range":"*/2"}})}})
  await assert.rejects(readAuditBrowsingBatch(contradictory,null,250),error=>error instanceof AuditBrowsingError&&error.status===503)
})

test("stream-capped fetch rejects bytes before SDK JSON allocation and fences stalled/ignored-abort work", async () => {
  let cancelled=false, jsonCalled=false
  const provider=new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(8));controller.enqueue(new Uint8Array(8))},cancel(){cancelled=true}}))
  provider.json=async()=>{jsonCalled=true;return []}
  const transport=createAuditBrowsingTransport(undefined,{responseBytes:10,totalBytes:100,fetcher:async()=>provider})
  try { await assert.rejects(transport.fetch("https://synthetic.invalid"),error=>error instanceof AuditBrowsingError&&error.status===503) }
  finally {transport.finish()}
  assert.equal(cancelled,true);assert.equal(jsonCalled,false)
  const stalled=createAuditBrowsingTransport(undefined,{deadlineMs:10,fetcher:async()=>new Response(new ReadableStream({start(){}}))})
  try{await assert.rejects(stalled.fetch("https://synthetic.invalid"))}finally{stalled.finish()}
  const ignored=createAuditBrowsingTransport(undefined,{deadlineMs:10,fetcher:()=>new Promise(()=>{})})
  try{await assert.rejects(ignored.fetch("https://synthetic.invalid"))}finally{ignored.finish()}
})
