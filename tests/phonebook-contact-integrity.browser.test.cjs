// Actual Phonebook page + actual route guard; only SDK/auth/navigation and sync
// services are synthetic. Nothing can reach a provider or personal browser.
const assert = require("node:assert/strict")
const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")
const { build } = require("esbuild")
const postcss = require("postcss")
const tailwind = require("@tailwindcss/postcss")
const root = path.resolve(__dirname, "..")
const out = process.env.PHONEBOOK_INTEGRITY_EVIDENCE
assert.ok(out && path.isAbsolute(out), "Use an owned absolute evidence directory")
fs.mkdirSync(out, { recursive: true })
const button = (page, name) => page.getByRole("button", { name, exact: true })
const company = page => page.getByRole("button", { name: /^ALPHA SHIPPING/ })
const contact = (page, name = "ALICE TEST") => page.getByRole("button", { name: new RegExp(`^${name}`) })
const field = (page, label) => page.getByText(label, { exact: true }).locator("..").locator("input")
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
async function verifyStatus(locator) {
  assert.equal(await locator.getAttribute("role"), "status")
  const colors = await locator.evaluate(el => ({ text: getComputedStyle(el).color, page: getComputedStyle(el.closest(".fc-admin-scope")).color }))
  assert.equal(colors.text, colors.page, "unboxed status uses readable page text, not white button text")
}
const messages = {
  save: "This contact changed or no longer exists. Your changes have not been saved; refresh the directory before trying again.",
  archive: "This contact changed or was removed. It has not been archived; refresh the directory before trying again.",
  undo: "This contact changed or was removed. Nothing was undone; refresh the directory and check the latest details.",
}
const entry = `import React from "react";import {createRoot} from "react-dom/client";import Page from "./app/admin/phonebook/page";import {AdminRouteGuard} from "./components/AdminRouteGuard";import {installPhonebookSyncHarness} from "./tests/fixtures/phonebook-sync-mocks";installPhonebookSyncHarness();const app=createRoot(document.getElementById("root"));const h=window.__phonebookSyncHarness;h.unmount=()=>app.unmount();h.rerender=()=>app.render(<AdminRouteGuard><div aria-label="Unsafe guard control"><select aria-label="Unsafe selector"><option>Unsafe</option></select><button>Delete fixture</button></div><Page/></AdminRouteGuard>);h.rerender();`

