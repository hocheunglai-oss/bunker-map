/* Real Price Setter UI, synthetic data, isolated localhost browser only.
 * SQL transaction semantics are separately tested against the exact migration. */
const assert = require("node:assert/strict")
const http = require("node:http")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const { build } = require("esbuild")
const { reportPublicationBaseline } = require("./fixtures/report-publication-baseline.cjs")

async function main() {
  const root = path.resolve(__dirname, "..")
  const baseline = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.split("=")[1]
  if (baseline && !/^[a-f0-9]{40}$/i.test(baseline)) throw Error("Baseline must be an exact commit")
  const mocks = `
    const make = (n,name,extra={})=>({id:"00000000-0000-4000-8000-"+String(n).padStart(12,"0"),name,type:"port",lat:0,lng:0,hsfo:600,vlsfo:800,mgo:1000,hsfo_formula:null,vlsfo_formula:null,mgo_formula:null,updated_at:"2026-10-08",display_order:n,...extra});
    const state=window.__saveHarness={ports:[make(1,"Basis"),make(2,"Linked",{vlsfo_formula:"Basis + 0"}),make(3,"Chained",{vlsfo_formula:"Linked + 10"})],history:[],writes:[],requests:[],mode:"success"};
    export function useSimpleAdminAuth(){return {loading:false,authenticated:true,role:"BT",permissions:{pricesetter:new URLSearchParams(location.search).get("access")||"edit"}}}
    export function useIsMobile(){return false}
    export const supabase={from(table){let action="read",payload,filters=[];const q={
      select(){return q},order(){return q},maybeSingle(){action="singleRead";return q},single(){return q},
      eq(k,v){filters.push([k,v]);return q},in(k,v){filters.push([k,v]);return q},gte(){return q},lt(){return q},
      update(v){action="update";payload=v;return q},insert(v){action="insert";payload=v;return q},delete(){action="delete";return q},upsert(v){action="upsert";payload=v;return q},
      then(resolve,reject){return (async()=>{
        if(action!=="read"&&action!=="singleRead"){
          state.writes.push({table,action,payload:structuredClone(payload)});
          if(table==="ports"&&action==="update")for(const row of state.ports)if(filters.every(([k,v])=>Array.isArray(v)?v.includes(row[k]):row[k]===v))Object.assign(row,payload);
          return {data:null,error:null};
        }
        if(table==="price_history")return {data:null,error:{message:"Injected history failure"}};
        if(table==="ports")return {data:structuredClone(state.ports),error:null};
        return {data:action==="singleRead"?null:[],error:null};
      })().then(resolve,reject)}
    };return q}};
  `
  const bundle = await build({ absWorkingDir:root, stdin:{contents:'import React from "react";import {createRoot} from "react-dom/client";import Page from "./app/admin/pricesetter/page";createRoot(document.getElementById("root")).render(<Page/>);',resolveDir:root,loader:"tsx"},
    bundle:true,write:false,platform:"browser",format:"iife",jsx:"automatic",define:{"process.env.NODE_ENV":'"development"'},
    plugins:[{name:"synthetic-boundaries",setup(builder){
      builder.onResolve({filter:/^@\/lib\/(supabase|useSimpleAdminAuth|useIsMobile)$/},()=>({path:"mocks",namespace:"fixture"}));
      builder.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:mocks,loader:"js"}));
      if(baseline)builder.onLoad({filter:/app\/admin\/pricesetter\/page\.tsx$/},()=>({contents:execFileSync("git",["show",baseline+":app/admin/pricesetter/page.tsx"],{cwd:root,encoding:"utf8"}),loader:"tsx"}));
    }}],
  })
  const server=http.createServer((req,res)=>{res.setHeader("Content-Type",req.url==="/fixture.js"?"text/javascript":"text/html");res.end(req.url==="/fixture.js"?bundle.outputFiles[0].contents:'<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>')})
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve))
  const origin=`http://127.0.0.1:${server.address().port}`
  let browser, release
  try {
    const {chromium}=require("playwright")
    browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE_PATH?{executablePath:process.env.CHROME_EXECUTABLE_PATH}:{})})
    const context=await browser.newContext({viewport:{width:1400,height:900},timezoneId:"America/Los_Angeles"})
    const page=await context.newPage(), errors=[],blocked=[]
    page.setDefaultTimeout(8000);page.on("pageerror",e=>errors.push(e.message))
    await page.clock.install({time:new Date("2026-10-08T18:30:00Z")})
    await context.route("**/*",async route=>{
      const request=route.request(),url=new URL(request.url())
      if(url.origin!==origin){blocked.push(request.url());return route.abort()}
      if(url.pathname==="/api/admin/report-publication") { assert.equal(request.method(),"GET"); return route.fulfill({json:reportPublicationBaseline(url.searchParams.get("report"))}) }
      if(url.pathname==="/api/admin/prices/creation") { assert.equal(request.method(),"GET"); return route.fulfill({json:{actorId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",version:"0",pending:null}}) }
      if(url.pathname!=="/api/admin/prices")return route.continue()
      if(request.method()==="GET")return route.fulfill({json:await page.evaluate(()=>({version:1,count:window.__saveHarness.ports.length,ports:structuredClone(window.__saveHarness.ports)}))})
      assert.equal(request.method(),"POST")
      const input=request.postDataJSON()
      const mode=await page.evaluate(input=>{window.__saveHarness.requests.push(input);return window.__saveHarness.mode},input)
      if(mode==="defer"||mode==="timeout")await new Promise(resolve=>{release=resolve})
      if(mode==="offline")return route.abort()
      if(mode==="malformed")return route.fulfill({status:200,contentType:"application/json",body:"{bad JSON"})
      if(mode==="incomplete")return route.fulfill({status:200,json:{ports:[{id:input.portId}]}})
      if(mode==="error")return route.fulfill({status:503,json:{message:"The save could not be confirmed. Your draft is still here."}})
      if(mode==="conflict")return route.fulfill({status:409,json:{code:"PRICE_CONFLICT",message:"Saved prices changed while you were editing. Your draft is still here. Reload saved ports before trying again."}})
      const result=await page.evaluate(({input,mode})=>{
        const s=window.__saveHarness,row=s.ports.find(p=>p.id===input.portId)
        const snapshot=Object.fromEntries(Object.keys(input.expected).map(k=>[k,row[k]]))
        if(JSON.stringify(snapshot)!==JSON.stringify(input.expected))return {status:409,body:{code:"PRICE_CONFLICT",message:"Saved prices changed while you were editing. Your draft is still here. Reload saved ports before trying again."}}
        const oldName=row.name
        Object.assign(row,input.changes,{updated_at:"2026-10-09"})
        const affected=new Set([row.id]),names=new Set([oldName.toLowerCase(),row.name.toLowerCase()])
        for(let pass=0;pass<s.ports.length;pass++)for(const p of s.ports)for(const field of ["hsfo_formula","vlsfo_formula","mgo_formula"]){
          const formula=p[field],reference=formula?.split(/\s+[+-]\s+/)[0]
          if(reference?.toLowerCase()===oldName.toLowerCase()&&oldName!==row.name)p[field]=row.name+formula.slice(reference.length)
          if(reference&&names.has(reference.toLowerCase())){p.updated_at="2026-10-09";affected.add(p.id);names.add(p.name.toLowerCase())}
        }
        s.history=[{id:"synthetic-history",port_id:row.id,hsfo:row.hsfo,vlsfo:row.vlsfo,mgo:row.mgo,recorded_at:"2026-10-09T02:30:00"}]
        const ports=structuredClone(s.ports.filter(p=>affected.has(p.id)))
        if(mode==="badLinked")ports.find(p=>p.id!==row.id).updated_at="not-a-date"
        if(mode==="wrongPrice")ports.find(p=>p.id===row.id).hsfo=999
        if(mode==="wrongHistory")s.history[0].hsfo=999
        return {status:200,body:{replayed:false,history:s.history[0],ports}}
      },{input,mode})
      try {await route.fulfill({status:result.status,json:result.body})}catch(error){if(mode!=="timeout")throw error}
    })
    const rows=()=>page.locator('table:not([aria-label]) tbody tr'),row=n=>rows().nth(n),save=n=>row(n).getByRole("button",{name:"Save",exact:true})
    const state=()=>page.evaluate(()=>structuredClone(window.__saveHarness))
    async function reset(mode="success",query="") {release=undefined;await page.goto(origin+query);await row(0).getByPlaceholder("price").first().waitFor();await page.evaluate(mode=>{window.__saveHarness.mode=mode},mode)}
    async function draft(value="777"){await row(0).getByPlaceholder("price").first().fill(value)}
    async function failed(){await row(0).getByRole("alert").waitFor();assert.equal(await row(0).getByRole("button",{name:"Saved",exact:true}).count(),0);assert.equal(await save(0).isEnabled(),true);assert.equal(await row(0).getByPlaceholder("price").first().inputValue(),"777")}
    if(baseline){
      await reset();await draft();await save(0).click();await page.waitForFunction(()=>window.__saveHarness.writes.length>0);await save(0).waitFor()
      const s=await state();assert.equal(s.ports[0].hsfo,777);assert.deepEqual(s.history,[])
      console.log("REPRODUCED: original price save commits the port before a history failure, leaving price/history inconsistent")
      return
    }

    await reset();await draft("0");await save(0).click();await row(0).getByRole("button",{name:"Saved",exact:true}).waitFor()
    let s=await state();assert.equal(s.requests.length,1);assert.equal(s.requests[0].expected.hsfo,600);assert.equal(s.requests[0].changes.hsfo,0)
    assert.equal(s.requests[0].changes.lat,0);assert.equal(s.history[0].hsfo,0);assert.deepEqual(s.writes,[])
    assert.equal(await row(0).getByText("09/10/2026",{exact:true}).count(),1,"Hong Kong day does not become previous day in a western browser")
    for(const mode of ["error","conflict","offline","malformed","incomplete","badLinked","wrongPrice","wrongHistory"]){await reset(mode);await draft();await save(0).click();await failed();assert.equal((await state()).requests.length,1);assert.doesNotMatch(await row(0).getByRole("alert").innerText(),/JSON|SyntaxError|Unexpected token|property name/i)}
    console.log("PASS: one atomic request, zero/coordinates preserved, HK display date, failed/malformed/conflicting response retains drafts and releases Save")

    await reset("error");await draft();await save(0).click();await failed()
    await page.evaluate(()=>{window.__saveHarness.mode="success"});await save(0).click();await row(0).getByRole("button",{name:"Saved",exact:true}).waitFor();assert.equal(await row(0).getByRole("alert").count(),0)
    await draft("778");await save(0).click();await row(0).getByRole("button",{name:"Saved",exact:true}).waitFor();s=await state();assert.equal(s.requests.at(-1).expected.hsfo,777)
    await reset();await draft("NaN");await save(0).click();await row(0).getByRole("alert").waitFor();assert.deepEqual((await state()).requests,[])

    await reset("defer");await draft();await save(0).evaluate(button=>{button.click();button.click()})
    await page.waitForFunction(()=>window.__saveHarness.requests.length===1);assert.equal(await row(0).getByPlaceholder("price").first().isDisabled(),true)
    for(const name of ["Publish China","Publish Compact","Publish Taiwan","Publish HK"]){assert.equal(await page.getByRole("button",{name,exact:true}).isDisabled(),true)}
    assert.deepEqual((await state()).writes,[]);assert.equal((await state()).requests.length,1)
    release();await row(0).getByRole("button",{name:"Saved",exact:true}).waitFor()
    console.log("PASS: valid retry clears errors and refreshes baseline; invalid numbers never reach API; double-click and publication cannot race a pending save")

    await reset();await page.getByLabel("Linked VLSFO price or formula",{exact:true}).fill("Basis + 15");await row(0).getByRole("textbox").first().fill("New Basis");await save(0).click();await row(0).getByRole("button",{name:"Saved",exact:true}).waitFor()
    assert.equal(await page.getByLabel("Linked VLSFO price or formula",{exact:true}).inputValue(),"Basis + 15","other row's unsaved draft is retained after authoritative rename")
    await save(1).click();await row(1).getByRole("alert").waitFor();s=await state();assert.equal(s.requests[1].expected.vlsfo_formula,"Basis + 0");assert.equal(s.requests[1].expected.updated_at,"2026-10-08")
    await reset();await row(0).getByRole("textbox").first().fill("New Basis");await save(0).click();await row(0).getByRole("button",{name:"Saved",exact:true}).waitFor()
    assert.equal(await page.getByLabel("Linked VLSFO price or formula",{exact:true}).inputValue(),"New Basis + 0")
    await page.getByLabel("Linked VLSFO price or formula",{exact:true}).fill("New Basis + 15");await save(1).click();await row(1).getByRole("button",{name:"Saved",exact:true}).waitFor();assert.equal((await state()).requests[1].expected.vlsfo_formula,"New Basis + 0")
    console.log("PASS: basis renames refresh clean linked rows; another row's draft and original conflict baseline remain intact")

    await reset("timeout");await draft();await save(0).click();await page.waitForFunction(()=>window.__saveHarness.requests.length===1)
    await page.clock.runFor(20001);await failed();release();await page.waitForTimeout(30)
    await reset("conflict");await draft();await save(0).click();await failed()
    page.once("dialog",dialog=>dialog.dismiss());await row(0).getByRole("button",{name:"Reload saved ports",exact:true}).click();assert.equal(await row(0).getByPlaceholder("price").first().inputValue(),"777")
    page.once("dialog",dialog=>dialog.accept());await row(0).getByRole("button",{name:"Reload saved ports",exact:true}).click();await page.waitForFunction(()=>document.querySelector('input[placeholder="price"]').value==="600")
    await reset("success","?access=view");assert.equal(await save(0).isDisabled(),true);assert.equal(await row(0).getByPlaceholder("price").first().isDisabled(),true);assert.deepEqual((await state()).requests,[])
    assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
    console.log("PASS: stalled request recovers, reload requires draft-discard confirmation, View-only cannot save, no unhandled errors or external requests")
  } finally {if(release)release();if(browser)await browser.close();await new Promise(resolve=>server.close(resolve))}
}
main().catch(error=>{console.error(error);process.exitCode=1})
