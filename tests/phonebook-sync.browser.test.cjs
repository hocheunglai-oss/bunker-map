/* Run with node tests/phonebook-sync.browser.test.cjs.
 * Playwright can be provided by NODE_PATH and a separately launched headless
 * Chrome by CHROME_EXECUTABLE_PATH. --serve exposes synthetic data for a visual
 * agent-browser check. All browser data and writes remain in memory.
 */
const assert = require("node:assert/strict")
const http = require("node:http")
const path = require("node:path")
const { build } = require("esbuild")

const root = path.resolve(__dirname, "..")
const RETRY_KEY = "phonebook_carddav_pending:v2"
const button = (page, name) => page.getByRole("button", { name, exact: true })
const company = (page, name = "ALPHA SHIPPING") => page.getByRole("button", { name: new RegExp(`^${name}`) })
const contact = (page, name = "ALICE TEST") => page.getByRole("button", { name: new RegExp(`^${name}`) })
const field = (page, name) => page.getByText(name, { exact: true }).locator("..").locator("input")
const requests = (page) => page.evaluate(() => window.__phonebookSyncHarness.requests.filter((request) => request.url === "/api/phonebook/carddav-sync" && request.method === "POST"))
const retries = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "[]"), RETRY_KEY)
const settle = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))

async function main() {
  const mocks = path.join(root, "tests/fixtures/phonebook-sync-mocks.ts")
  const bundle = await build({
    absWorkingDir: root, entryPoints: ["tests/fixtures/phonebook-sync-page.tsx"], bundle: true,
    write: false, outdir: "phonebook-browser-fixture", platform: "browser", format: "iife", jsx: "automatic", logLevel: "warning",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "synthetic-phonebook-boundaries", setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/(supabase|useSimpleAdminAuth)$/ }, () => ({ path: mocks }))
    } }],
  })
  const assets = new Map(bundle.outputFiles.map((file) => [`/${path.basename(file.path)}`, file.contents]))
  const script = [...assets.keys()].find((name) => name.endsWith(".js"))
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local Phonebook sync regression</title><style>
  :root { --fc-admin-page-bg:#f4f5f8; --fc-admin-font:Arial,sans-serif; --fc-admin-panel-text:#20232a; --fc-admin-heading:#20232a; --fc-admin-panel-bg:#fff; --fc-admin-panel-soft-bg:#f8f9fc; --fc-admin-border:#ccd0d8; --fc-admin-border-soft:#dfe2e8; --fc-admin-muted:#69707d; --fc-admin-button-bg:#f4f5f8; --fc-admin-button-text:#20232a; --fc-admin-button-border:#ccd0d8; --fc-admin-primary-button-bg:#0672ed; --fc-admin-primary-button-text:#fff; --fc-admin-selected-bg:#e7f2ff; --fc-admin-selected-border:#0672ed; --fc-admin-success-bg:#218838; --fc-admin-success-text:#218838; --fc-admin-success-border:#218838; --fc-admin-danger-bg:#dc001b; --fc-admin-danger-text:#dc001b; --fc-admin-danger-border:#dc001b; --fc-admin-warning-bg:#fff3bf; --fc-admin-warning-text:#704b00; --fc-admin-warning-border:#e9be38; --fc-admin-link:#0672ed; --fc-input-border:#ccd0d8; --fc-tool-input-bg:#fff; --fc-tool-input-text:#20232a; }
  * { box-sizing:border-box; } body { margin:0; font-family:Arial,sans-serif; } button,input,select { font:inherit; } button:disabled { opacity:.55; cursor:default!important; }
  </style></head><body><div id="root"></div><script src="${script}"></script></body></html>`
  const server = http.createServer((request, response) => {
    if (request.method !== "GET") { response.writeHead(405); response.end("Read-only fixture server"); return }
    const asset = assets.get(new URL(request.url, "http://127.0.0.1").pathname)
    response.setHeader("Content-Type", asset ? "text/javascript" : "text/html")
    response.end(asset || html)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  let browser
  try {
    if (process.argv.includes("--serve")) {
      console.log(`Synthetic Phonebook sync fixture: ${baseUrl}`)
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
    async function reset() {
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
      await page.goto(baseUrl)
      await company(page).waitFor()
    }
    async function selectCompany(name = "ALPHA SHIPPING", firstContact = "ALICE TEST") {
      await company(page, name).click()
      await contact(page, firstContact).waitFor()
    }
    async function syncCompany() {
      await button(page, "Sync selected company").click()
      await page.waitForFunction(() => window.__phonebookSyncHarness.activeSyncs === 0)
      await button(page, "Sync selected company").waitFor()
      await settle(page)
    }
    async function retry() {
      await button(page, "☰").click()
      await button(page, "Retry Failed").click()
      await button(page, "Sync selected company").waitFor()
      await settle(page)
    }

    await reset()
    assert.equal(await button(page, "Sync selected company").count(), 1)
    assert.equal(await page.getByRole("button", { name: /^Synced \d+ Contacts$/ }).count(), 0)
    await page.getByText("FC Uno: 4 · CardDAV: 4", { exact: true }).waitFor()
    await button(page, "Refresh phonebook counts").click()
    await page.getByText("FC Uno: 4 · CardDAV: 4", { exact: true }).waitFor()
    assert.deepEqual(await requests(page), [], "a directory count is not evidence of remote sync")
    await selectCompany()
    // Add a contact after the UI cached the company: sync must re-fetch its IDs.
    await page.evaluate(() => {
      window.__phonebookSyncHarness.contacts.push({ id: "synthetic-contact-new", full_name: "NEW SERVER CONTACT", company: "ALPHA SHIPPING", favorite: false })
      window.__phonebookSyncHarness.requests.length = 0
    })
    assert.equal(await contact(page, "NEW SERVER CONTACT").count(), 0)
    await syncCompany()
    const companyRequests = await requests(page)
    assert.equal(companyRequests.length, 2)
    assert.ok(companyRequests.every((request) => request.body.contactIds.length <= 2))
    assert.deepEqual(companyRequests.flatMap((request) => request.body.contactIds).sort(), ["synthetic-contact-a", "synthetic-contact-b", "synthetic-contact-c", "synthetic-contact-new"])
    const refreshed = await page.evaluate(() => window.__phonebookSyncHarness.requests.findIndex((request) => request.url.includes("company=ALPHA%20SHIPPING")))
    assert.ok(refreshed >= 0, "sync fetches the authoritative company list")
    assert.deepEqual(await retries(page), [])
    console.log("PASS: truthful idle label; company sync re-fetches IDs and sends batches of at most two")

    await reset()
    await selectCompany()
    await page.evaluate(() => { window.__phonebookSyncHarness.syncPlan.push({ failedIds: ["synthetic-contact-a"] }) })
    await syncCompany()
    assert.deepEqual((await retries(page)).map((entry) => [entry.id, entry.operation]), [["synthetic-contact-a", "upsert"]])
    await page.getByText(/Synthetic verification failure/).waitFor()
    await selectCompany("BETA SHIPPING", "DAVE TEST")
    await syncCompany()
    assert.deepEqual((await retries(page)).map((entry) => entry.id), ["synthetic-contact-a"], "unrelated success preserves a failed contact")
    const beforeRetry = (await requests(page)).length
    await retry()
    assert.deepEqual((await requests(page)).slice(beforeRetry).map((request) => request.body), [{ contactIds: ["synthetic-contact-a"] }])
    assert.deepEqual(await retries(page), [])
    console.log("PASS: partial 207 keeps failed contacts queued across unrelated success; Retry targets them")

    await reset()
    await selectCompany()
    await contact(page).click()
    await button(page, "Edit").click()
    await field(page, "Mobile 1").fill("+85295556666")
    await page.evaluate(() => { window.__phonebookSyncHarness.syncPlan.push({ reject: true }) })
    await button(page, "Save").click()
    await page.getByText(/Synthetic CardDAV network failure/).waitFor()
    assert.equal(await page.evaluate(() => window.__phonebookSyncHarness.contacts[0].mobile_1), "+85295556666", "local Save must survive a remote failure")
    assert.deepEqual((await retries(page)).map((entry) => entry.id), ["synthetic-contact-a"])
    await retry()
    assert.deepEqual(await retries(page), [])
    console.log("PASS: saved edits survive network failure and can be retried without delete/recreate")

    await reset()
    await selectCompany()
    await contact(page).click()
    await button(page, "Edit").click()
    await page.evaluate(() => { window.__phonebookSyncHarness.syncPlan.push({ status: 503 }) })
    page.once("dialog", (dialog) => dialog.accept())
    await button(page, "Delete").click()
    await page.getByText(/Synthetic upstream sync failure/).waitFor()
    assert.equal(await page.evaluate(() => window.__phonebookSyncHarness.contacts.some((row) => row.id === "synthetic-contact-a")), false)
    assert.deepEqual((await retries(page)).map((entry) => [entry.id, entry.operation]), [["synthetic-contact-a", "delete"]])
    const beforeDeleteRetry = (await requests(page)).length
    await retry()
    assert.deepEqual((await requests(page)).slice(beforeDeleteRetry).map((request) => request.body), [{ deleteContactIds: ["synthetic-contact-a"] }])
    assert.deepEqual(await retries(page), [])
    console.log("PASS: a failed deletion is retried as DELETE, never as an upsert of a removed record")

    await reset()
    await selectCompany()
    await page.evaluate(() => { window.__phonebookSyncHarness.syncPlan.push({ malformed: true }) })
    await syncCompany()
    await page.getByText(/incomplete verification response/).waitFor()
    assert.deepEqual((await retries(page)).map((entry) => entry.id).sort(), ["synthetic-contact-a", "synthetic-contact-b", "synthetic-contact-c"])
    await retry()
    assert.deepEqual(await retries(page), [])
    console.log("PASS: malformed HTTP 200 is not treated as success; every unverified contact remains retryable")

    await reset()
    await selectCompany()
    await page.evaluate(() => { window.__phonebookSyncHarness.malformedContacts = true })
    await syncCompany()
    await page.getByText(/complete saved contact list could not be verified/).waitFor()
    assert.deepEqual(await requests(page), [])
    console.log("PASS: incomplete company-list response cannot silently report successful sync")

    await reset()
    await selectCompany()
    await page.evaluate((key) => localStorage.setItem(key, "broken-json"), RETRY_KEY)
    await syncCompany()
    await page.getByText(/retry information is unreadable/).waitFor()
    assert.deepEqual(await requests(page), [])
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), RETRY_KEY), "broken-json")
    console.log("PASS: corrupt retry storage fails visibly without erasing evidence or sending untracked sync")

    await reset()
    await button(page, "☰").click()
    let resyncPrompt = ""
    page.once("dialog", async (dialog) => { resyncPrompt = dialog.message(); await dialog.accept() })
    await button(page, "Resync all contacts").click()
    await button(page, "Sync selected company").waitFor()
    await settle(page)
    assert.ok(resyncPrompt)
    const fullRequests = await requests(page)
    assert.equal(fullRequests.length, 2)
    assert.ok(fullRequests.every((request) => request.body.fullRebuild === true && request.body.phase === "upload" && !request.body.deleteContactIds))
    assert.deepEqual(fullRequests.map((request) => request.body.cursor), [0, 2])
    assert.deepEqual(await retries(page), [])
    console.log("PASS: full resync uses increasing upload-only batches and never deletes first")

    assert.deepEqual(errors, [], "no browser errors")
    assert.deepEqual(blockedRequests, [], "no external browser requests")
    console.log("PASS: Phonebook browser regressions completed using isolated synthetic data only")
  } finally {
    if (browser) await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
