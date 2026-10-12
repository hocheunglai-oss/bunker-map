/* Actual Price Setter UI and config helpers; synthetic network boundaries.
 * Isolated headless localhost browser. Never reads/writes production data. */
const assert = require("node:assert/strict")
const http = require("node:http")
const path = require("node:path")
const { build } = require("esbuild")
const { reportPublicationBaseline } = require("./fixtures/report-publication-baseline.cjs")

async function main() {
  const root = path.resolve(__dirname, "..")
  const mocks = `
    const params=new URLSearchParams(location.search);
    const make=(n,name,extra={})=>({id:"00000000-0000-4000-8000-"+String(n).padStart(12,"0"),name,type:"port",lat:0,lng:0,hsfo:null,vlsfo:null,mgo:1000,hsfo_formula:null,vlsfo_formula:null,mgo_formula:null,updated_at:"2026-10-08",display_order:n,...extra});
    const s=window.__settings={mode:params.get("mode")||"success",saveMode:"success",reads:[],writes:[],requests:[],releases:[],fallbacks:{"basis::hsfo":"NA","other::mgo":"SE"},ports:[make(1,"Basis"),make(2,"Group",{type:"divider"}),make(3,"Other") ]};
    export function useSimpleAdminAuth(){return {loading:false,authenticated:true,role:"BT",permissions:{pricesetter:params.get("access")||"edit"}}}
    export function useIsMobile(){return false}
    export const supabase={from(table){let single=false,filters=[],action="read",payload;const q={
      select(){return q},order(){return q},eq(k,v){filters.push([k,v]);return q},in(k,v){filters.push([k,v]);return q},maybeSingle(){single=true;return q},single(){single=true;return q},
      update(v){action="update";payload=v;return q},upsert(v){action="upsert";payload=v;return q},
      then(resolve,reject){return (async()=>{
        if(action!=="read"){s.writes.push({table,action,payload});return {data:null,error:{message:"Synthetic write failure"}}}
        if(table==="ports")return {data:structuredClone(s.ports),error:null};
        const kind=single?"fallbacks":"snapshots", mode=s.mode;
        s.reads.push(kind);
        const result=single?{content:JSON.stringify(s.fallbacks)}:[{id:101,content:JSON.stringify({reportDate:"08 Oct 2026"})}];
        if(mode===kind+"Error")return {data:null,error:{message:"Synthetic failure"}};
        if(mode===kind+"Throw")throw Error("Synthetic offline");
        if(mode==="malformed")return {data:single?{content:"{bad"}:[{id:101,content:"{bad"}],error:null};
        if(mode==="schema")return {data:single?{}:[{id:"101",content:"{}"}],error:null};
        if(mode==="defer")await new Promise(resolve=>s.releases.push(resolve));
        return {data:result,error:null};
      })().then(resolve,reject)}
    };return q}};
  `
  const bundle = await build({absWorkingDir:root,stdin:{contents:'import React from "react";import {createRoot} from "react-dom/client";import Page from "./app/admin/pricesetter/page";createRoot(document.getElementById("root")).render(<Page/>);',resolveDir:root,loader:"tsx"},bundle:true,write:false,platform:"browser",format:"iife",jsx:"automatic",define:{"process.env.NODE_ENV":'"development"'},plugins:[{name:"synthetic-boundaries",setup(builder){
    builder.onResolve({filter:/^@\/lib\/(supabase|useSimpleAdminAuth|useIsMobile)$/},()=>({path:"mocks",namespace:"fixture"}));
    builder.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:mocks,loader:"js"}));
  }}]})
  const server=http.createServer((req,res)=>{res.setHeader("Content-Type",req.url==="/fixture.js"?"text/javascript":"text/html");res.end(req.url==="/fixture.js"?bundle.outputFiles[0].contents:'<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>')})
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve))
  const origin=`http://127.0.0.1:${server.address().port}`
  let browser, release
  try {
    const {chromium}=require("playwright")
    browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE_PATH?{executablePath:process.env.CHROME_EXECUTABLE_PATH}:{})})
    const context=await browser.newContext({viewport:{width:1400,height:900}}),page=await context.newPage(),errors=[],blocked=[]
    page.setDefaultTimeout(8000);page.on("pageerror",error=>errors.push(error.message))
    await page.clock.install({time:new Date("2026-10-09T03:00:00Z")})
    await context.route("**/*",async route=>{
      const request=route.request(),url=new URL(request.url())
      if(url.origin!==origin){blocked.push(request.url());return route.abort()}
      if(url.pathname==="/api/admin/prices/creation") { assert.equal(request.method(),"GET"); return route.fulfill({json:{actorId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",version:"0",pending:null}}) }
      if(url.pathname==="/api/admin/report-publication") { assert.equal(request.method(),"GET"); return route.fulfill({json:reportPublicationBaseline(url.searchParams.get("report"))}) }
      if(url.pathname!=="/api/admin/prices")return route.continue()
      if(request.method()==="GET")return route.fulfill({json:await page.evaluate(()=>({version:1,count:window.__settings.ports.length,ports:structuredClone(window.__settings.ports)}))})
      assert.equal(request.method(),"PATCH")
      const input=request.postDataJSON(),mode=await page.evaluate(input=>{window.__settings.requests.push(input);return window.__settings.saveMode},input)
      if(mode==="defer"||mode==="timeout")await new Promise(resolve=>{release=resolve})
      if(mode==="offline")return route.abort()
      if(mode==="error")return route.fulfill({status:503,json:{message:"The save could not be confirmed. Your draft is still here."}})
      if(mode==="malformed")return route.fulfill({status:200,contentType:"application/json",body:"{bad JSON"})
      if(mode==="incomplete")return route.fulfill({status:200,json:{}})
      if(mode==="conflict")return route.fulfill({status:409,json:{message:"This saved value changed while you were editing. Your draft is still here."}})
      const result=await page.evaluate(input=>{
        const s=window.__settings;
        if(input.operation==="fallback"){
          const current=s.fallbacks[input.key]??null;
          if(current!==input.expectedValue&&current!==input.value)return {status:409,body:{message:"This saved value changed while you were editing. Your draft is still here."}};
          s.fallbacks[input.key]=input.value;return {status:200,body:{key:input.key,fallbacks:structuredClone(s.fallbacks)}};
        }
        const port=s.ports.find(p=>p.id===input.portId);
        if(port.name!==input.expectedName&&port.name!==input.name.trim())return {status:409,body:{message:"This saved value changed while you were editing. Your draft is still here."}};
        port.name=input.name.trim();return {status:200,body:{port:structuredClone(port)}};
      },input)
      try {await route.fulfill({status:result.status,json:result.body})}catch(error){if(mode!=="timeout")throw error}
    })
    const override=()=>page.getByRole("combobox",{name:"Basis HSFO override",exact:true})
    const publish=()=>page.getByRole("button",{name:"Publish Taiwan",exact:true})
    const divider=()=>page.locator('table:not([aria-label]) tbody tr').nth(1).getByRole("textbox")
    const state=()=>page.evaluate(()=>structuredClone({...window.__settings,releases:[]}))
    async function reset(mode="success",access="edit") {
      release=undefined;await page.goto(`${origin}?mode=${mode}&access=${access}`)
      await divider().waitFor()
      if(mode==="success")await page.waitForFunction(()=>!document.body.innerText.includes("Loading report settings…"))
    }
    async function selectSaveMode(mode){await page.evaluate(mode=>{window.__settings.saveMode=mode},mode)}
    async function setDraft(){await page.locator('table:not([aria-label]) tbody tr').first().getByPlaceholder("price").nth(2).fill("777")}

    // Snapshot metadata now comes only from the versioned publication API.
    // This fixture verifies fallback settings, not report-source correctness.
    for(const mode of ["fallbacksError","fallbacksThrow","malformed","schema"]){
      await reset(mode);await page.getByRole("button",{name:"Try loading report settings again",exact:true}).waitFor()
      assert.equal(await publish().isDisabled(),true);assert.equal(await override().isDisabled(),true)
      assert.deepEqual((await state()).writes,[]);assert.deepEqual((await state()).requests,[])
      await setDraft();await page.evaluate(()=>{window.__settings.mode="success"});await page.getByRole("button",{name:"Try loading report settings again",exact:true}).click()
      await page.waitForFunction(()=>!document.body.innerText.includes("Loading report settings…"));assert.equal(await override().inputValue(),"NA")
      assert.equal(await page.locator('table:not([aria-label]) tbody tr').first().getByPlaceholder("price").nth(2).inputValue(),"777")
    }
    console.log("PASS: failed/network/malformed settings reads pause publishing and overrides; retry restores saved settings without losing price drafts")

    for(const mode of ["snapshotsError","snapshotsThrow"]){
      await reset(mode);await page.waitForFunction(()=>!document.body.innerText.includes("Loading report settings…"))
      assert.equal(await override().isDisabled(),false)
      assert.equal((await state()).reads.includes("snapshots"),false,"redundant unversioned snapshot reads cannot block repair")
    }
    await reset("defer");await page.waitForFunction(()=>window.__settings.releases.length===1)
    await page.clock.runFor(15001);await page.getByRole("button",{name:"Try loading report settings again",exact:true}).waitFor()
    await page.evaluate(()=>{window.__settings.mode="success";window.__settings.fallbacks["basis::hsfo"]="SE"})
    await page.getByRole("button",{name:"Try loading report settings again",exact:true}).click();await page.waitForFunction(()=>!document.body.innerText.includes("Loading report settings…"))
    assert.equal(await override().inputValue(),"SE");await page.evaluate(()=>{window.__settings.releases.splice(0).forEach(resolve=>resolve())});await page.waitForTimeout(30)
    assert.equal(await override().inputValue(),"SE","late timed-out read cannot overwrite recovered settings")

    for(const mode of ["error","conflict","offline","malformed","incomplete"]){
      await reset();await selectSaveMode(mode);await override().selectOption("SE")
      await page.getByRole("button",{name:"Retry override save",exact:true}).waitFor()
      assert.equal(await override().inputValue(),"SE");assert.equal(await publish().isDisabled(),true)
      assert.equal((await state()).fallbacks["basis::hsfo"],"NA");assert.deepEqual((await state()).writes,[])
      assert.doesNotMatch(await page.getByRole("alert").innerText(),/SyntaxError|JSON|Unexpected token/)
      await selectSaveMode("success");await page.getByRole("button",{name:"Retry override save",exact:true}).click()
      await page.waitForFunction(()=>!document.body.innerText.includes("Retry override save")&&!document.querySelector('[aria-label="Basis HSFO override"]').disabled)
      const saved=await state();assert.equal(saved.fallbacks["basis::hsfo"],"SE");assert.equal(saved.fallbacks["other::mgo"],"SE");assert.equal(saved.requests[1].expectedValue,"NA")
      assert.equal(await publish().isEnabled(),true)
    }
    console.log("PASS: failed override saves retain draft, pause publication, retry against the confirmed baseline, and preserve other overrides")

    await reset();await page.evaluate(()=>{window.__settings.fallbacks["basis::hsfo"]="SE"})
    await override().selectOption("-");await page.getByRole("button",{name:"Retry override save",exact:true}).waitFor()
    await page.getByRole("combobox",{name:"Basis VLSFO override",exact:true}).selectOption("NA")
    await page.waitForFunction(()=>!document.querySelector('[aria-label="Basis VLSFO override"]').disabled)
    await page.getByRole("button",{name:"Retry override save",exact:true}).click()
    await page.getByRole("button",{name:"Retry override save",exact:true}).waitFor()
    await page.waitForFunction(()=>window.__settings.requests.length===3)
    assert.equal((await state()).requests[2].expectedValue,"NA","saving VLSFO cannot acknowledge someone else's conflicting HSFO edit")
    assert.equal((await state()).fallbacks["basis::hsfo"],"SE");assert.equal(await override().inputValue(),"-")
    assert.equal(await publish().isDisabled(),true)
    console.log("PASS: saving a second override does not silently refresh a conflicted first override's baseline")

    await reset();await selectSaveMode("defer");await override().selectOption("SE");await page.waitForFunction(()=>window.__settings.requests.length===1)
    assert.equal(await override().isDisabled(),true);assert.equal(await publish().isDisabled(),true);release();release=undefined
    await page.waitForFunction(()=>!document.body.innerText.includes("Retry override save")&&!document.querySelector('[aria-label="Basis HSFO override"]').disabled)
    await selectSaveMode("timeout");await override().selectOption("NA");await page.waitForFunction(()=>window.__settings.requests.length===2)
    await page.clock.runFor(20001);await page.getByRole("button",{name:"Retry override save",exact:true}).waitFor();release();release=undefined
    await page.waitForFunction(()=>window.__settings.fallbacks["basis::hsfo"]==="NA")
    await selectSaveMode("success");await page.getByRole("button",{name:"Retry override save",exact:true}).click();await page.waitForFunction(()=>!document.body.innerText.includes("Retry override save"))
    assert.equal((await state()).requests[2].expectedValue,"SE","unknown result keeps original baseline for idempotent retry")

    await reset();await setDraft();await selectSaveMode("conflict");await override().selectOption("SE");await page.getByRole("button",{name:"Reload saved report settings",exact:true}).waitFor()
    page.once("dialog",dialog=>dialog.dismiss());await page.getByRole("button",{name:"Reload saved report settings",exact:true}).click();assert.equal(await override().inputValue(),"SE")
    page.once("dialog",dialog=>dialog.accept());await page.getByRole("button",{name:"Reload saved report settings",exact:true}).click();await page.waitForFunction(()=>!document.body.innerText.includes("Retry override save"))
    assert.equal(await override().inputValue(),"NA");assert.equal(await page.locator('table:not([aria-label]) tbody tr').first().getByPlaceholder("price").nth(2).inputValue(),"777")

    for(const mode of ["error","conflict","offline","malformed","incomplete"]){
      await reset();await selectSaveMode(mode);await divider().fill("New Group");await divider().blur();await page.getByRole("button",{name:"Retry divider save",exact:true}).waitFor()
      assert.equal(await divider().inputValue(),"New Group");assert.equal((await state()).ports[1].name,"Group")
      await selectSaveMode("success");await page.getByRole("button",{name:"Retry divider save",exact:true}).click();await page.locator('table:not([aria-label]) tbody tr').nth(1).getByRole("status").filter({hasText:/^Saved$/}).waitFor()
      assert.equal((await state()).requests[1].expectedName,"Group")
      await divider().fill("Next Group");await divider().blur();await page.waitForFunction(()=>window.__settings.ports[1].name==="Next Group")
      assert.equal((await state()).requests.at(-1).expectedName,"New Group")
    }
    await reset();await selectSaveMode("defer");await divider().fill("New Group");await divider().blur();await page.waitForFunction(()=>window.__settings.requests.length===1)
    assert.equal(await divider().isDisabled(),true);release();release=undefined;await page.waitForFunction(()=>window.__settings.ports[1].name==="New Group")
    await reset("success","view");assert.equal(await override().isDisabled(),true);assert.equal(await divider().isDisabled(),true);assert.equal(await publish().isDisabled(),true)
    assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
    console.log("PASS: timeout/lost-response retry, draft-discard consent, confirmed divider rename baseline, View restrictions, and no external requests or unhandled errors")
  } finally {if(release)release();if(browser)await browser.close();await new Promise(resolve=>server.close(resolve))}
}
main().catch(error=>{console.error(error);process.exitCode=1})
