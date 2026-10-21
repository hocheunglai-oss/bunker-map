/* Actual page/navigation/guard/CSS -> HTTP route -> CAS helper; synthetic auth/DB/provider transports only. */
const assert = require("node:assert/strict")
const http = require("node:http")
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs")
const { join, resolve, basename, isAbsolute } = require("node:path")
const { tmpdir } = require("node:os")
const { createHash } = require("node:crypto")
const { build } = require("esbuild")
const postcss = require("postcss")
const tailwind = require("@tailwindcss/postcss")
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || "playwright")

const root = resolve(__dirname, "..")
const output = process.env.EVENT_CALENDAR_FALLBACK_OUTPUT || mkdtempSync(join(tmpdir(), "fcuno-calendar-fallback-browser-"))
const preflight = process.env.EVENT_CALENDAR_FALLBACK_PREFLIGHT === "1"
assert.ok(isAbsolute(output))
mkdirSync(output, { recursive: true })
const sourcePaths = ["app/admin/eventcalendar/page.tsx", "app/api/office-calendar-store/[key]/route.ts", "lib/eventCalendarStore.ts", "lib/eventCalendarResponse.ts", "lib/clientStorage.ts", "data/eventCalendar.ts", "components/AdminRouteGuard.tsx"]
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex")
const sourceBefore = Object.fromEntries(sourcePaths.map(file => [file, hash(join(root, file))]))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, message) { for (let i = 0; i < 200; i += 1) { if (predicate()) return; await delay(10) } assert.fail(message) }
const cacheA = { id: "synthetic-cache-a", title: "SYNTHETIC CACHE A", startDate: "2026-06-01", endDate: "2026-06-02", people: ["OL"], uncertainPeople: [], tags: [], eventType: "Unclassified" }
const cacheB = { ...cacheA, id: "synthetic-cache-b", title: "SYNTHETIC CACHE B" }
const seedId = "fc-2026-024"
const seedTitle = "ON LEAVE (TWO WEEKS ONLY, EXACT SCHEDULE TO BE FIXED)"
const canonicalEmpty = () => ({ events: [], people: ["OL", "CY"], emailRecipientsText: "keep@example.test", deletedEventIds: ["keep-general"], deletedRequiredSeedIds: ["keep-required"], unrelated: { keep: true } })

