/* Run with node tests/attendance-confirmation.browser.test.cjs.
 * NODE_PATH may provide Playwright; CHROME_EXECUTABLE_PATH selects a browser.
 * Always launches isolated headless contexts. --serve exposes the same fixture
 * for agent-browser. Neither mode uses live APIs or changes real attendance.
 * --baseline-ref=<full commit SHA> bundles that revision's guard in memory to
 * reproduce the original viewer rejection without changing workspace files.
 */
const assert = require("node:assert/strict")
const http = require("node:http")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const { build } = require("esbuild")

const root = path.resolve(__dirname, "..")
const ownId = "11111111-1111-4111-8111-111111111111"
const otherId = "22222222-2222-4222-8222-222222222222"
const button = (page, name) => page.getByRole("button", { name, exact: true })
const staffRows = (page, code) => page.locator("tbody tr").filter({ has: page.locator("th strong").filter({ hasText: new RegExp(`^${code}$`) }) })
const posts = (page) => page.evaluate(() => window.__attendanceConfirmationHarness.requests.filter((request) => request.method === "POST"))
const settle = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))

async function main() {
  const baselineRef = process.argv.find((argument) => argument.startsWith("--baseline-ref="))?.slice("--baseline-ref=".length)
  if (baselineRef && !/^[a-f0-9]{40}$/i.test(baselineRef)) throw new Error("Baseline ref must be an exact full commit SHA")
  const mocks = path.join(root, "tests/fixtures/attendance-confirmation-mocks.ts")
  const bundle = await build({
    absWorkingDir: root, entryPoints: ["tests/fixtures/attendance-confirmation-page.tsx"], bundle: true,
    write: false, outdir: "attendance-browser-fixture", platform: "browser", format: "iife", jsx: "automatic", logLevel: "warning",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "synthetic-attendance-boundaries", setup(builder) {
      builder.onResolve({ filter: /^(?:@\/lib\/useSimpleAdminAuth|next\/navigation)$/ }, () => ({ path: mocks }))
      if (baselineRef) builder.onLoad({ filter: /\/components\/AdminRouteGuard\.tsx$/ }, ({ path: filename }) => ({
        contents: execFileSync("git", ["show", `${baselineRef}:components/AdminRouteGuard.tsx`], { cwd: root, encoding: "utf8" }),
        loader: "tsx", resolveDir: path.dirname(filename),
      }))
    } }],
  })
  const assets = new Map(bundle.outputFiles.map((file) => [`/${path.basename(file.path)}`, file.contents]))
  const script = [...assets.keys()].find((name) => name.endsWith(".js"))
  const css = [...assets.keys()].filter((name) => name.endsWith(".css")).map((name) => `<link rel="stylesheet" href="${name}">`).join("")
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local attendance confirmation regression</title>${css}<style>
  :root { --fc-admin-page-bg:#f4f5f8; --fc-admin-font:Arial,sans-serif; --fc-admin-panel-text:#20232a; --fc-admin-heading:#20232a; --fc-admin-panel-bg:#fff; --fc-admin-panel-soft-bg:#f8f9fc; --fc-admin-border:#ccd0d8; --fc-admin-border-soft:#dfe2e8; --fc-admin-muted:#69707d; --fc-admin-button-bg:#f4f5f8; --fc-admin-button-text:#20232a; --fc-admin-button-border:#ccd0d8; --fc-admin-primary-button-bg:#0672ed; --fc-admin-primary-button-text:#fff; --fc-admin-selected-bg:#e7f2ff; --fc-admin-selected-border:#0672ed; --fc-admin-success-bg:#e9f7ef; --fc-admin-success-text:#127535; --fc-admin-success-border:#218838; --fc-admin-danger-bg:#dc001b; --fc-admin-danger-text:#dc001b; --fc-admin-danger-border:#dc001b; --fc-admin-warning-bg:#fff3bf; --fc-admin-warning-text:#704b00; --fc-admin-warning-border:#e9be38; --fc-admin-link:#0672ed; --fc-input-border:#ccd0d8; --fc-tool-input-bg:#fff; --fc-tool-input-text:#20232a; }
  * { box-sizing:border-box; } body { margin:0; font-family:Arial,sans-serif; } button,input,select { font:inherit; } button:disabled { opacity:.55; cursor:default!important; }
  </style></head><body><div id="root"></div><script src="${script}"></script></body></html>`
  const server = http.createServer((request, response) => {
    if (request.method !== "GET") { response.writeHead(405); response.end("Read-only fixture server"); return }
    const pathname = new URL(request.url, "http://127.0.0.1").pathname
    const asset = assets.get(pathname)
    response.setHeader("Content-Type", asset ? pathname.endsWith(".css") ? "text/css" : "text/javascript" : "text/html")
    response.end(asset || html)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  let browser
  try {
    if (process.argv.includes("--serve")) {
      console.log(`Synthetic attendance confirmation fixture: ${baseUrl}`)
      await new Promise((resolve) => {
        const stop = () => { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); resolve() }
        process.once("SIGINT", stop); process.once("SIGTERM", stop)
      })
      return
    }
    const { chromium } = require("playwright")
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) })
    const errors = []
    const blockedRequests = []
    let context
    let page
    async function reset(permission = "view") {
      if (context) await context.close()
      context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
      await context.route("**/*", (route) => {
        if (new URL(route.request().url()).origin === baseUrl) return route.continue()
        blockedRequests.push(route.request().url())
        return route.abort()
      })
      page = await context.newPage()
      page.setDefaultTimeout(8000)
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
      await page.goto(`${baseUrl}/?permission=${permission}`)
      if (permission === "none") { await page.getByRole("heading", { name: "Access Denied" }).waitFor(); return }
      await button(page, "MONTHLY STATEMENT").click()
      await page.getByLabel("Monthly attendance user").waitFor()
      await page.waitForFunction(() => !document.querySelector('[aria-label="Monthly attendance year"]').disabled)
      const previousYear = await page.evaluate(() => String(window.__attendanceConfirmationHarness.currentYear - 1))
      await page.getByLabel("Monthly attendance year").selectOption(previousYear)
      await staffRows(page, "AT").first().getByRole("button", { name: "CONFIRM", exact: true }).waitFor()
      await settle(page)
    }

    await reset()
    if (baselineRef) {
      await staffRows(page, "AT").first().getByRole("button", { name: "CONFIRM", exact: true }).click()
      await page.getByText("You have view-only access to this admin page.", { exact: false }).waitFor()
      assert.deepEqual(await posts(page), [], "the old browser guard blocks confirmation before it reaches the server")
      assert.equal(await staffRows(page, "AT").first().getByText("CONFIRMED", { exact: true }).count(), 0)
      assert.deepEqual(errors, [])
      assert.deepEqual(blockedRequests, [])
      console.log("PASS: baseline guard reproduces View self-confirmation rejection before the API is called")
      return
    }
    assert.equal(await page.getByLabel("Monthly attendance year").isEnabled(), true)
    assert.equal(await page.getByLabel("Monthly attendance user").isEnabled(), true)
    assert.equal(await button(page, "SEND REMINDER").isDisabled(), true)
    assert.equal(await staffRows(page, "AT").first().getByRole("button", { name: "CONFIRM", exact: true }).isEnabled(), true)
    assert.equal(await staffRows(page, "BT").first().getByRole("button", { name: "CONFIRM", exact: true }).isDisabled(), true)
    await staffRows(page, "AT").first().getByRole("button", { name: "CONFIRM", exact: true }).click()
    await staffRows(page, "AT").first().getByText("CONFIRMED", { exact: true }).waitFor()
    const ownPosts = await posts(page)
    assert.equal(ownPosts.length, 1)
    assert.equal(ownPosts[0].body.action, "save-confirmation")
    assert.equal(ownPosts[0].body.confirmation.personId, ownId)
    assert.equal(ownPosts[0].body.confirmation.status, "confirmed")
    await page.getByLabel("Monthly attendance user").selectOption(otherId)
    assert.equal(await staffRows(page, "AT").count(), 0)
    assert.equal(await staffRows(page, "BT").count(), 12)
    console.log("PASS: View user confirms own closed month, filters work, other users and reminders stay protected")

    await reset()
    await page.evaluate(() => { window.__attendanceConfirmationHarness.failNextConfirmation = true; window.__attendanceConfirmationHarness.holdNextConfirmation = true })
    await staffRows(page, "AT").first().getByRole("button", { name: "CONFIRM", exact: true }).click()
    await button(page, "SAVING…").waitFor()
    await settle(page)
    assert.equal(await button(page, "SAVING…").isDisabled(), true)
    await page.evaluate(() => window.__attendanceConfirmationHarness.releaseConfirmation())
    await page.getByText("Synthetic confirmation failure. Please retry.", { exact: false }).waitFor()
    await settle(page)
    const retry = staffRows(page, "AT").first().getByRole("button", { name: "CONFIRM", exact: true })
    assert.equal(await retry.isEnabled(), true, "SAVING must not leave a View confirmation permanently disabled")
    await retry.click()
    await staffRows(page, "AT").first().getByText("CONFIRMED", { exact: true }).waitFor()
    assert.equal((await posts(page)).length, 2)
    console.log("PASS: a failed confirmation is retryable after the real guard observes SAVING")

    await reset()
    const currentYear = await page.evaluate(() => String(window.__attendanceConfirmationHarness.currentYear))
    await page.getByLabel("Monthly attendance year").selectOption(currentYear)
    await staffRows(page, "AT").last().getByText("OPEN", { exact: true }).waitFor()
    assert.equal(await staffRows(page, "AT").last().getByRole("button", { name: "CONFIRM", exact: true }).count(), 0)
    await button(page, "ALL TIME RECORD").click()
    await page.getByLabel("Annual attendance totals year").waitFor()
    await page.waitForFunction(() => !document.querySelector('[aria-label="Annual attendance totals year"]').disabled)
    assert.equal(await button(page, "EDIT").isDisabled(), true)
    assert.deepEqual(await posts(page), [])
    console.log("PASS: open months cannot be confirmed, annual filter works, attendance editing stays disabled")

    await reset("edit")
    assert.equal(await button(page, "SEND REMINDER").isEnabled(), true)
    await staffRows(page, "BT").first().getByRole("button", { name: "CONFIRM", exact: true }).click()
    await staffRows(page, "BT").first().getByText("CONFIRMED", { exact: true }).waitFor()
    assert.equal((await posts(page))[0].body.confirmation.personId, otherId)
    console.log("PASS: editor can still confirm another staff member")

    await reset("none")
    assert.equal(await button(page, "MONTHLY STATEMENT").count(), 0)
    assert.deepEqual(await page.evaluate(() => window.__attendanceConfirmationHarness.requests), [])
    assert.deepEqual(errors, [], "no browser errors")
    assert.deepEqual(blockedRequests, [], "no external browser requests")
    console.log("PASS: no-access user cannot load attendance; all regression data stayed in isolated memory")
  } finally {
    if (browser) await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
