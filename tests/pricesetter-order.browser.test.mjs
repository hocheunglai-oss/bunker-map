// Real React page -> real API/audit constructor -> exact migration in isolated
// PostgreSQL (PGlite). Only session and network adapters are synthetic. No live
// credentials, external services, or personal browser access.
import assert from "node:assert/strict"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { build, transformSync } from "esbuild"
import * as mutation from "../lib/priceSetterMutation.ts"
import * as history from "../lib/priceHistoryRecords.ts"
import * as settings from "../lib/priceSetterSettings.ts"
import * as order from "../lib/priceSetterOrder.ts"
import * as inventory from "../lib/priceSetterInventory.ts"
import * as creationRecovery from "../lib/priceSetterCreationRecovery.ts"
import * as priceRequest from "../lib/priceSetterRequest.ts"
import * as adminPages from "../lib/adminPages.ts"
import { setup, basis, linked, chained, other } from "./fixtures/price-setter-sql.mjs"
import { reportPublicationBaseline } from "./fixtures/report-publication-baseline.cjs"

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const divider = "55555555-5555-4555-8555-555555555555", original = [basis, linked, chained, other, divider]
const baseline = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.split("=")[1]
const renameChecks = process.argv.includes("--rename")
const indicatorBaseline = process.argv.includes("--indicator-baseline")
if (baseline && !/^[a-f0-9]{40}$/i.test(baseline)) throw Error("Use an exact baseline commit")
const app = await setup({ creationCutover: true }), requests = [], directWrites = [], auditHeaders = [], failures = []
let mode = "success", configMode = "success", release, browser, server

