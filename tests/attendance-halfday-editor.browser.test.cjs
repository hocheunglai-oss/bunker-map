// Real editor/guard/CSS; synthetic in-memory API only. Never touches live attendance.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const http = require("node:http")
const { execFileSync } = require("node:child_process")
const { build } = require("esbuild")
const postcss = require("postcss")
const tailwind = require("@tailwindcss/postcss")
const { chromium, webkit } = require("playwright")
const root = path.resolve(__dirname, "..")
const button = (page, name) => page.getByRole("button", { name, exact: true })
const dialog = page => page.getByRole("dialog", { name: "EDIT ATTENDANCE" })
const status = page => dialog(page).getByRole("combobox")
async function main() {
  const output = process.env.ATTENDANCE_HALFDAY_SCREENSHOTS
  assert.ok(output && path.isAbsolute(output), "Owned absolute screenshot directory required")
  fs.mkdirSync(output, { recursive: true })
  const baseline = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.split("=")[1]
  if (baseline && !/^[a-f0-9]{40}$/.test(baseline)) throw new Error("Exact baseline SHA required")
  const bundle = await build({ absWorkingDir: root, entryPoints: ["tests/fixtures/attendance-halfday-page.tsx"], bundle: true, write: false,
    outdir: "halfday-fixture", platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "synthetic-boundaries", setup(builder) {
      builder.onResolve({ filter: /^(?:@\/lib\/useSimpleAdminAuth|next\/navigation)$/ }, () => ({ path: path.join(root, "tests/fixtures/attendance-halfday-mocks.ts") }))
      if (baseline) builder.onLoad({ filter: /\/AttendanceRecordClient\.tsx$/ }, ({ path: filename }) => ({ contents: execFileSync("git", ["show", `${baseline}:app/admin/attendancerecord/AttendanceRecordClient.tsx`], { cwd: root, encoding: "utf8" }), loader: "tsx", resolveDir: path.dirname(filename) }))
    } }],
  })
  const assets = new Map(bundle.outputFiles.map(file => ["/" + path.basename(file.path), file.contents]))
  const global = await postcss([tailwind()]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })
  const js = [...assets.keys()].find(key => key.endsWith(".js")), css = [...assets.keys()].filter(key => key.endsWith(".css"))
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/globals.css">${css.map(href => `<link rel="stylesheet" href="${href}">`).join("")}</head><body><div id="root"></div><script src="${js}"></script></body></html>`
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname
    if (req.method !== "GET") { res.writeHead(405); return res.end() }
    if (assets.has(pathname)) { res.setHeader("Content-Type", pathname.endsWith(".css") ? "text/css" : "text/javascript"); return res.end(assets.get(pathname)) }
    if (pathname === "/globals.css") { res.setHeader("Content-Type", "text/css"); return res.end(global.css) }
    if (pathname !== "/") { res.writeHead(404); return res.end() }
    res.setHeader("Content-Type", "text/html"); res.end(html)
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`, results = []
  try {
    for (const [engine, launcher] of baseline ? [["chromium", chromium]] : [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await launcher.launch({ headless: true })
      try {
        for (const width of baseline ? [1440] : [320, 390, 1440]) for (const scheme of baseline ? ["light"] : ["light", "dark"]) {
          const context = await browser.newContext({ viewport: { width, height: width === 320 ? 740 : width === 390 ? 844 : 1000 }, colorScheme: scheme, ...(width < 760 ? { isMobile: true, hasTouch: true } : {}) })
          try {
            const page = await context.newPage(), errors = [], external = [], captures = []
            // Stable weekday/current-month fixture, independent of the CI run date.
            await page.clock.setFixedTime(new Date("2026-11-03T04:00:00Z"))
            page.setDefaultTimeout(10000)
            page.on("pageerror", error => errors.push(error.message))
            await context.route("**/*", route => {
              if (new URL(route.request().url()).origin === origin) return route.continue()
              external.push(route.request().url()); return route.abort()
            })
            async function capture(state) {
              const screenshot = `${engine}-${width}-${scheme}-${state}.png`
              await page.screenshot({ path: path.join(output, screenshot), fullPage: true })
              const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
              assert.ok(dimensions.scroll <= width + 1, `${screenshot}: page horizontal overflow ${JSON.stringify(dimensions)}`)
              if (await dialog(page).count()) {
                const bounds = await dialog(page).boundingBox()
                assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `${screenshot}: editor fits screen`)
                const clipped = await dialog(page).locator("button,select,input").evaluateAll(elements => elements.filter(element => {
                  const r = element.getBoundingClientRect(), d = element.closest('[role="dialog"]').getBoundingClientRect()
                  return r.x < d.x - 1 || r.right > d.right + 1
                }).map(element => element.getAttribute("aria-label") || element.textContent))
                assert.deepEqual(clipped, [], `${screenshot}: controls not clipped`)
                assert.ok((await status(page).boundingBox()).height >= 38, "status selector remains touch-sized, including WebKit")
              }
              captures.push(screenshot)
            }
            const cell = direction => page.getByRole("button", { name: new RegExp(`^Edit Alice Test 02/.* ${direction} attendance$`) })
            async function open(direction) { await cell(direction).click(); await dialog(page).waitFor() }
            async function save() { await button(dialog(page), "Save changes").click(); await dialog(page).waitFor({ state: "hidden" }); await button(page, "REFRESH").waitFor() }
            async function entries() { return page.evaluate(() => window.__halfday.entries.map(({ portion, code, units }) => ({ portion, code, units })).sort((a, b) => a.portion.localeCompare(b.portion))) }
            await page.goto(`${origin}/?permission=edit`)
            await open("IN")
            await status(page).selectOption("mode:home-office")
            if (baseline) {
              assert.equal(await button(page, "Full day").getAttribute("aria-pressed"), "true", "baseline resets half-day mode to full")
              await button(page, "AM").click(); await save(); await open("OUT")
              assert.equal(await button(page, "AM").getAttribute("aria-pressed"), "true", "baseline incorrectly opens AM when clicking PM")
              await status(page).selectOption("leave:ALS"); await button(page, "PM").click(); await save()
              assert.deepEqual(await entries(), [{ portion: "pm", code: "ALS", units: 0.5 }], "baseline loses morning HO")
              console.log("PASS baseline reproduction: choosing HO resets portion; adding PM annual leave replaces morning HO")
              return
            }
            assert.equal(await button(page, "AM").getAttribute("aria-pressed"), "true", "home office preserves selected half")
            await save(); const originalAm = await page.evaluate(() => window.__halfday.entries[0])
            await open("OUT")
            await status(page).selectOption("leave:ALS")
            assert.equal(await button(page, "PM").getAttribute("aria-pressed"), "true")
            assert.equal(await button(page, "AM").isDisabled(), true)
            assert.equal(await button(page, "Full day").isDisabled(), true)
            await capture("am-home-pm-leave-editor"); await save()
            assert.deepEqual(await entries(), [{ portion: "am", code: "HO", units: 0.5 }, { portion: "pm", code: "ALS", units: 0.5 }])
            assert.deepEqual(await page.evaluate(() => window.__halfday.entries.find(entry => entry.portion === "am")), originalAm, "morning record untouched")
            const last = await page.evaluate(() => window.__halfday.posts.at(-1).dayEdit)
            assert.equal(Object.hasOwn(last, "existingLeaveEntryId"), false, "new half must not use opposite entry id")
            await button(page, "REFRESH").click(); await cell("IN").filter({ hasText: "HO" }).waitFor(); await cell("OUT").filter({ hasText: "ALS" }).waitFor()
            await capture("saved-and-refreshed")
            await open("OUT"); await status(page).selectOption("leave:ALU")
            await page.evaluate(() => { window.__halfday.failNext = true })
            await button(dialog(page), "Save changes").click()
            await page.getByText("Synthetic save failed; original records preserved.", { exact: false }).waitFor()
            assert.deepEqual(await entries(), [{ portion: "am", code: "HO", units: 0.5 }, { portion: "pm", code: "ALS", units: 0.5 }])
            await save(); assert.deepEqual(await entries(), [{ portion: "am", code: "HO", units: 0.5 }, { portion: "pm", code: "ALU", units: 0.5 }])
            await open("OUT"); await button(dialog(page), "Delete entry").click(); await dialog(page).waitFor({ state: "hidden" })
            assert.deepEqual(await entries(), [{ portion: "am", code: "HO", units: 0.5 }])
            // Reverse assignment/order catches both direction-sensitive paths.
            await page.goto(`${origin}/?permission=edit`)
            await open("OUT"); await status(page).selectOption("mode:home-office")
            assert.equal(await button(page, "PM").getAttribute("aria-pressed"), "true"); await save()
            await open("IN"); await status(page).selectOption("leave:ALS"); await save()
            assert.deepEqual(await entries(), [{ portion: "am", code: "ALS", units: 0.5 }, { portion: "pm", code: "HO", units: 0.5 }])
            await page.goto(`${origin}/?permission=edit&manualMode=home-office`)
            await open("OUT"); await status(page).selectOption("leave:ALS"); await button(page, "PM").click(); await save()
            assert.equal(await page.evaluate(() => window.__halfday.posts.at(-1).dayEdit.workMode), "home-office", "keep existing manual HOME for remaining work half")
            await cell("IN").filter({ hasText: "HO" }).waitFor(); await cell("OUT").filter({ hasText: "ALS" }).waitFor()
            // Morning departure belongs to the PM absence: guide without weakening its server guard.
            await page.goto(`${origin}/?permission=edit&pmLeave=1&morningOut=13:00`)
            await open("IN")
            await dialog(page).getByText("To correct a morning sign-out, edit the PM (OUT) leave entry.", { exact: true }).waitFor()
            await page.getByLabel("Sign out time", { exact: true }).fill("13:05")
            await button(dialog(page), "Save changes").click()
            assert.equal(await page.evaluate(() => window.__halfday.posts.length), 0, "wrong-half correction is not sent")
            await button(dialog(page), "Close attendance editor").click()
            await open("OUT"); await page.getByLabel("Sign out time", { exact: true }).fill("13:05"); await save()
            assert.equal(await page.evaluate(() => window.__halfday.posts.at(-1).dayEdit.updateSignOut), true)
            assert.deepEqual(await entries(), [{ portion: "pm", code: "ALS", units: 0.5 }])
            // Reproduce the reported two-day counter, both older-response fallback and API total.
            for (const totals of ["fallback", "api"]) {
              await page.goto(`${origin}/?permission=edit&countExample=1&totals=${totals}`)
              const attended = page.getByRole("row").filter({ hasText: "ATTENDED DAYS" }).locator("td").first()
              await attended.waitFor()
              assert.equal(await attended.innerText(), "1.5", `${totals}: one office day plus half HOME is 1.5`)
              assert.equal(await page.getByRole("row").filter({ hasText: "LATE DAYS" }).locator("td").first().innerText(), "1", "late occasions are not fractional")
              await button(page, "REFRESH").click()
              assert.equal(await attended.innerText(), "1.5", "refresh retains fractional total")
              await capture(`fractional-total-${totals}`)
              await button(page, "MONTHLY STATEMENT").click()
              const summaryRow = page.getByRole("row").filter({ hasText: "Alice Test" })
              await summaryRow.waitFor()
              assert.ok((await summaryRow.innerText()).includes("1.5"), "monthly statement also displays fractional total")
            }
            await page.goto(`${origin}/?permission=view`); await button(page, "REFRESH").waitFor()
            assert.equal(await page.getByRole("button", { name: /^Edit Alice/ }).count(), 0)
            await page.goto(`${origin}/?permission=signed-out`); await page.getByRole("heading", { name: "Access Denied" }).waitFor()
            assert.equal(await page.getByRole("button", { name: /^Edit Alice/ }).count(), 0)
            await capture("signed-out")
            assert.deepEqual(errors, []); assert.deepEqual(external, [])
            results.push({ engine, width, scheme, captures, passed: true })
          } finally { await context.close() }
        }
      } finally { await browser.close() }
    }
    fs.writeFileSync(path.join(output, "receipt.json"), JSON.stringify({ passed: true, cases: results.length, results,
      limitations: ["Synthetic auth/data; real editor, guard, CSS. Native SQL/API tests separately verify persistence and totals.", "No physical phone; Chromium and mobile WebKit engines verified."] }, null, 2))
    console.log(JSON.stringify({ passed: true, cases: results.length, output }))
  } finally { await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
