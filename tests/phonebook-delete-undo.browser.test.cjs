// Actual Phonebook page, route guard, global CSS and IndexedDB. Only the same
// reviewed SDK/auth/sync boundary is synthetic; no provider request is possible.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const http = require("node:http")
const crypto = require("node:crypto")
const { build } = require("esbuild")
const postcss = require("postcss")
const tailwind = require("@tailwindcss/postcss")
const root = path.resolve(__dirname, "..")
const out = process.env.PHONEBOOK_DELETE_UNDO_EVIDENCE
assert.ok(out && path.isAbsolute(out), "Use a new owned evidence directory")
assert.equal(fs.existsSync(out), false, "Do not overwrite earlier results")
fs.mkdirSync(out, { recursive: true })
const ids = { company: "11111111-1111-4111-8111-111111111111", contacts: ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"] }
const sha = v => crypto.createHash("sha256").update(v).digest("hex")
const button = (page, name) => page.getByRole("button", { name, exact: true })
const company = (page, name = "ALPHA SHIPPING") => page.getByRole("button", { name: new RegExp("^" + name) })
const contact = (page, name = "ALICE TEST") => page.getByRole("button", { name: new RegExp("^" + name) })
const field = (page, label) => page.getByText(label, { exact: true }).locator("..").locator("input")
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const entry = `import React from "react";import {createRoot} from "react-dom/client";import Page from "./app/admin/phonebook/page";import {AdminRouteGuard} from "./components/AdminRouteGuard";import {installPhonebookSyncHarness} from "./tests/fixtures/phonebook-sync-mocks";
installPhonebookSyncHarness();const h=window.__phonebookSyncHarness,ids=${JSON.stringify(ids)},scenario=new URLSearchParams(location.search).get("scenario")||"delete";
h.companies[0].id=ids.company;h.contacts.forEach((c,i)=>c.id=ids.contacts[i]);
if(new URLSearchParams(location.search).get("mode")==="none")h.auth.permissions.phonebook="none";
if(scenario.startsWith("company")){const before={...h.companies[0],updated_at:"2026-10-13T00:00:00.123456Z"};let action="update";
if(scenario==="company-create")action="create";else if(scenario==="company-delete")action="delete";else if(scenario!=="company-same"){h.companies[0].name="RENAMED SHIPPING";h.contacts.filter(c=>c.company==="ALPHA SHIPPING").forEach(c=>c.company="RENAMED SHIPPING")}
const after={...h.companies[0]};if(action==="delete")h.companies.shift();if(scenario==="company-empty")h.contacts=h.contacts.filter(c=>c.company!=="RENAMED SHIPPING");
localStorage.setItem("phonebook_change_log",JSON.stringify([{id:"seed-company",entityType:"company",action,label:"Synthetic company change",timestamp:"2026-10-20T00:00:00Z",before:action==="create"?null:before,after:action==="delete"?null:after}]))}
h.syncReplies=[];const send=window.fetch;window.fetch=async(...args)=>{const response=await send(...args);const url=typeof args[0]==="string"?args[0]:args[0]?.url;if(url==="/api/phonebook/carddav-sync"&&args[1]?.method==="POST")h.syncReplies.push({status:response.status,body:await response.clone().json()});return response};
const app=createRoot(document.getElementById("root"));h.unmount=()=>app.unmount();h.rerender=()=>app.render(<React.Fragment key={h.auth.actorKey}><AdminRouteGuard><select aria-label="Unsafe fixture selector"><option>Unsafe</option></select><button>Delete fixture</button><Page/></AdminRouteGuard></React.Fragment>);h.rerender();`

async function main() {
  const mocks = path.join(root, "tests/fixtures/phonebook-sync-mocks.ts")
  const bundle = await build({ absWorkingDir: root, stdin: { contents: entry, resolveDir: root, loader: "tsx" }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' }, plugins: [{ name: "synthetic-phonebook-boundaries", setup(builder) {
    builder.onResolve({ filter: /^@\/lib\/(supabase|useSimpleAdminAuth)$/ }, () => ({ path: mocks }))
    builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "synthetic" }))
    builder.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({ contents: 'export const usePathname=()=>location.pathname;export const useRouter=()=>({push:()=>{}});', loader: "js" }))
  } }] })
  const css = await postcss([tailwind()]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })
  const publicRoot = fs.realpathSync(path.join(root, "public"))
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/globals.css"><link rel="stylesheet" href="/roboto.css"></head><body class="fc-admin-scope"><div id="root"></div><script src="/bundle.js"></script></body></html>'
  const server = http.createServer((req, res) => {
    if (req.method !== "GET") { res.writeHead(405); res.end(); return }
    const url = new URL(req.url, "http://127.0.0.1")
    if (url.pathname === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].contents); return }
    if (url.pathname === "/globals.css") { res.setHeader("Content-Type", "text/css"); res.end(css.css); return }
    if (url.pathname === "/roboto.css") { res.setHeader("Content-Type", "text/css"); res.end(fs.readFileSync(path.join(root, "app/fonts/roboto.css"))); return }
    const file = path.resolve(publicRoot, "." + url.pathname)
    if (file.startsWith(publicRoot + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) { res.end(fs.readFileSync(file)); return }
    if (url.pathname !== "/admin/phonebook") { res.writeHead(404); res.end(); return }
    res.setHeader("Content-Type", "text/html"); res.end(html)
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const { chromium, webkit } = require("playwright"), results = []
  let browser, context, failure
  try {
    for (const [engine, launcher] of process.env.PHONEBOOK_DELETE_UNDO_DIAGNOSTIC ? [["chromium", chromium]] : [["chromium", chromium], ["webkit", webkit]]) {
      browser = await launcher.launch({ headless: true })
      for (const width of process.env.PHONEBOOK_DELETE_UNDO_DIAGNOSTIC ? [1440] : [1440, 320, 390]) for (const scheme of process.env.PHONEBOOK_DELETE_UNDO_DIAGNOSTIC ? ["light"] : ["light", "dark"]) {
        let page, errors, blocked
        async function reset(scenario = "delete", mode = "edit", select = true) {
          await context?.close(); context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, colorScheme: scheme })
          errors = []; blocked = []
          await context.route("**/*", route => { const req = route.request(), url = new URL(req.url()); if (url.origin === origin && req.method() === "GET" && !url.pathname.startsWith("/api/")) return route.continue(); blocked.push({ path: url.pathname, method: req.method() }); return route.abort() })
          page = await context.newPage(); page.setDefaultTimeout(10000); page.on("pageerror", e => errors.push(e.message))
          await page.goto(origin + "/admin/phonebook?scenario=" + scenario + "&mode=" + mode)
          if (select && !["signedout", "none"].includes(mode)) { await company(page, scenario.startsWith("company") && !["company-same", "company-create", "company-delete"].includes(scenario) ? "RENAMED SHIPPING" : "ALPHA SHIPPING").click(); if (scenario !== "company-empty") await contact(page).click() }
        }
        async function undo() { await button(page, "☰").click(); await button(page, "Undo").first().click() }
        async function editBob(value) { await contact(page, "BOB TEST").click(); await button(page, "Edit").click(); await field(page, "Mobile 1").fill(value) }
        async function removeAlice() { await button(page, "Edit").click(); page.once("dialog", d => d.accept()); await button(page, "Delete").click() }
        async function snapshot(id, screenshot = false) {
          await settle(page)
          const state = await page.evaluate(() => { const h = window.__phonebookSyncHarness; return { contacts: structuredClone(h.contacts), companies: structuredClone(h.companies), operations: structuredClone(h.operations), requests: structuredClone(h.requests), syncReplies: structuredClone(h.syncReplies), retries: JSON.parse(localStorage.getItem("phonebook_carddav_pending:v2") || "[]"), log: JSON.parse(localStorage.getItem("phonebook_change_log") || "[]"), status: [...document.querySelectorAll('[role="status"]')].map(e => e.textContent), companyDeleteRetrySnapshots: h.companyDeleteRetrySnapshots } })
          assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
          const visual = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, statuses: [...document.querySelectorAll('[role="status"]')].map(el => ({ text: el.textContent, color: getComputedStyle(el).color, pageColor: getComputedStyle(el.closest(".fc-admin-scope")).color })) }))
          assert.ok(visual.scrollWidth <= width, "No horizontal page overflow")
          for (const status of visual.statuses) if (!status.text.startsWith("View-only access.")) assert.equal(status.color, status.pageColor, "Mutation feedback stays readable on the page background")
          if (screenshot) await page.screenshot({ path: path.join(out, `${engine}-${width}-${scheme}-${id}.png`), fullPage: true })
          results.push({ id, engine, browserVersion: browser.version(), width, scheme, state, visual }); return state
        }
        const syncs = s => s.requests.filter(r => r.url === "/api/phonebook/carddav-sync" && r.method === "POST")
        await reset("company-rename"); await undo(); await page.getByText("Undone and synced.", { exact: true }).waitFor()
        let s = await snapshot("company-undo-verified"); assert.equal(s.companies[0].name, "ALPHA SHIPPING"); assert.equal(s.log.length, 0); assert.deepEqual(s.retries, []); assert.ok(s.syncReplies.every(r => r.body.failed.length === 0)); assert.equal(await page.getByText("Undo complete.", { exact: true }).count(), 0)

        await reset("company-rename"); await page.evaluate(id => window.__phonebookSyncHarness.syncPlan.push({ failedIds: [id] }), ids.contacts[0]); await undo(); await page.getByText(/^Undone locally, but CardDAV sync failed\./).waitFor()
        s = await snapshot("company-undo-207-keeps-failure", true); assert.equal(s.companies[0].name, "ALPHA SHIPPING"); assert.equal(s.log.length, 0); assert.deepEqual(s.retries.map(r => [r.id, r.operation]), [[ids.contacts[0], "upsert"]]); assert.ok(s.syncReplies.some(r => r.status === 207)); assert.equal(await page.getByText("Undo complete.", { exact: true }).count(), 0)

        for (const status of [409, 500]) {
          await reset("company-rename"); await page.evaluate(status => { window.__phonebookSyncHarness.companySaveStatus = status }, status); await undo(); await page.getByText("This company changed or was removed. Your edits are still here; reopen it before saving again.", { exact: true }).waitFor()
          s = await snapshot(`company-undo-${status}-keeps-log`); assert.equal(s.companies[0].name, "RENAMED SHIPPING"); assert.equal(s.log.length, 1); assert.deepEqual(syncs(s), []); assert.deepEqual(s.retries, []); assert.equal(await button(page, "Edit").isDisabled(), false)
        }
        for (const scenario of ["company-same", "company-empty", "company-create", "company-delete"]) {
          await reset(scenario, "edit", scenario !== "company-delete"); await undo(); await page.getByText("Undo complete.", { exact: true }).waitFor(); s = await snapshot(scenario + "-no-sync-completion"); assert.equal(s.log.length, 0); assert.deepEqual(syncs(s), []); assert.deepEqual(s.retries, [])
          if (scenario === "company-create") assert.equal(s.companies.some(c => c.id === ids.company), false)
          if (scenario === "company-delete") assert.equal(s.companies.some(c => c.id === ids.company), true)
        }
        for (const mode of ["success", "missing", "sync-failure"]) {
          await reset()
          if (mode === "missing") await page.evaluate(id => { const h = window.__phonebookSyncHarness; h.contacts = h.contacts.filter(c => c.id !== id) }, ids.contacts[0])
          if (mode === "sync-failure") await page.evaluate(id => window.__phonebookSyncHarness.syncPlan.push({ failedIds: [id] }), ids.contacts[0])
          await removeAlice(); await page.getByText(mode === "sync-failure" ? /^CardDAV sync was not fully verified\./ : "Deleted and synced.", { exact: mode !== "sync-failure" }).waitFor()
          s = await snapshot("delete-" + mode); assert.equal(s.contacts.some(c => c.id === ids.contacts[0]), false); assert.equal(s.log.length, 1); assert.deepEqual(s.operations[0].filters, [{ field: "id", value: ids.contacts[0] }], "Deliberate Delete stays ID-only/idempotent, not new CAS")
          assert.deepEqual(syncs(s).map(r => r.body), [{ deleteContactIds: [ids.contacts[0]] }]); assert.equal(s.retries.length, mode === "sync-failure" ? 1 : 0)
        }
        await reset(); await button(page, "Edit").click(); page.once("dialog", d => d.dismiss()); await button(page, "Delete").click(); s = await snapshot("delete-cancel-no-operation"); assert.deepEqual(s.operations, []); assert.deepEqual(syncs(s), []); assert.equal(await contact(page, "BOB TEST").isDisabled(), false)

        await reset(); await page.evaluate(id => { const h = window.__phonebookSyncHarness; h.contacts = h.contacts.filter(c => c.id === id || c.company === "BETA SHIPPING"); h.failCompanyDeletes = true }, ids.contacts[0]); await button(page, "Edit").click(); const accept = d => d.accept(); page.on("dialog", accept); await button(page, "Delete").click(); await page.getByText("Contact deleted and CardDAV deletion verified, but company could not be deleted.", { exact: true }).waitFor(); page.off("dialog", accept)
        s = await snapshot("delete-stage-before-optional-company-failure"); assert.equal(s.contacts.some(c => c.id === ids.contacts[0]), false); assert.equal(s.companies.some(c => c.id === ids.company), true); assert.deepEqual(s.companyDeleteRetrySnapshots.map(rows => rows.map(r => [r.id, r.operation])), [[[ids.contacts[0], "delete"]]]); assert.deepEqual(s.retries, [])

        for (const action of ["delete", "company"]) {
          await reset(action === "company" ? "company-rename" : "delete")
          await page.evaluate(action => { const h = window.__phonebookSyncHarness; if (action === "company") h.deferCompanySave = true; else h.deferContactDelete = true; h.syncPlan.push({ defer: true, failedIds: [h.contacts[0].id] }) }, action)
          if (action === "delete") await removeAlice(); else await undo()
          await page.waitForFunction(action => typeof window.__phonebookSyncHarness[action === "delete" ? "releaseContactDelete" : "releaseCompanySave"] === "function", action)
          assert.equal(await contact(page, "BOB TEST").isDisabled(), true); await contact(page, "BOB TEST").evaluate(node => node.click()); assert.equal(await field(page, "Mobile 1").count(), action === "delete" ? 1 : 0, "A pending local mutation cannot admit a new BOB editor")
          await page.evaluate(action => window.__phonebookSyncHarness[action === "delete" ? "releaseContactDelete" : "releaseCompanySave"](), action); await page.waitForFunction(() => typeof window.__phonebookSyncHarness.releaseSync === "function")
          await editBob("+85299900011"); await page.evaluate(() => window.__phonebookSyncHarness.releaseSync()); await page.waitForFunction(() => window.__phonebookSyncHarness.activeSyncs === 0); await settle(page)
          assert.equal(await field(page, "Mobile 1").inputValue(), "+85299900011"); s = await snapshot(action + "-lock-and-late-sync-draft", true); assert.equal(s.contacts.find(c => c.id === ids.contacts[1]).mobile_1, "+85292223333"); assert.equal(s.log.some(r => r.id === "seed-company"), false); assert.equal(s.status.some(t => /Undo complete|Undone locally|Deleted and synced/.test(t)), false)

          for (const ownerChange of ["account", "unmount"]) {
            await reset(action === "company" ? "company-rename" : "delete")
            await page.evaluate(action => { const h = window.__phonebookSyncHarness; if (action === "company") h.deferCompanySave = true; else h.deferContactDelete = true }, action)
            if (action === "delete") await removeAlice(); else await undo()
            await page.waitForFunction(action => typeof window.__phonebookSyncHarness[action === "delete" ? "releaseContactDelete" : "releaseCompanySave"] === "function", action)
            if (ownerChange === "unmount") await page.evaluate(() => window.__phonebookSyncHarness.unmount())
            else { await page.evaluate(() => { const h = window.__phonebookSyncHarness; h.auth.actorKey = "synthetic-actor-b"; h.rerender() }); await company(page, action === "company" ? "RENAMED SHIPPING" : "ALPHA SHIPPING").click(); await editBob("+85299900022") }
            await page.evaluate(action => window.__phonebookSyncHarness[action === "delete" ? "releaseContactDelete" : "releaseCompanySave"](), action); await settle(page)
            if (ownerChange === "account") assert.equal(await field(page, "Mobile 1").inputValue(), "+85299900022")
            s = await snapshot(action + "-old-" + ownerChange + "-completion-owned"); assert.deepEqual(syncs(s), []); assert.deepEqual(s.retries, []); assert.equal(s.log.length, action === "company" ? 1 : 0)
          }
        }
        await reset(); await page.evaluate(() => { window.__phonebookSyncHarness.deferCompanyContacts = true }); await removeAlice(); await page.waitForFunction(() => typeof window.__phonebookSyncHarness.releaseCompanyContacts === "function"); assert.equal(await contact(page, "BOB TEST").isDisabled(), true); assert.deepEqual((await page.evaluate(() => window.__phonebookSyncHarness.operations)), []); await page.evaluate(() => window.__phonebookSyncHarness.releaseCompanyContacts()); await page.getByText("Deleted and synced.", { exact: true }).waitFor(); await snapshot("delete-locks-before-first-directory-read")

        for (const ownerChange of ["account", "unmount"]) {
          await reset(); await page.evaluate(() => { window.__phonebookSyncHarness.deferCompanyContacts = true }); await removeAlice(); await page.waitForFunction(() => typeof window.__phonebookSyncHarness.releaseCompanyContacts === "function")
          if (ownerChange === "unmount") await page.evaluate(() => window.__phonebookSyncHarness.unmount())
          else { await page.evaluate(() => { const h = window.__phonebookSyncHarness; h.deferCompanyContacts = false; h.auth.actorKey = "synthetic-actor-b"; h.rerender() }); await company(page).click(); await editBob("+85299900044") }
          await page.evaluate(() => window.__phonebookSyncHarness.releaseCompanyContacts()); await settle(page)
          if (ownerChange === "account") assert.equal(await field(page, "Mobile 1").inputValue(), "+85299900044")
          s = await snapshot("delete-pre-read-" + ownerChange + "-cannot-write"); assert.deepEqual(s.operations, []); assert.deepEqual(syncs(s), []); assert.deepEqual(s.log, []); assert.equal(s.contacts.some(c => c.id === ids.contacts[0]), true)
        }

        await reset("company-rename"); await editBob("+85299900033"); await undo(); await page.getByText("Finish or cancel your current contact edits before using Undo.", { exact: true }).waitFor(); assert.equal(await field(page, "Mobile 1").inputValue(), "+85299900033"); s = await snapshot("company-undo-keeps-existing-draft"); assert.deepEqual(s.requests.filter(r => r.url === "/api/phonebook/company" && r.method === "POST"), []); assert.equal(s.log.length, 1)

        await reset("company-same", "view")
        await page.waitForFunction(() => document.querySelector('[aria-label="Unsafe fixture selector"]')?.disabled && [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Edit")?.disabled && [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Delete fixture")?.disabled)
        assert.equal(await button(page, "Edit").isDisabled(), true); assert.equal(await button(page, "Delete fixture").isDisabled(), true); assert.equal(await page.getByLabel("Unsafe fixture selector").isDisabled(), true); await button(page, "☰").click(); await page.waitForFunction(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Undo")?.disabled); assert.equal(await button(page, "Undo").first().isDisabled(), true)
        const denied = await page.evaluate(async () => { const r = await fetch("/api/phonebook/company", { method: "POST", body: "{}" }); return { status: r.status, body: await r.json() } }); assert.equal(denied.status, 403); assert.match(denied.body.message, /view-only/); s = await snapshot("view-guard-denies-mutations", true); assert.deepEqual(s.operations, []); assert.deepEqual(syncs(s), [])
        for (const mode of ["signedout", "none"]) { await reset("company-rename", mode); await page.getByRole("heading", { name: "Access Denied", exact: true }).waitFor(); s = await snapshot(mode + "-no-phonebook-read", true); assert.deepEqual(s.requests, []); assert.deepEqual(s.operations, []) }
      }
      await context?.close(); context = null; await browser.close(); browser = null
    }
    assert.equal(results.length, process.env.PHONEBOOK_DELETE_UNDO_DIAGNOSTIC ? 26 : 312)
  } catch (error) { failure = String(error.stack || error) }
  finally {
    await context?.close(); await browser?.close(); await new Promise(resolve => server.close(resolve))
    const report = { cases: results.length, results, error: failure || null, sourceHashes: Object.fromEntries(["app/admin/phonebook/page.tsx", "tests/fixtures/phonebook-sync-mocks.ts", "components/AdminRouteGuard.tsx", "lib/useSimpleAdminAuth.ts", "lib/phonebookContactWrite.ts", "lib/phonebookSyncClient.ts", "app/api/phonebook/company/route.ts", "app/api/admin/supabase/route.ts", "app/globals.css", "app/fonts/roboto.css"].map(f => [f, sha(fs.readFileSync(path.join(root, f)))])), runnerSha256: sha(fs.readFileSync(__filename)), scope: "Actual page/guard/CSS/IndexedDB with isolated synthetic SDK/auth/sync only. Actor transitions key-remount the page as the real provider does. Not real Supabase/RLS/CardDAV or physical Safari/iPhone proof.", cleanup: { browsersClosed: true, serverClosed: true, personalBrowserTouched: false } }
    fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 }); console.log(JSON.stringify({ cases: results.length, error: failure || null, cleanup: report.cleanup, output: out }))
    if (failure) process.exitCode = 1
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
