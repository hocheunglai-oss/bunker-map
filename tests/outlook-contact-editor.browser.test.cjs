/* Run with node tests/outlook-contact-editor.browser.test.cjs.
 * Playwright may be supplied through NODE_PATH. CHROME_EXECUTABLE_PATH can
 * select an installed browser; it always launches a separate headless context.
 * --serve exposes the same synthetic page for agent-browser verification.
 * The actual page component is bundled, but all data stays in local memory.
 */
const assert = require("node:assert/strict")
const http = require("node:http")
const path = require("node:path")
const { build } = require("esbuild")

const root = path.resolve(__dirname, "..")
const contactButton = (page, name = "DORVAL-ORIGINAL PERSON") => page.getByRole("button", { name: new RegExp(`^${name}`) })
const field = (page, label) => page.getByLabel(label, { exact: true })
const button = (page, name) => page.getByRole("button", { name, exact: true })
const operations = (page) => page.evaluate(() => window.__outlookContactHarness.operations)
const committedContact = (page) => page.evaluate(() => window.__outlookContactHarness.contacts.find((contact) => contact.id === "synthetic-contact-a"))
async function settle(page) { await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }

async function main() {
  const mocks = path.join(root, "tests/fixtures/outlook-contact-mocks.ts")
  const bundle = await build({
    absWorkingDir: root, entryPoints: ["tests/fixtures/outlook-contact-editor.tsx"],
    bundle: true, write: false, outdir: "outlook-browser-fixture", platform: "browser", format: "iife", jsx: "automatic", logLevel: "warning",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "synthetic-outlook-boundaries", setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/(supabase|useSimpleAdminAuth)$/ }, () => ({ path: mocks }))
    } }],
  })
  const assets = new Map(bundle.outputFiles.map((file) => [`/${path.basename(file.path)}`, file.contents]))
  const script = [...assets.keys()].find((name) => name.endsWith(".js"))
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local Outlook contact regression</title><style>
  :root { --fc-admin-page-bg:#f4f5f8; --fc-admin-font:Arial,sans-serif; --fc-admin-panel-text:#20232a; --fc-admin-heading:#20232a; --fc-admin-panel-bg:#fff; --fc-admin-panel-soft-bg:#f8f9fc; --fc-admin-border:#ccd0d8; --fc-admin-border-soft:#dfe2e8; --fc-admin-muted:#69707d; --fc-admin-button-bg:#f4f5f8; --fc-admin-button-text:#20232a; --fc-admin-button-border:#ccd0d8; --fc-admin-success-bg:#218838; --fc-admin-success-text:#fff; --fc-admin-success-border:#218838; --fc-admin-danger-bg:#dc001b; --fc-admin-danger-text:#fff; --fc-admin-danger-border:#dc001b; --fc-admin-link:#0672ed; --fc-input-border:#ccd0d8; --fc-tool-input-bg:#fff; --fc-tool-input-text:#20232a; --fc-row-bg:#f4f5f8; --fc-row-text:#20232a; --fc-row-border:#dfe2e8; --fc-row-active-bg:#e7f2ff; --fc-row-active-text:#0054af; --fc-accent:#0672ed; --fc-count-bg:#e7f2ff; --fc-count-text:#0054af; --fc-error:#b00020; --fc-muted:#69707d; }
  * { box-sizing:border-box; } body { margin:0; font-family:Arial,sans-serif; } button,input,select { font:inherit; } button:disabled { opacity:.55; cursor:default!important; }
  </style></head><body><div id="root"></div><script src="${script}"></script></body></html>`
  const server = http.createServer((request, response) => {
    if (request.method !== "GET") { response.writeHead(405); response.end("Read-only fixture server"); return }
    const url = new URL(request.url, "http://127.0.0.1")
    const asset = assets.get(url.pathname)
    response.setHeader("Content-Type", asset ? "text/javascript" : "text/html")
    response.end(asset || html)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  let browser
  try {
    if (process.argv.includes("--serve")) {
      console.log(`Synthetic Outlook contact fixture: ${baseUrl}`)
      await new Promise((resolve) => {
        const stop = () => { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); resolve() }
        process.once("SIGINT", stop); process.once("SIGTERM", stop)
      })
      return
    }
    const { chromium } = require("playwright")
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    const blockedRequests = []
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === baseUrl) return route.continue()
      blockedRequests.push(route.request().url())
      return route.abort()
    })
    let page
    async function reset() {
      if (page) await page.close()
      page = await context.newPage()
      page.setDefaultTimeout(8000)
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
      await page.goto(baseUrl)
      await contactButton(page).waitFor()
      await contactButton(page).click()
      await field(page, "Email").waitFor()
    }
    async function assertNoMembershipChanges() {
      assert.deepEqual(await page.evaluate(() => window.__outlookContactHarness.members), await page.evaluate(() => window.__outlookContactHarness.baselineMembers))
      assert.ok((await operations(page)).every((operation) => operation.table === "shared_addressbook_contacts"), "contact edits never write group membership tables")
    }

    await reset()
    assert.equal(await button(page, "Save").isDisabled(), true)
    await field(page, "Email").fill("")
    await field(page, "Display Name").fill("DORVAL-NEW PERSON")
    await field(page, "Email").fill("new.person@example.test")
    await settle(page)
    assert.deepEqual(await operations(page), [], "typing/clearing any contact field must never persist")
    assert.equal((await committedContact(page)).primary_email, "original@example.test")
    await button(page, "Cancel").click()
    assert.equal(await field(page, "Email").inputValue(), "original@example.test")
    assert.equal(await field(page, "Display Name").inputValue(), "DORVAL-ORIGINAL PERSON")
    assert.deepEqual(await operations(page), [], "Cancel does not write")
    console.log("PASS: intermediate blank email/name remain local; Cancel restores committed details")

    await field(page, "Email").fill(" NEW.PERSON@example.test ")
    await field(page, "Display Name").fill(" DORVAL-NEW   PERSON ")
    await field(page, "Nickname").fill("New Nickname")
    await button(page, "Save").click()
    await page.waitForFunction(() => window.__outlookContactHarness.contacts[0].primary_email === "new.person@example.test")
    await settle(page)
    const savedOperations = await operations(page)
    assert.equal(savedOperations.length, 1)
    assert.equal(savedOperations[0].method, "PATCH", "saving edits uses UPDATE, never UPSERT/recreation")
    assert.deepEqual(savedOperations[0].filters, [{ field: "id", value: "synthetic-contact-a" }])
    assert.equal(savedOperations[0].columns, "id")
    assert.equal(savedOperations[0].single, true, "missing/deleted contacts must be detected")
    const editableFields = new Set(["display_name", "primary_email", "nickname", "first_name", "last_name", "source_book"])
    assert.ok(Object.keys(savedOperations[0].payload).every((key) => editableFields.has(key)))
    assert.equal(savedOperations[0].payload.primary_email, "new.person@example.test")
    const contact = await committedContact(page)
    assert.equal(contact.display_name, "DORVAL-NEW PERSON")
    assert.equal(contact.source_card, "original-card-a")
    assert.equal(contact.vcard, "UNCHANGED ORIGINAL VCARD")
    assert.deepEqual(contact.properties, { custom: "preserve me" })
    await assertNoMembershipChanges()
    assert.equal(await button(page, "Save").isDisabled(), true)
    await contactButton(page, "TEST SUPPLIERS").click()
    assert.equal(await page.locator("main").getByText("new.person@example.test", { exact: true }).count(), 1)
    console.log("PASS: one normalized PATCH preserves identity, source card, metadata, and group membership")

    await reset()
    for (const invalidEmail of ["", "not-an-email", "two@example.test; other@example.test"]) {
      await field(page, "Email").fill(invalidEmail)
      await button(page, "Save").click()
      await settle(page)
      assert.equal(await field(page, "Email").inputValue(), invalidEmail)
      assert.deepEqual(await operations(page), [], "invalid email cannot persist")
    }
    const syncButton = button(page, "Sync now")
    if (!await syncButton.isDisabled()) await syncButton.click()
    assert.equal(await page.evaluate(() => window.__outlookContactHarness.requests.filter((request) => request.method !== "GET").length), 0, "Sync cannot start with an unsaved contact draft")
    console.log("PASS: invalid/blank/multiple emails blocked; unsaved draft cannot trigger sync")

    await reset()
    await field(page, "Email").fill("retry@example.test")
    await page.evaluate(() => { window.__outlookContactHarness.failNext = true })
    await button(page, "Save").click()
    await page.getByText("Synthetic save failure. Please retry.", { exact: true }).waitFor()
    assert.equal(await field(page, "Email").inputValue(), "retry@example.test")
    assert.equal((await committedContact(page)).primary_email, "original@example.test")
    await button(page, "Save").click()
    await page.waitForFunction(() => window.__outlookContactHarness.contacts[0].primary_email === "retry@example.test")
    assert.equal((await operations(page)).length, 2)
    await assertNoMembershipChanges()
    console.log("PASS: save error preserves draft and committed value; retry succeeds")

    await reset()
    await field(page, "Email").fill("network.retry@example.test")
    await page.evaluate(() => { window.__outlookContactHarness.throwNext = true })
    await button(page, "Save").click()
    await page.getByText("Synthetic network failure. Please retry.", { exact: true }).waitFor()
    assert.equal(await field(page, "Email").inputValue(), "network.retry@example.test")
    await button(page, "Save").click()
    await page.waitForFunction(() => window.__outlookContactHarness.contacts[0].primary_email === "network.retry@example.test")
    console.log("PASS: rejected network save retains editable draft and permits retry")

    await reset()
    await field(page, "Email").fill("unsaved@example.test")
    let switchPrompt = ""
    page.once("dialog", async (prompt) => { switchPrompt = prompt.message(); await prompt.dismiss() })
    await contactButton(page, "SECOND CONTACT").click()
    assert.ok(switchPrompt, "switching contacts warns about unsaved changes")
    assert.equal(await field(page, "Email").inputValue(), "unsaved@example.test")
    page.once("dialog", (prompt) => prompt.accept())
    await contactButton(page, "SECOND CONTACT").click()
    assert.equal(await field(page, "Email").inputValue(), "second@example.test")
    assert.deepEqual(await operations(page), [])
    console.log("PASS: contact switching can keep or discard unsaved changes without writing")

    await reset()
    await page.getByRole("combobox", { name: /^Source Book/ }).selectOption("__new_source_book__")
    await field(page, "New Source Book").fill("FC-NEW-BOOK")
    const apply = button(page, "Apply")
    if (await apply.count()) await apply.click()
    assert.deepEqual(await operations(page), [], "adding a source book stays draft-only")
    await button(page, "Save").click()
    await page.waitForFunction(() => window.__outlookContactHarness.contacts[0].source_book === "FC-NEW-BOOK")
    assert.equal((await operations(page)).length, 1)
    await assertNoMembershipChanges()
    console.log("PASS: new source book remains local until Save; group memberships remain intact")

    await reset()
    await field(page, "Email").fill("wait@example.test")
    await page.evaluate(() => { window.__outlookContactHarness.deferNext = true })
    await button(page, "Save").click()
    await page.waitForFunction(() => Boolean(window.__outlookContactHarness.releaseWrite))
    assert.equal(await button(page, "Delete").isDisabled(), true, "Delete cannot race an in-flight Save")
    assert.equal(await button(page, "Cancel").isDisabled(), true)
    assert.equal(await field(page, "Email").isDisabled(), true)
    assert.equal(await page.getByRole("button", { name: /^Saving/ }).isDisabled(), true)
    // Native click on a disabled control is a no-op, including repeated Save.
    await page.getByRole("button", { name: /^Saving/ }).evaluate((element) => element.click())
    await button(page, "Delete").evaluate((element) => element.click())
    assert.equal((await operations(page)).length, 1)
    await page.evaluate(() => window.__outlookContactHarness.releaseWrite())
    await page.waitForFunction(() => window.__outlookContactHarness.contacts[0].primary_email === "wait@example.test")
    await settle(page)
    assert.equal(await button(page, "Delete").isDisabled(), false)
    await assertNoMembershipChanges()
    console.log("PASS: saving locks fields, cancellation, repeated Save, and deletion")

    await reset()
    await field(page, "Email").fill("deleted@example.test")
    await page.evaluate(() => { window.__outlookContactHarness.contacts.shift() })
    await button(page, "Save").click()
    await page.getByText("Contact no longer exists.", { exact: true }).waitFor()
    assert.equal(await field(page, "Email").inputValue(), "deleted@example.test")
    assert.equal(await committedContact(page), undefined)
    assert.equal((await operations(page))[0].method, "PATCH", "a concurrent deletion is never recreated by save")
    console.log("PASS: concurrently deleted contact is not recreated by a stale draft")

    await reset()
    await button(page, "Add contact or group").click()
    await button(page, "New Contact").click()
    const createPanel = page.locator("section").filter({ has: button(page, "Create") })
    await createPanel.getByLabel("Display Name", { exact: true }).fill("NEW SYNTHETIC CONTACT")
    await createPanel.getByLabel("Email", { exact: true }).fill("new.contact@example.test")
    await page.evaluate(() => { window.__outlookContactHarness.failNext = true })
    await button(page, "Create").click()
    await page.getByText("Synthetic save failure. Please retry.", { exact: true }).waitFor()
    assert.equal(await createPanel.getByLabel("Email", { exact: true }).inputValue(), "new.contact@example.test")
    assert.equal(await createPanel.getByLabel("Display Name", { exact: true }).inputValue(), "NEW SYNTHETIC CONTACT")
    await button(page, "Create").click()
    await createPanel.waitFor({ state: "hidden" })
    assert.equal(await field(page, "Email").inputValue(), "new.contact@example.test")
    assert.equal((await operations(page)).length, 2)
    await assertNoMembershipChanges()
    console.log("PASS: failed creation retains entered details; retry creates one contact")

    await reset()
    await field(page, "Email").fill("draft.before.undo@example.test")
    page.once("dialog", (prompt) => prompt.dismiss())
    await button(page, "Undo activity").click()
    assert.equal(await field(page, "Email").inputValue(), "draft.before.undo@example.test")
    assert.equal(await page.evaluate(() => window.__outlookContactHarness.requests.filter((request) => request.method === "POST").length), 0)
    await page.evaluate(() => { window.__outlookContactHarness.deferUndo = true })
    page.once("dialog", (prompt) => prompt.accept())
    await button(page, "Undo activity").click()
    await page.waitForFunction(() => Boolean(window.__outlookContactHarness.releaseUndo))
    assert.equal(await field(page, "Email").isDisabled(), true, "editing cannot race a pending undo")
    assert.equal(await button(page, "Delete").isDisabled(), true)
    assert.equal(await button(page, "Add contact or group").isDisabled(), true)
    await contactButton(page, "SECOND CONTACT").evaluate((element) => element.click())
    assert.equal(await field(page, "Email").inputValue(), "original@example.test", "selection cannot change while undo reloads records")
    assert.deepEqual(await operations(page), [])
    await page.evaluate(() => window.__outlookContactHarness.releaseUndo())
    await page.getByText("Undo applied. Exchange will update automatically within the next hour, or select Sync now.", { exact: true }).waitFor()
    await contactButton(page).click()
    assert.equal(await field(page, "Email").inputValue(), "undo.original@example.test")
    assert.equal(await field(page, "Email").isDisabled(), false)
    assert.equal(await page.evaluate(() => window.__outlookContactHarness.requests.filter((request) => request.method === "POST").length), 1)
    await assertNoMembershipChanges()
    console.log("PASS: undo prompts before discarding and locks editing through its data reload")

    await reset()
    await page.setViewportSize({ width: 390, height: 844 })
    await settle(page)
    await field(page, "Email").fill("mobile@example.test")
    await button(page, "Save").scrollIntoViewIfNeeded()
    const bounds = await button(page, "Save").boundingBox()
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, "mobile Save remains reachable")
    await button(page, "Save").click()
    await page.waitForFunction(() => window.__outlookContactHarness.contacts[0].primary_email === "mobile@example.test")
    await assertNoMembershipChanges()
    console.log("PASS: mobile contact editing and Save remain usable")

    assert.deepEqual(errors, [], "no browser errors")
    assert.deepEqual(blockedRequests, [], "no external browser requests")
    console.log("PASS: all contact editor regressions completed using synthetic local data only")
  } finally {
    if (browser) await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
