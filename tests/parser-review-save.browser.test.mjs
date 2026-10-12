// Real review component in React StrictMode, owned isolated headless Chromium.
// Deferred synthetic same-origin APIs only; all external traffic is blocked.
import assert from "node:assert/strict"
import http from "node:http"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const version = "2026-10-12T00:00:00.123456+00:00"
const entry = `
  import React from "react";
  import {createRoot} from "react-dom/client";
  import {ParserReportReviewPanel} from "./components/ParserReportReviewPanel";
  const root=createRoot(document.getElementById("root"));
  const rows=["HUMAN","AI"].map(id=>({id,context:"shortened-enquiry",rawText:"RAW "+id,parserOutput:"PARSER "+id,correctedOutput:"CORRECTION "+id,note:"NOTE "+id,metadata:{guesses:{vesselName:id},aiFixOutput:id==="AI"?"SAVED AI":"",aiSources:id==="AI"?[{url:"https://example.test/imo",title:"Saved source"}]:[]},lastReportedAt:"2026-10-12T00:00:00Z",updatedAt:${JSON.stringify(version)}}));
  window.__saves=[];window.__ai=[];window.__notices=[];window.__loads=0;window.__reads=[];window.__deferReads=false;
  window.addEventListener("fcuno:parser-report-count-changed",event=>window.__notices.push(event.detail));
  window.fetch=(url,init={})=>{
    if(String(url).startsWith("/api/parser-reports")){
      if(init.method==="POST")return new Promise((resolve,reject)=>window.__saves.push({body:JSON.parse(init.body),resolve,reject}));
      window.__loads++;
      if(window.__deferReads)return new Promise((resolve,reject)=>window.__reads.push({resolve,reject}));
      return Promise.resolve(Response.json({pendingAiReports:rows.filter(row=>row.id==="AI"),readyForUserReports:rows.filter(row=>row.id==="HUMAN")}));
    }
    if(url==="/api/parser-ai")return new Promise((resolve,reject)=>window.__ai.push({body:JSON.parse(init.body),resolve,reject}));
    throw Error("Unexpected synthetic request: "+url);
  };
  window.__mount=(source="enquiryworksheet",canEdit=true)=>root.render(<React.StrictMode><ParserReportReviewPanel source={source} canEdit={canEdit}/></React.StrictMode>);
  window.__unmount=()=>root.render(null);
  window.__replyRead=(index,correction)=>window.__reads[index].resolve(Response.json(correction===undefined?{pendingAiReports:rows.filter(row=>row.id==="AI"),readyForUserReports:rows.filter(row=>row.id==="HUMAN")}:{pendingAiReports:[{...rows[0],correctedOutput:correction}],readyForUserReports:[]}));
  window.__reply=(index,status=200,body)=>{
    const request=window.__saves[index];
    request.resolve(Response.json(body===undefined?{success:true,report:{...rows.find(row=>row.id===request.body.id),correctedOutput:request.body.correctedOutput,note:request.body.note,metadata:{...rows.find(row=>row.id===request.body.id).metadata,aiReviewState:request.body.action==="submit-ai"?"pending-ai":"complete"},updatedAt:"2026-10-12T00:00:00."+String(123457+index).padStart(6,"0")+"+00:00"}}:body,{status}));
  };
  window.__mount(new URLSearchParams(location.search).get("source")||"enquiryworksheet");
`
const bundle = await build({ absWorkingDir: root, stdin: { contents: entry, resolveDir: root, loader: "tsx" }, outfile: "fixture.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } })
const javascript = bundle.outputFiles[0].contents
const server = http.createServer((req,res) => {
  if (req.url.split("?")[0] === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(javascript) }
  res.setHeader("Content-Type", "text/html")
  res.end('<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>')
})
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let browser
try {
  const { chromium } = require("playwright")
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" })
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } })
  const page = await context.newPage(), errors = [], blocked = []
  page.setDefaultTimeout(7000)
  page.on("pageerror",error => errors.push(error.message))
  await context.route("**/*",route => {
    if (new URL(route.request().url()).origin === origin) return route.continue()
    blocked.push(route.request().url()); return route.abort()
  })
  const button = name => page.getByRole("button",{name,exact:true})
  const correction = () => page.getByRole("textbox",{name:"Correct Version",exact:true})
  const note = () => page.getByRole("textbox",{name:"Note",exact:true})
  async function settled() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }
  async function reset(source="enquiryworksheet") { await page.goto(`${origin}/?source=${source}`); await button("HUMAN").waitFor(); await settled() }
  async function open(kind) { await button(kind).click(); await settled() }
  async function save(action) {
    const target = action === "submit-ai" ? "Pass To AI Review" : "Complete AI Review"
    await button(target).evaluate(node => {
      const key = Object.keys(node).find(key => key.startsWith("__reactProps$")); node[key].onClick(); node[key].onClick()
    })
    await page.waitForFunction(() => window.__saves.length > 0)
    return page.evaluate(() => window.__saves.length-1)
  }
  async function snapshot() { return page.locator('[role="dialog"] textarea,[role="dialog"] input').evaluateAll(nodes => nodes.map(node => node.value)) }
  async function reply(index,status=200,body) { await page.evaluate(({index,status,body}) => window.__reply(index,status,body),{index,status,body}); await settled() }

  for (const source of ["enquiryworksheet","spc"]) {
    for (const action of ["submit-ai","review"]) {
      await reset(source); await open(action === "submit-ai" ? "HUMAN" : "AI")
      if (action === "submit-ai") await correction().fill("KEEP MY CORRECTION")
      await note().fill("KEEP MY NOTE")
      const before = await snapshot(), index = await save(action)
      assert.equal(await page.evaluate(() => window.__saves.length),1,"same-render clicks send only one save")
      const sent = await page.evaluate(() => window.__saves[0].body)
      assert.equal(sent.expectedUpdatedAt,version); assert.equal(sent.source,source); assert.equal(sent.action,action)
      assert.equal(await correction().getAttribute("readonly"),""); assert.equal(await note().getAttribute("readonly"),"")
      const loads = await page.evaluate(() => window.__loads)
      await button("Refresh").click({force:true})
      assert.equal(await page.evaluate(() => window.__loads),loads,"refresh while a save is pending cannot replace the opened draft")
      await note().evaluate(node => { const key=Object.keys(node).find(key=>key.startsWith("__reactProps$")); node[key].onChange({target:{value:"LATE TYPING"}}) })
      assert.deepEqual(await snapshot(),before,"pending edits cannot be accepted and then silently discarded")
      await reply(index,409,{code:"PARSER_REPORT_CONFLICT",message:"This report changed in another session. Your draft has been kept; reload the latest report before saving."})
      await page.getByRole("dialog").getByRole("alert").waitFor()
      assert.deepEqual(await snapshot(),before); assert.equal(await page.evaluate(() => window.__notices.length),0)
      assert.equal(await button(action === "submit-ai" ? "Pass To AI Review" : "Complete AI Review").isDisabled(),false)
      const retry = await save(action)
      assert.equal(await page.evaluate(() => window.__saves.at(-1).body.expectedUpdatedAt),version,"a conflict cannot silently rebase the user's correction")
      await reply(retry,200,{success:true})
      await page.getByRole("dialog").getByRole("alert").getByText(/save could not be confirmed/).waitFor()
      assert.deepEqual(await snapshot(),before)
      const failure = await save(action)
      await page.evaluate(index => window.__saves[index].reject(new Error("SYNTHETIC NETWORK FAILURE")),failure)
      await page.getByRole("dialog").getByText("SYNTHETIC NETWORK FAILURE",{exact:true}).waitFor()
      assert.deepEqual(await snapshot(),before)
      console.log(`PASS ${source} ${action}: exact version, same-tick ownership, visible conflict/error/uncertain success, retained complete draft`)
    }
  }

  for (const source of ["enquiryworksheet","spc"]) {
    await reset(source); await open("HUMAN")
    await correction().fill("SUCCESSFUL CORRECTION"); await note().fill("SUCCESSFUL NOTE")
    await reply(await save("submit-ai"))
    await page.getByText("Correction saved and passed to AI review.",{exact:true}).waitFor()
    assert.equal(await page.getByRole("dialog").count(),0)
    await open("HUMAN")
    assert.equal(await correction().inputValue(),"SUCCESSFUL CORRECTION")
    assert.equal(await note().inputValue(),"SUCCESSFUL NOTE")
    assert.equal(await button("Complete AI Review").isDisabled(),false,"the successful save's finally cannot leave later dialogs locked")
    await reply(await save("review"))
    await page.getByText("AI review completed and case closed.",{exact:true}).waitFor()
    assert.deepEqual(await page.evaluate(() => window.__notices),[{source},{source}])
  }
  console.log("PASS both sources: successful human/AI saves close correctly, preserve normal queues, unlock the next dialog, notify once")

  for (const oldFails of [false,true]) {
    await reset(); await open("HUMAN"); const old = await save("submit-ai")
    await page.evaluate(() => window.__mount("spc")); await button("HUMAN").waitFor(); await settled()
    await open("HUMAN"); await note().fill("NEW SOURCE NOTE"); const current = await save("submit-ai"), before = await snapshot()
    if (oldFails) await page.evaluate(index => window.__saves[index].reject(new Error("STALE SAVE FAILURE")),old)
    else await reply(old)
    await settled(); assert.deepEqual(await snapshot(),before)
    assert.equal(await button("Saving...").isDisabled(),true)
    assert.equal(await page.evaluate(() => window.__notices.length),0)
    await reply(current,409,{message:"CURRENT SOURCE CONFLICT"})
    await page.getByRole("dialog").getByText("CURRENT SOURCE CONFLICT",{exact:true}).waitFor()
    assert.equal(await page.getByText("STALE SAVE FAILURE",{exact:true}).count(),0)
  }
  console.log("PASS source remount: old save success/error/finally cannot discard or unlock a different source draft")

  await reset(); await open("AI"); await button("AI Fix").click(); await page.waitForFunction(() => window.__ai.length===1)
  const pending = await save("review"), before = await snapshot()
  await page.evaluate(() => window.__ai[0].resolve(Response.json({correctedOutput:"STALE AI WHILE SAVING",imoSources:[]})))
  await settled(); assert.deepEqual(await snapshot(),before)
  await reply(pending,409,{message:"KEEP CURRENT DRAFT"})
  await page.getByRole("dialog").getByText("KEEP CURRENT DRAFT",{exact:true}).waitFor()
  assert.equal(await page.getByRole("textbox",{name:"AI Fix",exact:true}).inputValue(),"SAVED AI")
  assert.equal(await page.getByRole("link",{name:"Saved source",exact:true}).getAttribute("href"),"https://example.test/imo")
  console.log("PASS saving cancels stale AI ownership while retaining saved AI output and its source")

  for (const oldFails of [false,true]) {
    for (const oldFirst of [false,true]) {
      await reset(); await open("HUMAN"); await correction().fill("SAVED CURRENT CORRECTION")
      await page.evaluate(() => { window.__deferReads=true }); await button("Refresh").click({force:true})
      await page.waitForFunction(() => window.__reads.length===1)
      await reply(await save("submit-ai")); await page.getByText("Correction saved and passed to AI review.",{exact:true}).waitFor()
      if (!oldFirst) {
        if (oldFails) await page.evaluate(() => window.__reads[0].reject(new Error("STALE LIST FAILURE")))
        else await page.evaluate(() => window.__replyRead(0))
        await settled(); await open("HUMAN")
        assert.equal(await correction().inputValue(),"SAVED CURRENT CORRECTION")
        assert.equal(await button("Complete AI Review").isDisabled(),false,"an old GET cannot resurrect the pending-human queue after save")
        await button("Cancel").click()
      }
      await button("Refresh").click(); await page.waitForFunction(() => window.__reads.length===2)
      if (oldFirst) {
        if (oldFails) await page.evaluate(() => window.__reads[0].reject(new Error("STALE LIST FAILURE")))
        else await page.evaluate(() => window.__replyRead(0))
        await settled()
        assert.equal(await button("Loading...").isDisabled(),true,"stale GET finally cannot unlock a newer list read")
      }
      await page.evaluate(() => window.__replyRead(1,"NEWEST LOADED CORRECTION")); await settled(); await open("HUMAN")
      assert.equal(await correction().inputValue(),"NEWEST LOADED CORRECTION")
      assert.equal(await page.getByText("STALE LIST FAILURE",{exact:true}).count(),0)
    }
  }
  console.log("PASS late GET: saved queues stay current; stale success/error/finally cannot overwrite or unlock a newer list read")

  await reset(); await open("HUMAN")
  await page.evaluate(() => { window.__deferReads=true }); await button("Refresh").click({force:true}); await page.waitForFunction(() => window.__reads.length===1)
  await page.evaluate(() => window.__mount("spc")); await page.waitForFunction(() => window.__reads.length===2)
  await page.evaluate(() => window.__reads[0].reject(new Error("OLD SOURCE LIST FAILURE")))
  await settled(); assert.equal(await button("Loading...").isDisabled(),true)
  await page.evaluate(() => window.__replyRead(1,"CURRENT SOURCE CORRECTION")); await settled(); await open("HUMAN")
  assert.equal(await correction().inputValue(),"CURRENT SOURCE CORRECTION")
  assert.equal(await page.getByText("OLD SOURCE LIST FAILURE",{exact:true}).count(),0)
  console.log("PASS list source remount: abandoned read cannot affect the new source session")

  assert.deepEqual(errors,[]); assert.deepEqual(blocked,[])
  await context.close()
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
