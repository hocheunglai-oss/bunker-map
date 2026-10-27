// Actual AttendanceRecordClient + AdminRouteGuard + shipped global/module CSS.
// Synthetic authentication and in-memory API only. No live service or personal Chrome.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const path = require("node:path")
const { build } = require("esbuild")
const postcss = require("postcss")
const tailwind = require("@tailwindcss/postcss")
const { chromium, webkit } = require("playwright")
const root = path.resolve(__dirname, "..")
const button = (page, name) => page.getByRole("button", { name, exact: true })
const rows = (page, code) => page.locator("tbody tr").filter({ has: page.locator("th strong,td strong").filter({ hasText: new RegExp(`^${code}$`) }) })
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
async function main() {
  const output = process.env.ATTENDANCE_ANNUAL_SCREENSHOTS
  assert.ok(output && path.isAbsolute(output), "Owned absolute screenshot directory required")
  fs.mkdirSync(output, { recursive: true })
  const mocks = path.join(root, "tests/fixtures/attendance-confirmation-mocks.ts")
  const bundle = await build({ absWorkingDir: root, entryPoints: ["tests/fixtures/attendance-confirmation-page.tsx"], bundle: true,
    write: false, outdir: "annual-attendance-fixture", platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "synthetic-auth-api-navigation", setup(builder) {
      builder.onResolve({ filter: /^(?:@\/lib\/useSimpleAdminAuth|next\/navigation)$/ }, () => ({ path: mocks }))
    } }],
  })
  const assets = new Map(bundle.outputFiles.map(file => ["/" + path.basename(file.path), file.contents]))
  const global = await postcss([tailwind()]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })
  const js = [...assets.keys()].find(key => key.endsWith(".js")), css = [...assets.keys()].filter(key => key.endsWith(".css"))
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/globals.css">' + css.map(href => `<link rel="stylesheet" href="${href}">`).join("") + `</head><body><div id="root"></div><script src="${js}"></script></body></html>`
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
  let screenshots = 0
  try {
    for (const [engine, launcher] of [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await launcher.launch({ headless: true })
      try {
        for (const width of [320, 390, 1440]) for (const scheme of ["light", "dark"]) {
          for (const permission of ["view", "edit", "signed-out"]) {
            const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: scheme,
              ...(width < 760 ? { isMobile: true, hasTouch: true } : {}) })
            try {
              const page = await context.newPage(), errors = [], external = [], states = []
              page.setDefaultTimeout(8000)
              page.on("pageerror", error => errors.push(error.message))
              page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
              await context.route("**/*", route => {
                if (new URL(route.request().url()).origin === origin) return route.continue()
                external.push(route.request().url()); return route.abort()
              })
              async function capture(state) {
                await settle(page)
                const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
                const screenshot = `${engine}-${width}-${scheme}-${permission}-${state}.png`
                await page.screenshot({ path: path.join(output, screenshot), fullPage: true }); screenshots += 1
                assert.ok(dimensions.scroll <= width + 1, `${screenshot} document overflow ${JSON.stringify(dimensions)}`)
                const controls = await page.locator('button:visible,select:visible').evaluateAll(elements => elements.map(element => {
                  const r = element.getBoundingClientRect()
                  const cell = element.closest("td")?.getBoundingClientRect()
                  return { label: element.getAttribute("aria-label") || element.textContent.trim(), x: r.x, y: r.y, width: r.width, height: r.height,
                    clippedByCell: Boolean(cell && (r.x < cell.x - 1 || r.right > cell.right + 1)) }
                }))
                assert.ok(controls.every(control => !control.clippedByCell), `${screenshot} controls overlap table cells: ${JSON.stringify(controls.filter(control => control.clippedByCell))}`)
                if (width < 760 && permission !== "signed-out") {
                  assert.ok(controls.filter(control => control.label === "Annual attendance totals year").every(control => control.height >= 36), "year selector remains touch reachable in WebKit")
                  assert.ok(controls.filter(control => control.label === "CONFIRM YEAR" || control.label === "SAVING…" || /^Reset .* year-end confirmation$/.test(control.label))
                    .every(control => control.height >= 40), "annual confirmation and reset have phone-sized touch targets")
                  const region = page.getByRole("region", { name: "Annual attendance totals; scroll horizontally on small screens", exact: true })
                  const scrolling = await region.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }))
                  assert.ok(scrolling.scroll > scrolling.width, "narrow tables must have an inner scroll region")
                  await region.focus()
                  await region.evaluate(element => { element.scrollLeft = 0 })
                  await page.keyboard.press("ArrowRight")
                  await page.waitForFunction(() => document.querySelector('[aria-label="Annual attendance totals; scroll horizontally on small screens"]').scrollLeft > 0)
                  await page.keyboard.press("End")
                  assert.ok(await region.evaluate(element => element.scrollLeft >= element.scrollWidth - element.clientWidth - 1), "End reaches annual action column")
                  await settle(page)
                  const actionScreenshot = `${engine}-${width}-${scheme}-${permission}-${state}-actions.png`
                  await page.screenshot({ path: path.join(output, actionScreenshot), fullPage: true }); screenshots += 1
                  states.push({ state: `${state}-scroll-actions`, screenshot: actionScreenshot, scrolling })
                  await page.keyboard.press("Home")
                  assert.equal(await region.evaluate(element => element.scrollLeft), 0)
                  await page.keyboard.press("ArrowRight")
                  await page.keyboard.press("ArrowLeft")
                  assert.equal(await region.evaluate(element => element.scrollLeft), 0)
                }
                states.push({ state, screenshot, dimensions, controls })
              }
              await page.goto(`${origin}/?permission=${permission}`)
              if (permission === "signed-out") {
                await page.getByRole("heading", { name: "Access Denied", exact: true }).waitFor()
                assert.equal(await button(page, "ALL TIME RECORD").count(), 0)
                assert.deepEqual(await page.evaluate(() => window.__attendanceConfirmationHarness.requests), [])
                await capture("no-data")
              } else {
                const closedYear = await page.evaluate(() => String(window.__attendanceConfirmationHarness.currentYear - 1))
                await button(page, "MONTHLY STATEMENT").click()
                await page.waitForFunction(() => !document.querySelector('[aria-label="Monthly attendance year"]').disabled)
                await page.getByLabel("Monthly attendance year").selectOption(closedYear)
                await rows(page, "AT").nth(11).getByRole("button", { name: "CONFIRM", exact: true }).click()
                await rows(page, "AT").nth(11).getByText("CONFIRMED", { exact: true }).waitFor()
                await button(page, "ALL TIME RECORD").click()
                await page.waitForFunction(() => !document.querySelector('[aria-label="Annual attendance totals year"]').disabled)
                await page.getByLabel("Annual attendance totals year").selectOption(closedYear)
                await rows(page, "AT").getByRole("button", { name: "CONFIRM YEAR", exact: true }).waitFor()
                if (permission === "view") assert.equal(await rows(page, "BT").getByRole("button", { name: "CONFIRM YEAR", exact: true }).count(), 0)
                await capture("pending-annual-december-confirmed")
                await page.evaluate(() => { window.__attendanceConfirmationHarness.failNextConfirmation = true; window.__attendanceConfirmationHarness.holdNextConfirmation = true })
                await rows(page, "AT").getByRole("button", { name: "CONFIRM YEAR", exact: true }).click()
                await button(page, "SAVING…").waitFor()
                await page.waitForFunction(() => window.__attendanceConfirmationHarness.requests.filter(request => request.method === "POST").length === 2)
                assert.equal(await button(page, "SAVING…").isDisabled(), true)
                await capture("saving")
                await page.evaluate(() => window.__attendanceConfirmationHarness.releaseConfirmation())
                await page.getByText("Synthetic confirmation failure. Please retry.", { exact: false }).waitFor()
                await rows(page, "AT").getByRole("button", { name: "CONFIRM YEAR", exact: true }).click()
                await rows(page, "AT").getByText("CONFIRMED", { exact: true }).waitFor()
                await capture("confirmed")
                const annualPosts = await page.evaluate(() => window.__attendanceConfirmationHarness.requests.filter(request => request.method === "POST" && request.body.action === "save-annual-confirmation"))
                assert.equal(annualPosts.length, 2)
                assert.ok(annualPosts.every(request => !Object.hasOwn(request.body.confirmation, "month")))
                if (permission === "edit") {
                  await page.getByRole("button", { name: `Reset AT ${closedYear} year-end confirmation`, exact: true }).click()
                  await rows(page, "AT").getByRole("button", { name: "CONFIRM YEAR", exact: true }).waitFor()
                  await capture("reset")
                } else assert.equal(await page.getByRole("button", { name: /^Reset .* year-end confirmation$/ }).count(), 0)
                const currentYear = await page.evaluate(() => String(window.__attendanceConfirmationHarness.currentYear))
                await page.evaluate(() => { window.__attendanceConfirmationHarness.annualConfirmationAvailable = false })
                await page.getByLabel("Annual attendance totals year").selectOption(currentYear)
                await page.waitForFunction(() => !document.querySelector('[aria-label="Annual attendance totals year"]').disabled)
                await page.getByLabel("Annual attendance totals year").selectOption(closedYear)
                await page.getByText("Year-end confirmation is temporarily unavailable while an update finishes. Monthly confirmations are unchanged.", { exact: true }).waitFor()
                assert.equal(await button(page, "CONFIRM YEAR").count(), 0)
                assert.equal(await page.getByRole("button", { name: /^Reset .* year-end confirmation$/ }).count(), 0)
                assert.equal(await rows(page, "AT").getByText("NOT AVAILABLE", { exact: true }).count(), 1)
                await capture("pre-ddl-bridge")
                await button(page, "MONTHLY STATEMENT").click()
                await rows(page, "AT").nth(11).getByText("CONFIRMED", { exact: true }).waitFor()
                assert.equal(await rows(page, "AT").first().getByRole("button", { name: "CONFIRM", exact: true }).count(), 1)
              }
              assert.deepEqual(errors, []); assert.deepEqual(external, [])
              results.push({ engine, width, scheme, permission, states })
            } finally { await context.close() }
          }
        }
      } finally { await browser.close() }
    }
    assert.equal(results.length, 36)
    const receipt = { passed: true, cases: results.length, screenshots, output, results,
      limitations: ["Actual component/guard/global+module CSS; synthetic auth and in-memory API. Separate actual API/helper and native PostgreSQL tests verify server/data guards.",
        "Shipped admin palette remains fixed under light/dark OS preferences; no invented dark theme.", "No physical phone or native Safari session; mobile WebKit engine checked. No live service mutations."] }
    fs.writeFileSync(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify({ passed: true, cases: results.length, screenshots, output }))
  } finally { await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