async function main() {
  const mocks = path.join(root, "tests/fixtures/phonebook-sync-mocks.ts")
  const bundle = await build({ absWorkingDir: root, stdin: { contents: entry, resolveDir: root, loader: "tsx" }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' }, plugins: [{ name: "synthetic-boundaries", setup(builder) {
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
    const asset = path.resolve(publicRoot, "." + url.pathname)
    if (asset.startsWith(publicRoot + path.sep) && fs.existsSync(asset) && fs.statSync(asset).isFile()) { res.end(fs.readFileSync(asset)); return }
    if (url.pathname !== "/admin/phonebook") { res.writeHead(404); res.end(); return }
    res.setHeader("Content-Type", "text/html"); res.end(html)
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const { chromium, webkit } = require("playwright")
  const results = []
  let browser, context
  try {
    for (const [engine, launcher] of process.env.PHONEBOOK_INTEGRITY_DIAGNOSTIC ? [["chromium", chromium]] : [["chromium", chromium], ["webkit", webkit]]) {
      browser = await launcher.launch({ headless: true })
      for (const width of process.env.PHONEBOOK_INTEGRITY_DIAGNOSTIC ? [1440] : [1440, 320, 390]) for (const scheme of process.env.PHONEBOOK_INTEGRITY_DIAGNOSTIC ? ["light"] : ["light", "dark"]) {
        let page, errors, external
        async function reset(mode = "edit", logAction = null, oldLog = false) {
          await context?.close(); context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, colorScheme: scheme })
          external = []; errors = []
          await context.route("**/*", route => { if (new URL(route.request().url()).origin === origin) return route.continue(); external.push(route.request().url()); return route.abort() })
          // Synthetic backend state survives only the explicit F5 recovery
          // scenario. The actual IndexedDB/contact cache code is never mocked.
          await context.addInitScript(() => { let state; Object.defineProperty(window, "__phonebookSyncHarness", { configurable: true, get: () => state, set: value => { const saved = sessionStorage.getItem("synthetic-reload-backend"); if (saved) value.contacts = JSON.parse(saved); state = value } }) })
          await context.addInitScript(() => {
            window.__contactCacheWrites = []
            const put = IDBObjectStore.prototype.put, get = IDBObjectStore.prototype.get
            IDBObjectStore.prototype.put = function (value, ...args) { if (this.name === "entries" && value?.key === "contacts") window.__contactCacheWrites.push(structuredClone(value)); return put.call(this, value, ...args) }
            IDBObjectStore.prototype.get = function (key) {
              const request = get.call(this, key)
              if (this.name === "entries" && key === "contacts" && sessionStorage.getItem("hold-next-hydration")) {
                sessionStorage.removeItem("hold-next-hydration")
                const descriptor = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "onsuccess")
                // Hold delivery, not the payload: result remains the real native
                // IndexedDB record and the page's cache functions are unchanged.
                Object.defineProperty(request, "onsuccess", { set(callback) { descriptor.set.call(request, event => { window.__releaseContactHydration = () => callback.call(request, event) }) } })
              }
              return request
            }
          })
          if (logAction) await context.addInitScript(({ action, old }) => {
            const row = { id: "synthetic-contact-a", full_name: "ALICE TEST", company: "ALPHA SHIPPING", company_source_id: "company-a", favorite: false, mobile_1: "+85291112222", personal_email: "alice@example.test", updated_at: "2026-10-14T00:00:00.123456Z", created_at: "2026-10-01T00:00:00Z", source_key: "source-synthetic-contact-a" }
            if (old) delete row.updated_at
            localStorage.setItem("phonebook_change_log", JSON.stringify([{ id: "seed-log", entityType: "contact", action, label: "ALICE TEST", timestamp: "2026-10-20T00:00:00Z", before: action === "create" ? null : row, after: action === "delete" ? null : row }]))
          }, { action: logAction, old: oldLog })
          page = await context.newPage(); page.setDefaultTimeout(8000); page.on("pageerror", e => errors.push(e.message))
          await page.goto(origin + "/admin/phonebook?mode=" + mode)
          if (mode !== "signedout") { await company(page).click(); await contact(page).click() }
        }
        async function edit() { await button(page, "Edit").click(); await field(page, "Mobile 1").waitFor() }
        async function clearEvidence() { await page.evaluate(() => { const h = window.__phonebookSyncHarness; h.requests.length = 0; h.operations.length = 0 }) }
        async function saveAlice() { await edit(); await field(page, "Mobile 1").fill("+85295556666"); await button(page, "Save").click(); await page.getByText("Saved and verified on CardDAV.", { exact: true }).waitFor(); await settle(page); await clearEvidence() }
        async function undo() { await button(page, "☰").click(); await button(page, "Undo").first().click() }
        async function snapshot(id) {
          await settle(page)
          const state = await page.evaluate(() => { const h = window.__phonebookSyncHarness; return { contacts: structuredClone(h.contacts), operations: structuredClone(h.operations), contactReads: structuredClone(h.contactReads), cacheWrites: structuredClone(window.__contactCacheWrites), cacheInvalidated: Boolean(localStorage.getItem("phonebook_contacts_cache_invalid:v1")), sync: h.requests.filter(r => r.url === "/api/phonebook/carddav-sync" && r.method === "POST"), retries: JSON.parse(localStorage.getItem("phonebook_carddav_pending:v2") || "[]"), log: JSON.parse(localStorage.getItem("phonebook_change_log") || "[]") } })
          assert.deepEqual(errors, []); assert.deepEqual(external, [])
          results.push({ id, engine, browserVersion: browser.version(), width, scheme, state })
          return state
        }
        async function expectNoSync(id) { const s = await snapshot(id); assert.deepEqual(s.sync, []); assert.deepEqual(s.retries, []); return s }
        const newer = { mobile_1: "+85298887777", personal_email: "colleague-new@example.test", updated_at: "2026-10-20T12:00:00.123457Z" }

        for (const action of ["save", "archive"]) for (const missing of [true, false]) {
          await reset(); await edit(); await field(page, "Mobile 1").fill("+85295556666")
          await page.evaluate(({ missing, newer }) => { const h = window.__phonebookSyncHarness; if (missing) h.contacts.splice(0, 1); else Object.assign(h.contacts[0], newer) }, { missing, newer })
          if (action === "archive") page.once("dialog", d => d.accept())
          await button(page, action === "save" ? "Save" : "Archive").click(); await page.getByText(messages[action], { exact: true }).waitFor()
          await verifyStatus(page.getByText(messages[action], { exact: true }))
          assert.equal(await field(page, "Mobile 1").inputValue(), "+85295556666")
          const s = await expectNoSync(`${action}-${missing ? "missing" : "stale"}`)
          assert.deepEqual(s.operations[0].filters.map(f => f.field), ["id", "updated_at"])
          if (!missing) assert.equal(s.contacts[0].personal_email, newer.personal_email)
          if (action === "archive") assert.equal(await page.getByText("PAST CONTACT", { exact: true }).count(), 0)
        }
        for (const missing of [true, false]) {
          await reset(); await saveAlice()
          await page.evaluate(({ missing, newer }) => { const h = window.__phonebookSyncHarness; if (missing) h.contacts.splice(0, 1); else Object.assign(h.contacts[0], newer) }, { missing, newer })
          await undo(); await page.getByText(messages.undo, { exact: true }).waitFor()
          await verifyStatus(page.getByText(messages.undo, { exact: true }))
          const s = await expectNoSync(`undo-${missing ? "missing" : "stale"}`); assert.equal(s.log.length, 1)
          if (!missing) assert.equal(s.contacts[0].personal_email, newer.personal_email)
        }
        for (const failed of [false, true]) {
          await reset(); await edit(); await field(page, "Mobile 1").fill("+85295556666")
          if (failed) await page.evaluate(() => window.__phonebookSyncHarness.syncPlan.push({ failedIds: ["synthetic-contact-a"] }))
          page.once("dialog", d => d.accept()); await button(page, "Archive").click()
          await page.getByText(failed ? /^Archived locally, but CardDAV sync failed\./ : "Archived and synced.", { exact: !failed }).waitFor()
          await verifyStatus(page.getByText(failed ? /^Archived locally, but CardDAV sync failed\./ : "Archived and synced.", { exact: !failed }))
          const s = await snapshot(`archive-${failed ? "sync-failure" : "verified"}`)
          assert.equal(s.contacts[0].name_remark, "PAST CONTACT"); assert.equal(s.contacts[0].mobile_1, "+85291112222", "Archive acknowledges the server row, not an unrelated unsaved draft field")
          assert.equal(s.retries.length, failed ? 1 : 0)
          await page.screenshot({ path: path.join(out, `${engine}-${width}-${scheme}-archive-${failed ? "failed" : "verified"}.png`), fullPage: true })
        }
        for (const failed of [false, true]) {
          await reset(); await saveAlice(); if (failed) await page.evaluate(() => window.__phonebookSyncHarness.syncPlan.push({ failedIds: ["synthetic-contact-a"] }))
          await undo(); await page.getByText(failed ? /^Undone locally, but CardDAV sync failed\./ : "Undone and verified on CardDAV.", { exact: !failed }).waitFor()
          await verifyStatus(page.getByText(failed ? /^Undone locally, but CardDAV sync failed\./ : "Undone and verified on CardDAV.", { exact: !failed }))
          const s = await snapshot(`undo-${failed ? "sync-failure" : "verified"}`)
          assert.equal(s.contacts[0].mobile_1, "+85291112222"); assert.equal(s.log.length, 0); assert.equal(s.retries.length, failed ? 1 : 0)
          assert.equal(await page.getByText("Undo complete.", { exact: true }).count(), 0)
          for (const key of ["id", "source_key", "created_at", "updated_at"]) assert.equal(key in s.operations[0].payload, false)
          await page.screenshot({ path: path.join(out, `${engine}-${width}-${scheme}-undo-${failed ? "failed" : "verified"}.png`), fullPage: true })
        }
        for (const action of ["save", "archive", "undo"]) for (const failure of ["reject", "error", "malformed", "malformed-false", "malformed-zero", "malformed-null", "malformed-empty-string", "commit-reject"]) {
          console.log(JSON.stringify({ probe: `${action}-${failure}`, engine, width, scheme }))
          await reset(); if (action === "undo") await saveAlice(); else { await edit(); await field(page, "Mobile 1").fill("+85295556666") }
          await page.evaluate(failure => { const h = window.__phonebookSyncHarness; if (failure.startsWith("malformed")) h.malformedContactReply = failure === "malformed" ? true : failure.slice("malformed-".length); else h.contactWriteFailure = failure }, failure)
          if (action === "undo") await undo(); else { if (action === "archive") page.once("dialog", d => d.accept()); await button(page, action === "save" ? "Save" : "Archive").click() }
          const expected = action === "save" ? failure.startsWith("malformed") ? "Contact save response could not be verified. Your changes are still here; check the directory before trying again." : failure === "error" ? "Unable to save contact. Your changes are still here; try Save again." : "Contact save was not confirmed. Your changes are still here; check the directory before trying Save again." : action === "archive" ? failure.startsWith("malformed") ? "Archive response could not be verified. Check the directory before trying again." : "Archive was not confirmed. Check the directory before trying again." : failure.startsWith("malformed") ? "Undo response could not be verified. Check the directory before trying again." : "Undo was not confirmed. Check the directory before trying again."
          await page.getByText(expected, { exact: true }).waitFor(); const s = await expectNoSync(`${action}-${failure}`)
          if (action === "undo") assert.equal(s.log.length, 1)
          assert.equal(s.cacheInvalidated, false, "transport and malformed replies are not classified as genuine CAS conflicts")
        }
        async function cachedAlice() {
          await reset(); await saveAlice()
          await page.waitForFunction(() => new Promise(resolve => { const r = indexedDB.open("phonebook-cache", 1); r.onsuccess = () => { const db = r.result; const q = db.transaction("entries").objectStore("entries").get("contacts"); q.onsuccess = () => { db.close(); resolve(q.result?.items?.some(c => c.id === "synthetic-contact-a" && c.mobile_1 === "+85295556666")) } }; r.onerror = () => resolve(false) }))
        }
        async function conflict(missing = false) {
          await cachedAlice()
          await edit(); await field(page, "Mobile 1").fill("+85296660000")
          await page.evaluate(({ missing, newer }) => { const h = window.__phonebookSyncHarness; if (missing) h.contacts.splice(0, 1); else Object.assign(h.contacts[0], newer) }, { missing, newer })
          await button(page, "Save").click(); await page.getByText(messages.save, { exact: true }).waitFor()
          assert.equal(await field(page, "Mobile 1").inputValue(), "+85296660000")
        }
        await reset(); await page.evaluate(() => { window.__phonebookSyncHarness.deferCacheFetch = true }); await saveAlice(); await page.waitForFunction(() => Boolean(window.__phonebookSyncHarness.releaseCacheFetch))
        await edit(); await field(page, "Mobile 1").fill("+85296660000"); await page.evaluate(values => Object.assign(window.__phonebookSyncHarness.contacts[0], values), newer); await button(page, "Save").click(); await page.getByText(messages.save, { exact: true }).waitFor()
        await page.evaluate(() => window.__phonebookSyncHarness.releaseCacheFetch()); await settle(page)
        const warm = await expectNoSync("old-warm-response-cannot-revive-conflict-cache")
        assert.equal(warm.cacheInvalidated, true); assert.equal(warm.cacheWrites.some(record => record.items.some(c => c.id === "synthetic-contact-a" && c.mobile_1 === "+85295556666")), false)

        await cachedAlice(); await page.evaluate(() => { sessionStorage.setItem("synthetic-reload-backend", JSON.stringify(window.__phonebookSyncHarness.contacts)); sessionStorage.setItem("hold-next-hydration", "1") }); await page.reload(); await company(page).waitFor(); await page.waitForFunction(() => Boolean(window.__releaseContactHydration))
        await company(page).click(); await contact(page).click(); await edit(); await field(page, "Mobile 1").fill("+85296660000"); await page.evaluate(values => Object.assign(window.__phonebookSyncHarness.contacts[0], values), newer); await button(page, "Save").click(); await page.getByText(messages.save, { exact: true }).waitFor()
        await page.evaluate(() => window.__releaseContactHydration()); await settle(page); assert.equal(await field(page, "Mobile 1").inputValue(), "+85296660000")
        await button(page, "Cancel").click(); await clearEvidence(); await button(page, "All Companies").click(); await company(page).click(); await contact(page, "BOB TEST").waitFor()
        assert.equal(await page.evaluate(() => window.__phonebookSyncHarness.requests.filter(r => r.url === "/api/phonebook/contacts?company=ALPHA%20SHIPPING").length), 1, "late old hydration must not repopulate the company cache after conflict invalidation")
        await expectNoSync("old-hydration-cannot-revive-company-cache")
        for (const reopen of ["click", "keyboard", "edit"]) {
          await conflict(); await contact(page).click(); await page.getByText("Your unsaved changes are still here. Cancel them before reopening the latest contact.", { exact: true }).waitFor()
          assert.equal(await field(page, "Mobile 1").inputValue(), "+85296660000")
          assert.equal((await snapshot(`conflict-${reopen}-keeps-unsaved-draft`)).contactReads.length, 0)
          await button(page, "Cancel").click()
          if (reopen === "edit") await button(page, "Edit").click(); else if (reopen === "keyboard") await contact(page).press("Enter"); else await contact(page).click()
          await page.getByText("Latest contact details loaded. Review them, then click Edit to make changes.", { exact: true }).waitFor(); await edit()
          assert.equal(await field(page, "Mobile 1").inputValue(), newer.mobile_1)
          const s = await expectNoSync(`conflict-${reopen}-fresh-revision`); assert.equal(s.contactReads.length, 1)
          assert.deepEqual(s.contactReads[0].filters, [{ field: "id", value: "synthetic-contact-a" }])
        }
        await conflict(true); await button(page, "Cancel").click(); await contact(page).click(); await page.getByText("This contact was removed from the directory.", { exact: true }).waitFor()
        assert.equal(await contact(page).count(), 0); assert.equal(await button(page, "Edit").count(), 0); await expectNoSync("conflict-missing-reopen-never-resurrects")
        for (const missing of [false, true]) {
          await conflict(missing)
          await page.evaluate(() => sessionStorage.setItem("synthetic-reload-backend", JSON.stringify(window.__phonebookSyncHarness.contacts)))
          await page.reload(); await company(page).click()
          if (missing) { await contact(page, "BOB TEST").waitFor(); assert.equal(await contact(page).count(), 0) }
          else { await contact(page).click(); await edit(); assert.equal(await field(page, "Mobile 1").inputValue(), newer.mobile_1) }
          await expectNoSync(`conflict-fresh-indexeddb-F5-${missing ? "missing" : "stale"}`)
        }
        for (const failure of ["reject", "error", "malformed", "false", "zero", "null", "empty-string"]) {
          await conflict(); await button(page, "Cancel").click(); await page.evaluate(failure => { window.__phonebookSyncHarness.contactReadFailure = failure }, failure); await contact(page).click()
          await page.getByText("The latest contact could not be loaded. Your saved details have not been changed; try reopening it again.", { exact: true }).waitFor()
          const failed = await expectNoSync(`conflict-reopen-${failure}`); assert.equal(failed.cacheInvalidated, true)
          assert.equal(await contact(page).count(), 1, "an unverified reply must never remove the cached row as though its absence was proven")
          await contact(page).click(); await page.getByText("Latest contact details loaded. Review them, then click Edit to make changes.", { exact: true }).waitFor(); await edit(); assert.equal(await field(page, "Mobile 1").inputValue(), newer.mobile_1)
        }
        await conflict(); await button(page, "Cancel").click(); await page.evaluate(() => { window.__phonebookSyncHarness.contactReadFailure = "hold" }); await contact(page).click(); await page.waitForFunction(() => Boolean(window.__phonebookSyncHarness.releaseContactRead))
        assert.equal(await button(page, "Edit").isDisabled(), true)
        await page.evaluate(() => window.__phonebookSyncHarness.unmount()); await page.evaluate(() => window.__phonebookSyncHarness.releaseContactRead()); await settle(page)
        await expectNoSync("conflict-reopen-unmounted-owner")
        await reset(); await saveAlice()
        const firstRevision = await page.evaluate(() => window.__phonebookSyncHarness.contacts[0].updated_at)
        await edit(); await field(page, "Mobile 1").fill("+85297776666"); await button(page, "Save").click(); await page.getByText("Saved and verified on CardDAV.", { exact: true }).waitFor()
        const twice = await snapshot("second-save-adopts-returned-revision")
        assert.equal(twice.operations[0].filters.find(f => f.field === "updated_at").value, firstRevision)
        assert.equal(twice.contacts[0].mobile_1, "+85297776666")
        await undo(); await page.getByText("Undone and verified on CardDAV.", { exact: true }).waitFor(); await clearEvidence(); await undo(); await page.getByText(messages.undo, { exact: true }).waitFor()
        const stacked = await expectNoSync("older-stacked-undo-conflicts-safely"); assert.equal(stacked.contacts[0].mobile_1, "+85295556666"); assert.equal(stacked.log.length, 1)
        await reset(); await saveAlice(); await page.evaluate(() => { const h = window.__phonebookSyncHarness; h.deferContactWrite = true; h.syncPlan.push({ defer: true, failedIds: ["synthetic-contact-a"] }) }); await undo(); await page.waitForFunction(() => Boolean(window.__phonebookSyncHarness.releaseContactWrite))
        assert.equal(await contact(page, "BOB TEST").isDisabled(), true)
        assert.equal(await button(page, "Undoing...").isDisabled(), true)
        await contact(page, "BOB TEST").evaluate(node => node.click()); assert.equal(await page.getByText("ALICE TEST", { exact: true }).count() > 0, true)
        await page.evaluate(() => window.__phonebookSyncHarness.releaseContactWrite()); await page.waitForFunction(() => Boolean(window.__phonebookSyncHarness.releaseSync))
        await contact(page, "BOB TEST").click(); await edit(); await field(page, "Mobile 1").fill("+85296667777")
        await page.evaluate(() => window.__phonebookSyncHarness.releaseSync()); await page.waitForFunction(() => window.__phonebookSyncHarness.activeSyncs === 0); await settle(page)
        assert.equal(await field(page, "Mobile 1").inputValue(), "+85296667777"); assert.equal(await page.getByText(/^Undone locally/).count(), 0)
        await snapshot("undo-lock-and-late-sync-draft")

        await reset(); await saveAlice(); await page.evaluate(() => window.__phonebookSyncHarness.syncPlan.push({ defer: true, failedIds: ["synthetic-contact-a"] })); await undo(); await page.waitForFunction(() => Boolean(window.__phonebookSyncHarness.releaseSync))
        await page.evaluate(() => { const h = window.__phonebookSyncHarness; h.auth.actorKey = "synthetic-actor-b"; h.rerender() }); await settle(page)
        await contact(page, "BOB TEST").click(); await edit(); await field(page, "Mobile 1").fill("+85296667777")
        await page.evaluate(() => window.__phonebookSyncHarness.releaseSync()); await page.waitForFunction(() => window.__phonebookSyncHarness.activeSyncs === 0); await settle(page)
        assert.equal(await field(page, "Mobile 1").inputValue(), "+85296667777"); assert.equal(await page.getByText(/^Undone locally/).count(), 0)
        await snapshot("old-sync-cannot-message-new-owner-editor")

        await reset(); await saveAlice(); await contact(page, "BOB TEST").click(); await edit(); await field(page, "Mobile 1").fill("+85296667777"); await undo()
        await page.getByText("Finish or cancel your current contact edits before using Undo.", { exact: true }).waitFor(); assert.equal(await field(page, "Mobile 1").inputValue(), "+85296667777")
        assert.deepEqual((await expectNoSync("undo-existing-draft-protected")).operations, [])

        await reset("edit", "update", true); await undo(); await page.getByText("This older change cannot be safely undone here. Reopen the contact and make the correction manually.", { exact: true }).waitFor()
        assert.deepEqual((await expectNoSync("undo-legacy-no-revision")).operations, [])

        for (const stale of [false, true]) {
          await reset("edit", "create"); if (stale) await page.evaluate(values => Object.assign(window.__phonebookSyncHarness.contacts[0], values), newer)
          await undo(); await page.getByText(stale ? messages.undo : "Undone and verified on CardDAV.", { exact: true }).waitFor()
          const s = await snapshot(`undo-create-${stale ? "stale" : "verified"}`); assert.equal(s.contacts.some(c => c.id === "synthetic-contact-a"), stale)
          assert.equal(s.sync.length, stale ? 0 : 1); assert.equal(s.log.length, stale ? 1 : 0)
          if (!stale) assert.deepEqual(s.sync[0].body, { deleteContactIds: ["synthetic-contact-a"] })
        }
        await reset("edit", "delete"); await page.evaluate(() => window.__phonebookSyncHarness.contacts.splice(0, 1)); await undo()
        await page.getByText("Undone and verified on CardDAV.", { exact: true }).waitFor()
        const restore = await snapshot("undo-delete-restores-new-revision")
        assert.equal("updated_at" in restore.operations[0].payload, false, "a restored row receives a fresh database revision rather than reviving an old CAS token")
        const restoredRow = restore.contacts.find(c => c.id === "synthetic-contact-a")
        assert.equal(restoredRow.source_key, "source-synthetic-contact-a")
        assert.notEqual(restoredRow.updated_at, "2026-10-14T00:00:00.123456Z")
        for (const mutation of ["undo", "archive", "save"]) {
          await reset(); if (mutation === "undo") await saveAlice(); else await edit()
          await page.evaluate(() => { window.__phonebookSyncHarness.deferContactWrite = true })
          if (mutation === "undo") await undo(); else { if (mutation === "archive") page.once("dialog", d => d.accept()); await button(page, mutation === "archive" ? "Archive" : "Save").click() }
          await page.waitForFunction(() => Boolean(window.__phonebookSyncHarness.releaseContactWrite))
          await page.evaluate(() => { const h = window.__phonebookSyncHarness; h.auth.actorKey = "synthetic-actor-b"; h.rerender() }); await settle(page)
          await page.evaluate(() => window.__phonebookSyncHarness.releaseContactWrite()); await settle(page)
          await expectNoSync(`${mutation}-owner-changed`)
        }
        await reset(); await saveAlice(); await page.evaluate(() => { window.__phonebookSyncHarness.deferContactWrite = true }); await undo(); await page.waitForFunction(() => Boolean(window.__phonebookSyncHarness.releaseContactWrite))
        await page.evaluate(() => window.__phonebookSyncHarness.unmount()); await page.evaluate(() => window.__phonebookSyncHarness.releaseContactWrite()); await settle(page)
        await expectNoSync("undo-unmounted")

        await reset("view")
        await page.waitForFunction(() => document.querySelector('[aria-label="Unsafe selector"]')?.disabled && [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Edit")?.disabled)
        assert.equal(await page.getByLabel("Unsafe selector").isDisabled(), true); assert.equal(await button(page, "Delete fixture").isDisabled(), true); assert.equal(await button(page, "Edit").isDisabled(), true)
        await expectNoSync("actual-guard-view")
        await page.screenshot({ path: path.join(out, `${engine}-${width}-${scheme}-view.png`), fullPage: true })
        await reset("signedout"); await page.getByRole("heading", { name: "Access Denied" }).waitFor(); const signedout = await expectNoSync("actual-guard-signedout"); assert.deepEqual(signedout.operations, [])
        await page.screenshot({ path: path.join(out, `${engine}-${width}-${scheme}-signedout.png`), fullPage: true })
        await context.close(); context = null
      }
      await browser.close(); browser = null
    }
  } finally { await context?.close(); await browser?.close(); await new Promise(resolve => server.close(resolve)) }
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ cases: results.length, results, scope: "Actual page/global CSS/route guard; synthetic SDK/auth/navigation/sync. SDK/native/API tests are separate. No actual provider, signed-in account or physical device.", cleanup: { browsersClosed: true, serverClosed: true, personalBrowserTouched: false } }, null, 2) + "\n")
  console.log(JSON.stringify({ cases: results.length, evidence: path.join(out, "results.json"), ownedResourcesClosed: true }))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
