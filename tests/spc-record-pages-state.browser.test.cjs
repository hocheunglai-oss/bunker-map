// Actual pages, navigation and global CSS. Only auth/HTTP are synthetic.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http")
const { build } = require("esbuild"), postcss = require("postcss"), tailwind = require("@tailwindcss/postcss")
const { chromium, webkit } = require("playwright"), root = path.resolve(__dirname, "..")
const mocks = {
  "@/lib/useSpcAuth": "export const useSpcAuth=()=>window.__spcRecordPagesHarness.auth;export const clearSpcClientSessionCache=()=>{};export const primeSpcClientSessionCache=()=>{};",
  "next/navigation": "const router={push:p=>window.__spcRecordPagesHarness.routes.push(p),replace:p=>window.__spcRecordPagesHarness.routes.push(p),prefetch:()=>{}};export const useRouter=()=>router;export const usePathname=()=>'/spc/'+(window.__spcRecordPagesHarness.kind==='lost'?'lost-record':'today-enquiries');",
  "next/link": "import React from 'react';export default function Link({prefetch,...props}){return <a {...props}/>;}",
  "next/image": "import React from 'react';export default function Image({priority,unoptimized,fill,...props}){return <img {...props}/>;}",
}
async function main() {
  const output = process.env.SPC_RECORD_PAGES_SCREENSHOTS
  assert.ok(output && path.isAbsolute(output), "Use an owned absolute evidence directory.")
  fs.mkdirSync(output, { recursive: true })
  const baseline = process.argv.includes("--baseline-invalid")
  const dateOnly = process.argv.includes("--timezone-date")
  const baselineTimezone = process.argv.includes("--baseline-timezone")
  assert.ok(!baselineTimezone || dateOnly, "Timezone baseline is a focused control only.")
  const bundle = await build({ absWorkingDir: root, entryPoints: ["tests/fixtures/spc-record-pages-state.tsx"],
    bundle: true, write: false, outdir: "record-page-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' }, plugins: [{ name: "synthetic-auth", setup(builder) {
      // Focused RED control: remove ONLY the one-line date formatter correction
      // in the in-memory bundle. The actual page/DOM/CSS stay otherwise intact.
      if (baselineTimezone) builder.onLoad({ filter: /app\/spc\/lost-record\/page\.tsx$/ }, args => {
        const contents = fs.readFileSync(args.path, "utf8"), correction = '    timeZone: "Asia/Hong_Kong",\n'
        assert.ok(contents.includes(correction), "The focused baseline must remove the exact HKT correction.")
        return { contents: contents.replace(correction, ""), loader: "tsx", resolveDir: path.dirname(args.path) }
      })
      builder.onResolve({ filter: /^(?:@\/lib\/useSpcAuth|next\/(?:navigation|link|image))$/ }, args => ({ path: args.path, namespace: "synthetic" }))
      builder.onLoad({ filter: /.*/, namespace: "synthetic" }, args => ({ contents: mocks[args.path], loader: "jsx", resolveDir: root }))
    } }] })
  const assets = new Map(bundle.outputFiles.map(file => ["/" + path.basename(file.path), file.contents]))
  const script = [...assets.keys()].find(file => file.endsWith(".js"))
  const pageStyles = [...assets.keys()].filter(file => file.endsWith(".css")).map(file => '<link rel="stylesheet" href="' + file + '">').join("")
  const css = await postcss([tailwind()]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1")
    if (req.method !== "GET") { res.writeHead(405); return res.end() }
    if (assets.has(url.pathname)) { res.setHeader("Content-Type", url.pathname.endsWith(".css") ? "text/css" : "text/javascript"); return res.end(assets.get(url.pathname)) }
    if (url.pathname === "/globals.css") { res.setHeader("Content-Type", "text/css"); return res.end(css.css) }
    const image = path.join(root, "public", url.pathname)
    if (fs.existsSync(image) && fs.statSync(image).isFile()) return res.end(fs.readFileSync(image))
    res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/globals.css">' + pageStyles + '</head><body><div id="root"></div><script src="' + script + '"></script></body></html>')
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = "http://127.0.0.1:" + server.address().port, results = []
  try {
    if (dateOnly) {
      for (const [engine, launcher] of [["chromium", chromium], ["webkit", webkit]]) {
        const browser = await launcher.launch({ headless: true })
        try { for (const timezoneId of ["America/Los_Angeles", "Asia/Hong_Kong"]) {
          const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId })
          try {
            await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
            const page = await context.newPage()
            await page.clock.install({ time: new Date("2026-10-16T01:02:03.123Z") })
            await page.goto(origin + "/?kind=lost")
            const row = () => page.locator(".spc-lost-record-table tbody tr").nth(1).locator("td")
            await page.getByText("FIRST VESSEL 1", { exact: true }).waitFor()
            const timestampDate = await row().first().innerText(), eta = await row().nth(4).innerText()
            const prefix = engine + "-" + timezoneId.replaceAll("/", "-")
            await page.screenshot({ path: path.join(output, prefix + "-timestamp.png") })
            await page.evaluate(() => { window.__spcRecordPagesHarness.outcomeDate = "2026-10-20" })
            await page.getByRole("button", { name: "REFRESH", exact: true }).click()
            await page.waitForFunction(() => ![...document.querySelectorAll("button")].some(button => button.textContent === "REFRESHING..."))
            const outcomeDate = await row().first().innerText()
            await page.screenshot({ path: path.join(output, prefix + "-date-only.png") })
            results.push({ engine, timezoneId, timestampDate, outcomeDate, eta })
          } finally { await context.close() }
        } } finally { await browser.close() }
      }
      fs.writeFileSync(path.join(output, "timezone-results.json"), JSON.stringify({ baselineTimezone, results, cleanup: "All owned browser contexts and browsers closed; loopback server closed in finally." }, null, 2))
      for (const result of results) {
        assert.equal(result.timestampDate, "16 OCT 2026", JSON.stringify(result))
        assert.equal(result.outcomeDate, "20 OCT 2026", JSON.stringify(result))
        assert.equal(result.eta, "2026-10-20", JSON.stringify(result))
      }
      console.log("Actual Lost page dates verified in Chromium/WebKit × Los Angeles/Hong Kong; date-only ETA unchanged.")
      return
    }
    for (const [engine, launcher] of [["chromium", chromium], ["webkit", webkit]]) {
      if (baseline && engine !== "chromium") continue
      const browser = await launcher.launch({ headless: true, ...(engine === "chromium" && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) })
      try { for (const width of baseline ? [390] : [320, 390, 1440]) for (const scheme of baseline ? ["light"] : ["light", "dark"]) {
        const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, colorScheme: scheme, timezoneId: "America/Los_Angeles" })
        try {
          const page = await context.newPage(), errors = [], external = []
          await page.clock.install({ time: new Date("2026-10-16T01:02:03.123Z") })
          page.setDefaultTimeout(7000); page.on("pageerror", error => errors.push(error.message))
          await context.route("**/*", route => { if (new URL(route.request().url()).origin === origin) return route.continue(); external.push(route.request().url()); return route.abort() })
          const refresh = () => page.getByRole("button", { name: /^REFRESH(?:ING\.\.\.)?$/ })
          const screenshot = async suffix => {
            const bounds = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
            assert.ok(bounds.scroll <= bounds.width + 1, JSON.stringify(bounds))
            await page.screenshot({ path: path.join(output, engine + "-" + width + "-" + scheme + "-" + suffix + ".png"), fullPage: false })
          }
          await page.goto(origin + "/?kind=today")
          await page.getByText("FIRST VESSEL 1 / SINGAPORE / VLSFO 500MTS", { exact: true }).waitFor()
          assert.ok(await page.evaluate(() => window.__spcRecordPagesHarness.requests.filter(r => r.path === "/api/spc/today-enquiries").length >= 2), "StrictMode must exercise setup, cleanup, and a fresh owned read.")
          await page.evaluate(() => { window.__spcRecordPagesHarness.readMode = "invalid" })
          await refresh().click(); await page.waitForTimeout(80)
          if (baseline) {
            await screenshot("baseline-invalid")
            fs.writeFileSync(path.join(output, "baseline-invalid.json"), JSON.stringify({ body: await page.locator("body").innerText(), requests: await page.evaluate(() => window.__spcRecordPagesHarness.requests) }, null, 2))
            assert.equal(await page.getByText("No enquiries received today.", { exact: true }).count(), 0, "Malformed HTTP success must not become a verified empty list.")
            console.log("Baseline malformed-response assertion passed truthfully."); return
          }
          assert.equal(await page.getByText("No enquiries received today.", { exact: true }).count(), 0)
          assert.equal(await page.getByText("FIRST VESSEL 1 / SINGAPORE / VLSFO 500MTS", { exact: true }).count(), 1)
          await screenshot("today-invalid")
          const set = patch => page.evaluate(patch => Object.assign(window.__spcRecordPagesHarness, patch), patch)
          const next = () => page.getByRole("button", { name: "NEXT PAGE", exact: true })
          const previous = () => page.getByRole("button", { name: "PREVIOUS PAGE", exact: true })
          const verifyRows = () => page.getByText("FIRST VESSEL 1 / SINGAPORE / VLSFO 500MTS", { exact: true }).waitFor()
          const recordReads = () => page.evaluate(() => window.__spcRecordPagesHarness.requests.filter(r => r.method === "GET" && !r.path.includes("lost-reasons")).length)
          for (const readMode of ["network", "json", "http", "conflict"]) {
            await set({ readMode }); await refresh().click(); await page.getByRole("alert").waitFor()
            assert.equal(await page.getByText("FIRST VESSEL 1 / SINGAPORE / VLSFO 500MTS", { exact: true }).count(), 1)
            assert.doesNotMatch(await page.getByRole("alert").innerText(), /private database/i)
          }
          await set({ readMode: "ok", total: 251 }); await refresh().click()
          await page.getByText("251 enquiries · Page 1 of 2 · 250 on this page", { exact: true }).waitFor()
          await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => { window.__copiedRecordText = value } } }))
          await page.getByRole("button", { name: "SELECT THIS PAGE", exact: true }).click()
          await page.getByRole("button", { name: "COPY SELECTED ON THIS PAGE", exact: true }).click()
          assert.equal((await page.evaluate(() => window.__copiedRecordText)).split("\n\n").length, 250)
          await next().press("Enter"); await page.getByText("251 enquiries · Page 2 of 2 · 1 on this page", { exact: true }).waitFor()
          assert.equal(await page.getByText("0 SELECTED ON THIS PAGE", { exact: true }).count(), 1)
          assert.equal(await next().isDisabled(), true)
          await previous().press("Enter"); await page.getByText("251 enquiries · Page 1 of 2 · 250 on this page", { exact: true }).waitFor()
          const lastColumn = async suffix => {
            await page.locator(".spc-table-wrap").evaluate(node => { node.scrollLeft = node.scrollWidth })
            assert.ok(await page.locator(".spc-table thead th").last().evaluate(node => {
              const cell = node.getBoundingClientRect(), wrap = node.closest(".spc-table-wrap").getBoundingClientRect()
              return cell.right <= wrap.right + 1 && cell.right > wrap.left && cell.left < wrap.right
            }), "The final column must be reachable inside the table scroll region.")
            await screenshot(suffix)
            await page.locator(".spc-table-wrap").evaluate(node => { node.scrollLeft = 0 })
          }
          await lastColumn("today-final-column")
          await set({ readMode: "conflict" }); await next().click(); await page.getByRole("alert").waitFor()
          assert.equal(await page.getByText("251 enquiries · Page 1 of 2 · 250 on this page", { exact: true }).count(), 1)
          await screenshot("today-pagination-conflict")
          await set({ readMode: "ok", revision: "b".repeat(64), total: 2 }); await refresh().click(); await verifyRows()
          // Held old-owner read must not replace the new actor's verified page.
          await set({ readMode: "defer" }); await refresh().click()
          await page.waitForFunction(() => window.__spcRecordPagesHarness.pending.length === 1)
          const oldPage = await page.evaluate(() => window.__spcRecordPagesHarness.page())
          await page.evaluate(() => { const h = window.__spcRecordPagesHarness; h.readMode = "ok"; h.auth = { ...h.auth, username: "second@example.invalid", actorKey: "b".repeat(64) }; h.render() })
          await page.getByText("SECOND VESSEL 1 / SINGAPORE / VLSFO 500MTS", { exact: true }).waitFor()
          await page.evaluate(oldPage => window.__spcRecordPagesHarness.pending.shift().resolve(Response.json(oldPage)), oldPage)
          await page.waitForTimeout(40)
          assert.equal(await page.getByText("FIRST VESSEL 1 / SINGAPORE / VLSFO 500MTS", { exact: true }).count(), 0)
          // A denied response clears rows immediately, without parsing HTML.
          await set({ readMode: "denied" }); await refresh().click(); await page.getByRole("alert").waitFor()
          assert.equal(await page.getByText("SECOND VESSEL 1 / SINGAPORE / VLSFO 500MTS", { exact: true }).count(), 0)
          await screenshot("today-denied")
          await page.goto(origin + "/?kind=today"); await verifyRows()
          await set({ readMode: "unauthorized" }); await refresh().click(); await page.getByRole("alert").waitFor()
          assert.equal(await page.getByText("FIRST VESSEL 1 / SINGAPORE / VLSFO 500MTS", { exact: true }).count(), 0)
          await screenshot("today-unauthorized")
          await page.goto(origin + "/?kind=today&read=invalid"); await page.getByRole("alert").waitFor()
          assert.equal(await page.locator(".spc-fixture-empty-row").count(), 0)
          await set({ readMode: "ok", total: 0 }); await refresh().click(); await page.getByText("No enquiries received on 2026-10-16.", { exact: true }).waitFor()
          await screenshot("today-verified-empty")
          // Full fetch and body deadlines recover, and ignored abort/late results stay stale.
          for (const readMode of ["defer", "body-defer"]) {
            await page.goto(origin + "/?kind=today"); await verifyRows()
            await set({ readMode }); await refresh().click()
            await page.waitForFunction(() => window.__spcRecordPagesHarness.pending.length === 1)
            await page.clock.fastForward(30_100)
            await page.getByRole("alert").waitFor(); assert.match(await page.getByRole("alert").innerText(), /timed out/i)
            assert.equal(await refresh().isDisabled(), false)
            await set({ readMode: "ok", total: 1 }); await refresh().click(); await page.getByText("1 enquiries · Page 1 of 1 · 1 on this page", { exact: true }).waitFor()
            await page.evaluate(() => { const h = window.__spcRecordPagesHarness; h.total = 2; h.pending.shift().resolve(Response.json(h.page())) })
            await page.clock.fastForward(10)
            assert.equal(await page.getByText("1 enquiries · Page 1 of 1 · 1 on this page", { exact: true }).count(), 1)
            await screenshot("today-" + readMode + "-recovered"); await page.clock.resume()
          }
          // Hong Kong midnight, while the browser still has the previous local
          // calendar date, resets page 2 to page 1 without resending its cursor.
          await page.goto(origin + "/?kind=today"); await verifyRows()
          await set({ total: 251 }); await refresh().click()
          await page.getByText("251 enquiries · Page 1 of 2 · 250 on this page", { exact: true }).waitFor()
          await next().press("Enter")
          await page.getByText("251 enquiries · Page 2 of 2 · 1 on this page", { exact: true }).waitFor()
          await set({ day: "2026-10-17", checkedAt: "2026-10-16T16:00:01Z", revision: "c".repeat(64) })
          await page.clock.setSystemTime(new Date("2026-10-16T16:00:01Z")); await page.clock.fastForward(15_100)
          await page.getByText("251 enquiries · Page 1 of 2 · 250 on this page", { exact: true }).waitFor()
          assert.equal(await page.evaluate(() => window.__spcRecordPagesHarness.requests.filter(r => r.path === "/api/spc/today-enquiries").at(-1).cursor), null)
          await screenshot("today-hk-rollover")
          await page.clock.setSystemTime(new Date("2026-10-16T01:02:03.123Z"))

          await page.goto(origin + "/?kind=lost")
          const comments = () => page.getByPlaceholder("ADD SPC COMMENT", { exact: true })
          const save = () => page.getByRole("button", { name: "SAVE", exact: true }).first()
          await comments().first().waitFor(); await page.waitForFunction(() => !document.querySelector('input[placeholder="ADD SPC COMMENT"]').disabled)
          await screenshot("lost-verified")
          assert.equal(await page.locator(".spc-lost-record-table tbody tr").nth(1).locator("td").first().innerText(), "16 OCT 2026", "Lost timestamp dates must follow HKT, not the device timezone.")
          assert.equal(await page.locator(".spc-lost-record-table tbody tr").nth(1).locator("td").nth(4).innerText(), "2026-10-20", "Date-only ETA must retain its date-only semantics.")
          await lastColumn("lost-final-column")
          // Reason-list drafts have independent ownership and survive record refresh.
          await page.getByRole("button", { name: "EDIT LOST REASONS", exact: true }).click()
          await page.getByRole("dialog").locator("textarea").first().fill("PRICE\nKEPT REASON DRAFT")
          page.once("dialog", dialog => dialog.accept()); await page.getByRole("button", { name: "DONE", exact: true }).click()
          await refresh().click(); await comments().first().waitFor()
          await page.getByRole("button", { name: "EDIT LOST REASONS", exact: true }).click()
          assert.equal(await page.getByRole("dialog").locator("textarea").first().inputValue(), "PRICE\nKEPT REASON DRAFT")
          page.once("dialog", dialog => dialog.accept()); await page.getByRole("button", { name: "DONE", exact: true }).click()
          await set({ total: 251 }); await refresh().click(); await page.getByText("251 lost enquiries · Page 1 of 2 · 250 on this page", { exact: true }).waitFor()
          await comments().first().fill("KEEP MY UNSAVED REVIEW")
          const reads = await recordReads()
          page.once("dialog", dialog => dialog.dismiss()); await next().click()
          assert.equal(await recordReads(), reads); assert.equal(await comments().first().inputValue(), "KEEP MY UNSAVED REVIEW")
          page.once("dialog", dialog => dialog.accept()); await next().click(); await page.getByText("251 lost enquiries · Page 2 of 2 · 1 on this page", { exact: true }).waitFor()
          assert.equal(await comments().first().inputValue(), "")
          await previous().click(); await page.getByText("251 lost enquiries · Page 1 of 2 · 250 on this page", { exact: true }).waitFor()
          await set({ total: 2 }); await refresh().click(); await page.getByText("2 lost enquiries · Page 1 of 1 · 2 on this page", { exact: true }).waitFor()
          await comments().nth(1).fill("OTHER ROW DRAFT MUST STAY")
          await comments().first().fill("CAPTURED REVIEW")
          await save().click(); await page.waitForFunction(() => window.__spcRecordPagesHarness.pending.length === 1)
          assert.equal(await refresh().isDisabled(), true); assert.equal(await next().isDisabled(), true)
          assert.equal(await comments().nth(1).isDisabled(), true)
          await page.evaluate(() => { const a = document.createElement("a"); a.href = "/synthetic-leave"; a.id = "synthetic-navigation"; a.textContent = "Test navigation"; document.body.appendChild(a) })
          await page.locator("#synthetic-navigation").click()
          assert.equal(new URL(page.url()).pathname, "/", "Pending review must block document navigation.")
          await page.locator("#synthetic-navigation").evaluate(node => node.remove())
          const captured = await page.evaluate(() => window.__spcRecordPagesHarness.pending[0].body)
          assert.equal(captured.expectedUpdatedAt, "2026-10-16T01:02:03.123456Z")
          await page.evaluate(() => { const h = window.__spcRecordPagesHarness, p = h.pending.shift(); p.resolve(Response.json({ success: true, review: { id: p.body.id, updatedAt: "2026-10-16T01:02:03.123457Z", meta: { lostReason: "PRICE", supplierLostReason: "", supplierLostReasonDetails: "", spcComments: p.body.spcComments } } })) })
          await page.getByText("A record was updated. Refresh before changing pages. Other unsaved drafts are kept.", { exact: true }).waitFor()
          assert.equal(await comments().nth(1).inputValue(), "OTHER ROW DRAFT MUST STAY")
          assert.equal(await next().isDisabled(), true); assert.equal(await previous().isDisabled(), true)
          await screenshot("lost-saved-other-draft")
          page.once("dialog", dialog => dialog.dismiss()); await refresh().click(); assert.equal(await comments().nth(1).inputValue(), "OTHER ROW DRAFT MUST STAY")
          page.once("dialog", dialog => dialog.accept()); await refresh().click(); await page.waitForFunction(() => document.querySelectorAll('input[placeholder="ADD SPC COMMENT"]')[1]?.value === "")
          await comments().first().fill("CONFLICT DRAFT")
          await set({ writeMode: "conflict" }); await save().click(); await page.getByRole("alert").waitFor()
          assert.equal(await comments().first().inputValue(), "CONFLICT DRAFT"); await screenshot("lost-conflict")
          assert.equal(await save().isDisabled(), true)
          await set({ readMode: "invalid" }); page.once("dialog", dialog => dialog.accept()); await refresh().press("Enter"); await page.getByRole("alert").waitFor()
          assert.equal(await save().isDisabled(), true); assert.equal(await comments().first().inputValue(), "CONFLICT DRAFT")
          await set({ readMode: "ok" }); page.once("dialog", dialog => dialog.accept()); await refresh().click()
          await page.waitForFunction(() => document.querySelector('input[placeholder="ADD SPC COMMENT"]')?.value === "")
          // Malformed successful mutation ACK cannot advance the captured baseline.
          await comments().first().fill("MALFORMED ACK DRAFT")
          await set({ writeMode: "defer" }); await save().click(); await page.waitForFunction(() => window.__spcRecordPagesHarness.pending.length === 1)
          await page.evaluate(() => { const p = window.__spcRecordPagesHarness.pending.shift(); p.resolve(Response.json({ success: true, review: { id: p.body.id, updatedAt: p.body.expectedUpdatedAt, meta: { spcComments: p.body.spcComments } } })) })
          await page.getByRole("alert").waitFor(); assert.equal(await comments().first().inputValue(), "MALFORMED ACK DRAFT")
          assert.equal(await save().isDisabled(), true)
          page.once("dialog", dialog => dialog.accept()); await refresh().click(); await page.waitForFunction(() => document.querySelector('input[placeholder="ADD SPC COMMENT"]')?.value === "")
          await comments().first().fill("TIMEOUT DRAFT")
          await save().click(); await page.waitForFunction(() => window.__spcRecordPagesHarness.pending.length === 1)
          await page.clock.fastForward(30_100); await page.getByRole("alert").waitFor()
          assert.match(await page.getByRole("alert").innerText(), /timed out/i)
          assert.equal(await comments().first().inputValue(), "TIMEOUT DRAFT"); assert.equal(await refresh().isDisabled(), false)
          assert.equal(await save().isDisabled(), true)
          await set({ readMode: "invalid" }); page.once("dialog", dialog => dialog.accept()); await refresh().click(); await page.getByRole("alert").waitFor()
          assert.equal(await save().isDisabled(), true); assert.equal(await comments().first().inputValue(), "TIMEOUT DRAFT")
          await screenshot("lost-timeout")
          await set({ readMode: "ok" })
          page.once("dialog", dialog => dialog.accept()); await refresh().click(); await page.waitForFunction(() => document.querySelector('input[placeholder="ADD SPC COMMENT"]')?.value === "")
          await page.evaluate(() => { const h = window.__spcRecordPagesHarness, p = h.pending.shift(); p.resolve(Response.json({ success: true, review: { id: p.body.id, updatedAt: "2026-10-16T01:02:03.123457Z", meta: { spcComments: "LATE TIMEOUT ACK" } } })) })
          await page.waitForTimeout(30); assert.equal(await comments().first().inputValue(), "")
          await comments().first().fill("OLD ACTOR DRAFT")
          await set({ writeMode: "defer" }); await save().click(); await page.waitForFunction(() => window.__spcRecordPagesHarness.pending.length === 1)
          // A captured PATCH response cannot update a replacement actor's page/drafts.
          await page.evaluate(() => { const h = window.__spcRecordPagesHarness; h.auth = { ...h.auth, username: "second@example.invalid", actorKey: "b".repeat(64) }; h.render() })
          await page.getByText("SECOND VESSEL 1", { exact: true }).waitFor()
          await page.evaluate(() => { const h = window.__spcRecordPagesHarness, p = h.pending.shift(); p.resolve(Response.json({ success: true, review: { id: p.body.id, updatedAt: "2026-10-16T01:02:03.123457Z", meta: { spcComments: "OLD ACTOR ACK" } } })) })
          await page.waitForTimeout(40); assert.equal(await comments().first().inputValue(), "")
          assert.equal(await page.getByText("Lost record updated.", { exact: true }).count(), 0)
          await page.goto(origin + "/?kind=lost&reasons=invalid"); await page.getByRole("alert").waitFor()
          await page.getByText("FIRST VESSEL 1", { exact: true }).waitFor(); assert.equal(await comments().first().isDisabled(), true)
          await set({ reasonReadMode: "ok" }); await page.getByRole("button", { name: "RETRY LOST REASONS", exact: true }).click()
          await page.waitForFunction(() => !document.querySelector('input[placeholder="ADD SPC COMMENT"]').disabled)
          await page.getByRole("button", { name: "EDIT LOST REASONS", exact: true }).click()
          const buyerReasons = page.getByRole("dialog").locator("textarea").first()
          await buyerReasons.fill("PRICE\nPENDING REASON DRAFT")
          await page.getByRole("button", { name: "SAVE BUYER REASONS", exact: true }).click()
          await page.waitForFunction(() => window.__spcRecordPagesHarness.pending.length === 1)
          assert.equal(await buyerReasons.isDisabled(), true); assert.equal(await page.getByRole("button", { name: "DONE", exact: true }).isDisabled(), true)
          await page.clock.fastForward(30_100); await page.getByRole("dialog").getByRole("alert").waitFor()
          assert.equal(await buyerReasons.inputValue(), "PRICE\nPENDING REASON DRAFT")
          assert.equal(await page.getByRole("button", { name: "SAVE BUYER REASONS", exact: true }).isDisabled(), true)
          await screenshot("reason-timeout")
          await page.evaluate(() => { const h = window.__spcRecordPagesHarness, p = h.pending.shift(); p.resolve(Response.json({ success: true, reasons: p.body.reasons })) })
          await page.waitForTimeout(20); assert.equal(await buyerReasons.inputValue(), "PRICE\nPENDING REASON DRAFT")
          await set({ reasonReadMode: "invalid" }); page.once("dialog", dialog => dialog.accept()); await page.getByRole("dialog").getByRole("button", { name: "RETRY LOST REASONS", exact: true }).click()
          await page.getByRole("dialog").getByRole("alert").waitFor()
          assert.equal(await buyerReasons.inputValue(), "PRICE\nPENDING REASON DRAFT")
          assert.equal(await page.getByRole("button", { name: "SAVE BUYER REASONS", exact: true }).isDisabled(), true)
          await set({ reasonReadMode: "ok" }); page.once("dialog", dialog => dialog.accept()); await page.getByRole("dialog").getByRole("button", { name: "RETRY LOST REASONS", exact: true }).click()
          await page.waitForFunction(() => document.querySelector('[role="dialog"] textarea')?.value === "PRICE")
          assert.equal(await page.getByRole("button", { name: "SAVE BUYER REASONS", exact: true }).isDisabled(), false)
          await page.getByRole("button", { name: "DONE", exact: true }).click()
          for (const writeMode of ["denied", "unauthorized"]) {
            await page.goto(origin + "/?kind=lost"); await comments().first().waitFor()
            await page.waitForFunction(() => !document.querySelector('input[placeholder="ADD SPC COMMENT"]').disabled)
            await comments().first().fill("ACCESS RECHECK DRAFT"); await set({ writeMode }); await save().click()
            await page.getByRole("alert").waitFor(); assert.equal(await comments().count(), 0)
            assert.equal(await page.locator(".spc-table").count(), 0)
            await screenshot("lost-write-" + writeMode)
          }
          for (const kind of ["lost", "today"]) for (const mode of ["view", "none", "signed-out"]) {
            await page.goto(origin + "/?kind=" + kind + "&mode=" + mode)
            if (mode === "view") {
              await page.getByText(kind === "lost" ? "FIRST VESSEL 1" : "FIRST VESSEL 1 / SINGAPORE / VLSFO 500MTS", { exact: true }).waitFor()
              if (kind === "lost") { assert.equal(await comments().count(), 0); assert.equal(await page.getByRole("button", { name: "SAVE", exact: true }).count(), 0) }
            } else {
              await page.waitForFunction(() => window.__spcRecordPagesHarness.routes.includes("/spc"))
              assert.equal(await recordReads(), 0); assert.equal(await page.locator(".spc-table").count(), 0)
            }
            await screenshot(kind + "-" + mode)
          }
          // A permission downgrade while a read is held clears the page and ignores its late result.
          await page.goto(origin + "/?kind=lost"); await comments().first().waitFor(); await set({ readMode: "defer" }); await refresh().click()
          await page.waitForFunction(() => window.__spcRecordPagesHarness.pending.length === 1)
          await page.evaluate(() => { const h = window.__spcRecordPagesHarness; h.auth = { ...h.auth, permissions: { ...h.auth.permissions, "spc-lost-record": "none" } }; h.render() })
          await page.waitForFunction(() => window.__spcRecordPagesHarness.routes.includes("/spc"))
          await page.evaluate(() => { const h = window.__spcRecordPagesHarness; h.pending.shift().resolve(Response.json(h.page())) })
          await page.waitForTimeout(30); assert.equal(await comments().count(), 0)
          assert.deepEqual(errors, []); assert.deepEqual(external, []); results.push({ engine, width, scheme })
          console.log(engine + " " + width + " " + scheme + " passed")
        } finally { await context.close() }
      } } finally { await browser.close() }
    }
    assert.equal(results.length, 12)
    fs.writeFileSync(path.join(output, "results.json"), JSON.stringify({ results, cleanup: "All owned browsers, contexts and server closed in finally.", limits: ["Synthetic auth/API; actual pages/navigation/CSS.", "No real devices, signed-in production session or hosted writes."] }, null, 2))
  } finally { await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
