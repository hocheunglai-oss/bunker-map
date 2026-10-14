/* Actual history pages, isolated browser, synthetic read-only data/session.
 * --baseline-ref=<immutable commit> reproduces the old date/grouping defects.
 * No production connections, credentials, publications or personal tabs. */
const assert = require("node:assert/strict")
const http = require("node:http")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const { build } = require("esbuild")

async function main() {
  const root = path.resolve(__dirname, "..")
  const baseline = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.split("=")[1]
  if (baseline && !/^[a-f0-9]{40}$/.test(baseline)) throw Error("Baseline must be an immutable commit SHA")
  const mocks = `
    const ids={K:"11111111-1111-4111-8111-111111111111",T:"22222222-2222-4222-8222-222222222222",H:"33333333-3333-4333-8333-333333333333"};
    const ports = [{id:ids.K,name:"Kaohsiung"},{id:ids.T,name:"Taichung"},{id:ids.H,name:"Hong Kong"}].map(p=>({...p,lat:null,lng:null,hsfo:null,vlsfo:null,mgo:null,hsfo_formula:null,vlsfo_formula:null,mgo_formula:null,updated_at:null}));
    let rowId=0;
    const row=(id,port_id,recorded_at,price)=>({id:"44444444-4444-4444-8444-"+String(++rowId).padStart(12,"0"),port_id:ids[port_id],recorded_at,hsfo:price,vlsfo:price,mgo:price});
    const rows = [
      row("k-new","K","2026-10-01T23:30:00.000001",600),
      row("h-oct","H","2026-10-01T23:30:00",600),
      row("t-oct","T","2026-10-01T22:00:00",700),
      row("k-old","K","2026-10-01T20:00:00",100),
      row("k-sept","K","2026-09-30T23:30:00",500),
      row("h-sept","H","2026-09-30T23:30:00",500),
      row("t-sept","T","2026-09-30T22:00:00",550)
    ];
    window.__historyHarness={reads:[],writes:[]};
    window.fetch=async (url,options={})=>{
      if(options.method&&options.method!=="GET")throw Error("Unexpected mutation");
      const market=new URL(url,location.origin).searchParams.get("market");
      const names=market==="taiwan"?["Kaohsiung","Taichung"]:["Hong Kong"];
      const selected=ports.filter(p=>names.includes(p.name));
      window.__historyHarness.reads.push("ports","price_history");
      return new Response(JSON.stringify({market,ports:selected,rows:rows.filter(r=>selected.some(p=>p.id===r.port_id))}),{status:200});
    };
    export function useSimpleAdminAuth(){return {loading:false,authenticated:true,role:"ADMIN",permissions:{}};}
    export const supabase={from(table){
      if(!["ports","price_history","remarks"].includes(table))throw Error("Unexpected table "+table);
      const filters=[];let one=false,limit=null;
      const query={
        select(){return query},eq(key,value){filters.push(r=>r[key]===value);return query},
        in(key,values){filters.push(r=>values.includes(r[key]));return query},
        order(){return query},limit(n){limit=n;return query},single(){one=true;return query},maybeSingle(){one=true;return query},
        then(resolve,reject){return Promise.resolve().then(()=>{
          window.__historyHarness.reads.push(table);
          let data=(table==="ports"?ports:table==="price_history"?rows:[]).filter(r=>filters.every(f=>f(r)));
          if(limit!==null)data=data.slice(0,limit);
          return {data:structuredClone(one?data[0]??null:data),error:null};
        }).then(resolve,reject)}
      };
      for(const method of ["insert","update","upsert","delete"]){query[method]=()=>{window.__historyHarness.writes.push({table,method});throw Error("Unexpected mutation")};}
      return query;
    }};
  `
  const bundle = await build({
    absWorkingDir:root,
    stdin:{contents:'import React from "react"; import {createRoot} from "react-dom/client"; import HK from "./app/admin/hongkongpricehistory/page"; import TW from "./app/admin/taiwanpricehistory/page"; const Page=location.pathname==="/taiwan"?TW:HK; createRoot(document.getElementById("root")).render(<Page/>);',resolveDir:root,loader:"tsx"},
    bundle:true,write:false,platform:"browser",format:"iife",jsx:"automatic",define:{"process.env.NODE_ENV":'"development"'},
    plugins:[{name:"read-only-boundaries",setup(builder){
      builder.onResolve({filter:/^@\/lib\/(supabase|useSimpleAdminAuth)$/},()=>({path:"mocks",namespace:"fixture"}))
      builder.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:mocks,loader:"js"}))
      if(baseline)builder.onLoad({filter:/app\/admin\/(hongkong|taiwan)pricehistory\/page\.tsx$/},args=>({
        contents:execFileSync("git",["show",`${baseline}:${path.relative(root,args.path)}`],{cwd:root,encoding:"utf8"}),loader:"tsx"
      }))
    }}],
  })
  const html='<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;font-family:Arial}button,input,select{font:inherit}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'
  const server=http.createServer((request,response)=>{
    response.setHeader("Content-Type",request.url==="/fixture.js"?"text/javascript":"text/html")
    response.end(request.url==="/fixture.js"?bundle.outputFiles[0].contents:html)
  })
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve))
  const origin=`http://127.0.0.1:${server.address().port}`
  let browser
  try {
    const {chromium}=require("playwright")
    browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE_PATH?{executablePath:process.env.CHROME_EXECUTABLE_PATH}:{})})
    const zones=baseline?["America/Los_Angeles"]:["America/Los_Angeles","Pacific/Kiritimati","Asia/Hong_Kong"]
    for(const timezoneId of zones){
      const context=await browser.newContext({timezoneId,viewport:{width:1400,height:950}})
      const errors=[],blocked=[]
      await context.route("**/*",route=>{
        if(new URL(route.request().url()).origin===origin)return route.continue()
        blocked.push(route.request().url());return route.abort()
      })
      const page=await context.newPage();page.setDefaultTimeout(8000)
      page.on("pageerror",error=>errors.push(error.message))
      for(const market of ["hongkong","taiwan"]){
        await page.goto(`${origin}/${market}`)
        await page.locator("tbody tr").first().waitFor()
        const data=()=>page.locator("tbody tr").evaluateAll(rows=>rows.map(row=>Array.from(row.querySelectorAll("td"),cell=>cell.textContent.trim())))
        const initial=await data()
        assert.equal(initial[0][0],baseline?"02 Oct 2026":"01 Oct 2026")
        assert.equal(initial[0][1],baseline&&market==="taiwan"?"100":"600")
        if(market==="taiwan")assert.equal(initial[0][3],"700")
        await page.getByRole("combobox",{name:/^Year\b/}).selectOption("2026")
        await page.getByRole("combobox",{name:/^Month\b/}).selectOption("10")
        const filtered=await data()
        assert.equal(filtered.length,baseline?2:1)
        const average=await page.getByText("Monthly Average",{exact:true}).locator("..").innerText()
        assert.match(average,new RegExp(`HSFO: ${baseline?(market==="taiwan"?300:550):600}(?: \\||$)`))
        const state=await page.evaluate(()=>window.__historyHarness)
        assert.deepEqual(state.writes,[])
        assert.ok(state.reads.includes("ports")&&state.reads.includes("price_history"))
        console.log(`${baseline?"REPRODUCED":"PASS"}: ${market} in ${timezoneId}: date ${initial[0][0]}, first price ${initial[0][1]}, October rows ${filtered.length}, correct ${baseline?"defect baseline":"monthly average"}`)
        if(!baseline)for(const width of [320,390]){
          await page.setViewportSize({width,height:950})
          const label=market==="taiwan"?"Taiwan":"Hong Kong"
          const region=page.getByRole("region",{name:`${label} price history table`,exact:true})
          assert.equal(await region.getAttribute("tabindex"),"0")
          const layout=await region.evaluate(element=>{
            const cells=[...element.querySelector("tbody tr").querySelectorAll("td")].map(cell=>{
              const box=cell.getBoundingClientRect();return {left:box.left,right:box.right,width:box.width}
            })
            return {page:document.documentElement.scrollWidth,viewport:innerWidth,width:element.clientWidth,scroll:element.scrollWidth,cells}
          })
          assert.ok(layout.page<=layout.viewport,`${market} must contain mobile horizontal overflow`)
          assert.ok(layout.scroll>layout.width,`${market} must scroll rather than compress its columns`)
          assert.ok(layout.cells[0].width>=140,`${market} date must remain readable`)
          for(let index=1;index<layout.cells.length;index++)assert.ok(layout.cells[index].left>=layout.cells[index-1].right-1)
          await region.evaluate(element=>{element.scrollLeft=0})
          await region.focus();await page.keyboard.press("ArrowRight")
          await page.waitForFunction(name=>document.querySelector(`[aria-label="${name} price history table"]`).scrollLeft>0,label)
          if(market==="taiwan"){
            const entry=page.getByRole("region",{name:"Taiwan history price entry fields",exact:true})
            await entry.evaluate(element=>{element.scrollLeft=element.scrollWidth})
            const reachable=await entry.evaluate(element=>{
              const region=element.getBoundingClientRect(),button=[...element.querySelectorAll("button")].find(item=>item.textContent==="Add As Latest").getBoundingClientRect()
              return {scrolled:element.scrollLeft>0,visible:button.left>=region.left&&button.right<=region.right+1}
            })
            assert.deepEqual(reachable,{scrolled:true,visible:true},"Taiwan entry action must be reachable at the scroll end")
          }
          console.log(`PASS: ${market} ${width}px contained readable table, keyboard scrolling and reachable entry actions`)
        }
        await page.setViewportSize({width:1400,height:950})
      }
      assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
      await context.close()
    }
  } finally {
    if(browser)await browser.close()
    await new Promise(resolve=>server.close(resolve))
  }
}
main().catch(error=>{console.error(error);process.exitCode=1})
