// Actual Event Calendar component and global CSS; synthetic auth/API state.
// Owned headless contexts only. No production requests, calendar writes or email.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const http = require("node:http")
const { build } = require("esbuild")
const postcss = require("postcss")
const tailwind = require("@tailwindcss/postcss")
const { chromium, webkit } = require("playwright")
const root = path.resolve(__dirname, "..")
const output = process.env.CALENDAR_RECOVERY_SCREENSHOTS || fs.mkdtempSync(path.join(os.tmpdir(), "fcuno-calendar-recovery-"))

async function main() {
  const mocks = path.join(root, "tests/fixtures/event-calendar-mocks.ts")
  const bundle = await build({ absWorkingDir: root, entryPoints: ["tests/fixtures/event-calendar.tsx"], bundle: true, write: false, outdir: "fixture", platform: "browser", format: "iife", jsx: "automatic", logLevel: "warning", define: { "process.env.NODE_ENV": '"development"' }, plugins: [{ name: "synthetic-calendar-auth", setup(builder) { builder.onResolve({ filter: /^@\/lib\/useSimpleAdminAuth$|^next\/navigation$/ }, () => ({ path: mocks })) } }] })
  const js = bundle.outputFiles.find(file => file.path.endsWith(".js")).contents
  const styles = await postcss([tailwind({ base: root })]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })
  const server = http.createServer((request, response) => {
    assert.equal(request.method, "GET", "only local static assets reach HTTP")
    response.setHeader("Cache-Control", "no-store")
    if (request.url === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(js); return }
    if (request.url === "/styles.css") { response.setHeader("Content-Type", "text/css"); response.end(styles.css); return }
    response.setHeader("Content-Type", "text/html")
    response.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>')
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`, browsers = [], cases = [], errors = [], external = []
  const button = (page, name) => page.getByRole("button", { name, exact: true })
  const status = page => page.getByRole("status", { name: "Calendar recovery result", exact: true })
  try {
    for (const [engine, type] of [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await type.launch({ headless: true, ...(engine === "chromium" && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) }); browsers.push(browser)
      for (const width of [1280, 320, 390]) for (const colorScheme of ["light", "dark"]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, timezoneId: "Asia/Hong_Kong" })
        await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : (external.push(route.request().url()), route.abort()))
        const page = await context.newPage(); page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message)); page.on("dialog", dialog => dialog.accept())
        const runRecovery = async summary => {
          await page.evaluate(value => { window.__eventCalendarHarness.recoveryResult = value }, summary)
          await button(page, "Event calendar settings").click(); await button(page, "Recover Missing Events").click()
          await button(page, "Event calendar settings").click()
          await status(page).filter({ hasText: summary.restoredCount ? `Recovered ${summary.restoredCount}` : "No missing future events found" }).waitFor()
        }
        try {
          await page.goto(origin); await page.getByText("MULTI DAY SYNTHETIC EVENT", { exact: true }).waitFor()
          await runRecovery({ restoredCount: 5000, remainingCount: 1, skippedInvalidCount: 2, historyComplete: false })
          const expected = "Recovered 5000 missing events. 1 more event remains; run recovery again. 2 invalid historical records were skipped; ask an administrator to review them. Only part of the audit history was checked; older events may need administrator review"
          assert.equal(await status(page).textContent(), expected)
          const geometry = await status(page).evaluate(node => {
            const box = node.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(node)
            const text = range.getBoundingClientRect(), style = getComputedStyle(node)
            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, textLeft: text.left, textRight: text.right, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, documentOverflow: document.documentElement.scrollWidth - innerWidth, color: style.color, background: getComputedStyle(node.parentElement).backgroundColor, fontSize: style.fontSize }
          })
          assert.ok(geometry.left >= -1 && geometry.right <= width + 1, `status stays in viewport: ${JSON.stringify(geometry)}`)
          assert.ok(geometry.textLeft >= geometry.left - 1 && geometry.textRight <= geometry.right + 1, "complete status wraps within its panel")
          assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, "status has no internal clipping")
          assert.ok(geometry.documentOverflow <= 1, `no global horizontal overflow: ${JSON.stringify(geometry)}`)
          assert.ok(geometry.bottom <= 900, "full status and menu remain vertically reachable at test viewport")
          await page.screenshot({ path: path.join(output, `${engine}-${width}-${colorScheme}-recovery.png`), fullPage: true })
          const requests = await page.evaluate(() => window.__eventCalendarHarness.requests)
          assert.equal(requests.filter(request => request.path.endsWith("recover-missing") && request.method === "POST").length, 1)
          assert.deepEqual(requests.filter(request => request.method !== "GET" && !request.path.endsWith("recover-missing")), [], "status fixture triggers no Google sync, writes or email")
          await button(page, "Event calendar settings").click()
          await runRecovery({ restoredCount: 0, remainingCount: 0, skippedInvalidCount: 0, historyComplete: true })
          assert.equal(await status(page).textContent(), "No missing future events found")
          await page.goto(`${origin}?access=view`); await page.getByText("MULTI DAY SYNTHETIC EVENT", { exact: true }).waitFor()
          await button(page, "Event calendar settings").click(); assert.equal(await button(page, "Recover Missing Events").isDisabled(), true)
          assert.deepEqual(await page.evaluate(() => window.__eventCalendarHarness.requests.filter(request => request.method !== "GET")), [])
          cases.push({ engine, width, colorScheme, geometry }); console.log(`PASS ${engine} ${width} ${colorScheme}: bounded recovery warning wraps; repeat/no-op and View guard preserved`)
        } catch (error) {
          await page.screenshot({ path: path.join(output, `${engine}-${width}-${colorScheme}-failure.png`), fullPage: true }); throw error
        } finally { await context.close() }
      }
    }
    assert.equal(cases.length, 12); assert.deepEqual(errors, []); assert.deepEqual(external, [])
    fs.writeFileSync(path.join(output, "verification.json"), JSON.stringify({ cases, errors, external, output, limitations: "Actual component/global CSS and synthetic signed-in Edit/View state. Admin intentionally uses its existing light palette under either OS setting. No live auth/database/history/Google/SMTP, no signed-out runtime integration, and no physical device certification. API validation/CAS is covered separately by calendar-recovery.test.ts." }, null, 2))
    console.log(`Screenshots and receipt: ${output}`)
  } finally { for (const browser of browsers) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