async function savedIds() { return (await app.db.query("select id from ports order by display_order asc nulls last,id")).rows.map(row => row.id) }
const env = { NEXT_PUBLIC_SUPABASE_URL: "https://example.test", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-only" }
const modules = {
  "next/server": { NextResponse: { json: Response.json.bind(Response) } },
  "@/lib/priceSetterMutation": mutation, "@/lib/priceHistoryRecords": history,
  "@/lib/priceSetterSettings": settings, "@/lib/priceSetterOrder": order, "@/lib/adminPages": adminPages,
  "@/lib/priceSetterInventory": inventory,
  "@/lib/priceSetterCreationRecovery": creationRecovery,
  "@/lib/priceSetterRequest": priceRequest,
  "@/lib/adminAuth": { async requireAdminPagePermissionForRequest(request, page, access) { assert.equal(page,"pricesetter");assert.equal(access,request.method==="GET"&&!new URL(request.url).pathname.endsWith("/creation")?"view":"edit");return {username:"SYNTHETIC",displayName:"Synthetic Editor",role:"BT",adminUserId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"} } },
  "@supabase/supabase-js": { createClient(url,key,options) {
    assert.equal(url,env.NEXT_PUBLIC_SUPABASE_URL);assert.equal(key,env.SUPABASE_SERVICE_ROLE_KEY);auditHeaders.push(options.global.headers)
    return {async rpc(name,args) {
      const query = name === "reorder_price_setter_ports"
        ? ["select public.reorder_price_setter_ports($1::jsonb,$2::uuid[]) as result",[JSON.stringify(args.p_expected),args.p_order]]
        : name === "read_price_setter_inventory" ? ["select public.read_price_setter_inventory() as result",[]]
        : name === "read_price_setter_creation_state" ? ["select public.read_price_setter_creation_state($1::uuid) as result",[args.p_actor_id]]
        : name === "save_price_setter_port"
          ? ["select public.save_price_setter_port($1::uuid,$2::jsonb,$3::jsonb,$4::timestamptz) as result", [args.p_port_id,JSON.stringify(args.p_expected),JSON.stringify(args.p_changes),args.p_recorded_at]]
          : name === "save_price_setter_fallback"
            ? ["select public.save_price_setter_fallback($1,$2,$3) as result", [args.p_key,args.p_expected_value,args.p_value]] : null
      assert.ok(query, `Unexpected RPC ${name}`)
      try {return {data:(await app.db.query(...query)).rows[0].result,error:null}}
      catch(error){return {data:null,error:{code:error.code,message:error.message}}}
    }}
  } },
}
function load(relative) {
  const loaded={exports:{}}, code=transformSync(readFileSync(path.join(root,relative),"utf8"),{loader:"ts",format:"cjs",target:"node24"}).code
  new Function("require","module","exports","process",code)(name=>{assert.ok(Object.hasOwn(modules,name),name);return modules[name]},loaded,loaded.exports,{env})
  return loaded.exports
}
modules["@/lib/adminAudit"] = load("lib/adminAudit.ts")
const api = load("app/api/admin/prices/route.ts")
const creationApi = load("app/api/admin/prices/creation/route.ts")
const mocks = `
  export function useSimpleAdminAuth(){return {loading:false,authenticated:true,role:"BT",permissions:{pricesetter:new URLSearchParams(location.search).get("access")||"edit"}}}
  export function useIsMobile(){return false}
  export const supabase={from(table){let single=false,action="read",payload,filters=[];const q={
    select(){return q},order(){return q},eq(k,v){filters.push([k,v]);return q},in(){return q},maybeSingle(){single=true;return q},single(){single=true;return q},
    update(v){action="update";payload=v;return q},upsert(v){action="upsert";payload=v;return q},
    then(resolve,reject){return (async()=>{
      if(action!=="read")return (await fetch("/fixture/direct-write",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({table,action,payload,filters})})).json();
      if(table==="ports")return (await fetch("/fixture/ports")).json();
      if(table==="remarks"&&single)return (await fetch("/fixture/fallbacks")).json();
      return {data:single?null:[],error:null};
    })().then(resolve,reject)}
  };return q}};
`
try {
  const bundle=await build({absWorkingDir:root,stdin:{contents:'import React from "react";import {createRoot} from "react-dom/client";import Page from "./app/admin/pricesetter/page";createRoot(document.getElementById("root")).render(<Page/>);',resolveDir:root,loader:"tsx"},bundle:true,write:false,platform:"browser",format:"iife",jsx:"automatic",define:{"process.env.NODE_ENV":'"development"'},plugins:[{name:"isolated-adapters",setup(builder){
    builder.onResolve({filter:/^@\/lib\/(supabase|useSimpleAdminAuth|useIsMobile)$/},()=>({path:"mocks",namespace:"fixture"}));builder.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:mocks,loader:"js"}));
    if(baseline)builder.onLoad({filter:/app\/admin\/pricesetter\/page\.tsx$/},()=>({contents:execFileSync("git",["show",baseline+":app/admin/pricesetter/page.tsx"],{cwd:root,encoding:"utf8"}),loader:"tsx"}));
    if(baseline)builder.onLoad({filter:/lib\/reportFallbacks\.ts$/},()=>({contents:execFileSync("git",["show",baseline+":lib/reportFallbacks.ts"],{cwd:root,encoding:"utf8"}),loader:"ts"}));
  }}]})
  server=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,"http://localhost")
      if(url.pathname==="/fixture.js"){res.setHeader("Content-Type","text/javascript");return res.end(bundle.outputFiles[0].contents)}
      res.setHeader("Content-Type","application/json")
      if(url.pathname==="/fixture/ports")return res.end(JSON.stringify({data:(await app.db.query("select to_jsonb(p) as port from ports p order by display_order asc nulls last,id")).rows.map(row=>row.port),error:null}))
      if(url.pathname==="/fixture/fallbacks")return res.end(JSON.stringify(configMode==="error"?{data:null,error:{message:"Synthetic read failure"}}:{data:(await app.db.query("select content from remarks where id=105")).rows[0]||null,error:null}))
      if(url.pathname==="/api/admin/prices/creation") {assert.equal(req.method,"GET");const response=await creationApi.GET(new Request("https://example.test/api/admin/prices/creation"));res.statusCode=response.status;return res.end(await response.text())}
      if(url.pathname==="/api/admin/prices"||url.pathname==="/fixture/direct-write"){
        if(req.method==="GET") {const response=await api.GET(new Request("https://example.test/api/admin/prices"));res.statusCode=response.status;return res.end(await response.text())}
        const chunks=[];for await(const chunk of req)chunks.push(chunk)
        const body=Buffer.concat(chunks).toString(),input=JSON.parse(body)
        if(url.pathname==="/fixture/direct-write"){directWrites.push(input);return res.end(JSON.stringify({data:null,error:{message:"Injected write failure"}}))}
        assert.ok(["PATCH","POST"].includes(req.method));requests.push(input)
        const activeMode=mode
        if(activeMode==="error"){res.statusCode=503;return res.end(JSON.stringify({message:"The save could not be confirmed. Your draft is still here."}))}
        if(activeMode==="disconnect")return res.destroy()
        if(activeMode==="defer"||activeMode==="timeout")await new Promise(resolve=>{release=resolve})
        const response=await api[req.method](new Request("https://example.test/api/admin/prices",{method:req.method,headers:{"Content-Type":"application/json",Referer:"https://example.test/admin/user-management"},body}))
        let text=await response.text();res.statusCode=response.status
        if(activeMode==="malformed")text="{bad JSON"
        if(activeMode==="partial")text=JSON.stringify({replayed:false,order:JSON.parse(text).order?.slice(1)})
        if(!res.destroyed)res.end(text)
        return
      }
      res.setHeader("Content-Type","text/html");res.end('<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>')
    }catch(error){failures.push(String(error));res.statusCode=500;res.end('{}')}
  })
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve))
  const origin=`http://127.0.0.1:${server.address().port}`, {chromium}=require("playwright")
  browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE_PATH?{executablePath:process.env.CHROME_EXECUTABLE_PATH}:{})})
  const context=await browser.newContext({viewport:{width:1400,height:900}}),page=await context.newPage(),errors=[],blocked=[]
  page.setDefaultTimeout(8000);page.on("pageerror",error=>errors.push(error.message))
  await page.clock.install({time:new Date("2026-10-09T03:00:00Z")})
  await context.route("**/*",route=>{const url=new URL(route.request().url());if(url.origin===origin){if(url.pathname==="/api/admin/report-publication"){assert.equal(route.request().method(),"GET");return route.fulfill({json:reportPublicationBaseline(url.searchParams.get("report"))})}return route.continue()}blocked.push(route.request().url());return route.abort()})
  const rows=()=>page.locator('table:not([aria-label]) tbody tr'),row=name=>rows().filter({has:page.locator(`input[value="${name}"]`)})
  async function names(){return rows().locator('input').evaluateAll(inputs=>inputs.filter(input=>!input.placeholder).map(input=>input.value))}
  async function hover(transfer,to,edge="before"){
    const bounds=await row(to).boundingBox()
    await row(to).dispatchEvent("dragover",{dataTransfer:transfer,clientY:bounds.y+(edge==="before"?2:bounds.height-2)})
    return bounds
  }
  async function start(from){const transfer=await page.evaluateHandle(()=>new DataTransfer());await row(from).dispatchEvent("dragstart",{dataTransfer:transfer});return transfer}
  async function cancel(from,transfer){await row(from).dispatchEvent("dragend",{dataTransfer:transfer});await transfer.dispose()}
  async function indicated(to,edge="before"){await page.getByRole("status").filter({hasText:`Drop ${edge} ${to}`}).waitFor()}
  async function move(from,to,edge="before"){
    const canDrag=await row(from).getAttribute("draggable")==="true", transfer=await start(from), count=requests.length
    const bounds=await hover(transfer,to,edge)
    if(canDrag&&!baseline){
      await indicated(to,edge)
      assert.equal(await row(to).getAttribute("data-drop-position"),edge,"the insertion marker must be rendered before release")
      assert.match(await row(to).locator("td").first().evaluate(cell=>getComputedStyle(cell).boxShadow),edge==="before"?/0px 3px/:/0px -3px/)
      assert.deepEqual(await row(to).boundingBox(),bounds,"showing the marker must not shift the destination under the cursor")
      assert.equal(requests.length,count,"hover never writes")
    }
    await row(to).dispatchEvent("drop",{dataTransfer:transfer})
    await cancel(from,transfer)
  }
  async function reset(access="edit"){
    mode="success";configMode="success";requests.length=0;directWrites.length=0;release=undefined
    await app.db.exec(`reset role; drop trigger if exists synthetic_order_failure on ports; drop function if exists synthetic_order_failure(); update ports set name=case id when '${basis}' then 'Singapore' when '${linked}' then 'Dalian' when '${chained}' then 'Tokyo' when '${other}' then 'Bayuquan' else 'Group' end,hsfo_formula=null,vlsfo_formula=null,mgo_formula=null,display_order=case id when '${basis}' then 1 when '${linked}' then 2 when '${chained}' then 3 when '${other}' then 4 else 5 end; insert into ports(id,name,type,display_order) values('${divider}','Group','divider',5) on conflict(id) do nothing; set role service_role;`)
    await app.db.exec("delete from remarks; delete from price_history")
    if(renameChecks)await app.db.exec(`update ports set hsfo=null where id='${basis}'; insert into remarks(id,content) values(105,'{"singapore::hsfo":"NA","dalian::mgo":"SE"}')`)
    await page.goto(origin+"?access="+access);await row("Singapore").waitFor();await page.waitForFunction(()=>!document.body.innerText.includes("Loading report settings…"))
  }
  async function north(){await page.getByRole("button",{name:"China North",exact:true}).click();assert.equal(await rows().count(),2)}
  async function saved(){await page.getByRole("status").filter({hasText:/^Port order saved\.$/}).waitFor()}
  await reset()
  if(indicatorBaseline){
    const transfer=await page.evaluateHandle(()=>new DataTransfer())
    await row("Bayuquan").dispatchEvent("dragstart",{dataTransfer:transfer})
    const bounds=await row("Dalian").boundingBox()
    await row("Dalian").dispatchEvent("dragover",{dataTransfer:transfer,clientY:bounds.y+2})
    assert.equal(await row("Dalian").getAttribute("data-drop-position"),null)
    assert.equal(await page.getByRole("status").filter({hasText:/Drop (before|after)/}).count(),0)
    assert.deepEqual(requests,[])
    await row("Bayuquan").dispatchEvent("dragend",{dataTransfer:transfer})
    await transfer.dispose()
    console.log("REPRODUCED: dragging over a destination shows neither a before/after insertion line nor destination text before drop")
  }else if(renameChecks){
    const target=()=>rows().first(), nameInput=()=>target().locator('input:not([placeholder])').first()
    const save=()=>target().getByRole("button",{name:"Save",exact:true})
    const publish=()=>page.getByRole("button",{name:"Publish Taiwan",exact:true})
    const confirmed=()=>target().getByRole("button",{name:"Saved",exact:true})
    const override=label=>page.getByRole("combobox",{name:label+" HSFO override",exact:true})
    const map=async()=>JSON.parse((await app.db.query("select content from remarks where id=105")).rows[0].content)
    async function rename(name){await nameInput().fill(name);await save().click()}
    async function configReady(){await page.waitForFunction(()=>!document.body.innerText.includes("Loading report settings…"))}
    await row("Dalian").getByPlaceholder("price").last().fill("777")
    mode="defer";await rename("New Singapore");await target().getByRole("button",{name:"Saving...",exact:true}).waitFor()
    for(let attempt=0;attempt<100&&!release;attempt++)await new Promise(resolve=>setTimeout(resolve,10))
    assert.equal(typeof release,"function")
    assert.equal((await app.row(basis)).name,"Singapore");assert.equal(await publish().isDisabled(),true)
    assert.equal(await override("New Singapore").isDisabled(),true)
    release();release=undefined;await confirmed().waitFor();await configReady()
    assert.deepEqual(await map(),{"new singapore::hsfo":"NA","dalian::mgo":"SE"})
    assert.equal(await override("New Singapore").inputValue(),"NA")
    assert.equal(await row("Dalian").getByPlaceholder("price").last().inputValue(),"777")
    assert.equal(auditHeaders.at(-1)["x-bunker-admin-page-id"],"pricesetter")
    console.log("PASS: browser rename -> actual endpoint/audit -> atomic SQL override move -> fresh UI config, unrelated draft retained")

    await reset();mode="malformed";await rename("New Singapore")
    await target().getByRole("alert").waitFor();await configReady()
    assert.equal((await app.row(basis)).name,"New Singapore");assert.equal(await confirmed().count(),0)
    assert.equal(await publish().isDisabled(),true)
    assert.deepEqual(directWrites,[],"an unconfirmed rename cannot publish a report")
    assert.equal(await nameInput().inputValue(),"New Singapore")
    mode="success";await save().click();await confirmed().waitFor();await configReady()
    assert.deepEqual(await map(),{"new singapore::hsfo":"NA","dalian::mgo":"SE"})

    await reset();configMode="error";await rename("New Singapore");await confirmed().waitFor()
    await page.getByRole("button",{name:"Try loading report settings again",exact:true}).waitFor()
    assert.equal(await publish().isDisabled(),true);assert.equal(await override("New Singapore").isDisabled(),true)
    configMode="success";await page.getByRole("button",{name:"Try loading report settings again",exact:true}).click()
    await page.waitForFunction(()=>document.querySelector('[aria-label="New Singapore HSFO override"]')?.value==="NA")
    assert.equal(await override("New Singapore").inputValue(),"NA")

    await reset();mode="error";await override("Singapore").selectOption("SE")
    await page.getByRole("button",{name:"Retry override save",exact:true}).waitFor()
    await rename("New Singapore");await target().getByRole("alert").waitFor()
    assert.equal(requests.length,1,"unresolved override draft blocks the rename before a POST")
    assert.equal((await app.row(basis)).name,"Singapore")
    await nameInput().fill("Singapore");assert.equal(await override("Singapore").inputValue(),"SE")
    console.log("PASS: lost-response rename retry reconciles SQL, config read failure pauses publishing, unresolved override drafts block rename without being discarded")
    assert.deepEqual(directWrites,[]);assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);assert.deepEqual(failures,[])
  }else if(baseline){
    await north()
    await move("Bayuquan","Dalian");await page.waitForTimeout(100)
    assert.equal(directWrites.length,5);assert.equal(directWrites[0].filters[0][1],linked)
    assert.deepEqual(await savedIds(),original)
    await page.getByRole("button",{name:"All",exact:true}).last().click()
    assert.equal((await names())[0],"Dalian")
    console.log("REPRODUCED: filtered drag moves the wrong full-list row and displays an unsaved order despite every write failing")
  }else{
    for(const [from,to,edge,wanted] of [
      ["Singapore","Tokyo","before",[linked,basis,chained,other,divider]],
      ["Singapore","Tokyo","after",[linked,chained,basis,other,divider]],
      ["Bayuquan","Dalian","after",[basis,linked,other,chained,divider]],
      ["Group","Singapore","before",[divider,basis,linked,chained,other]],
      ["Singapore","Group","after",[linked,chained,other,divider,basis]],
    ]){
      await reset();await move(from,to,edge);await saved();assert.deepEqual(await savedIds(),wanted)
      assert.equal(await page.locator('[data-drop-position]').count(),0)
      assert.equal(requests.length,1)
      assert.deepEqual(requests[0].order,wanted,"the saved request must use the exact indicated side")
    }
    await reset();await north();await move("Dalian","Bayuquan","after");await saved()
    assert.deepEqual(await savedIds(),[basis,other,chained,linked,divider],"filtered after-insertion preserves hidden slots")
    console.log("PASS: before/after markers precede all writes, stable row geometry, upward/downward/end/divider/filtered insertion matches the actual SQL order")

    await reset();await north();await row("Dalian").locator("input").first().fill("D")
    assert.deepEqual(await names(),["D","Bayuquan"],"saved-name filtering retains the draft in its original visible slot")
    await move("Bayuquan","D","before");await saved()
    assert.deepEqual(await savedIds(),[basis,other,chained,linked,divider],"a draft rename cannot change filtered insertion or hidden slots")
    assert.equal(await row("D").locator("input").first().inputValue(),"D")
    assert.equal((await app.row(linked)).name,"Dalian","reordering must not save the name draft")
    console.log("PASS: filtered insertion also preserves hidden slots and unsaved names when a target's draft no longer matches the market filter")

    await reset()
    let transfer=await start("Bayuquan")
    await hover(transfer,"Dalian","before");await indicated("Dalian")
    assert.equal(await row("Dalian").getAttribute("data-drop-position"),"before")
    await hover(transfer,"Dalian","after");await indicated("Dalian","after")
    assert.equal(await row("Dalian").getAttribute("data-drop-position"),"after")
    await row("Dalian").dispatchEvent("drop",{dataTransfer:transfer});await cancel("Bayuquan",transfer);await saved()
    assert.deepEqual(await savedIds(),[basis,linked,other,chained,divider],"the last visible edge, not the drag direction, decides the result")

    await reset();transfer=await start("Bayuquan");await hover(transfer,"Dalian");await indicated("Dalian")
    await row("Dalian").dispatchEvent("dragleave",{dataTransfer:transfer,relatedTarget:await row("Dalian").locator("input").first().elementHandle()})
    assert.equal(await row("Dalian").getAttribute("data-drop-position"),"before","entering a child does not remove the marker")
    await row("Dalian").dispatchEvent("dragleave",{dataTransfer:transfer})
    assert.equal(await page.locator('[data-drop-position]').count(),0)
    await row("Dalian").dispatchEvent("drop",{dataTransfer:transfer});await cancel("Bayuquan",transfer)
    assert.deepEqual(requests,[],"a destination left before drop is no longer authorized")
    transfer=await start("Bayuquan");await hover(transfer,"Dalian");await indicated("Dalian");await cancel("Bayuquan",transfer)
    assert.equal(await page.locator('[data-drop-position]').count(),0);assert.deepEqual(requests,[])

    transfer=await start("Bayuquan");await row("Dalian").dispatchEvent("drop",{dataTransfer:transfer});await cancel("Bayuquan",transfer)
    assert.deepEqual(requests,[],"no drop without a displayed preview")
    await page.evaluate(()=>{
      const inputs=[...document.querySelectorAll('table[data-fcuno-port-order] input')]
      const source=inputs.find(input=>input.value==="Bayuquan").closest("tr"),target=inputs.find(input=>input.value==="Dalian").closest("tr")
      const dataTransfer=new DataTransfer()
      source.dispatchEvent(new DragEvent("dragstart",{bubbles:true,cancelable:true,dataTransfer}))
      target.dispatchEvent(new DragEvent("dragover",{bubbles:true,cancelable:true,dataTransfer,clientY:target.getBoundingClientRect().top+2}))
      // React has not committed the requested marker during this single event
      // turn. A calculated-but-not-rendered destination cannot authorize save.
      if(target.dataset.dropPosition)throw Error("Unexpected committed marker in the same event turn")
      target.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer}))
      source.dispatchEvent(new DragEvent("dragend",{bubbles:true,cancelable:true,dataTransfer}))
    })
    assert.deepEqual(requests,[],"a same-turn drop before the line renders cannot save")
    transfer=await page.evaluateHandle(id=>{const t=new DataTransfer();t.setData("application/x-fcuno-port-id",id);return t},other)
    await hover(transfer,"Dalian");await row("Dalian").dispatchEvent("drop",{dataTransfer:transfer});await transfer.dispose()
    assert.deepEqual(requests,[],"external/forged drag cannot reuse a previous local gesture")
    transfer=await start("Bayuquan");await hover(transfer,"Dalian");await indicated("Dalian")
    await transfer.evaluate((t,id)=>t.setData("application/x-fcuno-port-id",id),basis)
    await row("Dalian").dispatchEvent("drop",{dataTransfer:transfer});await cancel("Bayuquan",transfer)
    assert.deepEqual(requests,[],"changed transfer identity cannot use the indicated destination")

    transfer=await start("Bayuquan");await hover(transfer,"Dalian");await indicated("Dalian");await north()
    assert.equal(await page.locator('[data-drop-position]').count(),0)
    await row("Dalian").dispatchEvent("drop",{dataTransfer:transfer});await cancel("Bayuquan",transfer)
    assert.deepEqual(requests,[],"a changed filter invalidates the gesture even when both rows remain visible")
    await reset();transfer=await start("Dalian");await hover(transfer,"Tokyo","before")
    assert.equal(await page.locator('[data-drop-position]').count(),0)
    await row("Tokyo").dispatchEvent("drop",{dataTransfer:transfer});await cancel("Dalian",transfer)
    transfer=await start("Dalian");await hover(transfer,"Dalian");await row("Dalian").dispatchEvent("drop",{dataTransfer:transfer});await cancel("Dalian",transfer)
    assert.deepEqual(requests,[],"adjacent/same-row no-ops do not write")
    transfer=await page.evaluateHandle(()=>new DataTransfer())
    await row("Bayuquan").locator("input").first().dispatchEvent("dragstart",{dataTransfer:transfer})
    await hover(transfer,"Dalian");await row("Dalian").dispatchEvent("drop",{dataTransfer:transfer});await cancel("Bayuquan",transfer)
    assert.equal(await page.locator('[data-drop-position]').count(),0)
    assert.deepEqual(requests,[],"dragging editable text must not start a row move")
    console.log("PASS: last indicated edge wins; child transitions preserve it; leaving, canceling, unpreviewed/forged/stale-filter drops and no-ops never write")

    await reset()
    await row("Bayuquan").scrollIntoViewIfNeeded()
    const handle=await row("Bayuquan").locator("td").first().boundingBox()
    const destination=await row("Dalian").boundingBox()
    await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2)
    await page.mouse.down()
    await page.mouse.move(handle.x+handle.width/2,destination.y+4,{steps:12})
    await page.mouse.move(handle.x+handle.width/2,destination.y+3)
    await page.getByRole("status").filter({hasText:"Drop before Dalian"}).waitFor()
    assert.equal(await row("Dalian").getAttribute("data-drop-position"),"before")
    assert.deepEqual(await savedIds(),original);assert.deepEqual(requests,[])
    if(process.env.ORDER_SCREENSHOT_PATH)await page.screenshot({path:process.env.ORDER_SCREENSHOT_PATH,fullPage:true})
    await page.mouse.up();await saved()
    assert.deepEqual(await savedIds(),[basis,other,linked,chained,divider])
    assert.equal(await page.locator('[data-drop-position]').count(),0)
    console.log("PASS: native headless Chrome pointer drag shows the insertion line before release, then actual API/audit/SQL saves that exact destination")

    await reset();await row("Bayuquan").scrollIntoViewIfNeeded()
    const cancelHandle=await row("Bayuquan").locator("td").first().boundingBox(),cancelTarget=await row("Dalian").boundingBox()
    await page.mouse.move(cancelHandle.x+cancelHandle.width/2,cancelHandle.y+cancelHandle.height/2);await page.mouse.down()
    await page.mouse.move(cancelHandle.x+cancelHandle.width/2,cancelTarget.y+3,{steps:12});await page.mouse.move(cancelHandle.x+cancelHandle.width/2,cancelTarget.y+2)
    await page.getByRole("status").filter({hasText:"Drop before Dalian"}).waitFor()
    await page.keyboard.press("Escape");await page.mouse.up()
    await page.waitForFunction(()=>!document.querySelector('[data-drop-position]'))
    assert.deepEqual(requests,[]);assert.deepEqual(await savedIds(),original)
    console.log("PASS: Escape cancels a native pointer drag, removes the insertion indicator and preserves the saved order without a request")

    await reset()
    await north()
    await row("Dalian").getByPlaceholder("price").first().fill("777")
    mode="defer";await move("Bayuquan","Dalian");await page.waitForFunction(()=>document.body.innerText.includes("Saving port order…"))
    assert.deepEqual(await savedIds(),original);assert.deepEqual(await names(),["Dalian","Bayuquan"])
    await move("Bayuquan","Dalian");assert.equal(requests.length,1)
    assert.equal(await page.getByRole("button",{name:"Publish Taiwan",exact:true}).isDisabled(),true)
    release();release=undefined;await saved();assert.deepEqual(await savedIds(),[basis,other,chained,linked,divider])
    assert.equal(await row("Dalian").getByPlaceholder("price").first().inputValue(),"777")
    assert.deepEqual(directWrites,[]);assert.equal(auditHeaders.at(-1)["x-bunker-admin-page-id"],"pricesetter")
    console.log("PASS: filtered browser drag -> actual endpoint/audit -> one SQL transaction -> confirmed UI, hidden rows and price drafts preserved")

    await reset();await app.db.exec(`reset role; create function synthetic_order_failure() returns trigger language plpgsql as $$ begin if new.id='${linked}'::uuid then raise exception 'PRIVATE injected failure'; end if; return new; end $$; create trigger synthetic_order_failure before update on ports for each row execute function synthetic_order_failure(); set role service_role`)
    await move("Bayuquan","Dalian");await page.getByRole("button",{name:"Retry order save",exact:true}).waitFor()
    assert.deepEqual(await savedIds(),original);assert.deepEqual(await names(),["Singapore","Dalian","Tokyo","Bayuquan","Group"])
    assert.doesNotMatch(await page.getByRole("alert").innerText(),/PRIVATE|SQL|JSON/)
    await app.db.exec("reset role; drop trigger synthetic_order_failure on ports; drop function synthetic_order_failure(); set role service_role")
    await page.getByRole("button",{name:"Retry order save",exact:true}).click();await saved();assert.deepEqual(await savedIds(),[basis,other,linked,chained,divider])

    for(const failureMode of ["disconnect","malformed","partial"]){
      await reset();mode=failureMode;await move("Bayuquan","Dalian");await page.getByRole("button",{name:"Retry order save",exact:true}).waitFor()
      assert.deepEqual(await names(),["Singapore","Dalian","Tokyo","Bayuquan","Group"])
      assert.equal(await page.getByRole("button",{name:"Publish Taiwan",exact:true}).isDisabled(),true)
      mode="success";await page.getByRole("button",{name:"Retry order save",exact:true}).click();await saved();assert.deepEqual(await savedIds(),[basis,other,linked,chained,divider])
    }
    console.log("PASS: real SQL rollback, disconnected/partial/malformed responses retain original UI; retry confirms or reconciles the saved order")

    await reset();await app.db.exec(`update ports set display_order=100 where id='${basis}'`)
    await move("Bayuquan","Dalian");await page.getByRole("button",{name:"Retry order save",exact:true}).waitFor()
    assert.equal(await page.getByRole("status").filter({hasText:/^Port order saved\.$/}).count(),0)
    page.once("dialog",dialog=>dialog.dismiss());await page.getByRole("button",{name:"Reload saved ports",exact:true}).click();assert.equal((await names())[0],"Singapore")
    page.once("dialog",dialog=>dialog.accept());await page.getByRole("button",{name:"Reload saved ports",exact:true}).click();await page.waitForFunction(()=>!document.body.innerText.includes("Retry order save"))
    assert.equal((await names()).at(-1),"Singapore")

    await reset();mode="timeout";await move("Bayuquan","Dalian");await page.waitForFunction(()=>document.body.innerText.includes("Saving port order…"))
    await page.clock.runFor(20001);await page.getByRole("button",{name:"Retry order save",exact:true}).waitFor();release();release=undefined
    for(let attempt=0;attempt<100&&(await savedIds())[1]!==other;attempt++)await new Promise(resolve=>setTimeout(resolve,10))
    assert.equal((await savedIds())[1],other)
    mode="success";await page.getByRole("button",{name:"Retry order save",exact:true}).click();await saved()
    await reset();await move("Group","Singapore");await saved();assert.equal((await savedIds())[0],divider)
    await reset("view");assert.equal(await row("Singapore").getAttribute("draggable"),"false");await move("Bayuquan","Dalian");assert.deepEqual(requests,[])
    assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);assert.deepEqual(failures,[])
    console.log("PASS: stale-order conflict/reload consent, timeout/lost-response recovery, divider move, View restrictions, no external requests or browser errors")
  }
} finally {
  if(release)release();if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await app.db.close()
}
