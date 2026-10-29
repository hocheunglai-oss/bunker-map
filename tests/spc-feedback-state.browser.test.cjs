// Actual feedback page + navigation/global CSS. All auth and API data is synthetic.
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
  "@/lib/useSpcAuth": "export const useSpcAuth=()=>window.__spcFeedbackHarness.auth;export const clearSpcClientSessionCache=()=>{};export const primeSpcClientSessionCache=()=>{};",
  "next/navigation": "const router={push:p=>window.__spcFeedbackHarness.routes.push(p),replace:p=>window.__spcFeedbackHarness.routes.push(p),prefetch:()=>{}};export const useRouter=()=>router;export const usePathname=()=>'/spc/feedback';",
  "next/link": "import React from 'react';export default function Link({prefetch,...props}){return <a {...props}/>;}",
  "next/image": "import React from 'react';export default function Image({priority,unoptimized,fill,...props}){return <img {...props}/>;}",
}
async function main() {
  const output = process.env.SPC_FEEDBACK_SCREENSHOTS
  assert.ok(output && path.isAbsolute(output), "An owned absolute evidence directory is required.")
  fs.mkdirSync(output, { recursive: true })
  const baseline = process.argv.find(arg => arg.startsWith("--baseline-"))
  const bundle = await build({ absWorkingDir: root, entryPoints: ["tests/fixtures/spc-feedback-state.tsx"],
    bundle: true, write: false, outdir: "feedback-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "synthetic-auth", setup(builder) {
      builder.onResolve({ filter: /^(?:@\/lib\/useSpcAuth|next\/(?:navigation|link|image))$/ }, args => ({ path: args.path, namespace: "synthetic" }))
      builder.onLoad({ filter: /.*/, namespace: "synthetic" }, args => ({ contents: mocks[args.path], loader: "jsx", resolveDir: root }))
    } }],
  })
  const assets = new Map(bundle.outputFiles.map(file => ["/" + path.basename(file.path), file.contents]))
  const script = [...assets.keys()].find(name => name.endsWith(".js"))
  const css = await postcss([tailwind()]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/globals.css"></head><body><div id="root"></div><script src="' + script + '"></script></body></html>'
  const server = http.createServer((req, res) => {
    if (req.method !== "GET") { res.writeHead(405); return res.end() }
    const name = new URL(req.url, "http://127.0.0.1").pathname
    if (assets.has(name)) { res.setHeader("Content-Type", "text/javascript"); return res.end(assets.get(name)) }
    if (name === "/globals.css") { res.setHeader("Content-Type", "text/css"); return res.end(css.css) }
    const image = path.join(root, "public", name)
    if (name !== "/" && fs.existsSync(image) && fs.statSync(image).isFile()) return res.end(fs.readFileSync(image))
    if (name !== "/") { res.writeHead(404); return res.end() }
    res.setHeader("Content-Type", "text/html"); res.end(html)
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = "http://127.0.0.1:" + server.address().port, results = []
  try {
    for (const [engine, launcher] of [["chromium", chromium], ["webkit", webkit]]) {
      if (baseline && engine !== "chromium") continue
      const browser = await launcher.launch({ headless: true, ...(engine === "chromium" && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) })
      try {
        for (const width of baseline ? [390] : [320, 390, 1440]) for (const scheme of baseline ? ["light"] : ["light", "dark"]) {
          const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, colorScheme: scheme })
          try {
            const page = await context.newPage(), errors = [], external = []
            page.setDefaultTimeout(6000)
            page.on("pageerror", error => errors.push(error.message))
            await context.route("**/*", route => {
              if (new URL(route.request().url()).origin === origin) return route.continue()
              external.push(route.request().url()); return route.abort()
            })
            await page.goto(origin)
            const article = page.locator("article").first(), response = article.locator(".spc-feedback-review textarea")
            try { await response.waitFor() } catch (error) {
              await page.screenshot({ path: path.join(output, "setup-failure.png"), fullPage: true })
              fs.writeFileSync(path.join(output, "setup-failure.json"), JSON.stringify({ errors, external, body: await page.locator("body").innerText(), reads: await page.evaluate(() => window.__spcFeedbackHarness.reads) }, null, 2))
              throw error
            }
            const label = engine + "-" + width + "-" + scheme
            if (baseline === "--baseline-session") {
              await page.evaluate(() => { const h = window.__spcFeedbackHarness; h.readMode = "empty"; h.auth = { ...h.auth, role: "BUYER TRADER", username: "buyer-b@example.invalid" }; h.render() })
              await page.getByRole("heading", { name: "My Feedback", exact: true }).waitFor()
              await page.waitForTimeout(80)
              await page.screenshot({ path: path.join(output, "baseline-session.png"), fullPage: true })
              assert.equal(await page.getByRole("heading", { name: "Synthetic private issue", exact: true }).count(), 0, "A replacement user must not see the previous administrator's records.")
              console.log("Baseline session ownership assertion passed truthfully."); return
            }
            await response.fill("Captured saved review")
            await page.evaluate(() => { window.__spcFeedbackHarness.mode = "defer" })
            await article.getByRole("button", { name: "Save Review", exact: true }).click()
            await page.waitForFunction(() => window.__spcFeedbackHarness.pending.length === 1)
            await response.fill("New unsaved review while saving")
            await page.evaluate(() => {
              const h = window.__spcFeedbackHarness, p = h.pending[0]
              p.resolve(Response.json({ record: h.record({ ...p.body, updatedAt: "2026-10-16T07:00:00.123457+00:00", reviewedByDisplayName: "Synthetic Administrator" }) }))
            })
            await article.getByRole("button", { name: "Save Review", exact: true }).waitFor()
            await page.screenshot({ path: path.join(output, baseline ? "baseline-draft.png" : label + "-draft.png"), fullPage: true })
            assert.equal(await response.inputValue(), "New unsaved review while saving", "A successful acknowledgement must not erase typing made while the save was pending.")
            if (baseline) { console.log("Baseline draft ownership assertion passed truthfully."); return }
            assert.equal(await page.evaluate(() => window.__spcFeedbackHarness.writes[0].body.expectedUpdatedAt), "2026-10-16T07:00:00.123456+00:00")
            const refresh = () => page.getByRole("button", { name: /^(Refresh|Retry) Feedback$/ })
            const save = () => article.getByRole("button", { name: "Save Review", exact: true })
            const setMode = mode => page.evaluate(mode => { window.__spcFeedbackHarness.mode = mode }, mode)
            const changeSession = patch => page.evaluate(patch => {
              const h = window.__spcFeedbackHarness; h.auth = { ...h.auth, ...patch }; h.render()
            }, patch)
            // A cancelled refresh keeps the draft and makes no request.
            const count = await page.evaluate(() => window.__spcFeedbackHarness.reads)
            page.once("dialog", dialog => dialog.dismiss())
            await refresh().click()
            assert.equal(await response.inputValue(), "New unsaved review while saving")
            assert.equal(await page.evaluate(() => window.__spcFeedbackHarness.reads), count)
            page.once("dialog", dialog => dialog.accept())
            await refresh().click()
            await page.waitForFunction(() => document.querySelector(".spc-feedback-review textarea")?.value === "Original response")
            for (const mode of ["conflict", "network", "http", "invalid", "invalid-json", "wrong-id", "same-version", "backward-version", "wrong-response"]) {
              await response.fill("Retained review draft")
              await setMode(mode); await save().click()
              await page.getByRole("alert").waitFor()
              assert.equal(await response.inputValue(), "Retained review draft", mode)
              assert.equal(await page.getByRole("status").count(), 0)
              assert.doesNotMatch(await page.getByRole("alert").innerText(), /private database/i)
            }
            await page.screenshot({ path: path.join(output, label + "-conflict.png"), fullPage: true })
            page.once("dialog", dialog => dialog.accept()); await refresh().click()
            await response.waitFor()
            // Two rows retain separate request ownership and disabled states.
            await page.evaluate(() => { const h = window.__spcFeedbackHarness; h.pending = []; h.mode = "defer" })
            await response.fill("Row one review")
            await save().click()
            const second = page.locator("article").nth(1)
            await second.locator("textarea").fill("Row two review")
            await second.getByRole("button", { name: "Save Review", exact: true }).click()
            await page.waitForFunction(() => window.__spcFeedbackHarness.pending.length === 2)
            await page.evaluate(() => { const h = window.__spcFeedbackHarness, p = h.pending[0]; p.resolve(Response.json({ record: h.record({ ...p.body, updatedAt: "2026-10-16T07:00:00.123457+00:00" }) })) })
            await save().waitFor()
            assert.equal(await second.getByRole("button", { name: "Saving...", exact: true }).isDisabled(), true)
            await page.evaluate(() => { const h = window.__spcFeedbackHarness, p = h.pending[1]; p.resolve(Response.json({ record: h.record({ ...p.body, updatedAt: "2026-10-16T07:00:00.123457+00:00" }) })) })
            await second.getByRole("button", { name: "Save Review", exact: true }).waitFor()
            // Held review cannot leak into an authenticated replacement session.
            await response.fill("Old owner private draft")
            await page.evaluate(() => { const h = window.__spcFeedbackHarness; h.pending = [] })
            await save().click()
            await page.waitForFunction(() => window.__spcFeedbackHarness.pending.length === 1)
            await page.evaluate(() => { window.__spcFeedbackHarness.readMode = "empty" })
            await changeSession({ username: "buyer-b@example.invalid", role: "BUYER TRADER" })
            await page.getByText("No feedback yet.", { exact: true }).waitFor()
            await page.evaluate(() => { const h = window.__spcFeedbackHarness, p = h.pending[0]; p.resolve(Response.json({ record: h.record({ ...p.body, updatedAt: "2026-10-16T07:00:01Z" }) })) })
            await page.waitForTimeout(50)
            assert.equal(await page.locator("article").count(), 0)
            assert.equal(await page.evaluate(() => window.__spcFeedbackHarness.pending[0].signal.aborted), true)
            await page.screenshot({ path: path.join(output, label + "-buyer-empty.png"), fullPage: true })
            // Two synchronous submits before React commits can issue only one POST.
            await page.locator(".spc-feedback-title input").fill("Captured submission")
            await page.locator(".spc-feedback-message textarea").fill("Captured details")
            await page.evaluate(() => { const h = window.__spcFeedbackHarness; h.pending = []; h.mode = "defer" })
            const beforeWrites = await page.evaluate(() => window.__spcFeedbackHarness.writes.length)
            await page.locator("form").evaluate(form => { form.requestSubmit(); form.requestSubmit() })
            await page.waitForFunction(() => window.__spcFeedbackHarness.pending.length === 1)
            assert.equal(await page.evaluate(() => window.__spcFeedbackHarness.writes.length), beforeWrites + 1)
            await changeSession({ username: "buyer-c@example.invalid" })
            await page.getByText("No feedback yet.", { exact: true }).waitFor()
            await page.locator(".spc-feedback-title input").fill("New owner's draft")
            await page.evaluate(() => { const h = window.__spcFeedbackHarness, p = h.pending[0]; p.resolve(Response.json({ record: h.record({ ...p.body, id: "ffffffff-ffff-4fff-8fff-ffffffffffff", status: "NEW", adminResponse: "", createdByUsername: "buyer-b@example.invalid" }) }, { status: 201 })) })
            await page.waitForTimeout(50)
            assert.equal(await page.locator(".spc-feedback-title input").inputValue(), "New owner's draft")
            assert.equal(await page.locator("article").count(), 0)
            // Initial reads are fail-closed, not fabricated zero/empty results.
            for (const mode of ["network", "http", "invalid", "invalid-json"]) {
              await page.evaluate(mode => { window.__spcFeedbackHarness.readMode = mode }, mode)
              await changeSession({ username: mode + "@example.invalid", role: "ADMIN" })
              await page.getByRole("alert").waitFor()
              assert.equal(await page.getByText("No feedback yet.", { exact: true }).count(), 0)
              assert.equal(await page.getByText("0 records", { exact: true }).count(), 0)
              assert.equal(await page.getByRole("button", { name: "Send Feedback", exact: true }).isDisabled(), true)
            }
            await page.screenshot({ path: path.join(output, label + "-unavailable.png"), fullPage: true })
            await page.evaluate(() => { const h = window.__spcFeedbackHarness; h.readMode = "ok"; h.mode = "ok" })
            await refresh().click(); await response.waitFor()
            // ADMIN with View can read but neither edit nor issue a review.
            await changeSession({ permissions: { "spc-feedback": "view" } })
            await response.waitFor()
            assert.equal(await response.isDisabled(), true); assert.equal(await save().isDisabled(), true)
            assert.equal(await page.getByRole("button", { name: "Send Feedback", exact: true }).isDisabled(), true)
            await page.screenshot({ path: path.join(output, label + "-view-only.png"), fullPage: true })
            const readsBeforeEditSession = await page.evaluate(() => window.__spcFeedbackHarness.reads)
            await changeSession({ permissions: { "spc-feedback": "edit" } })
            // React may not have committed the keyed replacement yet. The old
            // view-only textarea is still visible until it does, so wait for
            // the new edit session's completed initial read before holding GETs.
            await page.waitForFunction(previousReads => {
              const response = document.querySelector(".spc-feedback-review textarea")
              const refresh = [...document.querySelectorAll("button")].find(button => button.textContent === "Refresh Feedback")
              return window.__spcFeedbackHarness.reads > previousReads && response?.disabled === false && refresh?.disabled === false
            }, readsBeforeEditSession)
            await response.waitFor()
            // A held GET is ignored after another authenticated identity loads.
            await page.evaluate(() => { const h = window.__spcFeedbackHarness; h.readMode = "defer"; h.pending = [] })
            await refresh().click()
            await page.waitForFunction(() => window.__spcFeedbackHarness.pending.length === 1)
            await page.evaluate(() => { window.__spcFeedbackHarness.readMode = "empty" })
            await changeSession({ username: "new-viewer@example.invalid" })
            await page.getByText("No feedback yet.", { exact: true }).waitFor()
            await page.evaluate(() => { const h = window.__spcFeedbackHarness; h.pending[0].resolve(Response.json({ records: [h.record()] })) })
            await page.waitForTimeout(50)
            assert.equal(await page.locator("article").count(), 0)
            // Actual 401/403 responses clear verified private data and drafts.
            for (const mode of ["unauthorized", "denied"]) {
              await page.evaluate(() => { window.__spcFeedbackHarness.readMode = "ok" })
              await refresh().click(); await response.waitFor()
              await page.evaluate(mode => { window.__spcFeedbackHarness.readMode = mode }, mode)
              await refresh().click(); await page.getByRole("alert").waitFor()
              assert.equal(await page.locator("article").count(), 0)
              assert.match(await page.getByRole("alert").innerText(), /access/i)
            }
            // A hung transport is bounded and late results cannot resurrect it.
            await page.clock.install()
            await page.evaluate(() => { const h = window.__spcFeedbackHarness; h.readMode = "defer"; h.pending = [] })
            await refresh().click()
            await page.waitForFunction(() => window.__spcFeedbackHarness.pending.length === 1)
            await page.clock.runFor(30_001)
            await page.getByRole("alert").waitFor()
            assert.equal(await refresh().isDisabled(), false)
            await page.evaluate(() => { const h = window.__spcFeedbackHarness; h.pending[0].resolve(Response.json({ records: [h.record()] })) })
            await page.waitForTimeout(50)
            assert.equal(await page.locator("article").count(), 0)
            await page.evaluate(() => { const h = window.__spcFeedbackHarness; h.readMode = "ok"; h.mode = "defer"; h.pending = [] })
            await refresh().click(); await response.waitFor()
            await response.fill("Timeout review draft")
            await save().click()
            await page.waitForFunction(() => window.__spcFeedbackHarness.pending.length === 1)
            await page.clock.runFor(30_001)
            await page.getByRole("alert").waitFor()
            assert.equal(await response.inputValue(), "Timeout review draft")
            assert.equal(await save().isDisabled(), false)
            await page.evaluate(() => { const h = window.__spcFeedbackHarness, p = h.pending[0]; p.resolve(Response.json({ record: h.record({ ...p.body, updatedAt: "2026-10-16T07:00:01Z" }) })) })
            await page.waitForTimeout(50)
            assert.equal(await response.inputValue(), "Timeout review draft")
            assert.equal(await page.getByRole("status").count(), 0)
            await page.locator(".spc-feedback-title input").fill("Timeout submission draft")
            await page.locator(".spc-feedback-message textarea").fill("Timeout submission details")
            await page.evaluate(() => { window.__spcFeedbackHarness.pending = [] })
            await page.getByRole("button", { name: "Send Feedback", exact: true }).click()
            await page.waitForFunction(() => window.__spcFeedbackHarness.pending.length === 1)
            await page.clock.runFor(30_001)
            await page.getByRole("alert").waitFor()
            assert.equal(await page.locator(".spc-feedback-title input").inputValue(), "Timeout submission draft")
            assert.equal(await page.getByRole("button", { name: "Send Feedback", exact: true }).isDisabled(), true)
            await page.screenshot({ path: path.join(output, label + "-timeout.png"), fullPage: true })
            const uncertainWrites = await page.evaluate(() => window.__spcFeedbackHarness.writes.length)
            await page.locator("form").evaluate(form => { form.requestSubmit(); form.requestSubmit() })
            await page.waitForTimeout(50)
            assert.equal(await page.evaluate(() => window.__spcFeedbackHarness.writes.length), uncertainWrites, "An uncertain submission cannot be sent again immediately.")
            // The original response may arrive after the deadline. It must not
            // clear the draft or unlock Send; only a verified refresh does that.
            await page.evaluate(() => {
              const h = window.__spcFeedbackHarness, p = h.pending[0]
              p.resolve(Response.json({ record: h.record({ ...p.body, id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
                createdByUsername: h.auth.username, adminResponse: "", status: "NEW" }) }, { status: 201 }))
            })
            await page.waitForTimeout(50)
            assert.equal(await page.getByRole("button", { name: "Send Feedback", exact: true }).isDisabled(), true)
            assert.equal(await page.locator(".spc-feedback-title input").inputValue(), "Timeout submission draft")
            page.once("dialog", dialog => dialog.accept())
            await page.evaluate(() => { window.__spcFeedbackHarness.readMode = "network" })
            await refresh().click()
            await page.getByRole("alert").waitFor()
            assert.equal(await page.getByRole("button", { name: "Send Feedback", exact: true }).isDisabled(), true, "A failed refresh must not unlock an uncertain submission.")
            await page.locator("form").evaluate(form => form.requestSubmit())
            assert.equal(await page.evaluate(() => window.__spcFeedbackHarness.writes.length), uncertainWrites)
            await page.evaluate(() => { window.__spcFeedbackHarness.readMode = "ok" })
            await refresh().click(); await response.waitFor()
            assert.equal(await page.getByRole("button", { name: "Send Feedback", exact: true }).isDisabled(), false)
            assert.equal(await page.locator(".spc-feedback-title input").inputValue(), "Timeout submission draft")
            assert.match(await page.getByRole("status").innerText(), /check the list.*before sending/i)
            await page.screenshot({ path: path.join(output, label + "-refreshed-kept-draft.png"), fullPage: true })
            // Other uncertain outcomes use the same refresh gate, not only timeout.
            for (const mode of ["network", "http", "invalid", "invalid-json", "wrong-response"]) {
              await setMode(mode)
              await page.getByRole("button", { name: "Send Feedback", exact: true }).click()
              await page.getByRole("alert").waitFor()
              assert.equal(await page.getByRole("button", { name: "Send Feedback", exact: true }).isDisabled(), true, mode)
              const writes = await page.evaluate(() => window.__spcFeedbackHarness.writes.length)
              await page.locator("form").evaluate(form => form.requestSubmit())
              assert.equal(await page.evaluate(() => window.__spcFeedbackHarness.writes.length), writes)
              await refresh().click()
              await page.getByRole("status").waitFor()
              assert.equal(await page.getByRole("button", { name: "Send Feedback", exact: true }).isDisabled(), false)
              assert.equal(await page.locator(".spc-feedback-title input").inputValue(), "Timeout submission draft")
            }
            await changeSession({ authenticated: false })
            await page.waitForFunction(() => window.__spcFeedbackHarness.routes.includes("/spc"))
            assert.equal(await page.locator("main").count(), 0)
            await page.screenshot({ path: path.join(output, label + "-signed-out.png"), fullPage: true })
            await changeSession({ authenticated: true, permissions: { "spc-feedback": "none" } })
            const deniedReads = await page.evaluate(() => window.__spcFeedbackHarness.reads)
            await page.waitForTimeout(50)
            assert.equal(await page.evaluate(() => window.__spcFeedbackHarness.reads), deniedReads)
            await page.evaluate(() => { const h = window.__spcFeedbackHarness; h.readMode = "ok"; h.mode = "ok" })
            await changeSession({ permissions: { "spc-feedback": "edit" } })
            await response.waitFor()
            await page.screenshot({ path: path.join(output, label + "-verified.png"), fullPage: true })
            const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
            assert.ok(dimensions.scroll <= dimensions.width + 1, JSON.stringify(dimensions))
            const heading = page.getByRole("heading", { name: "All Feedback", exact: true })
            const geometry = await heading.boundingBox(), buttonBox = await refresh().boundingBox()
            assert.ok(geometry.y + geometry.height <= buttonBox.y || geometry.x + geometry.width <= buttonBox.x || buttonBox.x + buttonBox.width <= geometry.x, "Refresh must not overlap the heading.")
            assert.deepEqual(errors, []); assert.deepEqual(external, [])
            results.push({ engine, width, scheme, dimensions, draftRace: "preserved", sessionRace: "ignored",
              malformedAck: "rejected", pendingRows: "independent", duplicateSubmit: "one POST", uncertainSubmission: "blocked until verified refresh", deadlines: "GET/POST/PATCH bounded",
              viewGuard: "read-only", failedRead: "no false empty", signedOut: "cleared" })
          } catch (error) {
            fs.writeFileSync(path.join(output, "failure.json"), JSON.stringify({ baseline: baseline || null, engine, width, scheme, message: error.message, stack: error.stack }, null, 2))
            throw error
          } finally { await context.close() }
        }
      } finally { await browser.close() }
    }
    assert.equal(results.length, 12)
    fs.writeFileSync(path.join(output, "receipt.json"), JSON.stringify({ passed: results.length, failed: 0, results, limits: ["Actual page/navigation/global CSS, synthetic API/auth only.", "No physical device, personal browser or live data tested."] }, null, 2))
    console.log(JSON.stringify({ passed: results.length, failed: 0 }))
  } finally { await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
