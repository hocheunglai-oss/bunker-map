import assert from "node:assert/strict"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { setupReportPublicationApp } from "./fixtures/report-publication-app.mjs"
import { publicReportReader } from "./fixtures/public-report-reader.mjs"
import { priceSetterDeletionSnapshot } from "../lib/priceSetterMutation.ts"

// Actual Price Setter, actual audited price/publication routes and actual SQL.
// Only authentication and the network adapter are synthetic. No live requests.
// Public reader uses the real route/helper; Next cache behaviour is a separate
// release gate, not something this adapter claims to verify.
const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const mocks = `
  export function useSimpleAdminAuth(){return {loading:false,authenticated:true,role:"BT",permissions:{pricesetter:new URLSearchParams(location.search).get("access")||"edit"}}}
  export function useIsMobile(){return false}
  export const supabase={from(table){let single=false,filters=[];const q={
    select(){return q},order(){return q},in(key,value){filters.push([key,value]);return q},eq(key,value){filters.push([key,[value]]);return q},maybeSingle(){single=true;return q},
    then(resolve,reject){return fetch("/fixture/read",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({table,single,filters})}).then(r=>r.json()).then(resolve,reject)}
  };return q}};
`
const bundle = await build({ absWorkingDir: root,
  stdin: { contents: 'import React from "react";import {createRoot} from "react-dom/client";import Page from "./app/admin/pricesetter/page";createRoot(document.getElementById("root")).render(<React.StrictMode><Page/></React.StrictMode>);', resolveDir: root, loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "synthetic-session-and-transport", setup(builder) {
    builder.onResolve({ filter: /^@\/lib\/(supabase|useSimpleAdminAuth|useIsMobile)$/ }, () => ({ path: "mocks", namespace: "fixture" }))
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: mocks, loader: "js" }))
  } }],
})
const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial}button,input,select{font:inherit}button:disabled{opacity:.5}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'
let app, browser, release, readMode = "success", publishMode = "success", priceMode = "success", inventoryMode = "success", creationMode = "success", ackMode = "success"
const requests = []
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1")
    if (url.pathname === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].contents); return }
    if (url.pathname.startsWith("/api/") || url.pathname === "/fixture/read") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString()
      if (url.pathname === "/fixture/read") {
        const input = JSON.parse(body); assert.ok(["ports", "remarks"].includes(input.table))
        let rows = (await app.db.query(`select to_jsonb(t) as row from public.${input.table} t order by id`)).rows.map(row => row.row)
        rows = rows.filter(row => input.filters.every(([key, values]) => values.includes(row[key])))
        res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: input.single ? rows[0] || null : rows, error: null })); return
      }
      if (url.pathname.startsWith("/api/reports/")) {
        const response = await app.publicReader.route.GET(new Request(url), { params: Promise.resolve({ key: url.pathname.split("/").at(-1) }) })
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return
      }
      assert.ok(["/api/admin/prices", "/api/admin/prices/creation", "/api/admin/report-publication"].includes(url.pathname))
      const entry = { path: url.pathname, report: url.searchParams.get("report"), page: url.searchParams.get("page"), method: req.method, body: body ? JSON.parse(body) : null }
      requests.push(entry)
      const mode = url.pathname.endsWith("report-publication") ? req.method === "GET" ? readMode : publishMode
        : url.pathname.endsWith("/creation") ? req.method === "GET" ? creationMode : ackMode : req.method === "GET" ? inventoryMode : priceMode
      if (mode === "defer") await new Promise(resolve => { release = resolve })
      if (mode === "failure") { res.writeHead(503, { "Content-Type": "application/json" }); res.end('{"message":"Synthetic temporary failure"}'); return }
      const route = url.pathname.endsWith("report-publication") ? app.route : url.pathname.endsWith("/creation") ? app.creationRoute : app.priceRoute
      const response = await route[req.method](new Request(url, { method: req.method, headers: req.headers, ...(req.method !== "GET" ? { body } : {}) }))
      let text = await response.text(); entry.status = response.status
      if (mode === "lost-reply") { res.destroy(); return }
      if (mode === "malformed") text = "{bad JSON"
      if (mode === "incomplete") text = "{}"
      if (mode === "truncated") {const data=JSON.parse(text);data.ports=data.ports.slice(0,1000);text=JSON.stringify(data)}
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(text); return
    }
    res.setHeader("Content-Type", "text/html"); res.end(html)
  } catch (error) { res.statusCode = 500; res.end("Synthetic harness failure"); console.error(error) }
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const reports = [{ key: "china", title: "China", id: 103 }, { key: "compact", title: "Compact", id: 104 }, { key: "taiwan", title: "Taiwan", id: 101 }, { key: "hongkong", title: "HK", review: "Hong Kong", id: 102 }]
try {
  browser = await require("playwright").chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" })
  const context = await browser.newContext({ timezoneId: "America/Los_Angeles", viewport: { width: 1400, height: 950 } })
  let page = await context.newPage()
  const errors = [], blocked = []
  function observe(target) { target.setDefaultTimeout(10000); target.on("pageerror", error => errors.push(error.message)); target.on("dialog", dialog => dialog.accept()) }
  observe(page)
  await context.route("**/*", route => { if (new URL(route.request().url()).origin === origin) return route.continue(); blocked.push(route.request().url()); return route.abort() })
  const button = name => page.getByRole("button", { name, exact: true })
  const portRow = name => page.locator('table:not([aria-label]) tbody tr').filter({ has: page.locator(`input[value="${name}"]`) })
  const price = () => portRow("Hong Kong").getByPlaceholder("price").first()
  const alert = text => page.getByRole("alert").filter({ hasText: text }).first()
  const publishCount = () => requests.filter(r => r.path.endsWith("report-publication") && r.method === "POST").length
  async function ready(report) { await page.waitForFunction(title => [...document.querySelectorAll("button")].some(b => ["Publish " + title, "Published " + title].includes(b.textContent) && !b.disabled), report.title) }
  async function readyAll() { for (const report of reports) await ready(report) }
  async function heldRequest() {
    const deadline=Date.now()+10000
    while(!release){assert.ok(Date.now()<deadline,"Expected the server to hold a request");await new Promise(resolve=>setTimeout(resolve,20))}
  }
  async function reload(report) { await button(`Reload saved ${report.review || report.title} report`).click(); await ready(report) }
  async function published(report) { return (await app.db.query("select content from remarks where id=$1", [report.id])).rows[0]?.content || null }
  async function publicReport(report) {
    const response = await page.request.get(`${origin}/api/reports/${report.key}`)
    assert.equal(response.status(), 200)
    return (await response.json()).snapshot
  }
  async function fresh(query = "") {
    if (app) await app.db.close()
    app = await setupReportPublicationApp(); app.publicReader = publicReportReader(app.db)
    requests.length = 0; readMode = publishMode = priceMode = inventoryMode = creationMode = ackMode = "success"; release = null
    await page.goto(origin + query); await portRow("Hong Kong").waitFor()
  }
  if (process.argv.includes("--filter-editing")) {
    const writes = () => requests.filter(request => request.method !== "GET")
    const allMarkets = () => button("All").last().click()
    const save = name => portRow(name).getByRole("button", { name: "Save", exact: true }).click()
    const add = async (name = "Add Port") => { await button("☰").click(); await button(name).click() }

    await fresh(); await readyAll(); await button("China North").click()
    const original = await app.state()
    await portRow("Dalian").locator("input").first().fill("D")
    assert.equal(await portRow("D").count(), 1, "typing a market port name must not remove its own input")
    assert.equal(await portRow("D").locator("input").first().evaluate(input => document.activeElement === input), true)
    await portRow("D").locator("input").first().fill("Dalian renamed")
    assert.equal(writes().length, 0)
    priceMode = "failure"; await save("Dalian renamed"); await alert(/Synthetic temporary failure/).waitFor()
    assert.equal(await portRow("Dalian renamed").count(), 1)
    assert.deepEqual(await app.state(), original)
    await button("Japan").click(); assert.equal(await portRow("Dalian renamed").count(), 0)
    await button("China North").click(); assert.equal(await portRow("Dalian renamed").count(), 1, "changing filters never discards the retained draft")
    priceMode = "success"; await save("Dalian renamed")
    await portRow("Dalian renamed").waitFor({ state: "detached" })
    assert.equal((await app.row(app.other)).name, "Dalian renamed")
    await allMarkets(); await portRow("Dalian renamed").getByRole("button", { name: "Saved", exact: true }).waitFor()
    assert.deepEqual(await app.publications(), [])
    console.log("PASS saved-name filtering: typing keeps focus and the editable row; failed saves and filter changes retain drafts; only confirmed rename changes market membership")

    await fresh(); await readyAll(); await button("Primary").click()
    for (const fuel of ["HSFO", "VLSFO", "MGO"]) await page.getByLabel(`Dalian ${fuel} price or formula`, { exact: true }).fill("")
    assert.equal(await portRow("Dalian").count(), 1, "clearing the final direct quote must keep the row and Save button")
    assert.equal(writes().length, 0)
    priceMode = "failure"; await save("Dalian"); await alert(/Synthetic temporary failure/).waitFor()
    assert.equal(await portRow("Dalian").count(), 1)
    assert.equal((await app.row(app.other)).hsfo, 100)
    priceMode = "success"; await save("Dalian"); await portRow("Dalian").waitFor({ state: "detached" })
    await button("Secondary").click(); await portRow("Dalian").getByRole("button", { name: "Saved", exact: true }).waitFor()
    assert.deepEqual(await portRow("Dalian").locator("input").evaluateAll(inputs => inputs.slice(1).map(input => input.value)), ["", "", ""])
    const cleared = await app.row(app.other); assert.equal(cleared.hsfo, null); assert.equal(cleared.vlsfo, null); assert.equal(cleared.mgo, null)
    assert.deepEqual(await app.publications(), [])
    console.log("PASS primary filtering: clearing all quotes and failed saves keep the row; confirmed SQL save alone moves it to Secondary without restoring old prices")

    await fresh(); await readyAll(); await button("Secondary").click()
    await page.getByLabel("Taichung HSFO price or formula", { exact: true }).fill("123")
    assert.equal(await portRow("Taichung").count(), 1, "entering a first quote must not hide the secondary row before saving")
    assert.equal(writes().length, 0)
    await save("Taichung"); await portRow("Taichung").waitFor({ state: "detached" })
    await button("Primary").click(); await portRow("Taichung").getByRole("button", { name: "Saved", exact: true }).waitFor()
    assert.equal((await app.row(app.chained)).hsfo, 123)
    assert.deepEqual(await app.publications(), [])
    console.log("PASS secondary filtering: first-quote draft stays editable until confirmed UI/API/SQL save, then appears in Primary")

    await fresh(); await readyAll(); await button("Hide Tertiary").click()
    await portRow("Dalian").locator("input").first().fill("Ningbo")
    assert.equal(await portRow("Ningbo").count(), 1, "a tertiary-name draft is not a saved tertiary port yet")
    await save("Ningbo"); await portRow("Ningbo").waitFor({ state: "detached" })
    assert.equal((await app.row(app.other)).name, "Ningbo")
    await button("Hide Tertiary").click(); await portRow("Ningbo").getByRole("button", { name: "Saved", exact: true }).waitFor()
    console.log("PASS tertiary filtering: saved baseline controls membership; hiding is applied only after a successful rename")

    await fresh(); await readyAll()
    await app.db.exec("update ports set vlsfo_formula='Hong Kong + 5' where name='Dalian'")
    await page.reload(); await readyAll(); await button("Secondary").click()
    await page.getByLabel("Dalian VLSFO price or formula", { exact: true }).fill("123")
    assert.equal(await portRow("Dalian").count(), 1, "replacing the last formula must not remove its own row before saving")
    await save("Dalian"); await portRow("Dalian").waitFor({ state: "detached" })
    await button("Primary").click(); await portRow("Dalian").getByRole("button", { name: "Saved", exact: true }).waitFor()
    assert.equal((await app.row(app.other)).vlsfo, 123); assert.equal((await app.row(app.other)).vlsfo_formula, null)
    console.log("PASS formula grouping: replacing a formula remains visible until confirmation, then uses the new saved classification")

    await fresh(); await readyAll()
    await price().fill("777"); await button("Taiwan").click(); await button("Primary").click(); await button("Hide Tertiary").click()
    ackMode = "failure"; await add(); await portRow("New Port").waitFor(); await alert(/Synthetic temporary failure/).waitFor()
    assert.equal(await button("All").first().getAttribute("aria-pressed"), "true")
    assert.equal(await button("All").last().getAttribute("aria-pressed"), "true")
    assert.equal(await button("Hide Tertiary").getAttribute("aria-pressed"), "true", "unrelated tertiary preference is retained")
    assert.equal(await price().inputValue(), "777", "revealing a new row does not discard another row's draft")
    const allocationId = writes().find(request => request.method === "PUT").body.requestId
    assert.equal((await app.db.query("select acknowledged_at from price_setter_creation_receipts")).rows[0].acknowledged_at, null)
    ackMode = "success"; await button("Check earlier addition").click(); await button("Check earlier addition").waitFor({ state: "hidden" })
    assert.equal(writes().filter(request => request.method === "PUT").at(-1).body.requestId, allocationId)
    assert.equal((await app.db.query("select count(*)::integer as count from price_setter_creation_receipts")).rows[0].count, 1)
    assert.equal(await price().inputValue(), "777")
    console.log("PASS filtered creation: a proven new row is revealed in All, other drafts/preferences survive; unconfirmed acknowledgement retries the same allocation without duplication")

    await fresh(); await readyAll(); await button("Taiwan").click(); await button("Primary").click(); priceMode = "lost-reply"
    await add(); await alert(/Could not confirm|could not be confirmed/).waitFor()
    assert.equal(await button("Taiwan").getAttribute("aria-pressed"), "true", "an unknown allocation must not change filters")
    assert.equal(await button("Primary").getAttribute("aria-pressed"), "true")
    assert.equal(await portRow("New Port").count(), 0)
    const lostId = writes().find(request => request.method === "PUT").body.requestId
    priceMode = "success"; await button("Check earlier addition").click(); await portRow("New Port").waitFor()
    await button("Check earlier addition").waitFor({ state: "hidden" })
    assert.ok(writes().filter(request => request.method === "PUT").every(request => request.body.requestId === lostId))
    assert.equal((await app.db.query("select count(*)::integer as count from price_setter_creation_receipts")).rows[0].count, 1)
    await button("Taiwan").click(); await button("Secondary").click(); await add("Add Divider")
    await page.getByRole("textbox", { name: "Divider title" }).waitFor()
    assert.equal(await button("All").last().getAttribute("aria-pressed"), "true")
    assert.equal((await app.db.query("select count(*)::integer as count from price_setter_creation_receipts")).rows[0].count, 2)
    assert.deepEqual(await app.publications(), [])
    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    console.log("PASS filtered recovery/dividers: lost replies leave filters unchanged until explicit same-receipt proof; recovered ports and confirmed dividers become visible without publication or external requests")
  } else if (process.argv.includes("--refresh-recovery")) {
    await fresh(); await readyAll(); priceMode = "lost-reply"
    await button("☰").click(); await button("Add Port").click()
    await alert(/Could not confirm|could not be confirmed/).waitFor()
    const original = requests.find(r => r.method === "PUT").body.requestId
    assert.equal((await app.db.query("select count(*)::integer as count from price_setter_creation_receipts")).rows[0].count, 1)
    priceMode = "success"; await page.reload(); await portRow("New Port").waitFor(); await readyAll()
    await button("Check earlier addition").click(); await button("Check earlier addition").waitFor({state:"hidden"})
    assert.equal(requests.filter(r => r.method === "PUT").at(-1).body.requestId, original)
    assert.equal((await app.db.query("select count(*)::integer as count from price_setter_creation_receipts")).rows[0].count, 1)
    assert.equal(await portRow("New Port 2").count(), 0)
    assert.deepEqual(await app.publications(), [])
    console.log("PASS refresh recovery: a committed addition with a lost reply survives full-page refresh; explicit checking reuses the original receipt with no duplicate or publication")

    for (const mode of ["lost-reply", "malformed", "incomplete", "failure"]) {
      await fresh(); await readyAll(); ackMode=mode
      await button("☰").click(); await button("Add Port").click()
      await alert(mode === "failure" ? /Synthetic temporary failure/ : /Could not confirm|could not be confirmed|earlier addition/).waitFor()
      const id=requests.find(r=>r.method==="PUT").body.requestId
      const before=await app.state(), marker=(await app.db.query("select public.get_bunker_map_backup_export_fence() as result")).rows[0].result
      ackMode="success"
      await button("Check earlier addition").click(); await button("Check earlier addition").waitFor({state:"hidden"})
      assert.deepEqual(await app.state(),before)
      assert.equal((await app.db.query("select count(*)::integer as n from price_setter_creation_receipts")).rows[0].n,1)
      assert.deepEqual([...new Set(requests.filter(r=>r.method==="PUT").map(r=>r.body.requestId))],[id])
      if(mode!=="failure") assert.deepEqual((await app.db.query("select public.get_bunker_map_backup_export_fence() as result")).rows[0].result,marker,"an acknowledgement replay must not mutate the backup fence")
      assert.deepEqual(await app.publications(),[])
      console.log(`PASS acknowledgement ${mode}: uncertain completion retains the original request; checking cannot allocate or publish again`)
    }

    await fresh();await readyAll();priceMode="lost-reply"
    await button("☰").click();await button("Add Port").click();await alert(/Could not confirm|could not be confirmed/).waitFor()
    const reopeningId=requests.find(r=>r.method==="PUT").body.requestId, writesBeforeReopen=requests.filter(r=>r.method!=="GET").length
    await page.evaluate(()=>{localStorage.clear();sessionStorage.clear()});await page.close()
    page=await context.newPage();observe(page);priceMode="success"
    await page.goto(origin);await portRow("New Port").waitFor();await button("Check earlier addition").waitFor()
    assert.equal(requests.filter(r=>r.method!=="GET").length,writesBeforeReopen,"opening a page reads recovery state but never allocates or acknowledges")
    await button("Check earlier addition").click();await button("Check earlier addition").waitFor({state:"hidden"})
    assert.equal(requests.filter(r=>r.method==="PUT").at(-1).body.requestId,reopeningId)
    assert.equal((await app.db.query("select count(*)::integer as n from price_setter_creation_receipts")).rows[0].n,1)
    console.log("PASS reopen/cleared storage: a new document recovers from the server with no browser request cache and no implicit write")

    for(const mode of ["failure","malformed","incomplete"]){
      await fresh();await readyAll();creationMode=mode;await page.reload();await portRow("Hong Kong").waitFor()
      await alert(/Could not check earlier additions/).waitFor()
      await button("☰").click();assert.equal(await button("Add Port").isDisabled(),true);await button("☰").click()
      assert.equal(requests.filter(r=>r.method==="PUT").length,0)
      await price().fill("777");await portRow("Hong Kong").getByRole("button",{name:"Save",exact:true}).click()
      await portRow("Hong Kong").getByRole("button",{name:"Saved",exact:true}).waitFor()
      assert.equal((await app.row(app.basis)).hsfo,777,"recovery read failure pauses additions, not unrelated price saving")
      creationMode="success";await button("Reload previous additions").click()
      await page.getByText("Checking earlier additions…",{exact:true}).waitFor({state:"hidden"})
      await button("☰").click();await button("Add Port").click();await portRow("New Port").waitFor()
      await button("Check earlier addition").waitFor({state:"hidden"})
      assert.deepEqual(await app.publications(),[])
      console.log(`PASS recovery read ${mode}: no revision-zero fallback or allocation; existing price edits work; explicit retry restores additions`)
    }

    await fresh();await readyAll()
    const second=await context.newPage();observe(second)
    try{
      await second.goto(origin);await second.locator('input[value="Hong Kong"]').waitFor();await second.getByText("Checking earlier additions…",{exact:true}).waitFor({state:"hidden"})
      await button("☰").click();await button("Add Port").click();await button("Check earlier addition").waitFor({state:"hidden"})
      await second.getByRole("button",{name:"☰",exact:true}).click();await second.getByRole("button",{name:"Add Port",exact:true}).click()
      await second.getByRole("alert").filter({hasText:/Another addition was completed/}).waitFor()
      assert.equal((await app.db.query("select count(*)::integer as n from price_setter_creation_receipts")).rows[0].n,1)
      await second.getByRole("button",{name:"Reload saved ports",exact:true}).click()
      await second.locator('input[value="New Port"]').waitFor();await second.getByText("Checking earlier additions…",{exact:true}).waitFor({state:"hidden"})
      await second.getByRole("button",{name:"☰",exact:true}).click();await second.getByRole("button",{name:"Add Port",exact:true}).click()
      await second.locator('input[value="New Port 2"]').waitFor();await second.getByRole("button",{name:"Check earlier addition",exact:true}).waitFor({state:"hidden"})
      assert.equal((await app.db.query("select count(*)::integer as n from price_setter_creation_receipts")).rows[0].n,2)
      console.log("PASS two completed tabs: stale intent is rejected; only explicit saved-list review and a fresh intention creates a second row")
    }finally{await second.close()}

    await fresh();await readyAll();priceMode="defer"
    await button("☰").click();await button("Add Port").click()
    await heldRequest()
    const delayed=release;priceMode="success"
    const competitor=await context.newPage();observe(competitor)
    try{
      await competitor.goto(origin);await competitor.locator('input[value="Hong Kong"]').waitFor();await competitor.getByText("Checking earlier additions…",{exact:true}).waitFor({state:"hidden"})
      await competitor.getByRole("button",{name:"☰",exact:true}).click();await competitor.getByRole("button",{name:"Add Port",exact:true}).click()
      await competitor.locator('input[value="New Port"]').waitFor();await competitor.getByRole("button",{name:"Check earlier addition",exact:true}).waitFor({state:"hidden"})
      delayed();release=null
      await alert(/Another addition was completed/).waitFor()
      assert.equal((await app.db.query("select count(*)::integer as n from price_setter_creation_receipts")).rows[0].n,1)
      assert.equal(await competitor.locator('input[value="New Port 2"]').count(),0)
      console.log("PASS delayed request: a request held before SQL cannot allocate after another tab completed and acknowledged its addition")
    }finally{if(release){release();release=null}await competitor.close()}

    await fresh();await readyAll()
    const firstActor=app.control.actorId, priorState=await app.state(), priorCalls=app.calls.length
    app.control.actorId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    await button("☰").click();await button("Add Port").click();await alert(/signed-in account changed/).waitFor()
    assert.deepEqual(await app.state(),priorState);assert.equal(app.calls.length,priorCalls)
    await button("Reload saved ports").click();await portRow("Hong Kong").waitFor();await page.getByText("Checking earlier additions…",{exact:true}).waitFor({state:"hidden"})
    await button("☰").click();await button("Add Port").click();await portRow("New Port").waitFor();await button("Check earlier addition").waitFor({state:"hidden"})
    const owner=(await app.db.query("select actor_id from price_setter_creation_receipts")).rows[0].actor_id
    assert.equal(owner,app.control.actorId);assert.notEqual(owner,firstActor)
    console.log("PASS account switch before allocation: the old page's actor binding is rejected before privileged work; explicit reload uses the new authenticated actor")

    await fresh();await readyAll();ackMode="defer"
    await button("☰").click();await button("Add Port").click();await portRow("New Port").waitFor()
    await heldRequest()
    const originalActor=app.control.actorId;app.control.actorId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";const resume=release;release=null;resume()
    await alert(/signed-in account changed/).waitFor()
    const unfinished=(await app.db.query("select actor_id,acknowledged_at from price_setter_creation_receipts")).rows[0]
    assert.equal(unfinished.actor_id,originalActor);assert.equal(unfinished.acknowledged_at,null)
    app.control.actorId=originalActor;ackMode="success";await page.reload();await button("Check earlier addition").waitFor()
    await button("Check earlier addition").click();await button("Check earlier addition").waitFor({state:"hidden"})
    assert.equal((await app.db.query("select count(*)::integer as n from price_setter_creation_receipts")).rows[0].n,1)
    assert.deepEqual(await app.publications(),[])
    assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
    console.log("PASS account switch before acknowledgement: another account cannot settle the saved addition; the original account recovers it without duplication")
  } else if (process.argv.includes("--mixed-fuel")) {
    await fresh(); await readyAll()
    await app.db.exec("update ports set vlsfo_formula='Hong Kong + 5' where name='Dalian'")
    await page.reload(); await readyAll()
    const row = portRow("Dalian")
    // A formula for VLSFO must not conceal independently editable HSFO/MGO.
    assert.deepEqual(await row.locator("input").evaluateAll(inputs => inputs.slice(1).map(input => ({
      placeholder: input.placeholder, value: input.value,
    }))), [
      { placeholder: "price", value: "100" },
      { placeholder: "formula", value: "Hong Kong + 5" },
      { placeholder: "price", value: "300" },
    ])
    assert.equal(publishCount(), 0)
    const fuel = (name, label) => page.getByLabel(`${name} ${label} price or formula`, { exact: true })
    const directOnlyRequests = requests.length
    await fuel("Hong Kong", "HSFO").fill("Dalian + 5")
    await portRow("Hong Kong").getByRole("button", { name: "Save", exact: true }).click()
    await portRow("Hong Kong").getByRole("alert").filter({ hasText: /must be a number/ }).waitFor()
    assert.equal(requests.length, directOnlyRequests)
    await page.reload(); await readyAll()
    const saveDalian = async () => {
      await row.getByRole("button", { name: "Save", exact: true }).click()
      await row.getByRole("button", { name: "Saved", exact: true }).waitFor()
      await readyAll()
    }
    await fuel("Dalian", "HSFO").fill("0")
    await saveDalian()
    let saved = await app.row(app.other)
    assert.equal(saved.hsfo, 0); assert.equal(saved.vlsfo_formula, "Hong Kong + 5"); assert.equal(saved.mgo, 300)
    assert.equal(await fuel("Dalian", "HSFO").inputValue(), "0")
    console.log("PASS mixed-fuel save: real UI/API/SQL preserves zero, the other fuel formula and independent direct price")

    await fuel("Dalian", "MGO").fill("Hong Kong + 5")
    await saveDalian(); saved = await app.row(app.other)
    assert.equal(saved.mgo, null); assert.equal(saved.mgo_formula, "Hong Kong + 5")
    await button("Publish China").click(); await button("Published China").waitFor()
    const snapshot = await publicReport(reports.find(report => report.key === "china"))
    const publicDalian = snapshot.sections.flatMap(section => section.rows).find(port => port.port === "Dalian")
    assert.deepEqual(publicDalian, { port: "Dalian", hsfo: 0, vlsfo: 805, mgo: 1005 })
    console.log("PASS per-fuel formula: an explicit edit replaces only its old direct price; published report resolves the exact formula")

    await fuel("Dalian", "MGO").fill("1e2"); await saveDalian(); saved = await app.row(app.other)
    assert.equal(saved.mgo, 100); assert.equal(saved.mgo_formula, null)
    await fuel("Dalian", "MGO").fill(""); await saveDalian(); saved = await app.row(app.other)
    assert.equal(saved.mgo, null); assert.equal(saved.mgo_formula, null)
    assert.equal(await fuel("Dalian", "MGO").inputValue(), "")
    console.log("PASS per-fuel transitions: formula → numeric → blank saves exactly; no old quote reappears")

    const requestCount = requests.length
    await fuel("Keelung", "VLSFO").fill("123")
    await portRow("Keelung").getByRole("button", { name: "Save", exact: true }).click()
    await portRow("Keelung").getByRole("alert").filter({ hasText: /uses a formula/ }).waitFor()
    assert.equal(requests.length, requestCount)
    assert.equal(await fuel("Keelung", "VLSFO").inputValue(), "123")
    assert.equal(publishCount(), 1, "save/edit/validation never publish automatically")
    console.log("PASS Taiwan basis guard: a direct draft is not falsely saved when the report requires a formula; draft retained, no request/publication")

    const vlsfo = fuel("Dalian", "VLSFO")
    await vlsfo.fill("Hong Kong + 5")
    await vlsfo.evaluate(input => { input.focus(); input.setSelectionRange(12, 12) })
    await page.keyboard.type("1")
    assert.equal(await vlsfo.inputValue(), "Hong Kong + 15")
    assert.deepEqual(await vlsfo.evaluate(input => [input.selectionStart, input.selectionEnd]), [13, 13])
    const beforeFailedSave = await app.state()
    priceMode = "failure"
    await row.getByRole("button", { name: "Save", exact: true }).click()
    await row.getByRole("alert").filter({ hasText: /Synthetic temporary failure/ }).waitFor()
    assert.equal(await vlsfo.inputValue(), "Hong Kong + 15")
    assert.deepEqual(await app.state(), beforeFailedSave)
    priceMode = "success"; await saveDalian()
    assert.equal((await app.row(app.other)).vlsfo_formula, "Hong Kong + 15")
    assert.equal(publishCount(), 1)
    console.log("PASS formula drafting: middle-of-text typing preserves caret; failed SQL/API delivery preserves draft and baseline; explicit retry saves without publishing")
    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    console.log("PASS mixed-fuel editing: direct HSFO/MGO remain visible beside a VLSFO formula; opening does not publish")
  } else if (process.argv.includes("--pricing-semantics")) {
    await fresh(); await readyAll()
    await app.db.exec(`update ports set hsfo=638,vlsfo=710,mgo=990 where name in ('Kaohsiung','Taichung');
      update price_history set hsfo=null,vlsfo=null,mgo=case when port_id='${app.linked}' then 0 else null end
      where port_id in ('${app.linked}','${app.chained}') and recorded_at::date='2026-10-08'`)
    const before = await app.state()
    await page.reload(); await readyAll()
    assert.equal(publishCount(), 0, "opening/reviewing the page cannot implicitly publish missing quotes")
    const review = page.getByRole("table", { name: "Taiwan saved report preview", exact: true })
    await page.getByText("Review saved Taiwan report · 08 Oct 2026", { exact: true }).click()
    const previewRow = name => review.getByRole("row").filter({ has: page.getByRole("cell", { name, exact: true }) })
    await previewRow("Kaohsiung").waitFor()
    assert.deepEqual(await previewRow("Kaohsiung").locator("td").allTextContents(), ["Kaohsiung", "–", "–", "0"])
    for (const name of ["Taichung", "Keelung", "Suao", "Hualien"]) {
      assert.deepEqual(await previewRow(name).locator("td").allTextContents(), [name, "–", "–", "–"])
    }
    assert.deepEqual(await app.state(), before)
    await button("Publish Taiwan").click(); await button("Published Taiwan").waitFor()
    const snapshot = await publicReport(reports.find(report => report.key === "taiwan"))
    const khh = snapshot.rows.find(row => row.port === "Kaohsiung")
    assert.deepEqual(khh.hsfo, { today: null, last: 500, change: null })
    assert.deepEqual(khh.mgo, { today: 0, last: 900, change: -900 })
    for (const name of ["Taichung", "Keelung", "Suao", "Hualien"]) {
      const row = snapshot.rows.find(row => row.port === name)
      assert.deepEqual(row.vlsfo, { today: null, last: 700, change: null })
      assert.deepEqual(row.mgo, { today: null, last: 900, change: null })
    }
    assert.equal(publishCount(), 1); assert.deepEqual(await app.state(), before)
    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    console.log("PASS missing-quote semantics: actual Price Setter preview → explicit publish → audited API/SQL → public JSON preserves unavailable quotes, formula propagation, zero and null changes without rewriting source")
  } else {
  for (const report of reports) {
    await fresh(); await readyAll()
    assert.equal(await published(report), null); assert.equal(await publicReport(report), null)
    const beforePrices = await app.state()
    await button(`Publish ${report.title}`).click(); await button(`Published ${report.title}`).waitFor()
    const payload = JSON.parse(await published(report))
    assert.equal(payload.reportDate, "08 Oct 2026"); assert.deepEqual(await app.state(), beforePrices)
    assert.deepEqual(await publicReport(report), payload, "actual public API parses the exact SQL-committed report")
    assert.equal(publishCount(), 1)
    const request = requests.find(r => r.method === "POST" && r.path.endsWith("report-publication"))
    assert.equal(request.page, "pricesetter"); assert.deepEqual(Object.keys(request.body).sort(), ["dateOverride", "publicationVersion", "sourceVersion"])
    assert.match(request.body.sourceVersion, /^[a-f0-9]{64}$/); assert.equal(request.body.dateOverride, "")
    assert.equal(app.auditHeaders.at(-1)["x-bunker-admin-user"], "SERVER-EDITOR")
    assert.equal(app.auditHeaders.at(-1)["x-bunker-admin-page-path"], "/admin/pricesetter")
    if (report.key === "taiwan") { assert.equal(payload.rows.length, 5); assert.equal(payload.specialNotice, "Special notice\nSecond line"); assert.equal(payload.remark, "Remark\nSecond line") }
    console.log(`PASS ${report.key}: real UI → version-only request → audited API → actual SQL → actual public JSON; exact date, prices and notices`)

    const date = page.locator('input[type="date"]').nth(reports.indexOf(report))
    await date.fill("2026-10-10"); assert.equal(await button(`Published ${report.title}`).count(), 0)
    for (const mode of ["failure", "malformed", "incomplete"]) {
      readMode = mode; await button(`Reload saved ${report.review || report.title} report`).click()
      await alert(/Saved report data could not be loaded completely/).waitFor()
      assert.equal(await button(`Publish ${report.title}`).isDisabled(), true); assert.equal(await date.inputValue(), "2026-10-10")
      assert.deepEqual(JSON.parse(await published(report)), payload); readMode = "success"; await reload(report)
    }
    console.log(`PASS ${report.key}: failed/malformed/incomplete saved-report reads pause publishing, preserve overrides and do not change publications`)

    // Source changes both before the API request and between calculation/SQL.
    const changeSource = () => report.key === "taiwan" ? app.db.exec("update remarks set content=content||' changed' where id=2")
      : app.db.query("update ports set hsfo=coalesce(hsfo,0)+1 where name=$1", [report.key === "hongkong" ? "Hong Kong" : "Dalian"])
    await changeSource(); const old = await published(report)
    await button(`Publish ${report.title}`).click(); await alert(/Saved data or the published report changed/).waitFor()
    assert.equal(await published(report), old); assert.equal(await button(`Publish ${report.title}`).isDisabled(), true); await reload(report)
    app.control.beforeWrite = changeSource
    await button(`Publish ${report.title}`).click(); await alert(/Saved data or the published report changed/).waitFor()
    assert.equal(await published(report), old); await reload(report)
    console.log(`PASS ${report.key}: source races before request and during commit cannot overwrite the public report`)

    publishMode = "defer"
    // Same event turn: a second report must not escape the shared immediate lock.
    const other = reports.find(item => item.key !== report.key), count = publishCount()
    await page.evaluate(({ title, other }) => {
      const buttons = [...document.querySelectorAll("button")]
      buttons.find(b => b.textContent === "Publish " + title).click()
      buttons.find(b => b.textContent === "Publish " + other).click()
    }, { title: report.title, other: other.title })
    await button(`Publishing ${report.title}...`).waitFor(); await page.waitForFunction(() => document.querySelector('input[placeholder="price"]')?.disabled)
    assert.equal(publishCount(), count + 1)
    assert.equal(await price().isDisabled(), true)
    for (const item of reports) { assert.equal(await page.locator('input[type="date"]').nth(reports.indexOf(item)).isDisabled(), true); assert.equal(await button(`Reload saved ${item.review || item.title} report`).isDisabled(), true) }
    while (!release) await new Promise(resolve => setTimeout(resolve, 5))
    release(); release = null; publishMode = "success"
    await button(`Published ${report.title}`).waitFor()
    assert.equal(JSON.parse(await published(report)).reportDate, "10 Oct 2026")
    console.log(`PASS ${report.key}: same-tick cross-report clicks produce one request; all price/date/reload controls lock during publication; override preserved`)

    await date.fill("2026-10-11"); publishMode = "lost-reply"
    await button(`Publish ${report.title}`).click(); await alert(/Publication could not be confirmed/).waitFor()
    assert.equal(await button(`Published ${report.title}`).count(), 0); assert.equal(await button(`Publish ${report.title}`).isDisabled(), true)
    const committed = await published(report); assert.equal(JSON.parse(committed).reportDate, "11 Oct 2026")
    publishMode = "success"; await reload(report)
    await button(`Publish ${report.title}`).click(); await button(`Published ${report.title}`).waitFor()
    assert.equal(await published(report), committed)
    assert.deepEqual(await publicReport(report), JSON.parse(committed))
    console.log(`PASS ${report.key}: lost reply is not false success; explicit reload and identical retry reconcile the committed report`)

    for (const damaged of ["{broken", "[]", JSON.stringify({ reportDate: "08 Oct 2026", rows: {}, sections: {} })]) {
      await fresh()
      await app.db.query("insert into remarks(id,content) values($1,$2)", [report.id, damaged])
      await page.reload(); await readyAll()
      const warning = alert(`The published ${report.review || report.title} report is damaged.`)
      await warning.waitFor()
      assert.equal(await published(report), damaged, "loading never repairs implicitly")
      assert.equal(publishCount(), 0)
      await page.getByText(`Review saved ${report.review || report.title} report · 08 Oct 2026`, { exact: true }).click()
      await page.getByRole("table", { name: `${report.review || report.title} saved report preview`, exact: true }).waitFor()
      assert.equal((await page.request.get(`${origin}/api/reports/${report.key}`)).status(), 502)
      await button(`Publish ${report.title}`).click(); await button(`Published ${report.title}`).waitFor()
      assert.equal(await warning.count(), 0, "warning clears only after confirmed publication")
      assert.deepEqual(await publicReport(report), JSON.parse(await published(report)))
    }
    console.log(`PASS ${report.key}: cold-page damaged JSON/shape warning → source review → explicit repair → public report; no implicit writes or cross-report blocking`)
  }

  // Price saves refresh sources but must not quietly adopt a competing report.
  await fresh(); await readyAll()
  for (const report of reports) { await button(`Publish ${report.title}`).click(); await button(`Published ${report.title}`).waitFor() }
  const taiwan = reports.find(r => r.key === "taiwan")
  const foreign = JSON.stringify({ ...JSON.parse(await published(taiwan)), reportDate: "07 Oct 2026" })
  await app.db.query("update remarks set content=$1 where id=101", [foreign])
  const count = publishCount()
  await price().evaluate(input => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "0")
    input.dispatchEvent(new Event("input", { bubbles: true }))
    ;[...document.querySelectorAll("button")].find(b => b.textContent === "Publish Taiwan").click()
  })
  await alert(/Save changed prices/).waitFor()
  assert.equal(publishCount(), count)
  await portRow("Hong Kong").getByRole("button", { name: "Save", exact: true }).click()
  await portRow("Hong Kong").getByRole("button", { name: "Saved", exact: true }).waitFor()
  await alert(/Another publication was saved/).waitFor()
  assert.equal((await app.row(app.basis)).hsfo, 0); assert.equal(await price().inputValue(), "0")
  assert.equal(await button("Publish Taiwan").isDisabled(), true); assert.equal(await published(taiwan), foreign)
  await reload(taiwan); await button("Publish Taiwan").click(); await button("Published Taiwan").waitFor()
  await ready(reports.find(r => r.key === "hongkong"))
  await button("Publish HK").click(); await button("Published HK").waitFor()
  assert.equal(JSON.parse(await published(reports[3])).rows[0].hsfo.today, 0)
  console.log("PASS price save: dirty rows cannot publish; actual price API/SQL saves zero; automatic source refresh never adopts a foreign report; explicit reload permits review/retry")

  await price().fill("9"); priceMode = "incomplete"
  await portRow("Hong Kong").getByRole("button", { name: "Save", exact: true }).click()
  await alert(/save could not be confirmed/).waitFor()
  assert.equal(await price().inputValue(), "9"); assert.equal((await app.row(app.basis)).hsfo, 9)
  for (const report of reports) assert.equal(await button(`Publish ${report.title}`).isDisabled(), true)
  const hk = reports[3], beforeRetry = publishCount()
  await reload(hk); assert.equal(await price().inputValue(), "9", "report reload never discards the uncertain price draft")
  await button("Publish HK").click(); await alert(/Save changed prices/).waitFor(); assert.equal(publishCount(), beforeRetry)
  priceMode = "success"
  await portRow("Hong Kong").getByRole("button", { name: "Save", exact: true }).click()
  await portRow("Hong Kong").getByRole("button", { name: "Saved", exact: true }).waitFor(); await readyAll()
  await button("Publish HK").click(); await button("Published HK").waitFor()
  assert.equal(JSON.parse(await published(hk)).rows[0].hsfo.today, 9)
  console.log("PASS uncertain price save: committed-but-unconfirmed result retains draft and keeps all publications paused")

  await fresh(); await readyAll()
  const requiredBefore = await app.state(), publicationsBeforeRename = await app.publications()
  const requiredName = portRow("Taichung").locator('input').first()
  await requiredName.fill("Renamed Taichung")
  await portRow("Renamed Taichung").getByRole("button", { name: "Save", exact: true }).click()
  await alert(/Keep its existing name/).waitFor()
  assert.deepEqual(await app.state(), requiredBefore)
  assert.deepEqual(await app.publications(), publicationsBeforeRename)
  assert.equal(await portRow("Renamed Taichung").count(), 1, "rejected rename retains the user's complete row draft")
  assert.equal((await app.read("taiwan")).status, 200)
  assert.equal(await button("Publish Taiwan").isDisabled(), true, "an unsaved rename cannot publish")
  await portRow("Renamed Taichung").locator('input').first().fill("Taichung")
  await portRow("Taichung").getByPlaceholder("price").first().fill("0")
  await portRow("Taichung").getByRole("button", { name: "Save", exact: true }).click()
  await portRow("Taichung").getByRole("button", { name: "Saved", exact: true }).waitFor()
  await readyAll(); await button("Publish Taiwan").click(); await button("Published Taiwan").waitFor()
  assert.equal((await app.row(app.chained)).hsfo, 0)
  assert.equal((await publicReport(reports[2])).rows.length, 5)
  console.log("PASS required-root rename: actual UI/API/SQL keeps the draft, rolls back changes, preserves report health and permits corrected price save/publication")

  async function showDeletes() { await button("☰").click(); await button("Show Delete Buttons").click() }
  async function deleteRow(name) { await portRow(name).getByRole("button",{name:"Delete",exact:true}).click() }
  await fresh();await readyAll();await showDeletes()
  const protectedBefore=await app.state()
  await deleteRow("Taichung");await alert(/required by a market report/).waitFor()
  assert.equal(await portRow("Taichung").count(),1);assert.deepEqual(await app.state(),protectedBefore)
  assert.equal((await app.read("taiwan")).status,200)
  assert.equal(app.auditHeaders.at(-2)["x-bunker-admin-user"],"SERVER-EDITOR")
  console.log("PASS deletion: actual UI/API/SQL blocks required Taichung deletion without dropping history/formulas or breaking Taiwan preview")

  await fresh();await readyAll()
  await app.db.exec(`update ports set hsfo_formula='Dalian + 0' where name='Kaohsiung'`)
  await showDeletes();await deleteRow("Dalian");await alert(/Other ports use this port/).waitFor()
  assert.equal(await portRow("Dalian").count(),1)
  await fresh();await readyAll()
  await app.db.query("insert into price_history(port_id,hsfo) values($1,0)",[app.other])
  await showDeletes();await deleteRow("Dalian");await alert(/saved price history/).waitFor()
  assert.equal(await portRow("Dalian").count(),1)
  console.log("PASS deletion dependencies: newly linked formulas and newly added history are checked at commit, not trusted from the browser")

  await fresh();await readyAll();await showDeletes()
  const staleBefore=await app.state()
  await app.db.query("update ports set hsfo=999 where id=$1",[app.other])
  await deleteRow("Dalian");await alert(/This port or its report settings changed/).waitFor()
  assert.equal(await portRow("Dalian").count(),1);assert.equal((await app.row(app.other)).hsfo,999)
  await button("Reload saved ports").click();await portRow("Dalian").waitFor()
  for(const report of reports)await reload(report)
  priceMode="defer";await deleteRow("Dalian");await page.waitForFunction(()=>[...document.querySelectorAll("button")].some(b=>b.textContent==="Publish Taiwan"&&b.disabled))
  assert.equal(await price().isDisabled(),true);assert.equal(await portRow("Dalian").getByRole("button",{name:"Delete",exact:true}).isDisabled(),true)
  for(let attempts=0;!release&&attempts<200;attempts++)await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(typeof release,"function");release();release=null;priceMode="success";await portRow("Dalian").waitFor({state:"detached"});await readyAll()
  assert.equal((await app.state()).ports.length,staleBefore.ports.length-1)
  const removal=requests.filter(r=>r.method==="DELETE").at(-1)
  assert.equal(removal.body.expected.hsfo,999);assert.equal(removal.status,200)
  console.log("PASS deletion conflict/locking: stale edits preserve rows; explicit reload reviews current prices; one confirmed transaction removes exactly that row")

  await fresh();await readyAll();await showDeletes();priceMode="lost-reply"
  await deleteRow("Dalian");await alert(/Could not confirm deletion/).waitFor()
  assert.equal(await portRow("Dalian").count(),1);assert.equal((await app.state()).ports.some(p=>p.id===app.other),false)
  assert.equal(await portRow("Dalian").getByRole("button",{name:"Delete",exact:true}).isDisabled(),true)
  priceMode="success";await button("Reload saved ports").click();await portRow("Dalian").waitFor({state:"detached"})
  for(const report of reports)await reload(report)
  console.log("PASS lost deletion reply: uncertain committed deletion keeps the displayed row and blocks repeat writes until explicit reconciliation")

  await fresh();await app.db.exec(`insert into remarks(id,content) values(105,'{"dalian::hsfo":"NA","hong kong::mgo":"SE"}')`)
  await page.reload();await readyAll();await showDeletes()
  await deleteRow("Dalian");await portRow("Dalian").waitFor({state:"detached"});await readyAll()
  assert.deepEqual(JSON.parse((await app.db.query("select content from remarks where id=105")).rows[0].content),{"hong kong::mgo":"SE"})
  assert.deepEqual(requests.filter(r=>r.method==="DELETE").at(-1).body.expectedFallbacks,{"dalian::hsfo":"NA"})
  assert.deepEqual(await app.publications(),[],"deletion must not implicitly publish reports")
  console.log("PASS deletion settings: reviewed target overrides are cleaned up atomically; other ports' settings and publications remain unchanged")

  async function addRow(label="Add Port") { await button("☰").click();await button(label).click() }
  for(const mode of ["lost-reply","malformed","incomplete"]) {
    await fresh();await readyAll();await price().fill("777")
    const before=await app.state();priceMode=mode
    await addRow();await alert(/Could not confirm|could not be confirmed/).waitFor()
    assert.equal(await price().inputValue(),"777","uncertain creation preserves unrelated unsaved drafts")
    const committed=await app.state(), first=requests.filter(r=>r.method==="PUT").at(-1)
    assert.equal(committed.ports.length,before.ports.length+1)
    assert.equal(committed.history.length,before.history.length)
    assert.equal(await portRow("New Port").count(),0,"unconfirmed success must not be shown as a confirmed addition")
    priceMode="success";await button("Reload saved ports").click();await portRow("New Port").waitFor()
    await portRow("New Port").locator("input").first().fill("Keep retry draft")
    await addRow();await portRow("Keep retry draft").waitFor();await readyAll()
    assert.equal(await portRow("New Port").count(),0)
    assert.equal(await page.locator('table:not([aria-label]) tbody tr').count(),committed.ports.length)
    assert.equal(requests.filter(r=>r.method==="PUT").at(-1).body.requestId,first.body.requestId)
    assert.deepEqual(await app.state(),committed,"replay must not reset edited saved values or create another row")
    assert.deepEqual(await app.publications(),[])
    console.log(`PASS creation ${mode}: explicit reload/retry reuses the receipt, preserves a subsequent draft and never duplicates or publishes`)
  }
  await fresh();await readyAll();priceMode="lost-reply";await addRow();await alert(/Could not confirm|could not be confirmed/).waitFor()
  const original=requests.filter(r=>r.method==="PUT").at(-1).body.requestId
  const created=(await app.state()).ports.find(p=>p.name==="New Port")
  await app.db.query("select public.delete_price_setter_port($1,$2::jsonb,'{}'::jsonb)",[created.id,JSON.stringify(priceSetterDeletionSnapshot(created))])
  priceMode="success";await button("Reload saved ports").click();await portRow("Hong Kong").waitFor()
  const putsBeforeWrongKind=requests.filter(r=>r.method==="PUT").length
  await addRow("Add Divider");await alert(/Retry Add Port first/).waitFor()
  assert.equal(requests.filter(r=>r.method==="PUT").length,putsBeforeWrongKind,"different kind cannot replace an uncertain attempt")
  assert.ok(requests.filter(r=>r.method==="PUT").every(r=>r.body.requestId===original),"browser-level connection retries also reuse the exact receipt")
  await button("Reload saved ports").click();await portRow("Hong Kong").waitFor();await addRow();await alert(/already removed/).waitFor()
  assert.equal(requests.filter(r=>r.method==="PUT").at(-1).body.requestId,original)
  assert.equal(await portRow("New Port").count(),0);assert.equal((await app.state()).ports.some(p=>p.id===created.id),false)
  await button("Reload saved ports").click();await portRow("Hong Kong").waitFor();await addRow();await portRow("New Port").waitFor()
  assert.notEqual(requests.filter(r=>r.method==="PUT").at(-1).body.requestId,original)
  console.log("PASS creation retirement: wrong-kind retry is stopped; deletion survives a delayed reply; only a new explicit intent gets a new request")

  await fresh();await readyAll();priceMode="defer";await addRow()
  for(let attempts=0;!release&&attempts<200;attempts++)await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(typeof release,"function");assert.equal(await price().isDisabled(),true)
  await button("☰").click();assert.equal(await button("Add Port").isDisabled(),true);assert.equal(await button("Add Divider").isDisabled(),true);await button("☰").click()
  assert.equal(await button("Publish Taiwan").isDisabled(),true)
  release();release=null;priceMode="success";await portRow("New Port").waitFor();await readyAll()
  await addRow();await portRow("New Port 2").waitFor();await addRow("Add Divider");await page.getByRole("textbox",{name:"Divider title"}).waitFor()
  assert.equal(requests.filter(r=>r.method==="PUT").length,3)
  assert.deepEqual(await app.publications(),[])
  console.log("PASS creation locking and server allocation: pending writes disable edits/publication; sequential explicit additions have distinct names and identities")

  await fresh();await app.db.exec("insert into ports(name,display_order) select 'Inventory port '||n,n from generate_series(1,1205) n")
  await page.reload();await portRow("Inventory port 1205").waitFor()
  assert.equal(await page.locator('table:not([aria-label]) tbody tr').count(),1212)
  await portRow("Inventory port 1205").getByPlaceholder("price").first().fill("123")
  await portRow("Inventory port 1205").getByRole("button",{name:"Save",exact:true}).click()
  await portRow("Inventory port 1205").getByRole("button",{name:"Saved",exact:true}).waitFor()
  assert.equal((await app.db.query("select hsfo=123 as matches from ports where name='Inventory port 1205'")).rows[0].matches,true)
  const largeState=await app.state(),writesBeforeInventory=requests.filter(r=>r.method!=="GET").length
  for(const mode of ["truncated","malformed","incomplete","failure"]){
    inventoryMode=mode;await page.reload();await alert(/Could not load saved ports/).waitFor()
    assert.equal(await page.locator('table:not([aria-label]) tbody tr').count(),0)
    assert.equal(await button("Publish Taiwan").isDisabled(),true)
    await button("☰").click();assert.equal(await button("Add Port").isDisabled(),true);await button("☰").click()
    inventoryMode="success";await button("Try loading again").click();await portRow("Inventory port 1205").waitFor()
    assert.equal(await page.locator('table:not([aria-label]) tbody tr').count(),1212)
    assert.deepEqual(await app.state(),largeState)
  }
  assert.equal(requests.filter(r=>r.method!=="GET").length,writesBeforeInventory)
  assert.deepEqual(await app.publications(),[])
  console.log("PASS complete inventory: 1,212 SQL-backed rows render; the final row saves correctly; truncated, malformed and failed reads pause all writes and recover without publication")

  await fresh("?access=view"); await page.getByText("Loading saved China report…", { exact: true }).waitFor({ state: "hidden" })
  for (const report of reports) assert.equal(await button(`Publish ${report.title}`).isDisabled(), true)
  const baseline = await (await app.read("taiwan", "pricesetter")).json(); app.control.access = "view"
  const calls = app.calls.length
  const denied = await page.request.post(`${origin}/api/admin/report-publication?report=taiwan&page=pricesetter`, { data: { sourceVersion: baseline.sourceVersion, publicationVersion: baseline.publicationVersion, dateOverride: "" } })
  assert.equal(denied.status(), 403); assert.equal(app.calls.length, calls); assert.deepEqual(await app.publications(), [])
  await showDeletes();assert.equal(await portRow("Dalian").getByRole("button",{name:"Delete",exact:true}).isDisabled(),true)
  const deleteDenied=await page.request.delete(`${origin}/api/admin/prices`,{data:{portId:app.other,expected:{},expectedFallbacks:{}}})
  assert.equal(deleteDenied.status(),403);assert.equal(app.calls.length,calls)
  const creationDenied=await page.request.put(`${origin}/api/admin/prices`,{data:{operation:"create",requestId:crypto.randomUUID(),kind:"port"}})
  assert.equal(creationDenied.status(),403);assert.equal(app.calls.length,calls)
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  console.log("PASS permissions: View cannot publish via UI or forged request; no browser errors or external requests")
  }
  await context.close()
} finally {
  if (release) release()
  if (browser) await browser.close()
  await new Promise(resolve => server.close(resolve))
  if (app) await app.db.close()
}
