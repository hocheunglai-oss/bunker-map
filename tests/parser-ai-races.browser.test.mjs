// Actual React components, isolated browser, deferred synthetic AI responses.
// No credentials, hosted services, personal browser, or production writes.
import assert from "node:assert/strict"
import http from "node:http"
import path from "node:path"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const baseline = process.argv.includes("--baseline-stdin") ? JSON.parse(readFileSync(0, "utf8")) : {}
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7)
const entry = `
  import React from "react";
  import {createRoot} from "react-dom/client";
  import Worksheet from "./app/admin/enquiryworksheet/page";
  import {ParserReportReviewPanel} from "./components/ParserReportReviewPanel";
  const root=createRoot(document.getElementById("root"));
  const rows=["A","B","HUMAN"].map(id=>({id,context:"shortened-enquiry",rawText:"VESSEL "+id,parserOutput:"PARSER "+id,correctedOutput:"CORRECT "+id,note:"NOTE "+id,metadata:{guesses:{vesselName:"REPORT "+id},aiFixOutput:id==="B"?"SAVED AI B":""},lastReportedAt:"2026-10-09T00:00:00Z",updatedAt:"2026-10-09T00:00:00.123456+00:00"}));
  window.__requests=[];window.__reportWrites=[];window.__ports=[];
  window.fetch=(url,init={})=>{
    if(String(url).startsWith("/api/admin/enquiryworksheet/ports")){
      if(new URLSearchParams(location.search).has("deferPorts"))return new Promise(resolve=>window.__ports.push(resolve));
      return Promise.resolve(Response.json({ports:[]}));
    }
    if(String(url).startsWith("/api/parser-reports")){
      if(init.method==="POST"){const body=JSON.parse(init.body);window.__reportWrites.push(body);return Promise.resolve(Response.json({success:true,report:{...rows.find(row=>row.id===body.id),...body,metadata:{...rows.find(row=>row.id===body.id).metadata,aiReviewState:body.action==="submit-ai"?"pending-ai":"complete"},updatedAt:"2026-10-12T00:00:00.123457+00:00"}}));}
      return Promise.resolve(Response.json({pendingAiReports:rows.slice(0,2),readyForUserReports:rows.slice(2)}));
    }
    if(url==="/api/parser-ai")return new Promise((resolve,reject)=>window.__requests.push({body:JSON.parse(init.body),resolve,reject}));
    throw Error("Unexpected synthetic request: "+url);
  };
  window.__mount=(kind,source="enquiryworksheet")=>root.render(<React.StrictMode>{kind==="worksheet"?<Worksheet/>:kind==="review"?<ParserReportReviewPanel source={source} canEdit={true}/>:null}</React.StrictMode>);
  window.__mount(location.pathname.includes("review")?"review":"worksheet");
`
const bundle = await build({
  absWorkingDir: root,
  stdin: { contents: entry, resolveDir: root, loader: "tsx" },
  outfile: "fixture.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "isolated-session-and-baseline", setup(builder) {
    builder.onResolve({ filter: /^@\/lib\/useSimpleAdminAuth$/ }, () => ({ path: "auth", namespace: "fixture" }))
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export function useSimpleAdminAuth(){return {authenticated:true,displayName:"Synthetic User",username:"synthetic"}}', loader: "js" }))
    builder.onLoad({ filter: /(?:enquiryworksheet\/page|ParserReportReviewPanel)\.tsx$/ }, (args) => {
      const relative = path.relative(root, args.path)
      return baseline[relative] ? { contents: baseline[relative], loader: "tsx" } : undefined
    })
  } }],
})
const assets = new Map(bundle.outputFiles.map((file) => [path.basename(file.path), file.contents]))
const server = http.createServer((req, res) => {
  const name = new URL(req.url, "http://localhost").pathname.slice(1)
  if (assets.has(name)) {
    res.setHeader("Content-Type", name.endsWith("css") ? "text/css" : "text/javascript")
    return res.end(assets.get(name))
  }
  res.setHeader("Content-Type", "text/html")
  res.end('<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>')
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let browser
try {
  const { chromium } = require("playwright")
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" })
  const context = await browser.newContext({ viewport: { width: 1700, height: 1200 } })
  const page = await context.newPage(), errors = [], blocked = []
  page.setDefaultTimeout(7000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.addInitScript(() => localStorage.clear())
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue()
    blocked.push(route.request().url())
    return route.abort()
  })
  const button = (name) => page.getByRole("button", { name, exact: true })
  const raw = () => page.getByRole("textbox", { name: "Enquiry text", exact: true })
  const output = () => page.getByRole("textbox", { name: "Editable shortened enquiry", exact: true })
  const ai = () => page.getByRole("button", { name: "Ask AI to correct shortened enquiry", exact: true })
  async function settled() { await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }
  async function reset(kind, query = "") {
    await page.goto(`${origin}/${kind}${query}`)
    await (kind === "worksheet" ? raw() : button("REPORT A")).waitFor()
    await settled()
  }
  async function startWorksheet(text = "Vessel: ALPHA\nPort: Singapore\nVLSFO 100MT") {
    await raw().fill(text)
    await ai().click()
    await page.waitForFunction(() => window.__requests.length > 0)
    return page.evaluate(() => window.__requests.length - 1)
  }
  async function resolve(index, correctedOutput = "AI ALPHA / singapore / vlsfo 123mts", fields = { vesselName: "AI ALPHA", port: "singapore" }) {
    await page.evaluate(({ index, correctedOutput, fields }) => window.__requests[index].resolve(Response.json({ correctedOutput, fields, warnings: [], imoSources: [] })), { index, correctedOutput, fields })
    await settled()
  }
  async function reject(index, message = "SYNTHETIC CURRENT FAILURE") {
    await page.evaluate(({ index, message }) => window.__requests[index].reject(new Error(message)), { index, message })
    await settled()
  }
  async function worksheetSnapshot() {
    return page.locator('textarea,input:not([type="checkbox"])').evaluateAll((nodes) => nodes.map((node) => node.value))
  }
  async function openReport(id) { await button(`REPORT ${id}`).click() }
  async function startReview() {
    await button("AI Fix").click()
    await page.waitForFunction(() => window.__requests.length > 0)
    return page.evaluate(() => window.__requests.length - 1)
  }
  const correction = () => page.getByRole("textbox", { name: "Correct Version", exact: true })
  const note = () => page.getByRole("textbox", { name: "Note", exact: true })
  const aiOutput = () => page.getByRole("textbox", { name: "AI Fix", exact: true })

  if (!only || only === "worksheet") {
    let a
    for (const action of ["raw", "roundtrip", "clear", "manual", "vessel", "header", "buyer", "remark", "generate"]) {
      await reset("worksheet")
      a = await startWorksheet()
      if (action === "raw") await raw().fill("Vessel: BETA\nPort: Busan\nVLSFO 200MT")
      if (action === "roundtrip") {
        await raw().fill("DIFFERENT ENQUIRY")
        await raw().fill("Vessel: ALPHA\nPort: Singapore\nVLSFO 100MT")
      }
      if (action === "clear") await button("Clear").click()
      if (action === "manual") await output().fill("KEEP MANUAL DRAFT")
      if (action === "vessel") await page.getByLabel("VESSEL NAME", { exact: true }).fill("USER VESSEL")
      if (action === "header") await page.getByRole("textbox", { name: "Vessel name and IMO", exact: true }).fill("USER HEADER")
      if (action === "buyer") await page.getByLabel("BUYER", { exact: true }).last().fill("USER BUYER")
      if (action === "remark") await button("180").click()
      if (action === "generate") await button("Generate").click()
      await settled()
      const before = await worksheetSnapshot()
      await resolve(a, "STALE AI OUTPUT", { vesselName: "STALE VESSEL", buyer: "STALE BUYER" })
      assert.deepEqual(await worksheetSnapshot(), before, `${action}: stale result must preserve the entire current draft`)
      assert.equal(await page.getByText("AI correction applied. Double check before sending.", { exact: true }).count(), 0)
    }
    console.log("PASS worksheet: raw edit, Clear, manual output, identity fields, remark and Generate invalidate stale AI")

    await reset("worksheet")
    a = await startWorksheet()
    await resolve(a)
    assert.equal(await output().inputValue(), "AI ALPHA / singapore / vlsfo 123mts")
    assert.equal(await page.getByLabel("VESSEL NAME", { exact: true }).inputValue(), "AI ALPHA")
    await output().fill("MANUAL CORRECTED DRAFT")
    // Starting a current request must retain a user-edited draft on failure.
    await ai().click()
    a = await page.evaluate(() => window.__requests.length - 1)
    await reject(a)
    assert.equal(await output().inputValue(), "MANUAL CORRECTED DRAFT")
    await page.getByText("SYNTHETIC CURRENT FAILURE", { exact: true }).waitFor()
    assert.equal(await ai().isDisabled(), false)
    console.log("PASS worksheet: current success applies; current failure retains draft and unlocks retry")

    for (const oldFails of [false, true]) {
      await reset("worksheet")
      a = await startWorksheet()
      await raw().fill("Vessel: BETA\nPort: Busan\nVLSFO 200MT")
      await ai().click()
      const b = await page.evaluate(() => window.__requests.length - 1)
      assert.equal(b, a + 1)
      if (oldFails) await reject(a, "STALE FAILURE")
      else await resolve(a, "STALE A")
      assert.equal(await ai().isDisabled(), true, "stale completion/finally cannot unlock B")
      assert.equal(await page.getByText("STALE FAILURE", { exact: true }).count(), 0)
      await resolve(b, "CURRENT B", { vesselName: "BETA", port: "busan" })
      assert.equal(await output().inputValue(), "CURRENT B")
      assert.equal(await ai().isDisabled(), false)
    }
    await reset("worksheet")
    await raw().fill("Vessel: ALPHA\nVLSFO 100MT")
    await ai().evaluate((node) => {
      const key = Object.keys(node).find((key) => key.startsWith("__reactProps$"))
      node[key].onClick()
      node[key].onClick()
    })
    assert.equal(await page.evaluate(() => window.__requests.length), 1, "same-render handlers share a synchronous request owner")
    a = 0
    await raw().fill("Vessel: BETA\nVLSFO 200MT")
    await ai().click()
    await resolve(1, "NEW B ALREADY APPLIED", { vesselName: "BETA" })
    await reject(a, "STALE AFTER B SUCCESS")
    assert.equal(await output().inputValue(), "NEW B ALREADY APPLIED")
    assert.equal(await page.getByText("STALE AFTER B SUCCESS", { exact: true }).count(), 0)
    assert.equal(await ai().isDisabled(), false)
    await reset("worksheet", "?deferPorts=1")
    a = await startWorksheet()
    await page.evaluate(() => window.__ports.forEach((release) => release(Response.json({ ports: ["SINGAPORE"] }))))
    await settled()
    const beforePortsResult = await worksheetSnapshot()
    await resolve(a, "STALE BEFORE PORT INDEX")
    assert.deepEqual(await worksheetSnapshot(), beforePortsResult)
    await reset("worksheet", "?deferPorts=1")
    a = await startWorksheet()
    await page.evaluate(() => window.__ports.forEach((release) => release(Response.json({ ports: [] }))))
    await settled()
    await resolve(a, "CURRENT WITH UNCHANGED PORT INDEX")
    assert.equal(await output().inputValue(), "CURRENT WITH UNCHANGED PORT INDEX")
    console.log("PASS worksheet: same-tick/out-of-order requests retain busy ownership; only changed port index invalidates")
  }

  if (!only || only === "review") {
    await reset("review")
    await openReport("A")
    let a = await startReview()
    await resolve(a, "CURRENT AI A")
    assert.equal(await aiOutput().inputValue(), "CURRENT AI A")
    assert.equal(await correction().inputValue(), "CORRECT A")
    assert.equal(await note().inputValue(), "NOTE A")
    await button("Complete AI Review").click()
    await page.getByText("AI review completed and case closed.", { exact: true }).waitFor()
    const write = await page.evaluate(() => window.__reportWrites.at(-1))
    assert.deepEqual({ id: write.id, aiOutput: write.aiOutput, correctedOutput: write.correctedOutput, note: write.note }, { id: "A", aiOutput: "CURRENT AI A", correctedOutput: "CORRECT A", note: "NOTE A" })
    console.log("PASS review: valid AI updates only its AI field; ordinary completion saves the current report")

    for (const action of ["close", "reopen", "switch", "note", "correction", "source", "unmount"]) {
      await reset("review")
      await openReport("A")
      a = await startReview()
      if (["close", "reopen", "switch", "correction"].includes(action)) await button("Cancel").click()
      if (action === "reopen") await openReport("A")
      if (action === "switch") await openReport("B")
      if (action === "note") await note().fill("KEEP MODIFIED NOTE")
      if (action === "correction") { await openReport("HUMAN"); await correction().fill("KEEP HUMAN CORRECTION") }
      if (action === "source") await page.evaluate(() => window.__mount("review", "spc"))
      if (action === "unmount") await page.evaluate(() => window.__mount("unmounted"))
      await settled()
      const before = await page.locator("textarea,input").evaluateAll((nodes) => nodes.map((node) => node.value))
      await resolve(a, "STALE AI FOR A")
      assert.deepEqual(await page.locator("textarea,input").evaluateAll((nodes) => nodes.map((node) => node.value)), before, action)
      assert.equal(await page.getByText("STALE AI FOR A", { exact: true }).count(), 0)
    }
    console.log("PASS review: close, same-ID reopen, switch, note/correction, source remount and unmount reject stale AI")

    for (const oldFails of [false, true]) {
      await reset("review")
      await openReport("A")
      a = await startReview()
      await button("Cancel").click()
      await openReport("B")
      const b = await startReview()
      assert.equal(b, a + 1)
      if (oldFails) await reject(a, "STALE REVIEW FAILURE")
      else await resolve(a, "STALE A")
      assert.equal(await button("Reviewing...").isDisabled(), true)
      assert.equal(await page.getByText("STALE REVIEW FAILURE", { exact: true }).count(), 0)
      await reject(b)
      assert.equal(await aiOutput().inputValue(), "SAVED AI B")
      assert.equal(await correction().inputValue(), "CORRECT B")
      assert.equal(await note().inputValue(), "NOTE B")
      await page.getByRole("alert").filter({ hasText: "SYNTHETIC CURRENT FAILURE" }).waitFor()
      assert.equal(await button("AI Fix").isDisabled(), false)
    }
    await reset("review")
    await openReport("A")
    await button("AI Fix").evaluate((node) => {
      const key = Object.keys(node).find((key) => key.startsWith("__reactProps$"))
      node[key].onClick()
      node[key].onClick()
    })
    assert.equal(await page.evaluate(() => window.__requests.length), 1)
    await button("Cancel").click()
    await openReport("B")
    await startReview()
    await resolve(1, "NEW AI B ALREADY APPLIED")
    await reject(0, "STALE AFTER REVIEW B SUCCESS")
    assert.equal(await aiOutput().inputValue(), "NEW AI B ALREADY APPLIED")
    assert.equal(await page.getByText("STALE AFTER REVIEW B SUCCESS", { exact: true }).count(), 0)
    assert.equal(await button("AI Fix").isDisabled(), false)
    console.log("PASS review: stale success/error/finally cannot release newer busy state; current failure keeps B intact")
  }
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  console.log("PASS isolated browser: no page errors or external requests")
  await context.close()
} finally {
  if (browser) await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
