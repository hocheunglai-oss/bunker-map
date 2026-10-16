// Actual index pages, SDK/client, route guard, navigation and CSS. Only session,
// Next routing and the proxy's HTTP transport are synthetic; no real data writes.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const path = require("node:path")
const { createRequire } = require("node:module")
const root = path.resolve(__dirname, ".."), repo = createRequire(path.join(root, "package.json"))
const { build } = repo("esbuild"), postcss = repo("postcss"), tailwind = repo("@tailwindcss/postcss")
const { chromium, webkit } = require("playwright")
const mocks = {
  "@/lib/useSimpleAdminAuth": "export const useSimpleAdminAuth=()=>window.__ccinfoIndexHarness.auth;export const clearAdminClientSessionCache=()=>{};",
  "next/navigation": "const router={push:p=>window.__ccinfoIndexHarness.routes.push(p),replace:p=>window.__ccinfoIndexHarness.routes.push(p),prefetch:()=>{}};export const useRouter=()=>router;export const usePathname=()=>location.pathname;",
  "next/link": "import React from 'react';export default function Link({prefetch,...props}){return <a {...props}/>;}",
  "next/image": "import React from 'react';export default function Image({priority,unoptimized,fill,...props}){return <img {...props}/>;}",
}
async function main() {
  const output = process.env.CCINFO_INDEX_SCREENSHOTS
  assert.ok(output && path.isAbsolute(output), "Set an owned absolute CCINFO_INDEX_SCREENSHOTS evidence directory.")
  fs.mkdirSync(output, { recursive: true })
  const bundle = await build({ absWorkingDir: root, entryPoints: ["tests/fixtures/ccinfo-index-state.tsx"], bundle: true, write: false,
    outdir: "ccinfo-index-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"', "process.env.NEXT_PUBLIC_SUPABASE_URL": '"https://synthetic-supabase.invalid"', "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": '"synthetic-no-credential"' },
    plugins: [{ name: "isolated-auth-navigation", setup(b) {
      b.onResolve({ filter: /^(?:@\/lib\/useSimpleAdminAuth|next\/(?:navigation|link|image))$/ }, a => ({ path: a.path, namespace: "fixture" }))
      b.onLoad({ filter: /.*/, namespace: "fixture" }, a => ({ contents: mocks[a.path], loader: "jsx", resolveDir: root }))
    } }],
  })
  const assets = new Map(bundle.outputFiles.map(file => ["/" + path.basename(file.path), file.contents]))
  const script = [...assets.keys()].find(name => name.endsWith(".js")), styles = [...assets.keys()].filter(name => name.endsWith(".css"))
  assert.ok(script)
  const globalCss = await postcss([tailwind()]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/globals.css">' + styles.map(href => '<link rel="stylesheet" href="' + href + '">').join("") + '</head><body><div id="root"></div><script src="' + script + '"></script></body></html>'
  const server = http.createServer((request, response) => {
    if (request.method !== "GET") { response.writeHead(405); return response.end() }
    const pathname = new URL(request.url, "http://127.0.0.1").pathname
    if (assets.has(pathname)) { response.setHeader("Content-Type", pathname.endsWith(".css") ? "text/css" : "text/javascript"); return response.end(assets.get(pathname)) }
    if (pathname === "/globals.css") { response.setHeader("Content-Type", "text/css"); return response.end(globalCss.css) }
    if (pathname === "/fc-uno-sidebar-logo.png") { response.setHeader("Content-Type", "image/png"); return response.end(fs.readFileSync(path.join(root, "public/fc-uno-sidebar-logo.png"))) }
    if (!/^\/admin\/ccinfo\/(companies|countries|ports)$/.test(pathname)) { response.writeHead(404); return response.end() }
    response.setHeader("Content-Type", "text/html"); response.end(html)
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const origin = "http://127.0.0.1:" + server.address().port, results = []
  try {
    for (const [engine, launcher] of [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await launcher.launch({ headless: true, ...(engine === "chromium" && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) })
      try { for (const kind of ["companies", "countries", "ports"]) for (const width of [320, 390, 1440]) for (const scheme of ["light", "dark"]) {
        const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, colorScheme: scheme, timezoneId: "Asia/Hong_Kong" })
        try {
          const page = await context.newPage(), errors = [], unexpected = [], label = `${engine}-${kind}-${width}-${scheme}`
          page.setDefaultTimeout(10000)
          page.on("pageerror", error => errors.push(error.message))
          await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : (unexpected.push(route.request().url()), route.abort()))
          const pending = async (method = "GET", after = -1) => {
            await page.waitForFunction(({ method, after }) => window.__ccinfoIndexHarness.requests.some(r => r.id > after && r.method === method && !r.done), { method, after })
            return page.evaluate(({ method, after }) => window.__ccinfoIndexHarness.requests.find(r => r.id > after && r.method === method && !r.done).id, { method, after })
          }
          const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
          const release = async (id, data, count = Array.isArray(data) ? data.length : 0, status = 200, raw) => { await page.evaluate(({ id, data, count, status, raw }) => window.__ccinfoIndexHarness.release(id, { data, count, status, raw }), { id, data, count, status, raw }); await settle() }
          const rows = (names, count = names.length) => page.evaluate(({ names, count }) => Array.from({ length: count }, (_, index) => window.__ccinfoIndexHarness.row(names[index] || `${names[0]} ${index}`)), { names, count })
          const singular = { companies: "company", countries: "country", ports: "port" }[kind]
          const acknowledgement = (id, changes = {}) => ({ deletion: { schema: "fcuno.ccinfo-delete/v1", kind: singular, id, deletedAt: "2026-10-16T07:00:00.123456Z", deletedCount: 1, portsDeleted: 0, portsDetached: 0, ...changes } })
          const refresh = () => page.getByRole("button", { name: /^(refresh|retry)( results)?$/i })
          const filter = () => page.getByRole("searchbox", { name: `Filter ${kind}`, exact: true })
          const entry = name => page.locator("tbody a").filter({ hasText: new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$") })
          const countText = () => page.locator(".fc-admin-app-content").innerText()
          const waitCount = count => page.waitForFunction(count => new RegExp(`Count:\\s*${count}(?:\\D|$)`, "i").test(document.querySelector(".fc-admin-app-content").innerText), count)
          const checked = async (names, count = names.length, after = -1) => { const id = await pending("GET", after), data = await rows(names); await release(id, data, count); await entry(names[0]).waitFor(); return { id, data } }
          const shot = async suffix => {
            const layout = await page.evaluate(() => {
              const regions = [...document.querySelectorAll(".fc-admin-app-content [role='region']")].filter(r => r.querySelector("table"))
              return { width: innerWidth, scroll: document.documentElement.scrollWidth, regions: regions.map(r => ({ left: r.getBoundingClientRect().left, right: r.getBoundingClientRect().right, client: r.clientWidth, scroll: r.scrollWidth, tabIndex: r.tabIndex, label: r.getAttribute("aria-label") })), images: [...document.images].map(img => ({ src: img.getAttribute("src"), complete: img.complete, width: img.naturalWidth })) }
            })
            assert.ok(layout.scroll <= width + 1, JSON.stringify(layout))
            for (const r of layout.regions) assert.ok(r.left >= -1 && r.right <= width + 1 && r.tabIndex === 0 && r.label, JSON.stringify(r))
            for (const img of layout.images) assert.ok(img.complete && img.width > 0, JSON.stringify(img))
            await page.screenshot({ path: path.join(output, label + "-" + suffix + ".png"), fullPage: true })
          }
          await page.goto(`${origin}/admin/ccinfo/${kind}`)
          let id = await pending(); await release(id, [], 0, 500)
          await page.getByRole("alert").waitFor()
          assert.equal(await page.getByText(/no (entries|results|companies|countries|ports)/i).count(), 0, "Unverified load cannot claim empty")
          assert.ok(!/Count:\s*0(?:\D|$)/i.test(await countText()), "Initial outage cannot claim zero")
          await shot("initial-unavailable")
          await refresh().click(); let current = await checked(["VERIFIED ALPHA", "VERIFIED BETA"], 2)
          await waitCount(2); await shot("verified-edit")
          const scroll = page.locator(".fc-admin-app-content [role='region']").filter({ has: page.locator("table") })
          assert.equal(await scroll.count(), 1, "A labelled native table scroll region is required")
          await scroll.focus(); await page.keyboard.press("End")
          const reached = await scroll.evaluate(region => { region.scrollLeft = region.scrollWidth; const cell = region.querySelector("tbody tr td:last-child").getBoundingClientRect(), box = region.getBoundingClientRect(); return { lastRight: cell.right, regionRight: box.right, scrollLeft: region.scrollLeft, overflow: region.scrollWidth > region.clientWidth } })
          assert.ok(reached.lastRight <= reached.regionRight + 1, JSON.stringify(reached)); if (width < 500) assert.ok(reached.overflow && reached.scrollLeft > 0, JSON.stringify(reached))
          await shot("verified-scrolled"); await scroll.evaluate(region => { region.scrollLeft = 0 })
          await refresh().click(); id = await pending("GET", current.id)
          const longRow = await page.evaluate(() => ({ ...window.__ccinfoIndexHarness.row("長い会社名".repeat(30) + "UNBROKEN".repeat(30)), notes: "Long information 名字 & references. ".repeat(1800) }))
          await release(id, [longRow]); await entry(longRow.name).waitFor()
          const longLayout = await page.locator("tbody tr").evaluate((tr, infoIndex) => {
            const cell = tr.children[infoIndex], style = getComputedStyle(cell), region = tr.closest("[role='region']")
            region.scrollLeft = region.scrollWidth
            return { infoClient: cell.clientWidth, infoScroll: cell.scrollWidth, overflow: style.overflowX, ellipsis: style.textOverflow,
              regionClient: region.clientWidth, regionScroll: region.scrollWidth, lastRight: tr.lastElementChild.getBoundingClientRect().right, regionRight: region.getBoundingClientRect().right,
              global: document.documentElement.scrollWidth, width: innerWidth }
          }, kind === "ports" ? 2 : 1)
          assert.ok(longLayout.infoClient <= 704 && longLayout.infoScroll > longLayout.infoClient, JSON.stringify(longLayout))
          assert.equal(longLayout.overflow, "hidden"); assert.equal(longLayout.ellipsis, "ellipsis")
          assert.ok(longLayout.lastRight <= longLayout.regionRight + 1 && longLayout.global <= width + 1, JSON.stringify(longLayout))
          await shot("long-row-scrolled")
          await refresh().click(); current = await checked(["VERIFIED ALPHA", "VERIFIED BETA"], 2, id)

          // Same selection refresh failures retain only explicitly labelled old evidence.
          await refresh().click(); id = await pending("GET", current.id); await release(id, [], 0, 500)
          await page.getByRole("alert").waitFor(); await entry("VERIFIED ALPHA").waitFor(); await waitCount(2)
          assert.match(await countText(), /last (checked|verified)|previously (checked|verified)/i); await shot("retained-refresh-error")
          for (const malformed of [{ data: [], count: null }, { data: [], count: "no-count" }, { data: [], count: -1 }, { data: [], count: 1 }, { data: [{ id: "bad", name: "BROKEN", notes: null }], count: 1 }]) {
            await refresh().click(); id = await pending("GET", id); await release(id, malformed.data, malformed.count)
            await page.getByRole("alert").waitFor(); await entry("VERIFIED ALPHA").waitFor(); await waitCount(2)
          }
          await refresh().click(); current = await checked(["VERIFIED ALPHA", "VERIFIED BETA"], 2, id)
          await refresh().click(); id = await pending("GET", current.id)
          const blockedDeletes = await page.evaluate(() => window.__ccinfoIndexHarness.requests.filter(r => r.method !== "GET").length)
          const readLockedButton = page.locator("tbody tr").filter({ hasText: "VERIFIED ALPHA" }).getByRole("button", { name: /^delete /i })
          assert.equal(await readLockedButton.isDisabled(), true); await readLockedButton.evaluate(button => button.click())
          assert.equal(await page.evaluate(() => window.__ccinfoIndexHarness.requests.filter(r => r.method !== "GET").length), blockedDeletes)
          await release(id, await rows(["VERIFIED ALPHA", "VERIFIED BETA"])); current = { id }

          // Latest search alone owns rows, count and loading, even if abort is ignored.
          await filter().fill("ALPHA"); const oldSearch = await pending("GET", current.id)
          await filter().fill("BETA"); const newSearch = await pending("GET", oldSearch)
          assert.equal(await entry("VERIFIED ALPHA").count(), 0, "New query must not display old-query rows")
          const beta = await rows(["BETA RESULT"]); await release(newSearch, beta); await entry("BETA RESULT").waitFor()
          await release(oldSearch, await rows(["ALPHA RESULT"])); await page.waitForFunction(id => window.__ccinfoIndexHarness.requests[id].done, oldSearch)
          assert.equal(await entry("ALPHA RESULT").count(), 0); await entry("BETA RESULT").waitFor(); await waitCount(1)
          await shot("owned-search")
          const literal = 'A,(.*)%_"\\Case'
          await filter().fill(literal); id = await pending("GET", newSearch)
          const literalFilter = await page.evaluate(id => window.__ccinfoIndexHarness.requests[id].search, id)
          assert.match(literalFilter, /\.imatch\."\*\*\*=/); assert.ok(literalFilter.includes('%_'))
          await release(id, await rows(["LITERAL SEARCH RESULT"])); await entry("LITERAL SEARCH RESULT").waitFor()

          // A page2→new-filter transition must issue the new search at page1 atomically.
          await filter().fill("PAGED"); id = await pending("GET", id)
          await release(id, await rows(["PAGED ROW"], 200), 201); await waitCount(201)
          await page.getByRole("button", { name: "Next", exact: true }).click(); const oldPage = await pending("GET", id)
          await filter().fill("NEW QUERY"); const newPage = await pending("GET", oldPage)
          const resetRequests = await page.evaluate(after => window.__ccinfoIndexHarness.requests.filter(r => r.id > after).map(r => ({ offset: r.offset, search: r.search })), oldPage)
          assert.deepEqual(resetRequests.map(r => r.offset), [0], "No intermediate page2 request for a new filter")
          await release(newPage, await rows(["NEW QUERY RESULT"])); await entry("NEW QUERY RESULT").waitFor()
          await release(oldPage, await rows(["STALE PAGE TWO"]), 201)
          assert.equal(await entry("STALE PAGE TWO").count(), 0); await entry("NEW QUERY RESULT").waitFor(); assert.match(await countText(), /Page 1\s*\/\s*1/i)

          // Identity and already-started body parsing are independent owner boundaries.
          await refresh().click(); const oldOwner = await pending("GET", newPage)
          await page.evaluate(() => window.__ccinfoIndexHarness.setAuth({ username: "synthetic-editor-b@example.invalid" }))
          const newOwner = await pending("GET", oldOwner); assert.equal(await entry("NEW QUERY RESULT").count(), 0)
          await release(newOwner, await rows(["OWNER B RESULT"])); await entry("OWNER B RESULT").waitFor(); await release(oldOwner, await rows(["OWNER A LATE"]))
          assert.equal(await entry("OWNER A LATE").count(), 0)
          await refresh().click(); const bodyOwner = await pending("GET", newOwner)
          await page.evaluate(({ id, data }) => window.__ccinfoIndexHarness.deferBody(id, { data, count: 1 }), { id: bodyOwner, data: await rows(["LATE DECODED RESULT"]) })
          await page.waitForFunction(() => window.__ccinfoIndexHarness.bodies.some(b => !b.done))
          await page.evaluate(() => window.__ccinfoIndexHarness.setAuth({ username: "synthetic-editor-c@example.invalid" }))
          id = await pending("GET", bodyOwner); await release(id, await rows(["OWNER C RESULT"])); await entry("OWNER C RESULT").waitFor()
          await page.evaluate(({ id, data }) => window.__ccinfoIndexHarness.releaseBody(id, data), { id: bodyOwner, data: await rows(["LATE DECODED RESULT"]) })
          assert.equal(await entry("LATE DECODED RESULT").count(), 0); await entry("OWNER C RESULT").waitFor()

          // View may read/search/refresh but never offers an enabled delete action.
          await page.evaluate(() => window.__ccinfoIndexHarness.setAuth({ permission: "view" }))
          id = await pending("GET", id); await release(id, await rows(["VIEW RESULT"])); await entry("VIEW RESULT").waitFor()
          assert.equal(await page.getByRole("button", { name: /^delete /i }).evaluateAll(buttons => buttons.filter(b => !b.disabled).length), 0)
          await refresh().click(); id = await pending("GET", id); await release(id, await rows(["VIEW REFRESHED"])); await entry("VIEW REFRESHED").waitFor(); await shot("verified-view")
          await refresh().click(); const revoked = await pending("GET", id)
          await page.evaluate(() => window.__ccinfoIndexHarness.setAuth({ permission: "none" }))
          await page.getByRole("heading", { name: "Access Denied", exact: true }).waitFor(); await release(revoked, await rows(["REVOKED LATE"]))
          assert.equal(await page.locator("tbody a").count(), 0); await shot("permission-none")
          await page.evaluate(() => window.__ccinfoIndexHarness.setAuth({ authenticated: false }))
          assert.equal(await page.locator("tbody a").count(), 0); await shot("signed-out")
          await page.evaluate(() => window.__ccinfoIndexHarness.setAuth({ authenticated: true, permission: "edit" }))
          current = await checked(["DELETE TARGET", "KEEP RECORD"], 2, revoked)

          // The delete intent is single-flight, cancelled safely and bound to exact row/version.
          const deleteTarget = () => page.locator("tbody tr").filter({ hasText: "DELETE TARGET" }).getByRole("button", { name: /^delete /i })
          await page.evaluate(() => { window.__ccinfoIndexHarness.confirmResult = false })
          const beforeCancel = await page.evaluate(() => window.__ccinfoIndexHarness.requests.length)
          await deleteTarget().click(); assert.equal(await page.evaluate(() => window.__ccinfoIndexHarness.requests.length), beforeCancel)
          await page.evaluate(() => { window.__ccinfoIndexHarness.confirmResult = true })
          for (const response of ["empty", "wrong", "wrong-kind", "wrong-schema", "invalid-time", "zero-count", "negative-ports", "conflict", "failure", "lost"]) {
            await deleteTarget().click(); const deletion = await pending("POST", current.id)
            assert.equal(await deleteTarget().isDisabled(), true)
            assert.equal(await refresh().isDisabled(), true)
            await deleteTarget().evaluate(button => button.click())
            assert.equal(await page.evaluate(after => window.__ccinfoIndexHarness.requests.filter(r => r.id >= after && r.method === "POST").length, deletion), 1, "Repeat click cannot send duplicate deletion")
            const request = await page.evaluate(id => { const r = window.__ccinfoIndexHarness.requests[id]; return { target: r.target, headers: r.headers, body: r.body } }, deletion)
            assert.equal(new URL(request.target).pathname, "/api/ccinfo/delete-record")
            assert.deepEqual(request.body, { kind: singular, id: (await rows(["DELETE TARGET"]))[0].id, expectedUpdatedAt: "2026-10-16T00:00:00.123456Z", deletePorts: false }, "Atomic deletion requires exact captured identity/version and non-destructive port policy")
            assert.match(request.headers["content-type"] || "", /application\/json/)
            const ackChanges = { wrong: { id: "00000000-0000-4000-8000-ffffffffffff" }, "wrong-kind": { kind: "incorrect-kind" }, "wrong-schema": { schema: "invalid" }, "invalid-time": { deletedAt: "invalid" }, "zero-count": { deletedCount: 0 }, "negative-ports": { portsDetached: -1 } }
            if (response === "lost") { await page.evaluate(id => window.__ccinfoIndexHarness.reject(id), deletion); await settle() }
            else await release(deletion, response === "empty" ? {} : acknowledgement(request.body.id, ackChanges[response]), 0, response === "conflict" ? 409 : response === "failure" ? 500 : 200)
            await page.getByRole("alert").waitFor(); await entry("DELETE TARGET").waitFor(); await waitCount(2)
            assert.equal(await deleteTarget().isDisabled(), false)
            assert.ok(!(await countText()).includes("Private diagnostic"))
            current = { id: deletion }
          }
          await shot("unconfirmed-delete")
          // Late successful mutation acknowledgements cannot change a replacement
          // identity or filter, even when the mutation itself was not cancelled.
          await deleteTarget().click(); const oldMutation = await pending("POST", current.id)
          await page.evaluate(({ id, data }) => window.__ccinfoIndexHarness.deferBody(id, { data }), { id: oldMutation, data: acknowledgement((await rows(["DELETE TARGET"]))[0].id) })
          await page.waitForFunction(id => window.__ccinfoIndexHarness.bodies.some(b => b.requestId === id && !b.done), oldMutation)
          await page.evaluate(() => window.__ccinfoIndexHarness.setAuth({ username: "synthetic-editor-d@example.invalid" }))
          id = await pending("GET", oldMutation); await release(id, await rows(["OWNER D RESULT"])); await entry("OWNER D RESULT").waitFor()
          await page.evaluate(({ id, data }) => window.__ccinfoIndexHarness.releaseBody(id, data), { id: oldMutation, data: acknowledgement((await rows(["DELETE TARGET"]))[0].id) }); await settle()
          await entry("OWNER D RESULT").waitFor(); await waitCount(1)
          assert.equal(await page.evaluate(after => window.__ccinfoIndexHarness.requests.filter(r => r.id > after).length, id), 0)
          await filter().fill("DELETE GROUP"); current = await checked(["DELETE TARGET", "KEEP RECORD"], 2, id)
          await deleteTarget().click(); const filteredMutation = await pending("POST", current.id)
          await filter().fill("CURRENT QUERY"); id = await pending("GET", filteredMutation)
          await release(id, await rows(["CURRENT QUERY RESULT"])); await entry("CURRENT QUERY RESULT").waitFor()
          await release(filteredMutation, acknowledgement((await rows(["DELETE TARGET"]))[0].id))
          await entry("CURRENT QUERY RESULT").waitFor(); await waitCount(1)
          assert.equal(await page.evaluate(after => window.__ccinfoIndexHarness.requests.filter(r => r.id > after).length, id), 0)
          await filter().fill("DELETE GROUP"); current = await checked(["DELETE TARGET", "KEEP RECORD"], 2, id)
          await deleteTarget().click(); let deletion = await pending("POST", current.id)
          const deletedRow = await rows(["DELETE TARGET"]); await release(deletion, acknowledgement(deletedRow[0].id), 1)
          id = await pending("GET", deletion); await release(id, [], 0, 500)
          await page.getByRole("alert").waitFor(); assert.equal(await page.locator("tbody a").count(), 0)
          assert.ok(!/Count:\s*0(?:\D|$)/i.test(await countText()), "A failed post-delete reconciliation cannot invent zero")
          await refresh().click(); id = await pending("GET", id); await release(id, await rows(["KEEP RECORD"])); await entry("KEEP RECORD").waitFor(); await waitCount(1)
          assert.equal(await entry("DELETE TARGET").count(), 0)
          for (const status of [401, 403]) {
            await page.locator("tbody tr").filter({ hasText: "KEEP RECORD" }).getByRole("button", { name: /^delete /i }).click()
            const denied = await pending("POST", id); await release(denied, {}, null, status, "<html>Private denied</html>")
            await page.getByRole("alert").waitFor(); assert.equal(await page.locator("tbody a").count(), 0); assert.ok(!(await countText()).includes("Private denied"))
            await refresh().click(); id = await pending("GET", denied); await release(id, await rows(["KEEP RECORD"])); await entry("KEEP RECORD").waitFor()
          }

          // Deleting the last row of page2 clamps/reloads page1 and backfills its rows.
          await filter().fill("FINAL PAGE"); id = await pending("GET", id); await release(id, await rows(["FIRST PAGE ROW"], 200), 201); await waitCount(201)
          await page.getByRole("button", { name: "Next", exact: true }).click(); id = await pending("GET", id)
          const last = await rows(["LAST PAGE ROW"]); await release(id, last, 201); await entry("LAST PAGE ROW").waitFor()
          await page.locator("tbody tr").filter({ hasText: "LAST PAGE ROW" }).getByRole("button", { name: /^delete /i }).click()
          deletion = await pending("POST", id); await release(deletion, acknowledgement(last[0].id), 1)
          const reconcile = await pending("GET", deletion)
          const offset = await page.evaluate(id => window.__ccinfoIndexHarness.requests[id].offset, reconcile)
          if (offset === 200) { await release(reconcile, [], 200); id = await pending("GET", reconcile) } else { assert.equal(offset, 0); id = reconcile }
          await release(id, await rows(["BACKFILLED PAGE ONE"], 200), 200); await entry("BACKFILLED PAGE ONE").waitFor(); await waitCount(200)
          assert.match(await countText(), /Page 1\s*\/\s*1/i); assert.equal(await page.locator("tbody tr").count(), 200); await shot("last-page-clamped")

          // Server authorization failures clear verified private rows even with invalid JSON bodies.
          for (const status of [401, 403]) {
            await refresh().click(); const denied = await pending("GET", id); await release(denied, [], null, status, "<html>Private denied</html>")
            await page.getByRole("alert").waitFor(); assert.equal(await page.locator("tbody a").count(), 0); assert.ok(!(await countText()).includes("Private denied"))
            await refresh().click(); id = await pending("GET", denied); await release(id, await rows(["RESTORED ACCESS"])); await entry("RESTORED ACCESS").waitFor()
          }
          // Abort alone is not a deadline: adversarial transports and response
          // body decoding deliberately ignore it. Every pending phase must end
          // visibly, release its controls, retain checked evidence and ignore late ACKs.
          await page.clock.install()
          await refresh().click(); const hungRead = await pending("GET", id)
          await page.clock.runFor(30_001); await page.getByRole("alert").waitFor()
          assert.equal(await refresh().isDisabled(), false); await entry("RESTORED ACCESS").waitFor(); await waitCount(1)
          assert.equal(await page.evaluate(id => window.__ccinfoIndexHarness.requests[id].signal.aborted, hungRead), true)
          await release(hungRead, await rows(["LATE HUNG READ"]))
          assert.equal(await entry("LATE HUNG READ").count(), 0); await entry("RESTORED ACCESS").waitFor()
          await refresh().click(); const hungReadBody = await pending("GET", hungRead)
          await page.evaluate(({ id, data }) => window.__ccinfoIndexHarness.deferBody(id, { data, count: 1 }), { id: hungReadBody, data: await rows(["LATE HUNG READ BODY"]) })
          await page.waitForFunction(id => window.__ccinfoIndexHarness.bodies.some(b => b.requestId === id && !b.done), hungReadBody)
          await page.clock.runFor(30_001); await page.getByRole("alert").waitFor()
          assert.equal(await refresh().isDisabled(), false); await entry("RESTORED ACCESS").waitFor()
          await page.evaluate(({ id, data }) => window.__ccinfoIndexHarness.releaseBody(id, data), { id: hungReadBody, data: await rows(["LATE HUNG READ BODY"]) }); await settle()
          assert.equal(await entry("LATE HUNG READ BODY").count(), 0); await waitCount(1)
          await refresh().click(); id = await pending("GET", hungReadBody)
          const timeoutRow = (await rows(["DELETE TIMEOUT TARGET"]))[0]; await release(id, [timeoutRow]); await entry(timeoutRow.name).waitFor()
          const timeoutDelete = () => page.locator("tbody tr").filter({ hasText: timeoutRow.name }).getByRole("button", { name: /^delete /i })
          await timeoutDelete().click(); const hungDelete = await pending("POST", id)
          await page.clock.runFor(30_001); await page.getByRole("alert").waitFor()
          assert.equal(await timeoutDelete().isDisabled(), false); assert.equal(await refresh().isDisabled(), false); await waitCount(1)
          await release(hungDelete, acknowledgement(timeoutRow.id))
          await entry(timeoutRow.name).waitFor(); await waitCount(1)
          assert.equal(await page.evaluate(after => window.__ccinfoIndexHarness.requests.filter(r => r.id > after).length, hungDelete), 0, "Late timed-out deletion cannot issue reconciliation")
          await refresh().click(); id = await pending("GET", hungDelete); await release(id, [timeoutRow]); await entry(timeoutRow.name).waitFor()
          await timeoutDelete().click(); const hungDeleteBody = await pending("POST", id)
          await page.evaluate(({ id, data }) => window.__ccinfoIndexHarness.deferBody(id, { data }), { id: hungDeleteBody, data: acknowledgement(timeoutRow.id) })
          await page.waitForFunction(id => window.__ccinfoIndexHarness.bodies.some(b => b.requestId === id && !b.done), hungDeleteBody)
          await page.clock.runFor(30_001); await page.getByRole("alert").waitFor()
          assert.equal(await timeoutDelete().isDisabled(), false); await entry(timeoutRow.name).waitFor(); await waitCount(1)
          await page.evaluate(({ id, data }) => window.__ccinfoIndexHarness.releaseBody(id, data), { id: hungDeleteBody, data: acknowledgement(timeoutRow.id) }); await settle()
          await entry(timeoutRow.name).waitFor(); await waitCount(1)
          assert.equal(await page.evaluate(after => window.__ccinfoIndexHarness.requests.filter(r => r.id > after).length, hungDeleteBody), 0)
          await shot("bounded-read-delete-timeouts")
          id = hungDeleteBody
          await refresh().click(); id = await pending("GET", id); await release(id, [], 0)
          await waitCount(0); assert.equal(await page.getByRole("alert").count(), 0); await shot("verified-empty")
          assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.deepEqual(await page.evaluate(() => window.__ccinfoIndexHarness.unexpected), [])
          assert.equal(await page.evaluate(() => window.__ccinfoIndexHarness.requests.filter(r => r.method === "DELETE").length), 0, "Indexes must use only the atomic server deletion endpoint")
          results.push({ engine, kind, width, scheme, actualSdkAndProxy: true, errorsAndCounts: "passed", searchPageOwnership: "passed", identityAndDeferredBody: "passed", permissionsAndSignOut: "passed", deletionAckAndPagination: "passed", readFetchAndBodyDeadline: "passed", deleteFetchAndBodyDeadline: "passed", nativeAccessibleScroll: "passed" })
          console.log(label + " passed")
        } finally { await context.close() }
      } } finally { await browser.close() }
    }
    assert.equal(results.length, 36)
    fs.writeFileSync(path.join(output, "results.json"), JSON.stringify({ results, limits: ["Actual pages, Supabase SDK/client, route guard, navigation and CSS; synthetic auth/navigation/proxy HTTP transport only.", "Real proxy permission and database CAS/affected-row behavior are separate API/native gates. No real records, production/browser accounts, storage or provider calls.", "Both OS color preferences are tested; this does not introduce a different site theme or certify physical devices."], cleanup: "All owned contexts, browsers and loopback server close in finally." }, null, 2))
  } finally { await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
