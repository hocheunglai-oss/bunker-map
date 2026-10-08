/* Real Price Setter component, isolated headless browser and synthetic data.
 * Never signs into production, publishes a real report, or controls personal tabs. */
const assert = require("node:assert/strict")
const http = require("node:http")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const { build } = require("esbuild")

async function main() {
  const root = path.resolve(__dirname, "..")
  const baseline = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.split("=")[1]
  if(baseline && !/^[a-f0-9]{40}$/i.test(baseline))throw Error("Baseline must be an exact commit SHA")
  const mocks = `
    const names = ["Hong Kong","Kaohsiung","Taichung","Keelung","Suao","Hualien","Dalian","Singapore"];
    const state = window.__priceHarness = {
      mode:"success", reads:[], writes:[], release:null,
      ports:names.map((name,index)=>({id:String(index+1),name,hsfo:600,vlsfo:800,mgo:1000,updated_at:"2026-10-08T01:00:00Z",display_order:index+1})),
      remarks:[{id:1,content:"KEEP EXISTING REMARK"},{id:2,content:"KEEP EXISTING NOTICE\\nKEEP SECOND LINE"}]
    };
    export function useSimpleAdminAuth(){const access=new URLSearchParams(location.search).get("access")||"edit";return {loading:false,authenticated:true,role:"BT",permissions:{pricesetter:access}}}
    export function useIsMobile(){return false}
    export const supabase={from(table){
      let action="read", payload, filters=[], fields;
      const q={
        select(value){fields=value;return q}, order(){return q}, in(key,value){filters.push([key,value]);return q},
        eq(key,value){filters.push([key,[value]]);return q}, maybeSingle(){return q}, single(){return q},
        upsert(value){action="write";payload=value;return q},
        then(resolve,reject){return (async()=>{
          if(action==="write"){
            state.writes.push({table,payload:structuredClone(payload)});
            if(state.mode==="saveError")return {data:null,error:{message:"Synthetic publish failure"}};
            if(state.mode==="saveThrow")throw Error("Synthetic transport failure");
            if(state.mode==="deferSave")await new Promise(resolve=>{state.release=resolve});
            return {data:{id:payload.id},error:null};
          }
          const kind=table==="ports"?(filters.length?"reportPorts":"initialPorts"):
            table==="price_history"?"history":filters.some(([key,values])=>key==="id"&&values.includes(1))?"notices":"config";
          state.reads.push(kind);
          if(state.mode===kind+"Error")return {data:null,error:{message:"Synthetic "+kind+" error"}};
          if(state.mode===kind+"Throw")throw Error("Synthetic "+kind+" transport failure");
          if(state.mode===kind+"Empty")return {data:[],error:null};
          if(kind==="reportPorts" && state.mode==="missingTaiwanPort")return {data:state.ports.filter(row=>row.name!=="Hualien"&&filters.every(([key,values])=>values.includes(row[key]))),error:null};
          if(kind==="reportPorts" && state.mode==="invalidDate")return {data:state.ports.filter(row=>filters.every(([key,values])=>values.includes(row[key]))).map(row=>({...row,updated_at:"not-a-date"})),error:null};
          if(table==="ports")return {data:state.ports.filter(row=>filters.every(([key,values])=>values.includes(row[key]))),error:null};
          if(table==="price_history")return {data:state.ports.filter(row=>filters.every(([key,values])=>key!=="port_id"||values.includes(row.id))).map(row=>({id:row.id,port_id:row.id,hsfo:600,vlsfo:800,mgo:1000,recorded_at:"2026-10-08T01:00:00Z"})),error:null};
          if(kind==="notices")return {data:structuredClone(state.remarks),error:null};
          return {data:fields==="content"?null:[],error:null};
        })().then(resolve,reject)}
      };return q;
    }};
  `
  const bundle = await build({
    absWorkingDir:root, stdin:{contents:'import React from "react";import {createRoot} from "react-dom/client";import Page from "./app/admin/pricesetter/page";createRoot(document.getElementById("root")).render(<Page/>);',resolveDir:root,loader:"tsx"},
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
    const blocked=[],errors=[];
    await context.route("**/*",route=>{if(new URL(route.request().url()).origin===origin)return route.continue();blocked.push(route.request().url());return route.abort()});
    const page=await context.newPage();page.setDefaultTimeout(8000);page.on("pageerror",error=>errors.push(error.message));
    const button=name=>page.getByRole("button",{name:name.replace("Hong Kong","HK"),exact:true});
    const writes=()=>page.evaluate(()=>window.__priceHarness.writes);
    async function reset(mode="success"){
      await page.goto(origin);await page.getByRole("textbox").first().waitFor();
      await page.waitForFunction(()=>window.__priceHarness.reads.includes("initialPorts"));
      await page.evaluate(mode=>{window.__priceHarness.mode=mode},mode);
    }
    await reset("noticesError");
    await button("Publish Taiwan").click();
    if(baseline){
      await button("Published Taiwan").waitFor();
      const saved=(await writes()).find(item=>item.payload.id===101);
      const snapshot=JSON.parse(saved.payload.content);
      assert.equal(snapshot.remark,"");assert.equal(snapshot.specialNotice,"");
      console.log("REPRODUCED: Taiwan publication succeeds with blank remarks/notices after failed notice read");
      return;
    }
    await page.getByRole("alert").waitFor();
    assert.deepEqual(await writes(),[],"failed Taiwan notice read must never overwrite a report");
    assert.equal(await button("Publish Taiwan").isEnabled(),true);
    console.log("PASS: failed Taiwan notice read preserves published reports and exposes retry");

    for(const market of ["China","Compact","Taiwan","Hong Kong"]){
      for(const mode of ["reportPortsError","reportPortsThrow","reportPortsEmpty"]){
        await reset(mode);await button("Publish "+market).click();await page.getByRole("alert").waitFor();
        assert.deepEqual(await writes(),[],market+" "+mode+" must not publish");
        assert.equal(await button("Publish "+market).isEnabled(),true);
      }
    }
    for(const market of ["Taiwan","Hong Kong"]){
      for(const mode of ["historyError","historyThrow","historyEmpty"]){
        await reset(mode);await button("Publish "+market).click();await page.getByRole("alert").waitFor();
        assert.deepEqual(await writes(),[],market+" "+mode+" must not publish");
      }
    }
    await reset("noticesThrow");await button("Publish Taiwan").click();await page.getByRole("alert").waitFor();
    assert.deepEqual(await writes(),[]);
    await reset("missingTaiwanPort");await button("Publish Taiwan").click();await page.getByRole("alert").waitFor();
    assert.deepEqual(await writes(),[],"missing Taiwan port cannot silently shrink the report");
    for(const market of ["China","Compact"]){
      await reset("invalidDate");await button("Publish "+market).click();await page.getByRole("alert").waitFor();
      assert.deepEqual(await writes(),[],"invalid automatic dates cannot reach a report");
    }
    console.log("PASS: all four reports reject failed/empty port reads; history and notice transport failures are caught");

    for(const market of ["China","Compact","Taiwan","Hong Kong"]){
      for(const mode of ["saveError","saveThrow"]){
        await reset(mode);await button("Publish "+market).click();await page.getByRole("alert").waitFor();
        assert.equal(await button("Published "+market).count(),0);
        assert.equal(await button("Publish "+market).isEnabled(),true);
      }
      await reset();await button("Publish "+market).click();await button("Published "+market).waitFor();
      assert.equal((await writes()).length,1);
      assert.equal(await page.getByRole("alert").count(),0);
      if(market==="Taiwan"){
        const snapshot=JSON.parse((await writes())[0].payload.content);
        assert.equal(snapshot.remark,"KEEP EXISTING REMARK");
        assert.equal(snapshot.specialNotice,"KEEP EXISTING NOTICE\nKEEP SECOND LINE");
        assert.equal(snapshot.rows.length,5);
      }
    }
    // A successful retry must clear the previous error, not leave a false alarm behind.
    await reset("noticesError");await button("Publish Taiwan").click();await page.getByRole("alert").waitFor();
    await page.evaluate(()=>{window.__priceHarness.mode="success"});
    await button("Publish Taiwan").click();await button("Published Taiwan").waitFor();
    assert.equal(await page.getByRole("alert").count(),0);
    await reset();
    const price=page.getByPlaceholder("price").first();await price.fill("777");
    for(const market of ["China","Compact","Taiwan","Hong Kong"]){
      await button("Publish "+market).click();
    }
    assert.deepEqual(await writes(),[],"unsaved prices must not look published");
    assert.equal(await page.getByRole("alert").count(),4);

    await reset();await button("Publish Taiwan").click();await button("Published Taiwan").waitFor();
    await page.locator('input[type="date"]').nth(2).fill("2026-10-09");
    assert.equal(await button("Published Taiwan").count(),0,"date edits invalidate the published indicator");
    await page.evaluate(()=>{window.__priceHarness.mode="deferSave"});
    await button("Publish Taiwan").click();
    await page.waitForFunction(()=>Boolean(window.__priceHarness.release));
    assert.equal(await page.locator('input[type="date"]').nth(2).isDisabled(),true,"the publishing date is locked during its request");
    assert.equal(await page.getByPlaceholder("price").first().isDisabled(),true,"prices cannot race a publication");
    await page.evaluate(()=>window.__priceHarness.release());await button("Published Taiwan").waitFor();
    const dated=JSON.parse((await writes()).at(-1).payload.content);
    assert.equal(dated.reportDate,"09 Oct 2026");
    await page.goto(origin+"?access=view");await page.getByRole("textbox").first().waitFor();
    for(const market of ["China","Compact","Taiwan","Hong Kong"]){assert.equal(await button("Publish "+market).isDisabled(),true)}
    assert.equal(await page.getByPlaceholder("price").first().isDisabled(),true);
    assert.deepEqual(await writes(),[],"view-only users cannot initiate a mutation");
    assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
    console.log("PASS: save errors never claim publication; retries preserve notices; unsaved prices blocked; report-date changes invalidate status and cannot race publication; no external requests");
  } finally {
    if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1});
