/* Run with node tests/ccinfo-table-editor.browser.test.cjs.
 * Add --serve to keep the synthetic fixture available for manual verification.
 * Playwright may be supplied through NODE_PATH; no production services are used.
 */
const assert = require("node:assert/strict")
const http = require("node:http")
const path = require("node:path")
const { build } = require("esbuild")

const root = path.resolve(__dirname, "..")
const title = "Edit Supplier characteristics"
const dialog = (page) => page.getByRole("dialog", { name: title, exact: true })
const action = (page, name) => dialog(page).getByRole("button", { name, exact: true })
const cell = (page, row, column = 0) => dialog(page).locator(`input[data-row="${row}"][data-column="${column}"]`)

async function waitForValue(locator, value) {
  await locator.page().waitForFunction(({ selector, expected }) => document.querySelector(selector)?.value === expected,
    { selector: await locator.evaluate((node) => `dialog input[data-row="${node.dataset.row}"][data-column="${node.dataset.column}"]`), expected: value })
}

async function openEditor(page, last = false) {
  const buttons = page.getByRole("button", { name: "Edit", exact: true })
  await (last ? buttons.last() : buttons.first()).click()
  await dialog(page).waitFor({ state: "visible" })
}

async function assertInViewport(locator, label) {
  const bounds = await locator.boundingBox()
  const viewport = locator.page().viewportSize()
  assert.ok(bounds && bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1, `${label} must remain inside the viewport`)
}

async function closeDiscarding(page, viaEscape = false) {
  page.once("dialog", (prompt) => prompt.accept())
  if (viaEscape) await page.keyboard.press("Escape")
  else await action(page, "Cancel").click()
  await dialog(page).waitFor({ state: "hidden" })
}

