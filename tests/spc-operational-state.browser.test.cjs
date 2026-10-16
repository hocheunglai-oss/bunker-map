// Actual pages, SPC shell and global CSS; synthetic session/navigation/HTTP only.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http")
const root = path.resolve(__dirname, ".."), { build } = require("esbuild"), postcss = require("postcss"), tailwind = require("@tailwindcss/postcss")
const output = process.env.SPC_OPERATIONAL_SCREENSHOTS
assert.ok(output && path.isAbsolute(output), "Set an owned absolute evidence directory")
fs.mkdirSync(output, { recursive: true })
const mocks = {
  "@/lib/useSpcAuth": "export const useSpcAuth=()=>window.__operationalHarness.auth;",
  "next/navigation": "const router={replace:path=>window.__operationalHarness.routes.push(path)};export const useRouter=()=>router;",
}
;(async () => {
  const bundle = await build({ absWorkingDir: root, entryPoints: ["tests/fixtures/spc-operational-state.tsx"], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' }, plugins: [{ name: "synthetic-session", setup(b) {
    b.onResolve({ filter: /^(?:@\/lib\/useSpcAuth|next\/navigation)$/ }, a => ({ path: a.path, namespace: "synthetic" }))
    b.onLoad({ filter: /.*/, namespace: "synthetic" }, a => ({ contents: mocks[a.path], loader: "jsx", resolveDir: root }))
  } }] })
  const css = await postcss([tailwind()]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://127.0.0.1").pathname
    if (p === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].contents) }
    else if (p === "/globals.css") { res.setHeader("Content-Type", "text/css"); res.end(css.css) }
    else if (["/spc/techstack", "/spc/systemhealth"].includes(p)) { res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/globals.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>') }
    else { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = "http://127.0.0.1:" + server.address().port, { chromium, webkit } = require("playwright"), results = []
  try {
    for (const [engine, launcher] of [["chromium", chromium], ["webkit", webkit]]) {
      if (process.env.SPC_OPERATIONAL_RED && engine === "webkit") continue
      const browser = await launcher.launch({ headless: true, ...(engine === "chromium" && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) })
      try { for (const kind of ["tech", "health"]) for (const width of process.env.SPC_OPERATIONAL_RED ? [390] : [320, 390, 1440]) for (const scheme of process.env.SPC_OPERATIONAL_RED ? ["light"] : ["light", "dark"]) {
        const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, colorScheme: scheme, timezoneId: "Asia/Hong_Kong" })
        try {
          const page = await context.newPage(), errors = [], unexpected = []; page.setDefaultTimeout(6000)
          page.on("pageerror", e => errors.push(e.message))
          await context.route("**/*", r => new URL(r.request().url()).origin === origin ? r.continue() : (unexpected.push(r.request().url()), r.abort()))
          const pending = n => page.waitForFunction(n => window.__operationalHarness.pending.length === n, n)
          const shortCommit = value => page.getByText(value.repeat(7), { exact: true })
          const capture = async suffix => {
            const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, overflow: [...document.querySelectorAll(".spc-alert,.spc-operational-status,.spc-health-grid strong,.spc-check-grid h3,.spc-secret-grid h3,.spc-secret-grid article,.spc-tech-database li")].filter(n => n.scrollWidth > n.clientWidth + 1).map(n => ({ tag: n.tagName, class: n.className, text: n.textContent, client: n.clientWidth, scroll: n.scrollWidth })), databaseText: [...document.querySelectorAll(".spc-tech-database li")].map(n => {
              const panel = n.closest(".spc-panel").getBoundingClientRect(), range = document.createRange()
              range.selectNodeContents(n)
              const text = range.getBoundingClientRect()
              return { text: n.textContent, left: text.left, right: text.right, panelLeft: panel.left, panelRight: panel.right }
            }) }))
            assert.ok(dimensions.scroll <= dimensions.width + 1, JSON.stringify(dimensions)); assert.deepEqual(dimensions.overflow, [], JSON.stringify(dimensions))
            if (kind === "tech" && suffix === "verified") assert.ok(dimensions.databaseText.length > 10, "Database range checks must exercise the actual list")
            for (const row of dimensions.databaseText) assert.ok(row.left >= row.panelLeft - 1 && row.right <= row.panelRight + 1, "Database text clipped by its enclosing panel: " + JSON.stringify(row))
            await page.screenshot({ path: path.join(output, `${engine}-${kind}-${width}-${scheme}-${suffix}.png`), fullPage: true })
          if (["verified", "server-stale", "unavailable", "last-verified"].includes(suffix)) await page.screenshot({ path: path.join(output, `${engine}-${kind}-${width}-${scheme}-${suffix}-viewport.png`) })
          }
          await page.goto(origin + (kind === "health" ? "/spc/systemhealth" : "/spc/techstack")); await pending(1)
          await page.evaluate(() => window.__operationalHarness.reject())
          if (process.env.SPC_OPERATIONAL_RED) {
            await page.waitForTimeout(40)
            await page.screenshot({ path: path.join(output, `${kind}-baseline-network.png`), fullPage: true })
            fs.writeFileSync(path.join(output, `${kind}-baseline-network.json`), JSON.stringify({ errors, text: await page.locator("body").innerText() }, null, 2))
            assert.deepEqual(errors, [], "A failed initial read must not become an unhandled rejection")
          }
          const alert = page.getByRole("alert"), refresh = () => page.getByRole("button", { name: "Refresh", exact: true })
          await alert.waitFor(); assert.equal(await shortCommit("a").count(), 0); await capture("unavailable")
          await refresh().click(); await pending(1); await page.evaluate(() => window.__operationalHarness.release()); await shortCommit("a").waitFor()
          assert.equal(await alert.count(), 0); await capture("verified")
          if (kind === "tech") {
            const regions = await page.evaluate(() => [...document.querySelectorAll(".spc-table-wrap")].map(region => {
              region.scrollLeft = region.scrollWidth
              const box = region.getBoundingClientRect(), end = region.querySelector("tbody tr:last-child td:last-child").getBoundingClientRect()
              return { regionLeft: box.left, regionRight: box.right, lastLeft: end.left, lastRight: end.right }
            }))
            assert.equal(regions.length, 1)
            for (const region of regions) assert.ok(region.lastLeft >= region.regionLeft - 1 && region.lastRight <= region.regionRight + 1, JSON.stringify(region))
            await page.screenshot({ path: path.join(output, `${engine}-${kind}-${width}-${scheme}-table-scrolled.png`) })
            await page.locator(".spc-secret-grid").scrollIntoViewIfNeeded()
            await page.screenshot({ path: path.join(output, `${engine}-${kind}-${width}-${scheme}-secret-register.png`) })
            await page.evaluate(() => { scrollTo(0, 0); document.querySelectorAll(".spc-table-wrap").forEach(region => { region.scrollLeft = 0 }) })
          }
          for (const mode of ["http", "json", "shape"]) {
            await refresh().click(); await pending(1)
            await page.evaluate(mode => { const h = window.__operationalHarness; if (mode === "http") h.raw(503); else if (mode === "json") h.raw(); else h.release(0, 200, h.kind === "health" ? { status: "ok", checks: [null] } : { generatedAt: "bad", deployment: null }) }, mode)
            await alert.waitFor(); assert.equal(await shortCommit("a").count(), 1); assert.match(await alert.innerText(), /last|previous/i)
          }
          await capture("last-verified")
          if (kind === "health") {
            await refresh().click(); await pending(1); await page.evaluate(() => window.__operationalHarness.release(0, 200, window.__operationalHarness.health("a".repeat(40), true)))
            await page.getByText("UNKNOWN", { exact: true }).waitFor(); await page.getByText(/current status is unknown/i).waitFor(); await capture("server-stale")
          }
          for (const status of [401, 403]) {
            await refresh().click(); await pending(1); await page.evaluate(status => window.__operationalHarness.raw(status), status)
            await page.getByText(/access could not be verified/i).waitFor(); assert.equal(await shortCommit("a").count(), 0)
            await refresh().click(); await pending(1); await page.evaluate(() => window.__operationalHarness.release()); await shortCommit("a").waitFor()
          }
          await refresh().click(); await pending(1)
          await page.evaluate(() => { const h = window.__operationalHarness; h.auth = { ...h.auth, actorKey: "b".repeat(64) }; h.render() })
          await pending(2); assert.equal(await shortCommit("a").count(), 0)
          await page.evaluate(() => { const h = window.__operationalHarness; h.release(1, 200, h.kind === "health" ? h.health("b".repeat(40)) : h.tech("b".repeat(40))) }); await shortCommit("b").waitFor()
          await page.evaluate(() => window.__operationalHarness.release()); assert.equal(await shortCommit("a").count(), 0)
          await refresh().click(); await pending(1); await page.evaluate(() => window.__operationalHarness.deferBody()); await page.waitForFunction(() => window.__operationalHarness.bodies.length === 1)
          await page.evaluate(() => { const h = window.__operationalHarness; h.auth = { ...h.auth, username: "new-owner@example.invalid" }; h.render() }); await pending(1)
          await page.evaluate(() => window.__operationalHarness.release()); await shortCommit("a").waitFor()
          await page.evaluate(() => { const h = window.__operationalHarness; h.bodies.shift()(h.kind === "health" ? h.health("c".repeat(40)) : h.tech("c".repeat(40))) }); assert.equal(await shortCommit("c").count(), 0)
          await refresh().click(); await pending(1)
          await page.getByText(/timed out/i).waitFor(); assert.equal(await refresh().isEnabled(), true)
          assert.equal(await page.evaluate(() => window.__operationalHarness.pending[0].signal.aborted), true)
          await refresh().click(); await pending(2)
          await page.evaluate(() => { const h = window.__operationalHarness; h.release(1, 200, h.kind === "health" ? h.health("b".repeat(40)) : h.tech("b".repeat(40))) }); await shortCommit("b").waitFor()
          await page.evaluate(() => window.__operationalHarness.reject()); assert.equal(await shortCommit("b").count(), 1)
          await capture("deadline-recovery")
          await refresh().click(); await pending(1)
          await page.evaluate(() => { const h = window.__operationalHarness; h.auth = { ...h.auth, permissions: { "spc-tech-stack": "none", "spc-system-health": "none" } }; h.render() })
          await page.waitForFunction(() => document.querySelectorAll(".spc-panel").length === 0)
          await page.evaluate(() => window.__operationalHarness.release()); assert.equal(await shortCommit("a").count(), 0); await capture("no-access")
          await page.evaluate(() => { const h = window.__operationalHarness; h.auth = { ...h.auth, permissions: { "spc-tech-stack": "edit", "spc-system-health": "edit" } }; h.render() }); await pending(1)
          await page.evaluate(() => window.__operationalHarness.release()); await shortCommit("a").waitFor(); await capture("edit")
          await refresh().click(); await pending(1)
          await page.evaluate(() => { const h = window.__operationalHarness; h.auth = { ...h.auth, authenticated: false }; h.render() }); await page.waitForFunction(() => document.querySelectorAll(".spc-panel").length === 0)
          await page.evaluate(() => window.__operationalHarness.release()); assert.equal(await shortCommit("a").count(), 0); await capture("signed-out")
          assert.deepEqual(errors, []); assert.deepEqual(unexpected, [])
          results.push({ engine, kind, width, scheme, networkAndMalformedRecovery: "passed", lastVerified: "retained", accessRevocation: "cleared", actorAndBodyOwnership: "passed", abortIgnoringDeadline: "passed", viewEditNoneSignedOut: "passed" })
          console.log(`${engine} ${kind} ${width} ${scheme} passed`)
        } finally { await context.close() }
      } } finally { await browser.close() }
    }
    assert.equal(results.length, 24)
    fs.writeFileSync(path.join(output, "results.json"), JSON.stringify({ results, limits: ["Actual components/shell/global CSS with synthetic auth/navigation/HTTP. Real session ownership is separately covered by the shared-provider suite.", "Desktop and mobile Chromium/WebKit under both OS preferences; physical devices not tested.", "Only the shipped 30-second client deadline is clock-scaled to250ms in this isolated fixture.", "No live records, credentials, external services, personal browser or production writes."], cleanup: "All owned browsers/contexts/server closed in finally." }, null, 2))
  } finally { await new Promise(resolve => server.close(resolve)) }
})().catch(error => { console.error(error); process.exitCode = 1 })
