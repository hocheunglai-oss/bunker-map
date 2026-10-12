import assert from "node:assert/strict"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { setupMarketHistoryApp } from "./fixtures/market-price-history-app.mjs"
import { publicReportReader } from "./fixtures/public-report-reader.mjs"

const require=createRequire(import.meta.url)
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..")
const mocks=`
  const params=new URLSearchParams(location.search);
  export function useSimpleAdminAuth(){return {loading:false,authenticated:true,role:"BT",permissions:{"hongkong-price-history":params.get("access")||"edit","taiwan-price-history":params.get("access")||"edit"}};}
  export const supabase={from(){throw Error("Legacy direct history/publication transport used")}};
`
const bundle=await build({absWorkingDir:root,
  stdin:{contents:'import React from "react";import {createRoot} from "react-dom/client";import HK from "./app/admin/hongkongpricehistory/page";import TW from "./app/admin/taiwanpricehistory/page";const Page=location.pathname==="/taiwan"?TW:HK;createRoot(document.getElementById("root")).render(<React.StrictMode><Page/></React.StrictMode>);',resolveDir:root,loader:"tsx"},
  bundle:true,write:false,platform:"browser",format:"iife",jsx:"automatic",define:{"process.env.NODE_ENV":'"development"'},
  plugins:[{name:"synthetic-session-only",setup(builder){
    builder.onResolve({filter:/^@\/lib\/(supabase|useSimpleAdminAuth)$/},()=>({path:"mocks",namespace:"fixture"}))
    builder.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:mocks,loader:"js"}))
  }}],
})
const html='<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial}button,input,select{font:inherit}button:disabled{opacity:.5}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'
let app,browser
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,"http://127.0.0.1")
    if(url.pathname==="/fixture.js"){res.setHeader("Content-Type","text/javascript");res.end(bundle.outputFiles[0].contents);return}
    if(["/api/admin/price-history","/api/admin/report-publication"].includes(url.pathname)){
      const chunks=[];for await(const part of req)chunks.push(part)
      const request=new Request(url,{method:req.method,headers:req.headers,...(req.method==="POST"?{body:Buffer.concat(chunks)}:{})})
      const route=url.pathname.endsWith("report-publication")?app.publicationRoute:app.route
      const response=await route[req.method](request)
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return
    }
    if(url.pathname.startsWith("/api/reports/")) {
      const key=url.pathname.split("/").at(-1)
      const response=await app.publicReader.route.GET(new Request(url),{params:Promise.resolve({key})})
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return
    }
    res.setHeader("Content-Type","text/html");res.end(html)
  }catch(error){res.statusCode=500;res.end("Synthetic harness error");console.error(error)}
})
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve))
const origin=`http://127.0.0.1:${server.address().port}`
try {
  const {chromium}=require("playwright")
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_EXECUTABLE_PATH||"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"})
  for(const market of ["hongkong","taiwan"]) {
    app=await setupMarketHistoryApp()
    app.publicReader=publicReportReader(app.db)
    const context=await browser.newContext({timezoneId:"America/Los_Angeles",viewport:{width:1400,height:950}})
    const page=await context.newPage(),errors=[],blocked=[]
    page.setDefaultTimeout(10000)
    page.on("pageerror",error=>errors.push(error.message))
    page.on("dialog",dialog=>dialog.accept())
    await context.route("**/*",route=>{if(new URL(route.request().url()).origin===origin)return route.continue();blocked.push(route.request().url());return route.abort()})
    const button=name=>page.getByRole("button",{name,exact:true})
    const field=name=>page.getByRole("textbox",{name,exact:true})
    const historyRows=()=>page.locator('table:not([aria-label]) tbody tr')
    const firstPrice=()=>historyRows().first().locator("td").nth(1).innerText()
    async function ready(){await page.waitForFunction(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent==="Add As Latest");return b&&!b.disabled})}
    async function fill(day,hsfo="0") {
      await page.getByLabel("Date",{exact:true}).fill(day);await field("HSFO").fill(hsfo)
      for(const label of market==="taiwan"?["VLSFO Kaohsiung","VLSFO Taichung","MGO Kaohsiung","MGO Taichung"]:["VLSFO","MGO"])await field(label).fill("900")
    }
    async function reload(){await button("Reload saved history").click();await ready()}
    const title=market==="taiwan"?"Taiwan":"Hong Kong"
    async function reportReady(){await page.waitForFunction(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent==="Publish"||b.textContent==="Published");return b&&!b.disabled})}
    async function reloadReport(){await button(`Reload saved ${title} report`).click();await reportReady()}
    async function savedReport(){return (await app.db.query("select content from remarks where id=$1",[market==="taiwan"?101:102])).rows[0]?.content??null}
    async function publicReport() {
      const response=await page.request.get(`${origin}/api/reports/${market}`)
      assert.equal(response.status(),200);assert.match(response.headers()["cache-control"],/no-store/)
      const payload=await response.json();assert.equal(payload.key,market)
      return payload
    }
    async function failingTrigger(kind) {
      await app.db.exec(`reset role;create or replace function public.flow_fail() returns trigger language plpgsql as $$begin raise exception 'PRIVATE injected ${kind} failure';end;$$;
        create trigger flow_fail before ${kind} on price_history for each row execute function public.flow_fail();set role service_role;`)
    }
    async function removeTrigger(){await app.db.exec("reset role;drop trigger flow_fail on price_history;set role service_role")}
    await page.goto(`${origin}/${market}`);await ready();await reportReady()
    assert.equal(await firstPrice(),"600")
    await fill("2026-10-01")
    app.control.hold="change_market_price_history"
    await button("Add Missing Record").click()
    await page.waitForFunction(()=>[...document.querySelectorAll("button")].some(b=>b.textContent==="Saving..."))
    assert.equal(await field("HSFO").isDisabled(),true)
    assert.equal(await button("Publish").isDisabled(),true)
    assert.equal(await button("Reload saved history").isDisabled(),true)
    assert.equal(await button("Show Delete").isDisabled(),true)
    while(!app.control.release)await new Promise(resolve=>setTimeout(resolve,5))
    app.control.release();app.control.release=null
    await ready();await page.getByText("History saved. The public report is unchanged until Publish.",{exact:true}).waitFor()
    assert.equal(await firstPrice(),"0");assert.equal(await field("HSFO").inputValue(),"")
    const save=app.calls.find(call=>call.name==="change_market_price_history")
    assert.equal(save.args.p_expected_rows.length,market==="taiwan"?3:2)
    assert.equal(save.args.p_values.length,market==="taiwan"?2:1)
    assert.equal(save.args.p_values.find(v=>v.hsfo!==null).hsfo,0)
    assert.equal(app.auditHeaders.at(-1)["x-bunker-admin-user"],"SERVER-EDITOR")
    assert.equal((await app.db.query("select count(*)::int as n from price_history where port_id=any($1::uuid[]) and recorded_at::date='2026-10-01'",[save.args.p_expected_ports.map(p=>p.id)])).rows[0].n,market==="taiwan"?2:1)
    console.log(`PASS ${market}: actual browser → API → audited SQL; complete raw baseline, zero, duplicate cleanup, in-flight locks`)

    await fill("2026-10-02","222")
    await failingTrigger("insert");let before=await app.state()
    await button("Add Missing Record").click();await page.getByRole("alert").filter({hasText:/History could not be|History change|could not be confirmed/}).waitFor()
    assert.deepEqual(await app.state(),before);assert.equal(await field("HSFO").inputValue(),"222")
    assert.equal(await button("Add As Latest").isDisabled(),true)
    await removeTrigger();await reload();assert.equal(await field("HSFO").inputValue(),"222")
    const rootId=market==="taiwan"?app.linked:app.basis
    await app.db.query("update ports set vlsfo=123 where id=$1::uuid",[rootId]);before=await app.state()
    await button("Add Missing Record").click();await page.getByRole("alert").filter({hasText:/changed while you were editing/}).waitFor()
    assert.deepEqual(await app.state(),before);assert.equal(await field("HSFO").inputValue(),"222")
    await reload();await button("Add Missing Record").click();await ready()
    assert.equal(await firstPrice(),"222");assert.equal(await field("HSFO").inputValue(),"")
    console.log(`PASS ${market}: real SQL failure rolls back; stale edit is rejected; explicit reload retains draft and permits a confirmed retry`)

    await fill("2026-10-03","333");app.control.badWrite=true
    await button("Add Missing Record").click();await page.getByRole("alert").filter({hasText:/History could not be|History change|could not be confirmed/}).waitFor()
    assert.equal(await field("HSFO").inputValue(),"333")
    const committed=await app.state();app.control.badWrite=false
    await reload();assert.deepEqual(await app.state(),committed)
    assert.equal(await firstPrice(),"333");assert.equal(await field("HSFO").inputValue(),"333")
    console.log(`PASS ${market}: damaged response after commit is not reported as success; reload checks saved data without losing draft or writing again`)

    await button("Show Delete").click();await failingTrigger("delete");before=await app.state()
    await page.getByRole("button",{name:"Delete",exact:true}).first().click();await page.getByRole("alert").filter({hasText:/History could not be|History change|could not be confirmed/}).waitFor()
    assert.deepEqual(await app.state(),before);await removeTrigger();await reload()
    await page.getByRole("button",{name:"Delete",exact:true}).first().click();await ready()
    assert.equal(await firstPrice(),"222")
    assert.equal((await app.db.query("select count(*)::int as n from price_history where port_id=any($1::uuid[]) and recorded_at::date='2026-10-03'",[save.args.p_expected_ports.map(p=>p.id)])).rows[0].n,0)
    assert.equal((await app.row(rootId)).hsfo,222)
    console.log(`PASS ${market}: failed deletion never removes UI/data; confirmed deletion updates all market rows and latest prices atomically`)

    await reportReady();assert.equal(await savedReport(),null,"history changes alone never publish")
    assert.equal((await publicReport()).snapshot,null,"actual public reader remains unpublished after history edits")
    for(const flag of ["publicationReadFailure","publicationBadRead"]) {
      app.control[flag]=true
      await button(`Reload saved ${title} report`).click();await page.getByRole("alert").filter({hasText:/Saved report data could not be loaded completely/}).waitFor()
      assert.equal(await button("Publish").isDisabled(),true);assert.equal(await savedReport(),null)
      app.control[flag]=false;await reloadReport()
    }
    before=await savedReport()
    await app.db.query("update ports set vlsfo=124 where id=$1::uuid",[rootId])
    await button("Publish").click();await page.getByRole("alert").filter({hasText:/Saved data or the published report changed/}).waitFor()
    assert.equal(await savedReport(),before);assert.equal(await field("HSFO").inputValue(),"333")
    assert.equal(await button("Publish").isDisabled(),true);await reloadReport()
    app.control.hold="publish_report_snapshot"
    await button("Publish").click();await button("Publishing...").waitFor()
    for(const name of ["Reload saved history",`Reload saved ${title} report`,"Hide Delete","Add Missing Record"])assert.equal(await button(name).isDisabled(),true)
    assert.equal(await field("HSFO").isDisabled(),true)
    while(!app.control.release)await new Promise(resolve=>setTimeout(resolve,5))
    app.control.release();app.control.release=null
    await button("Published").waitFor()
    assert.equal(await field("HSFO").inputValue(),"333","publication never clears unsaved inputs")
    let payload=JSON.parse(await savedReport())
    assert.equal(payload.reportDate,"02 Oct 2026");assert.equal(payload.rows[0].hsfo.today,222)
    assert.equal(payload.rows.length,market==="taiwan"?5:1)
    if(market==="taiwan")assert.equal(payload.specialNotice,"EXISTING NOTICE")
    assert.deepEqual((await publicReport()).snapshot,payload,"actual public API returns exactly the committed report")
    assert.equal(app.permissions.at(-1).access,"edit");assert.equal(app.auditHeaders.at(-1)["x-bunker-admin-user"],"SERVER-EDITOR")
    console.log(`PASS ${market}: actual publication API/SQL; failed/malformed reads block publishing; stale source rejected; in-flight locks; saved date/prices/notices and server audit identity`)

    await reload() // The independently edited port also invalidated the history baseline.
    const foreign=JSON.stringify({...payload,reportDate:"01 Oct 2026"})
    await app.db.query("update remarks set content=$1 where id=$2",[foreign,market==="taiwan"?101:102])
    await fill("2026-10-04","444");await button("Add Missing Record").click();await ready()
    await page.getByRole("alert").filter({hasText:/Another publication was saved/}).waitFor()
    assert.equal(await savedReport(),foreign);assert.equal(await button("Publish").isDisabled(),true)
    assert.deepEqual((await publicReport()).snapshot,JSON.parse(foreign),"history save cannot change the public report")
    await reloadReport();await fill("2026-10-05","555")
    app.control.publicationBadWrite=true
    await button("Publish").click();await page.getByRole("alert").filter({hasText:/Publication could not be confirmed/}).waitFor()
    assert.equal(await button("Published").count(),0);assert.equal(await field("HSFO").inputValue(),"555")
    const exactCommitted=await savedReport();assert.notEqual(exactCommitted,foreign)
    app.control.publicationBadWrite=false;await reloadReport();await button("Publish").click();await button("Published").waitFor()
    assert.equal(await savedReport(),exactCommitted);assert.equal(await field("HSFO").inputValue(),"555")
    assert.deepEqual((await publicReport()).snapshot,JSON.parse(exactCommitted))
    console.log(`PASS ${market}: own save never silently adopts another publication; lost reply remains uncertain; explicit reload and read-only replay preserve unsaved inputs`)

    app.control.access="view"
    await page.goto(`${origin}/${market}?access=view`);await historyRows().first().waitFor()
    for(const name of ["Publish","Add Missing Record","Add As Latest","Show Delete"])assert.equal(await button(name).isDisabled(),true)
    assert.equal(await field("HSFO").isDisabled(),true)
    let calls=app.calls.length
    const denied=await page.evaluate(async market=>(await fetch(`/api/admin/price-history?market=${market}`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).status,market)
    assert.equal(denied,403);assert.equal(app.calls.length,calls)
    calls=app.calls.length
    const deniedPublish=await page.evaluate(async market=>(await fetch(`/api/admin/report-publication?report=${market}&page=${market}-price-history`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).status,market)
    assert.equal(deniedPublish,403);assert.equal(app.calls.length,calls)
    app.control.access="edit";app.control.readFailure=true
    await page.goto(`${origin}/${market}`);await page.getByRole("alert").filter({hasText:/Saved history could not be loaded completely/}).waitFor()
    assert.equal(await button("Add As Latest").isDisabled(),true)
    assert.equal(await historyRows().count(),0)
    app.control.readFailure=false;await reload();assert.equal(await firstPrice(),"444")
    assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
    console.log(`PASS ${market}: View can read but cannot edit/publish; failed loads are not editable empty lists; retry restores data; no external connections or browser errors`)
    await context.close();await app.db.close();app=null
  }
}finally {
  if(browser)await browser.close()
  if(app)await app.db.close()
  await new Promise(resolve=>server.close(resolve))
}
