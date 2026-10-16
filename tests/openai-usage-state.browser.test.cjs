// Actual usage page + navigation + module/global CSS; no external service calls.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const path = require("node:path")
const { build } = require("esbuild")
const postcss = require("postcss")
const tailwind = require("@tailwindcss/postcss")
const { chromium, webkit } = require("playwright")
const root = path.resolve(__dirname, "..")
const mocks = {
  "@/lib/useSimpleAdminAuth": "export const useSimpleAdminAuth=()=>window.__openAiUsageHarness.auth;export const clearAdminClientSessionCache=()=>{};",
  "next/navigation": "const router={push:path=>window.__openAiUsageHarness.routes.push(path),replace:path=>window.__openAiUsageHarness.routes.push(path),prefetch:()=>{}};export const useRouter=()=>router;export const usePathname=()=>'/admin/openaiusage';",
  "next/link": "import React from 'react';export default function Link({prefetch,...props}){return <a {...props}/>;}",
  "next/image": "import React from 'react';export default function Image({priority,unoptimized,fill,...props}){return <img {...props}/>;}",
}
async function main() {
  const output = process.env.OPENAI_USAGE_SCREENSHOTS
  assert.ok(output && path.isAbsolute(output), "An owned absolute evidence directory is required.")
  fs.mkdirSync(output, { recursive: true })
  const baseline = process.argv.find(arg => arg.startsWith("--baseline-"))
  const bundle = await build({
    absWorkingDir: root, entryPoints: ["tests/fixtures/openai-usage-state.tsx"], bundle: true, write: false,
    outdir: "openai-usage-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "synthetic-auth-and-navigation", setup(builder) {
      builder.onResolve({ filter: /^(?:@\/lib\/useSimpleAdminAuth|next\/(?:navigation|link|image))$/ }, args => ({ path: args.path, namespace: "synthetic" }))
      builder.onLoad({ filter: /.*/, namespace: "synthetic" }, args => ({ contents: mocks[args.path], loader: "jsx", resolveDir: root }))
    } }],
  })
  const assets = new Map(bundle.outputFiles.map(file => ["/" + path.basename(file.path), file.contents]))
  const script = [...assets.keys()].find(name => name.endsWith(".js"))
  const styles = [...assets.keys()].filter(name => name.endsWith(".css"))
  const globalCss = await postcss([tailwind()]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/globals.css">' + styles.map(href => '<link rel="stylesheet" href="' + href + '">').join("") + '</head><body><div id="root"></div><script src="' + script + '"></script></body></html>'
  const server = http.createServer((request, response) => {
    if (request.method !== "GET") { response.writeHead(405); return response.end() }
    const pathname = new URL(request.url, "http://127.0.0.1").pathname
    if (assets.has(pathname)) { response.setHeader("Content-Type", pathname.endsWith(".css") ? "text/css" : "text/javascript"); return response.end(assets.get(pathname)) }
    if (pathname === "/globals.css") { response.setHeader("Content-Type", "text/css"); return response.end(globalCss.css) }
    if (pathname === "/fc-uno-sidebar-logo.png") { response.setHeader("Content-Type", "image/png"); return response.end(fs.readFileSync(path.join(root, "public/fc-uno-sidebar-logo.png"))) }
    if (pathname !== "/") { response.writeHead(404); return response.end() }
    response.setHeader("Content-Type", "text/html"); response.end(html)
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = "http://127.0.0.1:" + server.address().port
  const results = []
  try {
    for (const [engine, launcher] of [["chromium", chromium], ["webkit", webkit]]) {
      if (baseline && engine !== "chromium") continue
      const browser = await launcher.launch({ headless: true, ...(engine === "chromium" && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) })
      try {
        for (const width of baseline ? [390] : [320, 390, 1440]) for (const scheme of baseline ? ["light"] : ["light", "dark"]) {
          const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, colorScheme: scheme })
          try {
            const page = await context.newPage(), errors = [], unexpected = []
            page.setDefaultTimeout(6000)
            page.on("pageerror", error => errors.push(error.message))
            await context.route("**/*", route => {
              if (new URL(route.request().url()).origin === origin) return route.continue()
              unexpected.push(route.request().url()); return route.abort()
            })
            await page.goto(origin + (baseline === "--baseline-period" ? "?mode=ok" : ""))
            const label = engine + "-" + width + "-" + scheme
            await page.getByRole("heading", { name: "OPENAI USAGE", exact: true }).waitFor()
            const metric = label => page.locator("main span", { hasText: new RegExp("^" + label + "$") }).locator("..").locator("strong")
            const refresh = () => page.getByRole("button", { name: "REFRESH", exact: true })
            const period = page.getByLabel("Usage period")
            const empty = page.getByText("NO TRACKED OPENAI REQUESTS YET", { exact: true })
            if (baseline === "--baseline-unavailable") {
              await page.waitForFunction(() => window.__openAiUsageHarness.reads.length === 1)
              await refresh().waitFor()
              await page.screenshot({ path: path.join(output, "baseline-unavailable.png"), fullPage: true })
              assert.equal(await empty.count(), 0, "An unavailable report must not claim there were no requests.")
              assert.notEqual(await metric("TOTAL REQUESTS").innerText(), "0", "An unavailable report must not show false zero metrics.")
              console.log("Baseline unavailable assertions passed truthfully.")
              return
            }
            if (!baseline) {
              const alert = page.getByRole("alert")
              await alert.waitFor()
              assert.match(await alert.innerText(), /unavailable|could not|unable/i)
              assert.equal(await empty.count(), 0)
              assert.equal(await metric("TOTAL REQUESTS").innerText(), "—")
              await page.screenshot({ path: path.join(output, label + "-unavailable.png"), fullPage: true })
              for (const mode of ["http", "invalid", "invalid-json", "wrong-period"]) {
                await page.evaluate(mode => { window.__openAiUsageHarness.mode = mode }, mode)
                await refresh().click(); await alert.waitFor()
                assert.equal(await metric("TOTAL REQUESTS").innerText(), "—")
                assert.equal(await empty.count(), 0)
              }
              await page.evaluate(() => { window.__openAiUsageHarness.mode = "ok" })
              await refresh().click()
            }
            await page.waitForFunction(() => document.querySelector("main")?.textContent?.includes("3,000"))
            await page.evaluate(() => { window.__openAiUsageHarness.mode = "defer" })
            await period.selectOption("7")
            await page.waitForFunction(() => window.__openAiUsageHarness.pending.some(item => item.days === 7))
            if (!baseline) assert.equal(await metric("TOTAL TOKENS").innerText(), "—", "The old period is hidden before the new report arrives.")
            await period.selectOption("90")
            await page.waitForFunction(() => window.__openAiUsageHarness.pending.some(item => item.days === 90))
            await page.evaluate(() => {
              const h = window.__openAiUsageHarness
              h.pending.find(item => item.days === 90).resolve(Response.json(h.response(90)))
            })
            await page.waitForFunction(() => document.querySelector("main")?.textContent?.includes("9,000"))
            await page.evaluate(() => {
              const h = window.__openAiUsageHarness
              h.pending.find(item => item.days === 7).resolve(Response.json(h.response(7)))
            })
            await page.waitForTimeout(80)
            await page.screenshot({ path: path.join(output, baseline ? "baseline-period.png" : label + "-period.png"), fullPage: true })
            assert.equal(await metric("TOTAL TOKENS").innerText(), "9,000", "A late 7-day response must not overwrite the selected 90-day report.")
            assert.equal(await period.inputValue(), "90")
            if (baseline) { console.log("Baseline period ownership assertions passed truthfully."); return }
            assert.match(await page.getByRole("status").innerText(), /last 90 days/i)
            assert.equal(await page.locator('main a[href="/spc/enquiries"]').count(), 1, "Legitimate SPC attribution is retained.")
            assert.equal(await page.evaluate(() => window.__openAiUsageHarness.pending.find(item => item.days === 7).signal.aborted), true)
            for (const mode of ["http", "network", "invalid", "invalid-json", "wrong-period"]) {
              await page.evaluate(mode => { window.__openAiUsageHarness.mode = mode }, mode)
              await refresh().click(); await page.getByRole("alert").waitFor()
              assert.match(await page.getByRole("alert").innerText(), /last verified/i)
              assert.doesNotMatch(await page.getByRole("alert").innerText(), /private upstream/i)
              assert.equal(await metric("TOTAL TOKENS").innerText(), "9,000")
              assert.equal(await page.locator('main a[href^="//"]').count(), 0)
            }
            await page.screenshot({ path: path.join(output, label + "-retained.png"), fullPage: true })
            for (const mode of ["unauthorized", "forbidden"]) {
              await page.evaluate(mode => { window.__openAiUsageHarness.mode = mode }, mode)
              await refresh().click(); await page.getByRole("alert").waitFor()
              assert.equal(await metric("TOTAL TOKENS").innerText(), "—", "Denied access clears retained usage.")
              assert.doesNotMatch(await page.getByRole("status").innerText(), /last verified/i)
              assert.match(await page.getByRole("alert").innerText(), /access/i)
              await page.screenshot({ path: path.join(output, label + "-" + mode + ".png"), fullPage: true })
              await page.evaluate(() => { window.__openAiUsageHarness.mode = "ok" })
              await refresh().click(); await refresh().waitFor()
              assert.equal(await metric("TOTAL TOKENS").innerText(), "9,000")
            }
            for (const mode of ["unsafe-link", "api-path"]) {
              await page.evaluate(mode => { window.__openAiUsageHarness.mode = mode }, mode)
              await refresh().click(); await refresh().waitFor()
              assert.equal(await page.getByRole("alert").count(), 0, "Accurate historical usage is not discarded for a non-UI path.")
              assert.equal(await page.locator("main tbody a").count(), 0, "Only safe UI paths become navigable links.")
              assert.match(await page.locator("main tbody").innerText(), mode === "api-path" ? /\/api\/ecosystem\/knowledge-extract/ : /\/\/example.invalid\/private/)
            }
            await page.evaluate(() => { const h = window.__openAiUsageHarness; h.pending = []; h.mode = "defer" })
            await refresh().click()
            await page.waitForFunction(() => window.__openAiUsageHarness.pending.length === 1)
            assert.equal(await page.getByRole("button", { name: "REFRESHING...", exact: true }).isDisabled(), true)
            await page.evaluate(() => { const h = window.__openAiUsageHarness; h.auth = { ...h.auth, authenticated: false }; h.render() })
            await page.waitForFunction(() => window.__openAiUsageHarness.routes.includes("/admin"))
            assert.equal(await page.getByRole("heading", { name: "OPENAI USAGE", exact: true }).count(), 0)
            await page.screenshot({ path: path.join(output, label + "-signed-out.png"), fullPage: true })
            await page.evaluate(() => { const h = window.__openAiUsageHarness; h.mode = "network"; h.auth = { ...h.auth, authenticated: true }; h.render() })
            await page.getByRole("alert").waitFor()
            assert.equal(await metric("TOTAL TOKENS").innerText(), "—", "A new session must not resurrect the former session's report.")
            await page.evaluate(() => { const h = window.__openAiUsageHarness; h.pending[0].resolve(Response.json(h.response(90, 7777))) })
            await page.waitForTimeout(80)
            assert.equal(await metric("TOTAL TOKENS").innerText(), "—")
            // An authenticated identity replacement also remounts the request owner.
            await page.evaluate(() => { const h = window.__openAiUsageHarness; h.mode = "defer"; h.pending = [] })
            await refresh().click()
            await page.waitForFunction(() => window.__openAiUsageHarness.pending.length === 1)
            await page.evaluate(() => { const h = window.__openAiUsageHarness; h.mode = "empty"; h.auth = { ...h.auth, username: "viewer-b@example.invalid" }; h.render() })
            await empty.waitFor()
            assert.equal(await metric("TOTAL TOKENS").innerText(), "0", "Only a verified empty response may show zero/no requests.")
            await page.evaluate(() => { const h = window.__openAiUsageHarness; h.pending[0].resolve(Response.json(h.response(30, 8888))) })
            await page.waitForTimeout(80)
            assert.equal(await metric("TOTAL TOKENS").innerText(), "0")
            await page.screenshot({ path: path.join(output, label + "-empty.png"), fullPage: true })
            await page.evaluate(() => { const h = window.__openAiUsageHarness; h.auth = { ...h.auth, permissions: { "openai-usage": "none" } }; h.render() })
            await page.getByRole("heading", { name: "OPENAI USAGE", exact: true }).waitFor({ state: "detached" })
            const reads = await page.evaluate(() => window.__openAiUsageHarness.reads.length)
            await page.waitForTimeout(50)
            assert.equal(await page.evaluate(() => window.__openAiUsageHarness.reads.length), reads, "Denied users do not fetch usage.")
            await page.evaluate(() => { const h = window.__openAiUsageHarness; h.mode = "ok"; h.auth = { ...h.auth, permissions: { "openai-usage": "view" } }; h.render() })
            await page.waitForFunction(() => document.querySelector("main")?.textContent?.includes("3,000"))
            await page.screenshot({ path: path.join(output, label + "-verified.png"), fullPage: true })
            const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
            assert.ok(dimensions.scroll <= dimensions.width + 1, JSON.stringify(dimensions))
            const table = page.locator("main table").locator("..")
            await table.evaluate(element => { element.scrollLeft = element.scrollWidth })
            await page.screenshot({ path: path.join(output, label + "-verified-scroll.png"), fullPage: true })
            await page.evaluate(() => { window.__openAiUsageHarness.mode = "high-counter" })
            await refresh().click(); await refresh().waitFor()
            assert.equal(await metric("TOTAL TOKENS").innerText(), "9,007,199,254,740,991")
            const counterBounds = await metric("TOTAL TOKENS").evaluate(element => ({ scroll: element.scrollWidth, width: element.clientWidth }))
            assert.ok(counterBounds.scroll <= counterBounds.width + 1, JSON.stringify(counterBounds))
            await page.screenshot({ path: path.join(output, label + "-large-counter.png"), fullPage: true })
            assert.deepEqual(errors, []); assert.deepEqual(unexpected, [])
            results.push({ engine, width, scheme, initialUnavailable: "no false zeros", periodRace: "ignored", invalidResponse: "last verified retained", sessionRace: "ignored", verifiedEmpty: "zero", viewGuard: "pass", dimensions })
          } catch (error) {
            fs.writeFileSync(path.join(output, "failure.json"), JSON.stringify({ baseline: baseline || null, engine, width, scheme, message: error.message, stack: error.stack }, null, 2))
            throw error
          } finally { await context.close() }
        }
      } finally { await browser.close() }
    }
    assert.equal(results.length, 12)
    const receipt = { passed: results.length, failed: 0, screenshots: output, results, limits: ["Synthetic auth and API; actual page/navigation/module/global CSS.", "Fixed admin light palette tested under both OS preferences.", "No provider calls, physical device, personal browser, or production mutation."] }
    fs.writeFileSync(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2))
    console.log(JSON.stringify(receipt))
  } finally { await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
