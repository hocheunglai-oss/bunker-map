/* Isolated headless UI regression. Real page, synthetic database/session only.
 * No live notices are published and no personal browser or tabs are touched. */
const assert = require("node:assert/strict")
const http = require("node:http")
const path = require("node:path")
const { build } = require("esbuild")

async function main() {
  const root = path.resolve(__dirname, "..")
  const mocks = `
    const params = new URLSearchParams(location.search);
    const state = window.__taiwanHarness = {
      rows: [{id:1,content:"EXISTING REMARK"},{id:2,content:"EXISTING NOTICE\\nSECOND EXISTING NOTICE"},{id:3,content:JSON.stringify({active:false,typhoonName:"",expectedReopenDate:""})}],
      writes: [], failLoad: params.has("failLoad"), failNext: false, rejectNext: false, deferNext: false, release: null
    };
    export function useSimpleAdminAuth() { return {loading:false, authenticated:true, role:"BT", permissions:{"taiwan-remarks":params.get("access") || "edit"}}; }
    export const supabase = {from(table) { if(table !== "remarks") throw Error("Unexpected table"); return {
      select() { return {async in() { if(state.failLoad) return {data:null,error:{message:"Synthetic load failure"}}; return {data:structuredClone(state.rows),error:null}; }}; },
      async upsert(rows) {
        state.writes.push(structuredClone(rows));
        if(state.deferNext) { state.deferNext=false; await new Promise(resolve=>{state.release=resolve}); }
        if(state.rejectNext) {state.rejectNext=false; throw Error("Synthetic transport failure");}
        if(state.failNext) {state.failNext=false; return {error:{message:"Synthetic save failure"}};}
        for(const row of rows) { const index=state.rows.findIndex(item=>item.id===row.id); if(index>=0) state.rows[index]=structuredClone(row); else state.rows.push(structuredClone(row)); }
        return {error:null};
      }
    }; }};
  `
  const bundle = await build({
    absWorkingDir: root, stdin: { contents: 'import React from "react"; import {createRoot} from "react-dom/client"; import Page from "./app/admin/taiwanremarks/page"; createRoot(document.getElementById("root")).render(<Page/>);', resolveDir: root, loader: "tsx" },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "synthetic-boundaries", setup(builder) {
      builder.onResolve({filter:/^@\/lib\/(supabase|useSimpleAdminAuth)$/}, () => ({path:"mocks",namespace:"fixture"}))
      builder.onLoad({filter:/.*/,namespace:"fixture"}, () => ({contents:mocks,loader:"js"}))
    }}],
  })
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
    :root{--fc-admin-page-bg:#f4f5f8;--fc-admin-font:Arial,sans-serif;--fc-admin-panel-text:#222;--fc-admin-panel-bg:#fff;--fc-admin-border:#ccd0d8;--fc-admin-border-soft:#dfe2e8;--fc-tool-input-bg:#fff;--fc-admin-button-bg:#f4f5f8;--fc-admin-button-text:#222;--fc-admin-primary-button-bg:#0672ed;--fc-admin-primary-button-text:#fff;--fc-admin-warning-bg:#fff1ca;--fc-admin-warning-text:#392700;--fc-admin-warning-border:#e2b74e;--fc-admin-success-bg:#21883a;--fc-admin-success-text:#fff;--fc-admin-danger-text:#b00020;} body{margin:0;font-family:Arial} button,input,select{font:inherit}button:disabled{opacity:.5}
    </style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`
  const server = http.createServer((request,response) => {
    response.setHeader("Content-Type", request.url === "/fixture.js" ? "text/javascript" : "text/html")
    response.end(request.url === "/fixture.js" ? bundle.outputFiles[0].contents : html)
  })
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  let browser
  try {
    const { chromium } = require("playwright")
    browser = await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE_PATH ? {executablePath:process.env.CHROME_EXECUTABLE_PATH}: {})})
    const context = await browser.newContext({viewport:{width:1280,height:950}})
    const errors = [], blocked = []
    await context.route("**/*",route => {if(new URL(route.request().url()).origin===origin) return route.continue(); blocked.push(route.request().url()); return route.abort()})
    const page = await context.newPage()
    page.setDefaultTimeout(8000)
    page.on("pageerror",error=>errors.push(error.message))
    const button = name => page.getByRole("button",{name,exact:true})
    const writes = () => page.evaluate(()=>window.__taiwanHarness.writes)
    async function reset(query="") {await page.goto(origin+query); await page.getByLabel("Special Notice",{exact:true}).waitFor(); await page.locator("summary").click()}
    async function select(id) {await page.getByLabel("Choose a template").selectOption(id)}

    await reset()
    assert.deepEqual(await writes(),[])
    assert.equal(await button("Saved").isDisabled(),true)
    await select("bao-shan-2026-10")
    assert.equal(await page.getByLabel("Special Notice",{exact:true}).inputValue(),"EXISTING NOTICE\nSECOND EXISTING NOTICE")
    assert.deepEqual(await writes(),[],"selecting a reference never saves or activates it")
    await button("Add to Special Notice").click()
    const added = await page.getByLabel("Special Notice",{exact:true}).inputValue()
    assert.ok(added.startsWith("EXISTING NOTICE\nSECOND EXISTING NOTICE\n"))
    assert.match(added,/12 TO 17 OCTOBER 2026/)
    await button("Add to Special Notice").click()
    assert.equal(await page.getByLabel("Special Notice",{exact:true}).inputValue(),added)
    assert.deepEqual(await writes(),[])
    await button("Save").click()
    await page.getByText("Remarks saved successfully",{exact:true}).first().waitFor()
    assert.deepEqual(await writes(),[[{id:2,content:added}]],"only the changed notice is saved; existing remarks/typhoon settings are untouched")
    console.log("PASS: no auto-publication, existing content preserved, two-line CPC notice, deduplication, changed-row-only save")

    await reset()
    await select("holiday-period")
    await button("Add to Special Notice").click()
    await page.getByText(/Replace the date, period or charge placeholders before adding/).waitFor()
    assert.equal(await page.getByLabel("Special Notice",{exact:true}).inputValue(),"EXISTING NOTICE\nSECOND EXISTING NOTICE")
    await page.getByLabel("Edit template wording").fill("HOLIDAY NOTICE – NO ORDER WILL BE ACCEPTED BY CPC FROM 10/10/2026 TO 11/10/2026.")
    page.once("dialog",dialog=>dialog.dismiss())
    await select("suao-pipeline")
    assert.equal(await page.getByLabel("Choose a template").inputValue(),"holiday-period","cancel protects the edited template")
    await button("Add as Remark").click()
    await button("Add as Remark").click()
    assert.equal(await page.getByLabel("Remark 1",{exact:true}).inputValue(),"EXISTING REMARK")
    assert.equal(await page.getByLabel("Remark 2",{exact:true}).count(),1)
    assert.deepEqual(await writes(),[])
    await button("Save").click()
    await button("Saved").waitFor()
    assert.equal((await writes())[0].length,1)
    assert.equal((await writes())[0][0].id,1)
    console.log("PASS: incomplete placeholders blocked, edited template protected, append as remark, duplicates avoided")

    await reset()
    await page.getByLabel("Special Notice",{exact:true}).fill("UNFINISHED [DATE]")
    await button("Save").click()
    assert.deepEqual(await writes(),[],"manual edits also cannot save unresolved template placeholders")
    await page.getByLabel("Special Notice",{exact:true}).fill("RETAIN THIS DRAFT\nSECOND LINE")
    await page.evaluate(()=>{window.__taiwanHarness.rejectNext=true; window.__taiwanHarness.deferNext=true})
    await button("Save").click()
    await page.waitForFunction(()=>Boolean(window.__taiwanHarness.release))
    assert.equal(await page.getByLabel("Special Notice",{exact:true}).isDisabled(),true)
    assert.equal(await button("Add to Special Notice").count(),0)
    assert.equal(await button("Add remark").isDisabled(),true)
    await page.evaluate(()=>window.__taiwanHarness.release())
    await page.getByText(/Your draft is still here/).first().waitFor()
    assert.equal(await page.getByLabel("Special Notice",{exact:true}).inputValue(),"RETAIN THIS DRAFT\nSECOND LINE")
    await page.evaluate(()=>{window.__taiwanHarness.failNext=true})
    await button("Save").click()
    await page.getByText("Error saving remarks",{exact:true}).first().waitFor()
    assert.equal(await page.getByLabel("Special Notice",{exact:true}).inputValue(),"RETAIN THIS DRAFT\nSECOND LINE")
    await button("Save").click()
    await button("Saved").waitFor()
    assert.equal((await writes()).length,3)
    console.log("PASS: save validation, in-flight edit locking, rejected and failed save retain drafts, explicit retry")

    await page.goto(origin+"?failLoad=1")
    await page.getByRole("alert").waitFor()
    assert.equal(await page.getByLabel("Special Notice",{exact:true}).count(),0)
    assert.deepEqual(await writes(),[])
    await page.evaluate(()=>{window.__taiwanHarness.failLoad=false})
    await button("Try again").click()
    await page.getByLabel("Special Notice",{exact:true}).waitFor()
    assert.equal(await page.getByLabel("Special Notice",{exact:true}).inputValue(),"EXISTING NOTICE\nSECOND EXISTING NOTICE")
    console.log("PASS: failed loads cannot become blank editable reports; retry recovers existing notices")

    await reset("?access=view")
    assert.equal(await button("Add remark").isDisabled(),true)
    assert.equal(await button("Saved").isDisabled(),true)
    assert.equal(await page.getByLabel("Special Notice",{exact:true}).isDisabled(),true)
    assert.deepEqual(await writes(),[])
    console.log("PASS: View permission never becomes editing permission")

    await reset()
    await select("bao-shan-2026-10")
    await page.setViewportSize({width:390,height:844})
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,"mobile layout must not overflow")
    if(process.env.TAIWAN_SCREENSHOT_PATH) await page.screenshot({path:process.env.TAIWAN_SCREENSHOT_PATH,fullPage:true})
    assert.deepEqual(errors,[])
    assert.deepEqual(blocked,[])
    console.log("PASS: responsive layout, no browser errors, no external requests")
  } finally {
    if(browser) await browser.close()
    await new Promise(resolve=>server.close(resolve))
  }
}
main().catch(error=>{console.error(error);process.exitCode=1})