async function main() {
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: ["tests/fixtures/ccinfo-table-editor.tsx"],
    bundle: true, write: false, outdir: "ccinfo-browser-fixture",
    platform: "browser", format: "iife", jsx: "automatic", logLevel: "warning",
    define: { "process.env.NODE_ENV": '"development"' },
  })
  const assets = new Map(bundle.outputFiles.map((file) => [`/${path.basename(file.path)}`, file.contents]))
  const js = [...assets.keys()].find((name) => name.endsWith(".js"))
  const css = [...assets.keys()].find((name) => name.endsWith(".css"))
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CCINFO editor regression</title>${css ? `<link rel="stylesheet" href="${css}">` : ""}<style>
    :root { --fc-admin-link:#0672ed; --fc-admin-panel-text:#20232a; --fc-admin-panel-bg:#fff; --fc-admin-panel-soft-bg:#f8f9fc; --fc-admin-selected-bg:#e7f2ff; --fc-admin-selected-border:#94baff; --fc-admin-border:#ccd0d8; --fc-admin-border-soft:#dfe2e8; --fc-admin-muted:#69707d; --fc-admin-button-bg:#f4f5f8; --fc-admin-button-text:#20232a; --fc-admin-success-bg:#218838; --fc-admin-success-text:#fff; --fc-admin-danger-bg:#fff1f1; --fc-admin-danger-text:#a20000; --fc-admin-danger-border:#d78c8c; }
    * { box-sizing:border-box; } body { margin:0; font-family:Arial,sans-serif; background:#f4f5f8; } button,input { font:inherit; }
  </style></head><body><div id="root"></div><script src="${js}"></script></body></html>`
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1")
    const asset = assets.get(url.pathname)
    response.setHeader("Content-Type", asset ? url.pathname.endsWith(".css") ? "text/css" : "text/javascript" : "text/html")
    response.end(asset || html)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  let browser
  try {
    if (process.argv.includes("--serve")) {
      console.log(`CCINFO table editor fixture: ${baseUrl}`)
      await new Promise((resolve) => {
        const stop = () => {
          process.removeListener("SIGINT", stop)
          process.removeListener("SIGTERM", stop)
          resolve()
        }
        process.once("SIGINT", stop)
        process.once("SIGTERM", stop)
      })
      return
    }
    const { chromium } = require("playwright")
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) })
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] })
    await context.route("**/*", (route) => route.request().url().startsWith(baseUrl) ? route.continue() : route.abort())
    const page = await context.newPage()
    page.setDefaultTimeout(8000)
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    async function reset(query = "") { await page.goto(baseUrl + query); await page.waitForFunction(() => Boolean(window.__ccinfoTableHarness)) }

    await reset()
    assert.equal(await page.getByRole("button", { name: "Edit", exact: true }).count(), 2, "top and bottom Edit controls")
    await openEditor(page)
    await assertInViewport(action(page, "Add Row"), "Add Row")
    await assertInViewport(action(page, "Save"), "Save")
    const scroll = dialog(page).locator("[data-ccinfo-table-scroll]")
    await scroll.evaluate((node) => { node.scrollTop = node.scrollHeight })
    await assertInViewport(action(page, "Add Row"), "Add Row after scrolling")
    await assertInViewport(action(page, "Save"), "Save after scrolling")
    await assertInViewport(cell(page, 0), "sticky heading")
    await action(page, "Add Row").click()
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-row") === "81")
    await assertInViewport(cell(page, 81), "new row")
    await cell(page, 81).fill("Added supplier")
    await closeDiscarding(page)
    assert.equal(await page.evaluate(() => window.__ccinfoTableHarness.calls), 0, "Cancel never invokes save")
    await openEditor(page, true)
    assert.equal(await cell(page, 81).count(), 0, "Cancel discards appended row")
    assert.equal(await cell(page, 1).inputValue(), "Supplier 001")
    await action(page, "Cancel").click()
    console.log("PASS: long-table controls, sticky heading, appended-row focus, top/bottom Edit, and cancel")

    await reset()
    await openEditor(page)
    await cell(page, 20, 2).click()
    await action(page, "Row Above").click()
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-row") === "20")
    assert.equal(await cell(page, 21).inputValue(), "Supplier 020")
    await cell(page, 20).fill("Inserted above")
    await action(page, "Row Below").click()
    assert.equal(await cell(page, 22).inputValue(), "Supplier 020")
    await cell(page, 21).fill("Inserted below")
    await action(page, "Delete Row").click()
    assert.equal(await cell(page, 21).inputValue(), "Supplier 020")
    await cell(page, 0).click()
    await action(page, "Row Above").click()
    assert.equal(await cell(page, 0).inputValue(), "Supplier", "row insertion cannot replace header")
    await action(page, "Save").click()
    await dialog(page).waitFor({ state: "hidden" })
    const inserted = await page.evaluate(() => window.__ccinfoTableHarness.current)
    assert.equal(inserted.table[21][0], "Inserted above")
    assert.equal(inserted.rowUpdates[22], "2026-09-24T01:00:00.000Z", "existing row timestamp follows its row")
    assert.equal(inserted.table.length, inserted.rowUpdates.length)
    console.log("PASS: adjacent insertion, deletion, header safety, and row timestamp alignment")

    await reset()
    await openEditor(page)
    await cell(page, 4, 2).click()
    await action(page, "Col Left").click()
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-column") === "2")
    assert.equal(await cell(page, 0, 3).inputValue(), "VLSFO")
    await action(page, "Col Right").click()
    assert.equal(await cell(page, 0, 4).inputValue(), "VLSFO")
    await action(page, "Delete Column").click()
    assert.equal(await cell(page, 0, 3).inputValue(), "VLSFO")
    await cell(page, 4, 2).click()
    await action(page, "Delete Column").click()
    assert.equal(await cell(page, 0, 2).inputValue(), "VLSFO")
    await cell(page, 78, 6).click()
    await page.evaluate(() => navigator.clipboard.writeText("Paste A\tPaste B\nPaste C\tPaste D"))
    await action(page, "Paste").click()
    await waitForValue(cell(page, 78, 6), "Paste A")
    assert.equal(await cell(page, 79, 7).inputValue(), "Paste D")
    await action(page, "Save").click()
    await dialog(page).waitFor({ state: "hidden" })
    const pasted = await page.evaluate(() => window.__ccinfoTableHarness.current)
    assert.equal(pasted.table[79][7], "Paste D")
    assert.equal(pasted.table[0].length, 8)
    assert.ok(Math.abs(pasted.columnWidths.reduce((sum, value) => sum + value, 0) - 100) < 0.1)
    console.log("PASS: column insertion/deletion and rectangular clipboard paste")

    await reset()
    await openEditor(page)
    await cell(page, 1).click()
    await page.keyboard.press("Tab")
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-column")), "1", "Tab advances to next cell")
    await page.keyboard.press("Shift+Tab")
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-column")), "0", "Shift+Tab returns to previous cell")
    const handle = dialog(page).locator('[data-ccinfo-column-resize="0"]')
    const handleBounds = await handle.boundingBox()
    assert.ok(handleBounds)
    await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + handleBounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(handleBounds.x + handleBounds.width / 2 - 45, handleBounds.y + handleBounds.height / 2)
    await page.mouse.up()
    await cell(page, 1).press("Meta+Enter")
    await dialog(page).waitFor({ state: "hidden" })
    const resized = await page.evaluate(() => window.__ccinfoTableHarness.current)
    assert.notEqual(resized.columnWidths[0], 22, "resizing changes saved column widths")
    assert.equal(resized.columnWidths[0] + resized.columnWidths[1], 30, "resizing preserves adjacent width total")
    assert.deepEqual(resized.table, await page.evaluate(() => window.__ccinfoTableHarness.baseline.table))
    await openEditor(page)
    const savedWidth = await dialog(page).locator("col").first().evaluate((node) => node.style.width)
    assert.equal(savedWidth, `${resized.columnWidths[0]}%`, "saved width survives reopening")
    await action(page, "Cancel").click()
    console.log("PASS: keyboard cell navigation, column resize persistence, and Cmd+Enter save")

    await reset()
    await openEditor(page)
    await cell(page, 80, 7).click()
    await page.evaluate(() => navigator.clipboard.writeText("Edge A\tEdge B\nEdge C\tEdge D"))
    await action(page, "Paste").click()
    await waitForValue(cell(page, 81, 8), "Edge D")
    await action(page, "Save").click()
    await dialog(page).waitFor({ state: "hidden" })
    const expanded = await page.evaluate(() => window.__ccinfoTableHarness.current)
    assert.equal(expanded.table.length, 82)
    assert.equal(expanded.table[0].length, 9)
    assert.equal(expanded.columnWidths.length, 9)
    assert.equal(expanded.rowUpdates.length, 82)
    assert.equal(expanded.table[79][0], "Supplier 079", "expanding paste preserves existing rows")
    console.log("PASS: clipboard paste safely expands table rows and columns")

    await reset()
    await openEditor(page)
    await cell(page, 1).click()
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "readText", {
        configurable: true,
        value: () => new Promise((resolve) => { window.__ccinfoReleaseClipboard = resolve }),
      })
    })
    await action(page, "Paste").click()
    await page.waitForFunction(() => Boolean(window.__ccinfoReleaseClipboard))
    assert.equal(await action(page, "Save").isDisabled(), true, "save waits for a pending paste")
    assert.equal(await action(page, "Cancel").isDisabled(), false, "pending clipboard permission can be canceled")
    await action(page, "Cancel").click()
    await dialog(page).waitFor({ state: "hidden" })
    await openEditor(page)
    await cell(page, 1).fill("New editing session")
    await page.evaluate(async () => {
      window.__ccinfoReleaseClipboard("Stale clipboard text\tMust not appear")
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    assert.equal(await cell(page, 1).inputValue(), "New editing session", "an old paste cannot overwrite a reopened editor")
    assert.equal(await cell(page, 1, 1).inputValue(), "Y")
    assert.equal(await cell(page, 81).count(), 0)
    assert.equal(await dialog(page).getByRole("alert").count(), 0)
    await action(page, "Save").click()
    await dialog(page).waitFor({ state: "hidden" })
    assert.equal(await page.evaluate(() => window.__ccinfoTableHarness.current.table[1][0]), "New editing session")
    console.log("PASS: canceled deferred clipboard read cannot mutate a later editing session")

    await reset()
    await openEditor(page)
    await cell(page, 1).fill("Keep my draft")
    await page.evaluate(() => { window.__ccinfoTableHarness.failNext = true })
    await action(page, "Save").click()
    await dialog(page).getByRole("alert").waitFor()
    assert.equal(await cell(page, 1).inputValue(), "Keep my draft")
    assert.equal(await page.evaluate(() => window.__ccinfoTableHarness.current.table[1][0]), "Supplier 001")
    await page.evaluate(() => { window.__ccinfoTableHarness.deferSave = true })
    await cell(page, 1).press("Control+Enter")
    await page.waitForFunction(() => Boolean(window.__ccinfoTableHarness.releaseSave))
    assert.equal(await cell(page, 1).isDisabled(), true, "cells disabled while saving")
    assert.equal(await action(page, "Add Row").isDisabled(), true, "structural edits disabled while saving")
    assert.equal(await action(page, "Cancel").isDisabled(), true, "cancel disabled while saving")
    await page.keyboard.press("Escape")
    assert.equal(await dialog(page).isVisible(), true, "Escape does not discard an in-flight save")
    await page.keyboard.press("Control+Enter")
    assert.equal(await page.evaluate(() => window.__ccinfoTableHarness.calls), 2, "pending shortcut does not duplicate save")
    await page.evaluate(() => window.__ccinfoTableHarness.releaseSave())
    await dialog(page).waitFor({ state: "hidden" })
    assert.equal(await page.evaluate(() => window.__ccinfoTableHarness.saved.length), 1)
    await openEditor(page)
    assert.equal(await cell(page, 1).inputValue(), "Keep my draft")
    await action(page, "Cancel").click()
    console.log("PASS: failed-save draft retention, retry, save shortcut, and pending-save deduplication")

    await reset()
    await openEditor(page)
    await cell(page, 1).fill("Discard me")
    const canceledResize = await dialog(page).locator('[data-ccinfo-column-resize="0"]').boundingBox()
    assert.ok(canceledResize)
    await page.mouse.move(canceledResize.x + canceledResize.width / 2, canceledResize.y + canceledResize.height / 2)
    await page.mouse.down()
    await page.mouse.move(canceledResize.x + canceledResize.width / 2 - 35, canceledResize.y + canceledResize.height / 2)
    await page.mouse.up()
    await cell(page, 1, 2).click()
    await action(page, "Col Left").click()
    page.once("dialog", (prompt) => prompt.dismiss())
    await page.keyboard.press("Escape")
    assert.equal(await dialog(page).isVisible(), true, "declining discard keeps edit dialog open")
    await closeDiscarding(page, true)
    await openEditor(page)
    assert.equal(await cell(page, 1).inputValue(), "Supplier 001")
    assert.equal(await cell(page, 0, 2).inputValue(), "VLSFO")
    await action(page, "Save").click()
    await dialog(page).waitFor({ state: "hidden" })
    const canceled = await page.evaluate(() => ({ current: window.__ccinfoTableHarness.current, baseline: window.__ccinfoTableHarness.baseline }))
    assert.deepEqual(canceled.current, canceled.baseline, "Cancel restores cells, column widths, and row timestamps")
    console.log("PASS: Escape discard confirmation and full draft rollback")

    await reset("?readOnly=1")
    assert.equal(await page.getByRole("button", { name: "Edit", exact: true }).count(), 0)
    assert.equal(await page.locator("dialog[open]").count(), 0)
    assert.equal(await page.evaluate(() => window.__ccinfoTableHarness.calls), 0)
    console.log("PASS: read-only table cannot enter editing")

    await page.setViewportSize({ width: 390, height: 700 })
    await reset()
    await openEditor(page)
    await assertInViewport(action(page, "Add Row"), "mobile Add Row")
    await assertInViewport(action(page, "Save"), "mobile Save")
    await action(page, "Add Row").click()
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-row") === "81")
    await assertInViewport(cell(page, 81), "mobile added cell")
    await cell(page, 81).fill("Mobile supplier")
    await action(page, "Save").click()
    await dialog(page).waitFor({ state: "hidden" })
    assert.equal(await page.evaluate(() => window.__ccinfoTableHarness.current.table[81][0]), "Mobile supplier")
    assert.deepEqual(errors, [], "no uncaught browser errors")
    console.log("PASS: mobile long-table editing and no browser errors")
  } finally {
    if (browser) await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