async function main() {
  const fixture = `import React from "react";import {createRoot} from "react-dom/client";import Page from "./app/admin/eventcalendar/page";import {AdminNavigationShell} from "./components/AdminNavigationShell";import {AdminRouteGuard} from "./components/AdminRouteGuard";import {ADMIN_PAGE_DEFINITIONS,normaliseAdminPagePermissions} from "./lib/adminPages";import {writeClientStorage} from "./lib/clientStorage";import {officeCalendarSeedEvents} from "./data/eventCalendar";
const q=new URL(location.href).searchParams,permission=q.get("permission")||"edit",cache=q.get("cache")||"none";localStorage.clear();if(cache!=="none"){const entries=${JSON.stringify([cacheA, cacheB])};if(cache.startsWith("deleted"))entries.push(officeCalendarSeedEvents.find(e=>e.id===${JSON.stringify(seedId)}));localStorage.setItem("bunker-map-office-calendar-events",JSON.stringify(entries));localStorage.setItem("bunker-map-office-calendar-people",JSON.stringify(["STALE CACHE"]));localStorage.setItem("bunker-map-office-calendar-email-recipients","stale@example.test");localStorage.setItem("bunker-map-office-calendar-deleted-required-seed-ids",JSON.stringify(cache==="deleted-required"?[${JSON.stringify(seedId)},"cached-other-required"]:["cached-other-required"]));localStorage.setItem("bunker-map-office-calendar-deleted-event-ids",JSON.stringify(cache==="deleted-general"?[${JSON.stringify(seedId)}]:[]));}if(q.get("storage")==="blocked")Object.defineProperty(window,"localStorage",{get(){throw new DOMException("Blocked synthetic storage","SecurityError")}});if(q.get("storage")==="quota")Storage.prototype.setItem=function(){throw new DOMException("Synthetic quota","QuotaExceededError")};window.__calendarAuth={loading:false,authenticated:permission!=="signedout",resetRequired:false,username:"SYNTHETIC USER",displayName:"Synthetic user",role:"STAFF",permissions:normaliseAdminPagePermissions({"event-calendar":permission==="signedout"?"none":permission}),pages:ADMIN_PAGE_DEFINITIONS};writeClientStorage("bunker_admin_actor",JSON.stringify(window.__calendarAuth));createRoot(document.getElementById("root")).render(<React.StrictMode><div className="fc-admin-scope"><AdminNavigationShell><AdminRouteGuard><Page/></AdminRouteGuard></AdminNavigationShell></div></React.StrictMode>);`
  const mocks = {
    "next/navigation": "const router={push:()=>{},replace:()=>{},prefetch:()=>{}};export const useRouter=()=>router;export const usePathname=()=>location.pathname;",
    "next/link": "import React from 'react';export default function Link({prefetch,...props}){return <a {...props}/>;}",
    "next/image": "import React from 'react';export default function Image({priority,unoptimized,fill,...props}){return <img {...props}/>;}",
  }
  const bundle = await build({ absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, sourcefile: "calendar-fallback-fixture.tsx", loader: "tsx" }, bundle: true, write: false, outdir: "fixture", platform: "browser", format: "iife", jsx: "automatic", logLevel: "warning", define: { "process.env.NODE_ENV": '"development"' }, plugins: [{ name: "synthetic-auth", setup(b) {
    b.onResolve({ filter: /^(?:@\/lib\/useSimpleAdminAuth|next\/(navigation|link|image))$/ }, args => ({ path: args.path, namespace: "fixture" }))
    b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ resolveDir: root, loader: "tsx", contents: args.path.endsWith("useSimpleAdminAuth") ? "export const useSimpleAdminAuth=()=>window.__calendarAuth;export const clearAdminClientSessionCache=()=>{};" : mocks[args.path] }))
  } }] })
  const assets = new Map(bundle.outputFiles.map(file => [`/${basename(file.path)}`, file.contents]))
  const js = [...assets.keys()].find(name => name.endsWith(".js"))
  const css = (await postcss([tailwind()]).process(readFileSync(join(root, "app/globals.css"), "utf8"), { from: join(root, "app/globals.css") })).css
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/globals.css"></head><body><div id="root"></div><script src="${js}"></script></body></html>`

  let row, writes, reads, requests, access, beforePatch, sideEffects, pending
  function reset(payload) { row = payload === null ? null : { payload: structuredClone(payload), updated_at: "2026-10-21T00:00:00.000Z" }; writes = 0; reads = 0; requests = []; access = "edit"; beforePatch = null; sideEffects = []; pending = 0 }
  const client = { from(table) {
    assert.equal(table, "office_calendar_store")
    let mode = "read", values, expected
    const q = { select() { return q }, eq(field, value) { if (field === "updated_at") expected = value; return q }, insert(value) { mode = "insert"; values = value; return q }, update(value) { mode = "update"; values = value; return q }, async maybeSingle() {
      await new Promise(resolve => setImmediate(resolve))
      if (mode === "read") { reads += 1; return { data: structuredClone(row), error: null } }
      if (mode === "insert" && row) return { data: null, error: { code: "23505" } }
      if (mode === "update" && (!row || row.updated_at !== expected)) return { data: null, error: null }
      row = structuredClone(values); writes += 1; return { data: { payload: structuredClone(row.payload) }, error: null }
    } }; return q
  } }
  const modules = {
    "next/server": { NextResponse: { json: Response.json } }, "@supabase/supabase-js": { createClient: () => client },
    "@/lib/adminAuth": { getAdminSession: async () => ({ authenticated: access !== "signedout" }), hasAdminPagePermission: (_session, _page, required) => access === "edit" || required === "view" && access === "view" },
    "@/lib/adminAudit": { createAdminAuditContext: () => ({}), createAdminAuditedSupabaseClient: () => client },
    "@/lib/calendarStaff": { loadCalendarStaffDirectory: async () => [], resolveCalendarStaffRecipients: () => ({ recipients: [], unresolved: [] }) },
  }
  const serverBundle = await build({ absWorkingDir: root, entryPoints: ["app/api/office-calendar-store/[key]/route.ts"], bundle: true, write: false, platform: "node", format: "cjs", target: "node24", logLevel: "warning", plugins: [{ name: "synthetic-service", setup(b) { b.onResolve({ filter: /^(?:next\/server|@supabase\/supabase-js|@\/lib\/(adminAuth|adminAudit|calendarStaff))$/ }, args => ({ path: args.path, external: true })) } }] })
  const loaded = { exports: {} }
  new Function("require", "module", "exports", "process", serverBundle.outputFiles[0].text)(name => modules[name] ?? require(name), loaded, loaded.exports, { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" } })
  async function dispatch(method, body, owner = "browser") {
    const result = await loaded.exports[method](new Request("https://synthetic.invalid/api/office-calendar-store/event-calendar", { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ protocolVersion: 2, ...body }) } : {}) }), { params: Promise.resolve({ key: "event-calendar" }) })
    const reply = await result.json(); requests.push({ owner, method, body: body ?? null, status: result.status, reply }); return { status: result.status, reply }
  }
  const json = (response, data, status = 200) => response.writeHead(status, { "content-type": "application/json", "cache-control": "private, no-store" }).end(JSON.stringify(data))
  const server = http.createServer(async (request, response) => { try {
    const url = new URL(request.url, "http://localhost")
    if (url.pathname === "/api/office-calendar-store/event-calendar") {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
      pending += 1
      try { if (request.method === "PATCH" && beforePatch) { const call = beforePatch; beforePatch = null; await call() } const result = await dispatch(request.method, body); return json(response, result.reply, result.status) } finally { pending -= 1 }
    }
    if (url.pathname === "/api/event-calendar/public-holidays") return json(response, { events: [], complete: true, coverage: [] })
    if (url.pathname === "/api/event-calendar/google-events") return json(response, { events: [] })
    if (["/api/event-calendar/google-sync", "/api/event-calendar/email-notify"].includes(url.pathname)) { sideEffects.push(url.pathname); return json(response, { success: true, status: "delivered", sent: 1, queued: 0, updated: 0, inserted: 0, deleted: 0 }) }
    if (url.pathname === "/api/parser-reports") return json(response, { readyForUserReview: 0 })
    if (url.pathname === "/fc-uno-sidebar-logo.png") return response.writeHead(200, { "content-type": "image/png" }).end(readFileSync(join(root, "public/fc-uno-sidebar-logo.png")))
    if (/^\/fonts\/[a-zA-Z0-9_.-]+\.woff2$/.test(url.pathname)) return response.writeHead(200, { "content-type": "font/woff2" }).end(readFileSync(join(root, "public", url.pathname)))
    if (url.pathname === "/globals.css") return response.writeHead(200, { "content-type": "text/css" }).end(css)
    const asset = assets.get(url.pathname); return response.writeHead(200, { "content-type": asset ? "text/javascript" : "text/html" }).end(asset || html)
  } catch (error) { json(response, { message: error.message }, 500) } })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const results = [], screenshots = [], errors = [], blocked = [], dialogErrors = [], contexts = [], browsers = [], browserVersions = {}
  let completed = false
  try {
    for (const [engineName, engine] of (preflight ? [["webkit", webkit]] : [["chromium", chromium], ["webkit", webkit]])) {
      const browser = await engine.launch({ headless: true }); browsers.push(browser); browserVersions[engineName] = browser.version()
      for (const width of (preflight ? [390] : [320, 390, 1440])) for (const scheme of (preflight ? ["dark"] : ["light", "dark"])) for (const permission of (preflight ? ["edit"] : ["edit", "view", "none", "signedout"])) {
        const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: scheme, timezoneId: "Asia/Hong_Kong" }); contexts.push(context)
        await context.route("**/*", route => { if (new URL(route.request().url()).origin === origin) return route.continue(); blocked.push(route.request().url()); return route.abort() })
        const page = await context.newPage(); page.setDefaultTimeout(10000)
        page.on("pageerror", error => errors.push({ engineName, width, scheme, permission, message: error.message }))
        const dialogs = [], dialogTasks = new Set()
        page.on("dialog", dialog => { const task = (async () => { dialogs.push({ type: dialog.type(), message: dialog.message() }); await dialog.accept() })(); dialogTasks.add(task); task.catch(error => dialogErrors.push(error.message)).finally(() => dialogTasks.delete(task)) })
        const button = name => page.getByRole("button", { name, exact: true })
        const heading = name => page.getByRole("heading", { name, exact: true })
        const prefix = `${engineName}-${width}-${scheme}-${permission}`
        async function settle() { await until(() => pending === 0, "all synthetic HTTP requests settled"); await Promise.allSettled([...dialogTasks]); assert.deepEqual(dialogErrors, []) }
        async function load(payload, cache = "none", storage = "normal") { reset(payload); access = permission; await page.goto(`${origin}/admin/eventcalendar?permission=${permission}&cache=${cache}&storage=${storage}`); if (permission === "none" || permission === "signedout") await page.getByText("Access Denied", { exact: true }).waitFor(); else { await button("Past Events").click(); await button("Event calendar settings").waitFor() } await settle(); assert.equal(writes, 0); assert.equal(requests.filter(item => item.method === "PATCH").length, 0) }
        async function open(title) { await page.getByText(title, { exact: true }).dblclick(); await heading("Edit Event").waitFor() }
        async function referenceLabel(title, expected) { assert.equal(await page.getByText(title, { exact: true }).locator("..").getByText("NOT YET SHARED", { exact: true }).count(), expected ? 1 : 0) }
        async function save(title) { await page.getByLabel("Event", { exact: true }).fill(title); await button("Save").click(); await heading("Send Event Update?").waitFor(); await button("No").click(); await settle() }
        async function remove() { await button("Delete Event").click(); await heading("Edit Event").waitFor({ state: "hidden" }); await settle() }
        async function screenshot(name) { const file = join(output, `${prefix}-${name}.png`); await page.screenshot({ path: file, fullPage: true }); screenshots.push(file) }
        function record(name, extra = {}) { results.push({ engine: engineName, width, scheme, permission, name, passed: true, ...extra }) }
        async function assertCurrentActionConflict(action) { const start = dialogs.length; await action(); await until(() => dialogs.slice(start).some(item => item.type === "alert"), "current action conflict alert"); await settle(); assert.equal(requests.filter(item => item.owner === "browser" && item.method === "PATCH").at(-1).status, 409); assert.equal(await heading("Edit Event").count(), 1) }
        try {
          if (permission === "none" || permission === "signedout") { await load(canonicalEmpty()); assert.equal(reads, 0); record("guard-denies-before-store-read") }
          else if (permission === "view") { await load(canonicalEmpty()); await referenceLabel(seedTitle, true); await page.getByText(seedTitle, { exact: true }).dblclick(); assert.equal(await heading("Edit Event").count(), 0); assert.equal(writes, 0); record("view-fallback-reference-is-read-only") }
          else {
            for (const state of ["absent", "empty"]) for (const operation of ["save", "delete"]) {
              await load(state === "absent" ? null : canonicalEmpty()); await referenceLabel(seedTitle, true); await open(seedTitle)
              if (operation === "save") await save("SYNTHETIC SAVED REQUIRED FALLBACK"); else await remove()
              const request = requests.find(item => item.owner === "browser" && item.method === "PATCH")
              assert.equal(request.status, 200); assert.equal(writes, 1)
              assert.deepEqual(request.body.expectedEventVersions, {})
              if (operation === "save") { assert.equal(request.body.operation, "create"); assert.deepEqual(row.payload.events.map(item => item.id), [seedId]); assert.equal(Object.hasOwn(request.body, "expectedAbsentEventIds"), false); await referenceLabel("SYNTHETIC SAVED REQUIRED FALLBACK", false) }
              else { assert.deepEqual(request.body.expectedAbsentEventIds, [seedId]); assert.deepEqual(request.body.settings.deletedRequiredSeedIds, [seedId]); assert.ok(row.payload.deletedEventIds.includes(seedId)); assert.ok(row.payload.deletedRequiredSeedIds.includes(seedId)); assert.equal(row.payload.events.length, 0) }
              if (state === "empty") { assert.equal(row.payload.emailRecipientsText, "keep@example.test"); assert.deepEqual(row.payload.people, ["OL", "CY"]); assert.deepEqual(row.payload.unrelated, { keep: true }) } else { assert.equal(Object.hasOwn(row.payload, "people"), false); assert.equal(Object.hasOwn(row.payload, "emailRecipientsText"), false) }
              assert.equal(sideEffects.includes("/api/event-calendar/email-notify"), false)
              await screenshot(`${state}-${operation}`); record(`${state}-required-${operation}`, { expectedVersions: request.body.expectedEventVersions, absentIds: request.body.expectedAbsentEventIds ?? [], writes })
            }

            await load(null, "custom"); await open(cacheA.title); await save("SYNTHETIC CACHE A SAVED")
            await referenceLabel("SYNTHETIC CACHE A SAVED", false); await referenceLabel(cacheB.title, true)
            assert.deepEqual(row.payload.events.map(item => item.id), [cacheA.id]); assert.equal(row.payload.events.some(item => item.id === cacheB.id), false)
            assert.equal(Object.hasOwn(row.payload, "people"), false); assert.equal(Object.hasOwn(row.payload, "emailRecipientsText"), false)
            const current = await dispatch("GET", null, "colleague")
            assert.equal((await dispatch("PATCH", { operation: "people", settings: { people: ["OL", "CY", "ZZ"] }, expectedSettingVersions: { people: current.reply.settingVersions.people } }, "colleague")).status, 200)
            await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await button("ZZ").waitFor()
            await page.getByText(cacheB.title, { exact: true }).waitFor(); await open(cacheB.title); await remove()
            assert.deepEqual(row.payload.events.map(item => item.id), [cacheA.id]); assert.ok(row.payload.deletedEventIds.includes(cacheB.id)); assert.equal(row.payload.deletedRequiredSeedIds?.includes("cached-other-required") ?? false, false)
            assert.deepEqual(row.payload.people, ["OL", "CY", "ZZ"])
            record("multiple-custom-fallbacks-persist-or-delete-only-selected-target")

            for (const cache of ["deleted-general", "deleted-required"]) { await load(null, cache); assert.equal(await page.getByText(seedTitle, { exact: true }).count(), 0); assert.equal(row, null); record(`cached-${cache}-suppresses-fallback-without-write`) }

            await load(null, "custom"); await button("Event calendar settings").click(); await button("Edit Email List").click(); await page.locator('textarea[placeholder="name@company.com"]').fill("explicit@example.test"); await button("Save").click(); await heading("Event Update Email Recipients").waitFor({ state: "hidden" }); await settle()
            assert.equal(row.payload.events.length, 0); assert.equal(row.payload.emailRecipientsText, "explicit@example.test"); assert.equal(Object.hasOwn(row.payload, "people"), false); assert.equal(row.payload.deletedRequiredSeedIds?.includes("cached-other-required") ?? false, false)
            record("settings-save-never-autoimports-cached-events-people-or-tombstones")

            await load(canonicalEmpty(), "custom")
            assert.equal(await page.getByText(cacheA.title, { exact: true }).count(), 0); assert.equal(await page.getByText(cacheB.title, { exact: true }).count(), 0)
            assert.equal(await button("STALE CACHE").count(), 0); await page.getByText(seedTitle, { exact: true }).waitFor()
            assert.deepEqual(row.payload, canonicalEmpty()); record("initially-canonical-store-ignores-unshared-cache")

            await load(null, "custom"); const initialReads = reads
            await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await until(() => reads > initialReads, "still-absent refresh request"); await page.waitForTimeout(100)
            assert.equal(await page.getByRole("alert").filter({ hasText: "Calendar refresh unavailable" }).count(), 0)
            await page.getByText(cacheA.title, { exact: true }).waitFor(); await page.getByText(cacheB.title, { exact: true }).waitFor(); assert.equal(row, null); assert.equal(writes, 0)
            record("still-absent-legacy-refresh-preserves-references-without-false-warning")

            await load(canonicalEmpty(), "custom"); row = null
            await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await page.getByRole("alert").filter({ hasText: "Calendar refresh unavailable" }).waitFor()
            assert.equal(await page.getByText(cacheA.title, { exact: true }).count(), 0); assert.equal(await page.getByText(cacheB.title, { exact: true }).count(), 0); assert.equal(writes, 0)
            record("canonical-store-disappearance-never-revives-cached-calendar")

            for (const operation of ["save", "delete"]) {
              await load(null, "custom"); await open(cacheA.title); await page.getByLabel("Event", { exact: true }).fill("SYNTHETIC LOSING DRAFT")
              beforePatch = async () => { const winner = await dispatch("PATCH", { operation: "create", events: [{ ...cacheA, title: "SYNTHETIC CONCURRENT WINNER" }] }, "colleague"); assert.equal(winner.status, 200) }
              await assertCurrentActionConflict(() => button(operation === "save" ? "Save" : "Delete Event").click())
              assert.equal(row.payload.events.find(item => item.id === cacheA.id).title, "SYNTHETIC CONCURRENT WINNER"); assert.equal(row.payload.deletedEventIds.includes(cacheA.id), false); assert.equal(await page.getByLabel("Event", { exact: true }).inputValue(), "SYNTHETIC LOSING DRAFT"); assert.equal(writes, 1)
              await screenshot(`concurrent-${operation}-draft`); record(`unseen-concurrent-winner-prevents-fallback-${operation}`)
            }

            for (const change of ["canonical", "general-tombstone", "required-tombstone"]) {
              await load(null, "custom"); await open(cacheA.title); await page.getByLabel("Event", { exact: true }).fill("SYNTHETIC PINNED FALLBACK DRAFT")
              if (change === "canonical") assert.equal((await dispatch("PATCH", { operation: "create", events: [{ ...cacheA, title: "SYNTHETIC REFRESH WINNER" }] }, "colleague")).status, 200)
              if (change === "general-tombstone") assert.equal((await dispatch("PATCH", { operation: "delete", eventIds: [cacheA.id], expectedAbsentEventIds: [cacheA.id] }, "colleague")).status, 200)
              if (change === "required-tombstone") assert.equal((await dispatch("PATCH", { operation: "settings", settings: { deletedRequiredSeedIds: [cacheA.id] } }, "colleague")).status, 200)
              await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await page.getByText("This event changed in another tab. Your draft is preserved, but it cannot overwrite the newer record. Cancel and reopen the event before saving.", { exact: true }).waitFor()
              assert.equal(await button("Save").isDisabled(), true); assert.equal(await button("Delete Event").isDisabled(), true); assert.equal(await page.getByLabel("Event", { exact: true }).inputValue(), "SYNTHETIC PINNED FALLBACK DRAFT"); assert.equal(writes, 1)
              record(`refresh-${change}-retains-pinned-fallback-draft`)
            }

            for (const storage of ["blocked", "quota"]) { await load(null, "none", storage); await open(seedTitle); await save("SYNTHETIC STORAGE-INDEPENDENT SAVE"); assert.equal(writes, 1); assert.deepEqual(row.payload.events.map(item => item.id), [seedId]); record(`fallback-save-survives-${storage}-cache`) }
          }
          const overflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth })); assert.ok(overflow.scroll <= overflow.width + 1, JSON.stringify(overflow))
          assert.deepEqual(errors, []); assert.deepEqual(dialogErrors, []); assert.deepEqual(blocked, [])
          await screenshot("final"); await settle(); console.log(`PASS ${prefix}`)
        } catch (error) { await screenshot("failure"); throw error } finally { await Promise.allSettled([...dialogTasks]); await context.close() }
      }
    }
    assert.equal(results.length, preflight ? 18 : 252)
    assert.equal(new Set(results.map(item => [item.engine, item.width, item.scheme, item.permission].join("/"))).size, preflight ? 1 : 48)
    completed = true
  } finally {
    const cleanupErrors = []
    for (const context of contexts) try { await context.close() } catch (error) { cleanupErrors.push(error.message) }
    for (const browser of browsers) try { await browser.close() } catch (error) { cleanupErrors.push(error.message) }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    const sourceAfter = Object.fromEntries(sourcePaths.map(file => [file, hash(join(root, file))])); assert.deepEqual(sourceAfter, sourceBefore)
    writeFileSync(join(output, "verification.json"), JSON.stringify({ schema: "fcuno.calendar-fallback-browser/v1", completed, preflight, sourceBefore, sourceAfter, runnerSha256: hash(__filename), results, screenshots, browserVersions, errors, dialogErrors, blocked, cleanup: { allOwnedResourcesClosed: cleanupErrors.length === 0, errors: cleanupErrors, personalBrowserTouched: false }, limits: ["Actual page/navigation/guard/compiled CSS, route/decoder/validation/CAS; authentication, DB/Supabase transport and providers are synthetic.", "No native SQL/RLS, real business data, external provider delivery, signed-in production or physical-device certification.", "Both OS preferences exercise existing fixed-light admin palette."] }, null, 2) + "\n", { mode: 0o600, flag: "wx" })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
