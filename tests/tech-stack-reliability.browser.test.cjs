// Actual page + navigation + module/global CSS; all service data is synthetic.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const path = require("node:path")
const { build } = require("esbuild")
const postcss = require("postcss")
const tailwind = require("@tailwindcss/postcss")
const { chromium, webkit } = require("playwright")
const root = path.resolve(__dirname, "..")
const partialResults = []
const mocks = {
  "@/lib/useSimpleAdminAuth": "export const useSimpleAdminAuth=()=>window.__techStackHarness.auth; export const clearAdminClientSessionCache=()=>{};",
  "next/navigation": "const router={push:path=>window.__techStackHarness.routes.push(path),replace:path=>window.__techStackHarness.routes.push(path),prefetch:()=>{}};export const useRouter=()=>router;export const usePathname=()=>'/admin/techstack';",
  "next/link": "import React from 'react';export default function Link({prefetch,...props}){return <a {...props}/>;}",
  "next/image": "import React from 'react';export default function Image({priority,unoptimized,fill,...props}){return <img {...props}/>;}",
}
async function main() {
  const output = process.env.TECH_STACK_SCREENSHOTS
  assert.ok(output && path.isAbsolute(output), "An owned absolute evidence directory is required.")
  fs.mkdirSync(output, { recursive: true })
  const bundle = await build({
    absWorkingDir: root, entryPoints: ["tests/fixtures/tech-stack-reliability.tsx"],
    bundle: true, write: false, outdir: "tech-stack-fixture", platform: "browser", format: "iife",
    jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' },
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
  const results = partialResults
  try {
    for (const [engine, launcher] of [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await launcher.launch({ headless: true, ...(engine === "chromium" && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) })
      try {
        for (const width of [320, 390, 1440]) for (const scheme of ["light", "dark"]) {
          const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, colorScheme: scheme })
          try {
            const page = await context.newPage(), errors = [], unexpected = []
            page.setDefaultTimeout(6000)
            page.on("pageerror", error => errors.push(error.message))
            await context.route("**/*", route => {
              if (new URL(route.request().url()).origin === origin) return route.continue()
              unexpected.push(route.request().url()); return route.abort()
            })
            await page.goto(origin)
            await page.getByRole("heading", { name: "CURRENT DEPLOYMENT", exact: true }).waitFor()
            const label = engine + "-" + width + "-" + scheme
            await page.screenshot({ path: path.join(output, label + "-initial-error.png"), fullPage: true })
            const alert = page.getByRole("alert")
            await alert.waitFor()
            assert.match(await alert.innerText(), /unavailable|could not|unable/i)
            await page.screenshot({ path: path.join(output, label + "-error-viewport.png") })
            const refresh = () => page.getByRole("button", { name: "REFRESH", exact: true })
            await page.evaluate(() => { window.__techStackHarness.mode = "ok" })
            await refresh().click()
            await page.getByText("aaaaaaa", { exact: true }).waitFor()
            assert.equal(await alert.count(), 0)
            for (const mode of ["http", "invalid"]) {
              await page.evaluate(mode => { window.__techStackHarness.mode = mode }, mode)
              await refresh().click(); await alert.waitFor()
              assert.equal(await page.getByText("aaaaaaa", { exact: true }).count(), 1, "Last verified response is retained.")
              assert.match(await alert.innerText(), /last|previous/i)
            }
            await page.evaluate(() => { window.__techStackHarness.mode = "defer" })
            await refresh().click()
            await page.waitForFunction(() => window.__techStackHarness.pending.length === 1)
            assert.equal(await page.getByRole("button", { name: "REFRESHING...", exact: true }).isDisabled(), true)
            await page.evaluate(() => {
              const h = window.__techStackHarness
              h.auth = { ...h.auth, authenticated: false }; h.render()
            })
            await page.waitForFunction(() => window.__techStackHarness.routes.includes("/admin"))
            assert.equal(await page.getByRole("heading", { name: "CURRENT DEPLOYMENT", exact: true }).count(), 0)
            await page.screenshot({ path: path.join(output, label + "-signed-out.png") })
            await page.evaluate(() => {
              const h = window.__techStackHarness
              h.mode = "ok"; h.auth = { ...h.auth, authenticated: true }; h.render()
            })
            await page.getByText("aaaaaaa", { exact: true }).waitFor()
            await page.evaluate(() => {
              const h = window.__techStackHarness
              h.pending.shift().resolve(Response.json(h.response("b".repeat(40))))
            })
            await page.waitForTimeout(50)
            assert.equal(await page.getByText("bbbbbbb", { exact: true }).count(), 0, "Cancelled old response cannot overwrite the new session.")
            for (const permission of ["view", "edit"]) {
              await page.evaluate(permission => {
                const h = window.__techStackHarness
                h.auth = { ...h.auth, permissions: { "tech-stack": permission } }; h.render()
              }, permission)
              const database = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "PRIMARY DATABASE", exact: true }) })
              assert.match(await database.innerText(), /17\.6\.1\.084 VERIFIED 2026-10-22/)
              const archive = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "DATABASE LOGICAL ARCHIVE", exact: true }) })
              assert.match(await archive.innerText(), /BROTLI-BOUNDED TEMP STAGING/)
              assert.doesNotMatch(await archive.innerText(), /GZIP-BOUNDED TEMP STAGING/)
              const media = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "UPLOADED MEDIA SNAPSHOT", exact: true }) })
              assert.match(await media.innerText(), /ONE-TIME SUPABASE STORAGE BYTE COPY[\s\S]*15 FILES \/ 224,309,367 BYTES; NOT RECURRING OR MONITORED BY SYSTEM HEALTH/)
              assert.equal(await page.getByRole("cell", { name: "DRIVE FILE BACKUP", exact: true }).count(), 1)
              assert.equal(await page.getByText("admin_role_defaults (optional; office_calendar_store fallback)", { exact: true }).count(), 1)
              const ssl = page.getByText(/^DATABASE SSL — DASHBOARD SETTING ENABLED/)
              assert.match(await ssl.innerText(), /2026-10-22 AT 20:03:56 HKT \(12:03:56 UTC\)[\s\S]*NOT CERTIFIED BY THIS SETTING CHECK/)
              const rehearsal = page.getByText(/^PRIVATE LOGICAL DATABASE REHEARSAL — COMPLETED/)
              assert.match(await rehearsal.innerText(), /2026-10-23[\s\S]*126 FULL-TABLE FINGERPRINTS, ORIGINAL METADATA AND EIGHT SEQUENCE STATES MATCHED[\s\S]*NATIVE TLS ON BOTH SOURCE CONNECTION HOPS[\s\S]*NOLOGIN[\s\S]*NOT A PRODUCTION UPGRADE[\s\S]*NOT A RECURRING POSTGRESQL BACKUP, MANAGED PHYSICAL\/PITR RESTORE, WHOLE HOSTED SUPABASE RECOVERY OR STORAGE-FILE RECOVERY/)
              const historicalMedia = await page.getByText(/^PRESENTATION MEDIA — VERIFIED/).innerText()
              assert.match(historicalMedia, /AT THAT DATE, DATABASE-TO-FILE CORRESPONDENCE AND HISTORICAL FILE-VERSION RECOVERY HAD NOT BEEN VERIFIED/)
              assert.doesNotMatch(historicalMedia, /DATABASE-TO-FILE BYTE MATCHING AND HISTORICAL FILE-VERSION RECOVERY REMAIN UNPROVED/)
              const correspondence = page.getByText(/^DATABASE-TO-FILE CORRESPONDENCE — VERIFIED/)
              const correspondenceText = await correspondence.innerText()
              assert.match(correspondenceText, /2026-10-23 AT 08:16 UTC[\s\S]*ALL 15 FILE IDENTITIES, VERSIONS AND SIZES \(224,309,367 BYTES\)[\s\S]*V9 LOGICAL DATABASE SNAPSHOT[\s\S]*COPIES BYTE-VERIFIED ON 2026-10-21/)
              assert.match(correspondenceText, /OFFLINE METADATA COMPARISON, NOT A NEW CLOUD AVAILABILITY CHECK OR STORAGE-BYTE RESTORE/)
              assert.match(correspondenceText, /OLDER DATABASE SNAPSHOTS, NEW UPLOADS AFTER V9 AND HISTORICAL FILE-VERSION RECOVERY REMAIN UNPROVED/)
              assert.match(correspondenceText, /NO RECURRING MEDIA BACKUP OR SYSTEM HEALTH MONITORING WAS ADDED/)
              assert.match(await page.getByText(/^EXCHANGE RENEWAL —/).innerText(), /24 HOURS[\s\S]*UNCHANGED 36-HOUR ACCEPTANCE LIMIT[\s\S]*NOT A TIMESTAMP-ONLY RENEWAL/)
              await media.scrollIntoViewIfNeeded()
              await page.screenshot({ path: path.join(output, label + "-" + permission + "-media.png") })
              await media.getByRole("cell").last().scrollIntoViewIfNeeded()
              await page.screenshot({ path: path.join(output, label + "-" + permission + "-media-scope.png") })
              await ssl.scrollIntoViewIfNeeded()
              await page.screenshot({ path: path.join(output, label + "-" + permission + "-ssl.png") })
              await rehearsal.scrollIntoViewIfNeeded()
              await page.screenshot({ path: path.join(output, label + "-" + permission + "-private-rehearsal.png") })
              await correspondence.scrollIntoViewIfNeeded()
              await page.screenshot({ path: path.join(output, label + "-" + permission + "-file-correspondence.png") })
            }
            assert.equal(await page.getByRole("heading", { name: "PHONEBOOK SERVER", exact: true }).count(), 0)
            assert.equal(await page.evaluate(() => window.__techStackHarness.configurationReads), 0, "View/Edit permission is not ADMIN authority.")
            const serverPanel = () => page.getByRole("region", { name: "Phonebook server configuration", exact: true })
            const serverRefresh = () => serverPanel().getByRole("button", { name: "REFRESH SERVER", exact: true })
            await page.evaluate(() => {
              const h = window.__techStackHarness
              h.auth = { ...h.auth, role: "ADMIN" }; h.render()
            })
            await serverPanel().getByText("server.example.test", { exact: true }).waitFor()
            assert.match(await serverPanel().innerText(), /CONFIGURATION ONLY; CONNECTION NOT CHECKED/)
            assert.match(await serverPanel().innerText(), /2026-10-26T06:00:00\.000Z/)
            assert.equal(await serverPanel().getByText("c".repeat(40), { exact: true }).count(), 1)
            await serverPanel().scrollIntoViewIfNeeded()
            const adminDimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
            assert.ok(adminDimensions.scroll <= adminDimensions.width + 1, "Visible ADMIN server panel must not overflow: " + JSON.stringify(adminDimensions))
            await page.screenshot({ path: path.join(output, label + "-admin-server.png") })
            for (const configurationMode of ["http", "invalid"]) {
              await page.evaluate(mode => { window.__techStackHarness.configurationMode = mode }, configurationMode)
              await serverRefresh().click(); await serverPanel().getByRole("status").waitFor()
              assert.equal(await serverPanel().getByText("server.example.test", { exact: true }).count(), 0, "A failed refresh must not retain the old hostname.")
              assert.doesNotMatch(await serverPanel().innerText(), /password|private-server-error|private-server\.example/)
            }
            await page.screenshot({ path: path.join(output, label + "-admin-server-unavailable.png") })
            for (const configurationMode of ["defer", "defer-body"]) {
              await page.evaluate(mode => { window.__techStackHarness.configurationMode = mode }, configurationMode)
              await serverRefresh().click()
              await page.waitForFunction(() => window.__techStackHarness.configurationPending.length === 1)
              assert.equal(await serverPanel().getByText("server.example.test", { exact: true }).count(), 0)
              await page.evaluate(() => {
                const h = window.__techStackHarness
                h.auth = { ...h.auth, role: "USER" }; h.render()
              })
              await page.waitForFunction(() => window.__techStackHarness.configurationPending[0].signal.aborted)
              assert.equal(await serverPanel().count(), 0, "Role downgrade immediately removes the diagnostic.")
              const reads = await page.evaluate(() => window.__techStackHarness.configurationReads)
              await page.screenshot({ path: path.join(output, label + "-viewer-no-server.png") })
              await page.evaluate(() => {
                const h = window.__techStackHarness
                h.configurationMode = "ok"; h.configurationHostname = "current.example.test"
                h.auth = { ...h.auth, role: "ADMIN", actorKey: h.auth.actorKey === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64) }; h.render()
              })
              await serverPanel().getByText("current.example.test", { exact: true }).waitFor()
              assert.equal(await page.evaluate(() => window.__techStackHarness.configurationReads), reads + 1)
              await page.evaluate(() => {
                const h = window.__techStackHarness
                h.configurationPending.shift().resolve(Response.json(h.configuration("stale.example.invalid")))
              })
              await page.waitForTimeout(30)
              assert.equal(await page.getByText("stale.example.invalid", { exact: true }).count(), 0, "Late headers/body cannot restore a previous owner's hostname.")
            }
            await page.evaluate(() => { window.__techStackHarness.configurationMode = "defer-body" })
            await serverRefresh().click()
            await page.waitForFunction(() => window.__techStackHarness.configurationPending.length === 1)
            await page.evaluate(() => {
              const h = window.__techStackHarness
              h.configurationMode = "ok"; h.configurationHostname = "replacement.example.test"
              h.auth = { ...h.auth, actorKey: "d".repeat(64) }; h.render()
            })
            await page.waitForFunction(() => window.__techStackHarness.configurationPending[0].signal.aborted)
            await serverPanel().getByText("replacement.example.test", { exact: true }).waitFor()
            await page.evaluate(() => {
              const h = window.__techStackHarness
              h.configurationPending.shift().resolve(Response.json(h.configuration("previous-admin.example.invalid")))
            })
            await page.waitForTimeout(30)
            assert.equal(await page.getByText("previous-admin.example.invalid", { exact: true }).count(), 0, "Same-role ADMIN replacement cannot reuse the previous actor's response.")
            await page.evaluate(() => {
              const h = window.__techStackHarness
              h.auth = { ...h.auth, resetRequired: true }; h.render()
            })
            await serverPanel().waitFor({ state: "detached" })
            const beforeReset = await page.evaluate(() => window.__techStackHarness.configurationReads)
            await page.evaluate(() => { window.__techStackHarness.auth = { ...window.__techStackHarness.auth, authenticated: false }; window.__techStackHarness.render() })
            await page.waitForFunction(() => window.__techStackHarness.routes.includes("/admin"))
            assert.equal(await page.getByText("replacement.example.test", { exact: true }).count(), 0)
            assert.equal(await page.evaluate(() => window.__techStackHarness.configurationReads), beforeReset)
            await page.screenshot({ path: path.join(output, label + "-signed-out-no-server.png") })
            await page.evaluate(() => {
              const h = window.__techStackHarness
              h.auth = { ...h.auth, authenticated: true, role: "USER", resetRequired: false }; h.render()
            })
            await page.getByRole("heading", { name: "CURRENT DEPLOYMENT", exact: true }).waitFor()
            assert.equal(await serverPanel().count(), 0)
            const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
            assert.ok(dimensions.scroll <= dimensions.width + 1, JSON.stringify(dimensions))
            await page.screenshot({ path: path.join(output, label + "-verified.png"), fullPage: true })
            await page.screenshot({ path: path.join(output, label + "-verified-viewport.png") })
            assert.deepEqual(errors, []); assert.deepEqual(unexpected, [])
            results.push({ engine, width, scheme, sourceTruthCopy: "view/edit pass", networkRecovery: "pass", invalidResponse: "pass", staleResponse: "ignored", signedOut: "no data", phonebookServer: "ADMIN-only; failed refresh clears; late headers/body ignored; same-role actor replacement/downgrade/reset/logout hides", adminDimensions, dimensions })
          } finally { await context.close() }
        }
      } finally { await browser.close() }
    }
    assert.equal(results.length, 12)
    const receipt = { passed: results.length, failed: 0, screenshots: output, results, limits: ["Synthetic auth and API; actual component/navigation/module/global CSS.", "The shipped admin palette is fixed light under both OS preferences.", "No physical device or production mutation."] }
    fs.writeFileSync(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2))
    console.log(JSON.stringify(receipt))
  } finally { await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => {
  const output = process.env.TECH_STACK_SCREENSHOTS
  if (output && path.isAbsolute(output) && fs.existsSync(output)) {
    fs.writeFileSync(path.join(output, "failed-receipt.json"), JSON.stringify({ passed: partialResults.length,
      failed: 1, complete: false, results: partialResults, error: error.message,
      limits: ["A partial run is not a complete desktop/mobile verification; the original failure remains fatal."] }, null, 2))
  }
  console.error(error); process.exitCode = 1
})
