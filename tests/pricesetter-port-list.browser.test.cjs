/* Real Price Setter with synthetic query results in an isolated headless browser.
 * No real ports, prices, reports, accounts or personal browser tabs are changed. */
const assert = require("node:assert/strict")
const http = require("node:http")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const { build } = require("esbuild")
const { reportPublicationBaseline } = require("./fixtures/report-publication-baseline.cjs")

async function main() {
  const root = path.resolve(__dirname, "..")
  const baseline = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.split("=")[1]
  if (baseline && !/^[a-f0-9]{40}$/i.test(baseline)) throw Error("Use an exact baseline commit")
  const mocks = `
    const params=new URLSearchParams(location.search);
    const make=(n,name,extra={})=>({id:"00000000-0000-4000-8000-"+String(n).padStart(12,"0"),name,type:"port",lat:null,lng:null,hsfo:600,vlsfo:800,mgo:1000,hsfo_formula:null,vlsfo_formula:null,mgo_formula:null,updated_at:null,display_order:n,...extra});
    const state=window.__portListHarness={mode:params.get("mode")||"success",reads:[],writes:[],release:null,recovery:{actorId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",version:"0",pending:null},
      ports:[make(1,"Hong Kong",{display_order:3}),make(2,"Dalian",{hsfo:610,vlsfo:810,mgo:1010,display_order:10})]};
    export function useSimpleAdminAuth(){return {loading:false,authenticated:true,role:"BT",permissions:{pricesetter:params.get("access")||"edit"}}}
    export function useIsMobile(){return false}
    export const supabase={from(table){let action="read",payload,filters=[],fields;
      const q={select(value){fields=value;return q},order(){return q},in(key,value){filters.push([key,value]);return q},eq(key,value){filters.push([key,[value]]);return q},maybeSingle(){return q},
        insert(value){action="insert";payload=value;return q},delete(){action="delete";return q},upsert(value){action="upsert";payload=value;return q},
        then(resolve,reject){return (async()=>{
          if(action!=="read"){
            state.writes.push({table,action,payload:payload&&structuredClone(payload),filters:structuredClone(filters),fields});
            if(state.mode===action+"Defer")await new Promise(resolve=>{state.release=resolve});
            if(state.mode===action+"Throw")throw Error("Synthetic transport failure");
            if(state.mode===action+"Error")return {data:null,error:{message:"Synthetic database failure"}};
            if(state.mode===action+"Empty")return {data:[],error:null};
            if(action==="delete"){const removed=state.ports.filter(row=>filters.every(([key,values])=>values.includes(row[key])));state.ports=state.ports.filter(row=>!removed.includes(row));return {data:structuredClone(removed),error:null};}
            if(action==="insert"){const row={id:"new-"+state.writes.length,...payload};state.ports.push(row);return {data:[structuredClone(row)],error:null};}
            return {data:{id:payload.id},error:null};
          }
          state.reads.push(table);
          if(table==="ports"){
            if(state.mode==="loadError")return {data:null,error:{message:"Synthetic read failure"}};
            if(state.mode==="loadThrow")throw Error("Synthetic transport failure");
            if(state.mode==="loadMalformed")return {data:{unexpected:true},error:null};
            if(state.mode==="loadBadRow")return {data:[null],error:null};
            const loaded=structuredClone(state.ports);
            if(state.mode==="loadDefer")await new Promise(resolve=>{state.release=resolve});
            return {data:loaded,error:null};
          }
          return {data:fields==="content"?null:[],error:null};
        })().then(resolve,reject)}
      };return q;
    }};
  `
  const bundle = await build({
    absWorkingDir:root,stdin:{contents:'import React from "react";import {createRoot} from "react-dom/client";import Page from "./app/admin/pricesetter/page";createRoot(document.getElementById("root")).render(<Page/>);',resolveDir:root,loader:"tsx"},
    bundle:true,write:false,platform:"browser",format:"iife",jsx:"automatic",define:{"process.env.NODE_ENV":'"development"'},
    plugins:[{name:"synthetic-boundaries",setup(builder){
      builder.onResolve({filter:/^@\/lib\/(supabase|useSimpleAdminAuth|useIsMobile)$/},()=>({path:"mocks",namespace:"fixture"}));
      builder.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:mocks,loader:"js"}));
      if(baseline)builder.onLoad({filter:/app\/admin\/pricesetter\/page\.tsx$/},()=>({contents:execFileSync("git",["show",baseline+":app/admin/pricesetter/page.tsx"],{cwd:root,encoding:"utf8"}),loader:"tsx"}));
    }}],
  })
  const server=http.createServer((req,res)=>{
    res.setHeader("Content-Type",req.url==="/fixture.js"?"text/javascript":"text/html");
    res.end(req.url==="/fixture.js"?bundle.outputFiles[0].contents:'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    const {chromium}=require("playwright");
    browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE_PATH?{executablePath:process.env.CHROME_EXECUTABLE_PATH}:{})});
    const context=await browser.newContext({viewport:{width:1400,height:900}});
    const errors=[],blocked=[];
    await context.route("**/*",async route=>{const url=new URL(route.request().url());if(url.origin===origin){
      if(url.pathname==="/api/admin/report-publication"){assert.equal(route.request().method(),"GET");return route.fulfill({json:reportPublicationBaseline(url.searchParams.get("report"))})}
      if(url.pathname==="/api/admin/prices/creation") {
        const result=await route.request().frame().evaluate(input=>{
          const state=window.__portListHarness;
          if(input){if(state.recovery.pending?.requestId===input.requestId)state.recovery.pending=null;return {actorId:input.actorId,requestId:input.requestId,acknowledged:true}}
          return structuredClone(state.recovery);
        },route.request().method()==="POST"?route.request().postDataJSON():null)
        return route.fulfill({json:result})
      }
      if(url.pathname==="/api/admin/prices") {
        if(route.request().method()==="GET") {
          const result=await route.request().frame().evaluate(async()=>{
            const state=window.__portListHarness;state.reads.push("ports");
            if(["loadError","loadThrow"].includes(state.mode))return {status:503,body:{message:"Could not load complete saved ports"}};
            if(state.mode==="loadMalformed")return {status:200,body:{unexpected:true}};
            const loaded=structuredClone(state.ports);
            if(state.mode==="loadDefer")await new Promise(resolve=>{state.release=resolve});
            if(state.mode==="loadBadRow")return {status:200,body:{version:1,count:1,ports:[null]}};
            return {status:200,body:{version:1,count:loaded.length,ports:loaded}};
          });
          return route.fulfill({status:result.status,json:result.body});
        }
        assert.ok(["PUT","DELETE"].includes(route.request().method()))
        if(route.request().method()==="PUT") {
          const result=await route.request().frame().evaluate(async input=>{
            const state=window.__portListHarness;
            state.writes.push({table:"ports",action:"insert",input});
            if(state.mode==="insertDefer")await new Promise(resolve=>{state.release=resolve});
            if(["insertError","insertThrow"].includes(state.mode))return {status:503,body:{message:"Could not confirm addition. Reload saved ports to check."}};
            if(state.mode==="insertEmpty")return {status:200,body:{}};
            const row={id:crypto.randomUUID(),name:input.kind==="divider"?"Section":"New Port",type:input.kind,display_order:11,
              lat:null,lng:null,hsfo:null,vlsfo:null,mgo:null,hsfo_formula:null,vlsfo_formula:null,mgo_formula:null,updated_at:null};
            state.ports.push(row);
            state.recovery={actorId:input.actorId,version:String(Number(state.recovery.version)+1),pending:{requestId:input.requestId,kind:input.kind}};
            return {status:200,body:{requestId:input.requestId,portId:row.id,kind:input.kind,replayed:false,port:row}};
          },route.request().postDataJSON())
          return route.fulfill({status:result.status,json:result.body})
        }
        const result=await route.request().frame().evaluate(async input=>{
          const state=window.__portListHarness;
          state.writes.push({table:"ports",action:"delete",input});
          if(state.mode==="deleteDefer")await new Promise(resolve=>{state.release=resolve});
          if(["deleteError","deleteThrow"].includes(state.mode))return {status:503,body:{message:"Could not confirm deletion. Reload saved ports to check."}};
          if(state.mode==="deleteEmpty")return {status:200,body:{}};
          state.ports=state.ports.filter(row=>row.id!==input.portId);
          return {status:200,body:{deletedId:input.portId,replayed:false}};
        },route.request().postDataJSON())
        return route.fulfill({status:result.status,json:result.body})
      }
      return route.continue()}blocked.push(route.request().url());return route.abort()});
    const page=await context.newPage();page.setDefaultTimeout(8000);page.on("pageerror",error=>errors.push(error.message));
    const portAlerts=()=>page.getByRole("alert").filter({hasText:/Could not confirm|could not be confirmed|Could not load saved ports/});
    const button=name=>page.getByRole("button",{name,exact:true});
    const writes=()=>page.evaluate(()=>window.__portListHarness.writes);
    const row=()=>page.locator("tr").filter({has:page.locator('input[value="Hong Kong"]')});
    async function menu(name){await button("☰").click();await button(name).click()}
    async function reset(query=""){await page.goto(origin+query);await page.locator('input[value="Hong Kong"]').waitFor()}
    async function confirmDelete(){page.once("dialog",dialog=>dialog.accept());await row().getByRole("button",{name:"Delete",exact:true}).click()}
    await reset();await menu("Show Delete Buttons");await page.evaluate(()=>{window.__portListHarness.mode="deleteError"});
    await confirmDelete();
    if(baseline){
      await page.locator('input[value="Hong Kong"]').waitFor({state:"detached"});
      assert.equal(await page.evaluate(()=>window.__portListHarness.ports.some(row=>row.id==="00000000-0000-4000-8000-000000000001")),true);
      assert.equal(await portAlerts().count(),0);
      console.log("REPRODUCED: failed database deletion removes the row from the UI without warning, but saved port still exists");
      return;
    }
    await portAlerts().waitFor();assert.equal(await row().count(),1);
    assert.equal(await row().getByRole("button",{name:"Delete",exact:true}).isDisabled(),true,"an uncertain delete must be checked before another deletion");
    await button("Reload saved ports").click();await page.locator('input[value="Hong Kong"]').waitFor();
    await portAlerts().waitFor({state:"hidden"});
    assert.equal(await portAlerts().count(),0);
    for(const mode of ["deleteThrow","deleteEmpty"]){
      await reset();await menu("Show Delete Buttons");await page.evaluate(mode=>{window.__portListHarness.mode=mode},mode);await confirmDelete();
      await portAlerts().waitFor();assert.equal(await row().count(),1);
    }
    await reset();await menu("Show Delete Buttons");page.once("dialog",dialog=>dialog.dismiss());await row().getByRole("button",{name:"Delete",exact:true}).click();assert.deepEqual(await writes(),[]);
    await confirmDelete();await page.locator('input[value="Hong Kong"]').waitFor({state:"detached"});assert.equal((await writes()).length,1);
    console.log("PASS: failed, rejected and unconfirmed deletes preserve the row; cancellation never writes; confirmed deletion removes only that port");

    for(const mode of ["loadError","loadThrow","loadMalformed","loadBadRow"]){
      await page.goto(origin+"?mode="+mode);await portAlerts().waitFor();
      assert.equal(await button("Publish China").isDisabled(),true);assert.deepEqual(await writes(),[]);
      await menu("Show Delete Buttons");await button("☰").click();assert.equal(await button("Add Port").isDisabled(),true);await button("☰").click();
      await page.evaluate(()=>{window.__portListHarness.mode="success"});await button("Try loading again").click();await page.locator('input[value="Hong Kong"]').waitFor();assert.equal(await portAlerts().count(),0);
    }
    await page.goto(origin+"?mode=loadDefer");await page.waitForFunction(()=>Boolean(window.__portListHarness.release));
    assert.equal(await button("Publish China").isDisabled(),true);await page.evaluate(()=>window.__portListHarness.release());await page.locator('input[value="Hong Kong"]').waitFor();
    await page.clock.install();
    await page.goto(origin+"?mode=loadDefer");await page.waitForFunction(()=>Boolean(window.__portListHarness.release));
    await page.clock.fastForward(15_001);await portAlerts().waitFor();
    await page.evaluate(()=>{window.__portListHarness.mode="success";window.__portListHarness.ports[0].name="Newer saved port"});
    await button("Try loading again").click();await page.locator('input[value="Newer saved port"]').waitFor();
    await page.evaluate(()=>window.__portListHarness.release());
    assert.equal(await page.locator('input[value="Hong Kong"]').count(),0,"late timed-out read cannot overwrite a successful retry");
    await page.clock.resume();
    console.log("PASS: load errors, malformed rows and rejected reads pause writes; retry recovers; initial loading cannot publish");

    for(const label of ["Add Port","Add Divider"]){
      for(const mode of ["insertError","insertThrow","insertEmpty"]){
        await reset();await page.evaluate(mode=>{window.__portListHarness.mode=mode},mode);await menu(label);await portAlerts().waitFor();
        assert.equal(await page.locator('table:not([aria-label]) tbody tr').count(),2);
        await button("☰").click();assert.equal(await button("Add Port").isDisabled(),true,"uncertain additions cannot be repeated before reconciliation");await button("☰").click();
        await page.evaluate(()=>{window.__portListHarness.mode="success"});await button("Reload saved ports").click();await page.locator('input[value="Hong Kong"]').waitFor();
        await menu(label);await page.locator('input[value="'+(label==="Add Port"?"New Port":"Section")+'"]').waitFor();
        assert.equal(await page.locator('table:not([aria-label]) tbody tr').count(),3);assert.equal(await portAlerts().count(),0);
        assert.deepEqual(Object.keys((await writes()).at(-1).input).sort(),["actorId","expectedVersion","kind","operation","requestId"],"client binds the server recovery state but cannot supply a port name, port identity, prices or order");
        assert.equal((await writes()).at(-1).input.actorId,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        assert.equal((await writes()).at(-1).input.expectedVersion,"0");
        assert.equal(await page.evaluate(()=>window.__portListHarness.ports.at(-1).display_order),11,"row uses server-allocated append order");
        assert.equal((await writes())[0].input.requestId,(await writes()).at(-1).input.requestId,"explicit recovery retries the same allocation");
      }
    }
    await reset();await page.evaluate(()=>{window.__portListHarness.mode="insertDefer"});await menu("Add Port");await page.waitForFunction(()=>Boolean(window.__portListHarness.release));
    assert.equal(await button("Publish China").isDisabled(),true);assert.equal(await page.getByPlaceholder("price").first().isDisabled(),true);
    await button("☰").click();assert.equal(await button("Add Divider").isDisabled(),true);await button("☰").click();await page.evaluate(()=>window.__portListHarness.release());await page.locator('input[value="New Port"]').waitFor();assert.equal((await writes()).length,1);
    console.log("PASS: failed additions leave existing rows intact; explicit recovery, correct append order and in-flight write locking");

    await reset();await page.getByPlaceholder("price").first().fill("777");await menu("Show Delete Buttons");await page.evaluate(()=>{window.__portListHarness.mode="deleteError"});await confirmDelete();await portAlerts().waitFor();
    page.once("dialog",dialog=>dialog.dismiss());await button("Reload saved ports").click();assert.equal(await page.getByPlaceholder("price").first().inputValue(),"777","cancelled reload preserves unsaved drafts");
    page.once("dialog",dialog=>dialog.accept());await button("Reload saved ports").click();await page.waitForFunction(()=>document.querySelector('input[placeholder="price"]')?.value==="600");
    await reset("?access=view");await button("☰").click();assert.equal(await button("Add Port").isDisabled(),true);assert.equal(await button("Add Divider").isDisabled(),true);await button("☰").click();await menu("Show Delete Buttons");assert.equal(await row().getByRole("button",{name:"Delete",exact:true}).isDisabled(),true);assert.deepEqual(await writes(),[]);
    assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
    console.log("PASS: reload requires consent to discard a draft; View remains read-only; no browser errors or external requests");
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve))}
}
main().catch(error=>{console.error(error);process.exitCode=1});
