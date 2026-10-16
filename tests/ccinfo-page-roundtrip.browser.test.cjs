/* Actual CCINFO page, synthetic local database, isolated headless browser.
 * Run with node tests/ccinfo-page-roundtrip.browser.test.cjs.
 * No production connection, credentials, or personal browser profile is used.
 */
const assert = require("node:assert/strict")
const http = require("node:http")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const { build } = require("esbuild")

const root = path.resolve(__dirname, "..")
const id = "00000000-0000-0000-0000-000000000001"
const portId = "00000000-0000-0000-0000-000000000002"
const countryId = "00000000-0000-0000-0000-000000000003"
const timestamp = "2026-10-09T01:00:00.000Z"
const generalTable = {
  title: "GENERAL SUPPLIERS", info: "", blocks: [],
  table: [["Supplier", "Remarks"], ["General supplier", "Original general remark"]],
  column_widths: [65, 35], table_row_updates: ["", timestamp],
}
const nestedTable = {
  title: "NESTED SUPPLIERS", info: "", blocks: [],
  table: [["Supplier", "Remarks"], ["Nested supplier", "Original nested remark"]],
  column_widths: [55, 45], table_row_updates: ["", timestamp],
}

async function main() {
  const record = {
    id, name: "SYNTHETIC CCINFO COMPANY", notes: "Unchanged general note", updated_at: timestamp,
    summary: JSON.stringify({
      sections: [
        { title: "NESTED TAB", info: "ORIGINAL TAB NOTE", blocks: [{ id: "tab-note", content: "ORIGINAL TAB NOTE", updated_at: timestamp }], sections: [nestedTable, { title: "NESTED TEXT", info: "ORIGINAL NESTED NOTE", blocks: [{ id: "nested-note", content: "ORIGINAL NESTED NOTE", updated_at: timestamp }] }] },
        { title: "", info: "", blocks: [], sections: [{ ...nestedTable, title: "", table: [["Supplier", "Remarks"], ["Untitled nested supplier", "Preserve legacy parent"]] }] },
      ],
      main_line_updates: {}, main_blocks: [{ id: "main-note", content: "Unchanged general note", updated_at: timestamp }],
      main_sections: [generalTable, { ...generalTable, title: "", table: [["Supplier", "Remarks"], ["Untitled general supplier", "Preserve legacy table"]] }, { title: "MAIN TEXT", info: "ORIGINAL MAIN SECTION NOTE", blocks: [{ id: "main-section-note", content: "ORIGINAL MAIN SECTION NOTE", updated_at: timestamp }] }],
    }),
  }
  const country = { id: countryId, name: "SYNTHETIC COUNTRY", summary: "Old country summary", notes: "Old country note", updated_at: timestamp }
  const port = { id: portId, name: "SYNTHETIC PORT", summary: null, notes: "Unchanged port note", country_id: countryId, country_name: country.name, updated_at: timestamp }
  let countryOptionAvailable = true
  let failNextPatch = false
  let zeroNextPatch = false
  let holdNextPatch = false
  let releasePatch = null
  let heldPatch = null
  let failNextCascade = false
  let cascadeRequests = 0
  let renameFailure = ""
  let holdRename = false
  let releaseRename = null
  let renameSequence = 0
  let canonicalizePortCountry = false
  const renameRequests = []
  let holdCompanyRead = ""
  let releaseRead = null
  const other = { ...structuredClone(record), id: "00000000-0000-0000-0000-000000000004", name: "SECOND SYNTHETIC COMPANY", notes: "Second company note", summary: null }
  const writes = []
  const bundle = await build({
    absWorkingDir: root,
    stdin: {
      contents: 'import React from "react"; import { createRoot } from "react-dom/client"; import Page from "./app/admin/ccinfo/page"; createRoot(document.getElementById("root")).render(<Page />);',
      resolveDir: root, sourcefile: "ccinfo-page-fixture.tsx", loader: "tsx",
    },
    bundle: true, write: false, outdir: "ccinfo-page-browser-fixture",
    platform: "browser", format: "iife", jsx: "automatic", logLevel: "warning",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{
      name: "local-only-page-dependencies",
      setup(builder) {
        if (process.env.CCINFO_PAGE_GIT_REF) builder.onLoad({ filter: /app\/admin\/ccinfo\/page\.tsx$/ }, () => ({ contents: execFileSync("git", ["show", `${process.env.CCINFO_PAGE_GIT_REF}:app/admin/ccinfo/page.tsx`], { cwd: root, encoding: "utf8" }), loader: "tsx", resolveDir: path.join(root, "app/admin/ccinfo") }))
        builder.onResolve({ filter: /^@\/lib\/(supabase|useSimpleAdminAuth|useIsMobile)$/ }, (args) => ({ path: args.path, namespace: "local-ccinfo-fixture" }))
        builder.onLoad({ filter: /.*/, namespace: "local-ccinfo-fixture" }, (args) => ({
          resolveDir: root,
          contents: args.path.endsWith("/supabase")
            ? 'import { createClient } from "@supabase/supabase-js"; export const supabase = createClient(location.origin, "synthetic-local-only-key", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });'
            : args.path.endsWith("/useSimpleAdminAuth")
              ? 'export const useSimpleAdminAuth = () => ({ loading: false, authenticated: true, username:"SYNTHETIC EDITOR",role:"ADMIN",permissions:{ccinfo:"edit"} });'
              : "export const useIsMobile = () => false;",
        }))
      },
    }],
  })
  const assets = new Map(bundle.outputFiles.map((file) => [`/${path.basename(file.path)}`, file.contents]))
  const js = [...assets.keys()].find((name) => name.endsWith(".js"))
  const css = [...assets.keys()].find((name) => name.endsWith(".css"))
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>CCINFO page regression</title>${css ? `<link rel="stylesheet" href="${css}">` : ""}<style>
    :root { --fc-admin-link:#0672ed; --fc-admin-panel-text:#20232a; --fc-admin-panel-bg:#fff; --fc-admin-panel-soft-bg:#f8f9fc; --fc-admin-page-bg:#f4f5f8; --fc-admin-selected-bg:#e7f2ff; --fc-admin-selected-border:#94baff; --fc-admin-border:#ccd0d8; --fc-admin-border-soft:#dfe2e8; --fc-admin-muted:#69707d; --fc-admin-button-bg:#f4f5f8; --fc-admin-button-text:#20232a; --fc-tool-input-bg:#fff; }
    * { box-sizing:border-box; } body { margin:0; font-family:Arial,sans-serif; } button,input { font:inherit; }
  </style></head><body><div id="root"></div><script src="${js}"></script></body></html>`
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1")
    response.setHeader("Cache-Control", "no-store")
    if (url.pathname === "/api/ccinfo/rename-country") {
      assert.equal(request.method, "POST")
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      renameRequests.push(body)
      assert.deepEqual(Object.keys(body).sort(), ["expectedUpdatedAt", "id", "name"])
      assert.equal(body.id, countryId)
      if (holdRename) {
        holdRename = false
        await new Promise((resolve) => { releaseRename = resolve })
        releaseRename = null
      }
      const failure = renameFailure
      renameFailure = ""
      if (failure === "timeout") return // The client's timeout aborts this unacknowledged request.
      if (failure === "country-stage" || failure === "ports-stage") {
        response.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Synthetic transaction rolled back" }))
        return
      }
      if (failure === "invalid") {
        response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid name" }))
        return
      }
      if (failure === "duplicate") {
        response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "Another country already uses this name. Please choose a different name." }))
        return
      }
      if (failure === "ambiguous") {
        response.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "Some ports need a country check before this rename. No changes were saved." }))
        return
      }
      if (failure === "conflict" || body.expectedUpdatedAt !== country.updated_at) {
        response.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Conflict" }))
        return
      }
      if (failure.startsWith("bad-ack")) {
        const invalid = { id: countryId, name: body.name, updated_at: "2099-10-12T08:00:00.123456+00:00" }
        if (failure === "bad-ack-id") invalid.id = id
        if (failure === "bad-ack-name") invalid.name = "WRONG COUNTRY"
        if (failure === "bad-ack-version") invalid.updated_at = body.expectedUpdatedAt
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ record: invalid }))
        return
      }
      const oldName = country.name
      const updatedAt = `2099-10-12T08:00:${String(++renameSequence).padStart(2, "0")}.123456+00:00`
      Object.assign(country, { name: body.name, updated_at: updatedAt })
      if (port.country_id === country.id || (!port.country_id && port.country_name === oldName)) Object.assign(port, { country_name: body.name, updated_at: updatedAt })
      writes.push({ table: "cc_countries", body: { name: body.name }, atomicRename: true })
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ record: { id: country.id, name: country.name, updated_at: country.updated_at } }))
      return
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      const table = url.pathname.slice("/rest/v1/".length)
      if (request.method === "PATCH") {
        const target = table === "cc_companies" ? url.searchParams.get("id") === `eq.${other.id}` ? other : record : table === "cc_ports" ? port : table === "cc_countries" ? country : null
        assert.ok(target, "only the synthetic company, port or country may be updated")
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString())
        if (table === "cc_ports" && Object.keys(body).length === 1 && Object.hasOwn(body, "country_name")) {
          cascadeRequests += 1
          if (failNextCascade) {
            failNextCascade = false
            response.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "Synthetic linked-port failure" }))
          } else {
            if (url.searchParams.get("country_id") === `eq.${port.country_id}` || url.searchParams.get("country_name") === `eq.${port.country_name}`) Object.assign(port, body, { updated_at: new Date().toISOString() })
            response.writeHead(204).end()
          }
          return
        }
        assert.equal(url.searchParams.get("id"), `eq.${target.id}`)
        if (holdNextPatch) {
          holdNextPatch = false
          heldPatch = { table, body, version: url.searchParams.get("updated_at") }
          await new Promise((resolve) => { releasePatch = resolve })
          releasePatch = null
        }
        if (failNextPatch) {
          failNextPatch = false
          response.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "Synthetic database unavailable" }))
          return
        }
        if (zeroNextPatch || (url.searchParams.has("updated_at") && url.searchParams.get("updated_at") !== `eq.${target.updated_at}`)) {
          zeroNextPatch = false
          if (request.headers.accept?.includes("application/vnd.pgrst.object+json")) response.writeHead(406, { "Content-Type": "application/json" }).end(JSON.stringify({ code: "PGRST116", message: "Zero rows returned" }))
          else response.writeHead(204).end()
          return
        }
        writes.push({ table, body, version: url.searchParams.get("updated_at") })
        Object.assign(target, body, { updated_at: new Date().toISOString() })
        if (table === "cc_ports" && canonicalizePortCountry && target.country_id === country.id) target.country_name = country.name
        if (request.headers.prefer?.includes("return=representation")) response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(request.headers.accept?.includes("application/vnd.pgrst.object+json") ? target : [target]))
        else response.writeHead(204).end()
      } else {
        response.setHeader("Content-Type", "application/json")
        const single = request.headers.accept?.includes("application/vnd.pgrst.object+json")
        const data = table === "cc_companies" ? single ? url.searchParams.get("id") === `eq.${other.id}` ? other : record : [record, other]
          : table === "cc_ports" ? single ? port : [port]
            : table === "cc_countries" ? single ? country : countryOptionAvailable ? [country] : []
              : []
        if (table === "cc_companies" && single && url.searchParams.get("id") === `eq.${holdCompanyRead}`) {
          holdCompanyRead = ""
          const heldData = structuredClone(data)
          await new Promise((resolve) => { releaseRead = resolve })
          releaseRead = null
          response.end(JSON.stringify(heldData))
          return
        }
        response.end(JSON.stringify(data))
      }
      return
    }
    if (url.pathname === "/api/admin/audit-logs") {
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({ logs: [] }))
      return
    }
    const asset = assets.get(url.pathname)
    response.setHeader("Content-Type", asset ? url.pathname.endsWith(".css") ? "text/css" : "text/javascript" : "text/html")
    response.end(asset || html)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  let browser
  try {
    const { chromium } = require("playwright")
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    await context.route("**/*", async (route) => {
      if (!route.request().url().startsWith(`${baseUrl}/`)) return route.abort()
      if (route.request().url() === `${baseUrl}/api/ccinfo/rename-country` && renameFailure === "network") {
        renameFailure = ""
        renameRequests.push(JSON.parse(route.request().postData()))
        return route.abort("internetdisconnected")
      }
      if (route.request().url() === `${baseUrl}/api/ccinfo/rename-country` && renameFailure === "lost-ack") {
        renameFailure = ""
        await route.fetch() // Commit at the local server, then lose only its acknowledgement.
        return route.abort("connectionreset")
      }
      return route.continue()
    })
    const page = await context.newPage()
    page.setDefaultTimeout(8000)
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    const dialog = (name) => page.getByRole("dialog", { name: `Edit ${name}`, exact: true })
    const cell = (editor, row, column) => editor.locator(`input[data-row="${row}"][data-column="${column}"]`)
    async function openEditor(name) {
      await page.getByRole("button", { name: "Edit", exact: true }).first().click()
      const editor = dialog(name)
      await editor.waitFor({ state: "visible" })
      return editor
    }
    if (process.argv[2] === "rename-baseline") {
      await page.goto(`${baseUrl}/admin/ccinfo?kind=country&id=${countryId}`)
      await page.getByText("Old country note", { exact: true }).waitFor()
      await page.locator("input[readonly]").dblclick()
      await page.locator("input:focus").fill("BASELINE PARTIAL RENAME")
      failNextCascade = true
      await page.getByRole("button", { name: "Save", exact: true }).last().click()
      const error = page.getByText(/Unable to complete the rename/)
      await error.waitFor()
      assert.equal(country.name, "BASELINE PARTIAL RENAME")
      assert.equal(port.country_name, "SYNTHETIC COUNTRY")
      assert.equal(await error.evaluate((node) => { const box = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) }), false, "failure text is covered by the still-open rename dialog")
      await page.getByRole("button", { name: "Save", exact: true }).last().click()
      await page.waitForTimeout(50)
      assert.equal(cascadeRequests, 1, "same-name retry returns before retrying the failed cascade")
      console.log("BASELINE CONFIRMED: partial country rename, covered failure message and same-name retry no-op")
      return
    }
    if (process.argv[2] === "rename") {
      const renameDialog = dialog("Country")
      const openRename = async (name) => {
        await page.locator("input[readonly]").dblclick()
        await renameDialog.waitFor()
        assert.equal(await renameDialog.getByRole("alert").count(), 0, "opening the dialog clears only its previous error")
        await renameDialog.locator("input").fill(name)
      }
      const waitForHeld = async (read, label) => {
        const deadline = Date.now() + 4000
        while (!read() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
        assert.ok(read(), `${label} reached the synthetic server`)
      }
      await page.goto(`${baseUrl}/admin/ccinfo?kind=country&id=${countryId}`)
      await page.getByText("Old country note", { exact: true }).waitFor()
      for (const [index, failure] of ["country-stage", "ports-stage", "invalid", "network", "timeout", "bad-ack-id", "bad-ack-name", "bad-ack-version"].entries()) {
        const nextName = `RETRY COUNTRY ${index}`
        await openRename(nextName)
        const before = structuredClone({ country, port })
        const beforeRequests = renameRequests.length
        renameFailure = failure
        if (failure === "timeout") await page.evaluate(() => {
          window.__renameOriginalTimeout = window.setTimeout
          window.setTimeout = (callback, delay, ...args) => window.__renameOriginalTimeout(callback, delay === 30_000 ? 80 : delay, ...args)
        })
        await renameDialog.getByRole("button", { name: "Save", exact: true }).click()
        const error = renameDialog.getByRole("alert")
        await error.waitFor().catch(async (cause) => { throw new Error(`${failure}: ${cause.message}; requests=${JSON.stringify(renameRequests)}; body=${await page.locator("body").innerText()}; pageErrors=${JSON.stringify(errors)}`) })
        if (failure === "timeout") await page.evaluate(() => { window.setTimeout = window.__renameOriginalTimeout; delete window.__renameOriginalTimeout })
        assert.deepEqual({ country, port }, before, `${failure} cannot acknowledge or partially change either fixture record`)
        assert.equal(renameRequests.length, beforeRequests + 1)
        assert.equal(renameRequests.at(-1).expectedUpdatedAt, before.country.updated_at)
        assert.equal(await renameDialog.locator("input").inputValue(), nextName)
        assert.equal(await error.evaluate((node) => { const box = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) }), true, "failure is readable inside the topmost dialog, not behind its backdrop")
        assert.equal(await renameDialog.getByRole("button", { name: "Save", exact: true }).isEnabled(), true)
        await renameDialog.getByRole("button", { name: "Save", exact: true }).click()
        await renameDialog.waitFor({ state: "hidden" })
        assert.equal(country.name, nextName)
        assert.equal(port.country_name, nextName)
        assert.equal(renameRequests.at(-1).expectedUpdatedAt, before.country.updated_at, "failed or unverifiable acknowledgements do not advance the client version")
        assert.equal(country.summary, before.country.summary)
        assert.equal(country.notes, before.country.notes)
        const rawVersion = country.updated_at
        await page.getByRole("button", { name: "Save", exact: true }).click()
        await page.getByRole("status").getByText("Saved.", { exact: true }).waitFor()
        assert.equal(writes.at(-1).version, `eq.${rawVersion}`, "subsequent content Save keeps PostgreSQL microseconds and offset exactly")
        assert.equal(Object.hasOwn(writes.at(-1).body, "name"), false, "ordinary country Save cannot bypass the atomic rename operation")
      }
      assert.equal(cascadeRequests, 0, "country rename no longer sends separate browser port cascades")
      console.log("PASS: both transaction-stage failures, invalid input, network/timeout and wrong id/name/version acknowledgements stay visible with draft intact; same-name retry and exact-version content Save work")

      await openRename("NAME ALREADY USED")
      renameFailure = "duplicate"
      const beforeDuplicate = structuredClone({ country, port })
      await renameDialog.getByRole("button", { name: "Save", exact: true }).click()
      await renameDialog.getByRole("alert").filter({ hasText: /already uses this name.*choose a different name/ }).waitFor()
      assert.deepEqual({ country, port }, beforeDuplicate)
      await renameDialog.locator("input").fill("NEW UNIQUE COUNTRY NAME")
      await renameDialog.getByRole("button", { name: "Save", exact: true }).click()
      await renameDialog.waitFor({ state: "hidden" })
      await openRename("CHECK AMBIGUOUS PORTS")
      renameFailure = "ambiguous"
      const beforeAmbiguous = structuredClone({ country, port })
      await renameDialog.getByRole("button", { name: "Save", exact: true }).click()
      await renameDialog.getByRole("alert").filter({ hasText: /ports need a country check.*No changes were saved/ }).waitFor()
      assert.deepEqual({ country, port }, beforeAmbiguous)
      assert.equal(await renameDialog.locator("input").inputValue(), "CHECK AMBIGUOUS PORTS")
      await renameDialog.getByRole("button", { name: "Cancel", exact: true }).click()
      console.log("PASS: duplicate-name400 and ambiguous-port409 preserve the route's actionable nontechnical explanation without changing records or losing the draft")

      await openRename("KEEP CONFLICTED RENAME DRAFT")
      const originalVersion = country.updated_at
      country.updated_at = "2099-10-13T08:00:00.654321+00:00"
      const external = structuredClone({ country, port })
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await renameDialog.getByRole("button", { name: "Save", exact: true }).click()
        await renameDialog.getByRole("alert").filter({ hasText: /entry changed or was removed/ }).waitFor()
        assert.equal(await renameDialog.locator("input").inputValue(), "KEEP CONFLICTED RENAME DRAFT")
        assert.equal(renameRequests.at(-1).expectedUpdatedAt, originalVersion, "conflict retries never adopt another editor's version")
        assert.deepEqual({ country, port }, external)
      }
      await renameDialog.getByRole("button", { name: "Cancel", exact: true }).click()
      await page.reload()
      await page.getByText(country.notes, { exact: true }).waitFor()
      console.log("PASS: HTTP409 preserves the rename draft and retries remain fenced by the original version without rebasing")

      await page.getByText(country.notes, { exact: true }).dblclick()
      await page.locator("textarea").fill("CONTENT SAVED BEFORE RENAME")
      holdNextPatch = true
      await page.getByRole("button", { name: "Save", exact: true }).last().click()
      await waitForHeld(() => releasePatch, "preceding content")
      await openRename("RENAME AFTER EARLIER CONTENT")
      holdRename = true
      const beforePrecedingRequests = renameRequests.length
      await renameDialog.getByRole("button", { name: "Save", exact: true }).click()
      await page.waitForTimeout(30)
      assert.equal(renameRequests.length, beforePrecedingRequests, "rename waits for its preceding content save")
      releasePatch()
      await waitForHeld(() => releaseRename, "rename after preceding content")
      assert.equal(renameRequests.at(-1).expectedUpdatedAt, country.updated_at, "rename consumes the preceding content acknowledgement's raw version")
      assert.equal(await page.getByRole("button", { name: "Saving", exact: true }).first().isDisabled(), true)
      releaseRename()
      await renameDialog.waitFor({ state: "hidden" })
      assert.equal(country.name, "RENAME AFTER EARLIER CONTENT")
      assert.equal(port.country_name, country.name)
      assert.equal(country.notes, "CONTENT SAVED BEFORE RENAME")
      assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isEnabled(), true, "finishing a rename must clear the earlier content save's pending indicator")
      await page.getByRole("button", { name: "Save", exact: true }).click()
      await page.getByRole("status").getByText("Saved.", { exact: true }).waitFor()
      console.log("PASS: country rename queued after a content save consumes its acknowledged version and preserves the saved text")

      await page.getByText(country.notes, { exact: true }).dblclick()
      await page.locator("textarea").fill("CONTENT QUEUED BEHIND RENAME")
      await openRename("ATOMIC QUEUED COUNTRY")
      holdRename = true
      const beforeQueueRequests = renameRequests.length
      const beforeQueueWrites = writes.length
      await renameDialog.locator("input").evaluate((node) => { for (let i = 0; i < 2; i += 1) node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })) })
      await waitForHeld(() => releaseRename, "rename")
      assert.equal(renameRequests.length, beforeQueueRequests + 1, "synchronous double-submit sends one atomic rename")
      assert.equal(await renameDialog.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true)
      assert.equal(await renameDialog.getByRole("button", { name: "Delete this Country", exact: true }).isDisabled(), true)
      assert.equal(await renameDialog.locator("input").isDisabled(), true)
      await renameDialog.locator("input").dispatchEvent("keydown", { key: "Escape" })
      await renameDialog.locator("..").dispatchEvent("click")
      assert.equal(await renameDialog.isVisible(), true, "Escape and backdrop cannot close a pending rename")
      await page.getByPlaceholder("Search company, country or port...").fill("SECOND")
      await page.getByRole("button", { name: /SECOND SYNTHETIC COMPANY/ }).dispatchEvent("click")
      assert.match(page.url(), new RegExp(countryId), "internal navigation remains blocked through the complete atomic operation")
      assert.equal(await renameDialog.isVisible(), true)
      holdNextPatch = true
      await page.getByRole("button", { name: "Save", exact: true }).dispatchEvent("click")
      await page.waitForTimeout(30)
      assert.equal(writes.length, beforeQueueWrites, "queued content waits for atomic rename acknowledgement")
      releaseRename()
      await renameDialog.waitFor({ state: "hidden" })
      await waitForHeld(() => releasePatch, "queued content")
      assert.equal(heldPatch.version, `eq.${country.updated_at}`)
      assert.equal(Object.hasOwn(heldPatch.body, "name"), false, "queued content cannot replay the pre-rename country name")
      await page.getByRole("button", { name: /SECOND SYNTHETIC COMPANY/ }).click()
      await page.getByText(/Please wait for the current save/).waitFor()
      assert.match(page.url(), new RegExp(countryId))
      const queuedFinished = page.waitForResponse((response) => response.request().method() === "PATCH")
      releasePatch()
      await queuedFinished
      await page.locator("textarea").waitFor({ state: "hidden" })
      assert.equal(country.name, "ATOMIC QUEUED COUNTRY")
      assert.equal(port.country_name, "ATOMIC QUEUED COUNTRY")
      assert.equal(country.notes, "CONTENT QUEUED BEHIND RENAME")
      assert.equal(renameRequests.length, beforeQueueRequests + 1)
      console.log("PASS: double-submit, Escape, backdrop, delete and navigation are protected while rename and queued content serialize; content cannot revert the renamed country")

      await page.getByText(country.notes, { exact: true }).dblclick()
      await page.locator("textarea").fill("KEEP CONTENT AFTER RENAME FAILURE")
      await openRename("FAILED QUEUED COUNTRY")
      renameFailure = "country-stage"
      holdRename = true
      const beforeFailedQueue = writes.length
      await renameDialog.getByRole("button", { name: "Save", exact: true }).click()
      await waitForHeld(() => releaseRename, "failed rename")
      await page.getByRole("button", { name: "Save", exact: true }).dispatchEvent("click")
      releaseRename()
      await renameDialog.getByRole("alert").waitFor()
      await page.waitForTimeout(50)
      assert.equal(writes.length, beforeFailedQueue, "a failed rename cancels queued stale writes without sending them")
      assert.equal(await page.locator("textarea").inputValue(), "KEEP CONTENT AFTER RENAME FAILURE")
      await renameDialog.getByRole("button", { name: "Cancel", exact: true }).click()
      await page.getByRole("button", { name: "Save", exact: true }).last().click()
      await page.locator("textarea").waitFor({ state: "hidden" })
      assert.equal(country.notes, "KEEP CONTENT AFTER RENAME FAILURE")
      assert.equal(country.name, "ATOMIC QUEUED COUNTRY")
      console.log("PASS: failed rename never sends its already-queued stale content write; visible content remains available for an explicit retry")

      await openRename("COMMITTED BUT ACKNOWLEDGEMENT LOST")
      renameFailure = "lost-ack"
      const beforeLostWrites = writes.length
      const beforeLostVersion = country.updated_at
      await renameDialog.getByRole("button", { name: "Save", exact: true }).click()
      await renameDialog.getByRole("alert").filter({ hasText: /could not be confirmed/ }).waitFor()
      assert.equal(country.name, "COMMITTED BUT ACKNOWLEDGEMENT LOST")
      assert.equal(port.country_name, country.name)
      await renameDialog.getByRole("button", { name: "Save", exact: true }).click()
      await renameDialog.getByRole("alert").filter({ hasText: /entry changed or was removed/ }).waitFor()
      assert.equal(writes.length, beforeLostWrites + 1, "lost acknowledgement retry cannot commit twice or overwrite the winning version")
      assert.equal(renameRequests.at(-1).expectedUpdatedAt, beforeLostVersion)
      assert.equal(await renameDialog.locator("input").inputValue(), country.name)
      await renameDialog.getByRole("button", { name: "Cancel", exact: true }).click()
      console.log("PASS: a committed rename with lost acknowledgement is labelled uncertain; same-name retry conflicts safely without adopting or overwriting the winning version")

      for (const [kind, target, label] of [["company", record, "Company Name"], ["port", port, "Port"]]) {
        await page.goto(`${baseUrl}/admin/ccinfo?kind=${kind}&id=${target.id}`)
        await page.getByText(target.notes, { exact: true }).waitFor()
        await page.locator("input[readonly]").dblclick()
        const editor = dialog(label)
        await editor.locator("input").fill(`RENAMED EXISTING ${kind.toUpperCase()}`)
        holdNextPatch = true
        const before = writes.length
        const atomicRequests = renameRequests.length
        await editor.locator("input").evaluate((node) => { for (let i = 0; i < 2; i += 1) node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })) })
        await waitForHeld(() => releasePatch, `${kind} rename`)
        assert.equal(await editor.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true)
        releasePatch()
        await editor.waitFor({ state: "hidden" })
        assert.equal(writes.length, before + 1)
        assert.equal(renameRequests.length, atomicRequests, "company and port rename keep their selected-record CAS path")
        await page.getByRole("button", { name: "Save", exact: true }).click()
        await page.getByRole("status").getByText("Saved.", { exact: true }).waitFor()
        assert.equal(target.name, `RENAMED EXISTING ${kind.toUpperCase()}`)
      }
      assert.equal(cascadeRequests, 0)
      assert.deepEqual(errors, [])
      console.log("PASS: existing company/port rename still use one bounded CAS request, reject duplicate submit, and support subsequent ordinary Save")

      await page.goto(`${baseUrl}/admin/ccinfo?kind=port&id=${portId}`)
      await page.getByRole("button", { name: `COUNTRY: ${country.name}`, exact: true }).waitFor()
      Object.assign(country, { name: "SERVER CANONICAL COUNTRY", notes: "Keep newer country note", summary: "Keep newer country summary" })
      const canonicalCountry = structuredClone(country)
      canonicalizePortCountry = true
      await page.getByRole("button", { name: "Save", exact: true }).click()
      await page.getByRole("status").getByText("Saved.", { exact: true }).waitFor()
      await page.getByRole("button", { name: "COUNTRY: SERVER CANONICAL COUNTRY", exact: true }).waitFor()
      assert.equal(port.country_name, country.name)
      const beforeCanonicalRetry = writes.length
      await page.getByRole("button", { name: "Save", exact: true }).click()
      await page.getByRole("status").getByText("Saved.", { exact: true }).waitFor()
      assert.equal(writes.length, beforeCanonicalRetry + 1, "the acknowledged canonical label must remain valid against refreshed country options")
      assert.equal(writes.at(-1).body.country_name, country.name, "a later Save must not replay the stale cached country label")
      assert.deepEqual(country, canonicalCountry, "installing a canonical port acknowledgement cannot write linked-country content")
      assert.deepEqual(errors, [])
      console.log("PASS: port Save installs the server's canonical country relation and options without writing linked-country content or replaying a stale label")
      return
    }
    if (process.argv[2] === "zero-record") {
      record.summary = null
      await page.goto(`${baseUrl}/admin/ccinfo?kind=company&id=${id}`)
      await page.getByText("Unchanged general note", { exact: true }).waitFor()
      zeroNextPatch = true
      const response = page.waitForResponse((response) => response.request().method() === "PATCH").catch((error) => { throw new Error(`${error.message}; page errors: ${JSON.stringify(errors)}; writes: ${writes.length}`) })
      void response.catch(() => {})
      await page.getByRole("button", { name: /^Saved?$/ }).click()
      await response
      await page.waitForTimeout(50)
      assert.equal(await page.getByText("Saved.", { exact: true }).count(), 0, "zero affected rows must never be reported as Saved")
      assert.match(await page.getByRole("status").first().innerText(), /entry changed or was removed/)
      assert.equal(writes.length, 0)
      assert.deepEqual(errors, [])
      console.log("PASS: actual whole-record Save rejects a zero-row/deleted result instead of claiming Saved")
      return
    }
    if (process.argv[2] === "conflicts") {
      await page.goto(`${baseUrl}/admin/ccinfo?kind=company&id=${id}`)
      await page.getByText("General supplier", { exact: true }).waitFor()
      let editor = await openEditor("GENERAL SUPPLIERS")
      await cell(editor, 1, 1).fill("KEEP LOCAL ZERO-ROW DRAFT")
      const beforeZero = structuredClone(record)
      zeroNextPatch = true
      await editor.getByRole("button", { name: "Save", exact: true }).click()
      await editor.getByRole("alert").waitFor()
      assert.equal(await cell(editor, 1, 1).inputValue(), "KEEP LOCAL ZERO-ROW DRAFT")
      assert.deepEqual(record, beforeZero)
      assert.equal(writes.length, 0)
      assert.match(await page.getByRole("status").first().innerText(), /entry changed or was removed/)
      await editor.getByRole("button", { name: "Save", exact: true }).click()
      await editor.waitFor({ state: "hidden" })
      assert.equal(JSON.parse(record.summary).main_sections[0].table[1][1], "KEEP LOCAL ZERO-ROW DRAFT")
      console.log("PASS: zero-row/deleted save does not close the actual table editor or report success; local cells survive and a verified retry works")

      await page.getByText("Unchanged general note", { exact: true }).dblclick()
      await page.locator("textarea").fill("QUEUED GENERAL NOTE")
      holdNextPatch = true
      const beforeQueue = writes.length
      await page.getByRole("button", { name: "Save", exact: true }).last().click()
      while (!releasePatch) await new Promise((resolve) => setTimeout(resolve, 10))
      await page.getByText("NESTED TAB", { exact: true }).click()
      editor = await openEditor("NESTED SUPPLIERS")
      await cell(editor, 1, 1).fill("QUEUED NESTED TABLE")
      await editor.getByRole("button", { name: "Save", exact: true }).click()
      await page.waitForTimeout(50)
      assert.equal(writes.length, beforeQueue, "the second save waits for the first acknowledged version")
      const secondFinished = page.waitForResponse((response) => response.request().method() === "PATCH" && response.request().postData().includes("QUEUED NESTED TABLE"))
      releasePatch()
      await secondFinished
      await editor.waitFor({ state: "hidden" })
      assert.equal(record.notes, "QUEUED GENERAL NOTE")
      const queuedSummary = JSON.parse(record.summary)
      assert.equal(queuedSummary.main_blocks[0].content, "QUEUED GENERAL NOTE")
      assert.equal(queuedSummary.sections[0].sections[0].table[1][1], "QUEUED NESTED TABLE")
      assert.equal(queuedSummary.main_sections[0].table[1][1], "KEEP LOCAL ZERO-ROW DRAFT")
      assert.equal(writes.length, beforeQueue + 2)
      console.log("PASS: concurrent actual-page text and nested-table saves serialize, advance the token, and preserve both payloads plus unrelated tables")
      await page.getByRole("button", { name: "GENERAL INFORMATION", exact: true }).click()

      editor = await openEditor("GENERAL SUPPLIERS")
      await cell(editor, 1, 1).fill("CANCELLED FAILED CELLS MUST NOT LEAK")
      failNextPatch = true
      await editor.getByRole("button", { name: "Save", exact: true }).click()
      await editor.getByRole("alert").waitFor()
      page.once("dialog", (dialog) => dialog.accept())
      await editor.getByRole("button", { name: "Cancel", exact: true }).click()
      await editor.waitFor({ state: "hidden" })
      await page.getByRole("button", { name: "Save", exact: true }).click()
      await page.getByRole("status").getByText("Saved.", { exact: true }).waitFor()
      assert.equal(JSON.parse(record.summary).main_sections[0].table[1][1], "KEEP LOCAL ZERO-ROW DRAFT", "cancelled failed table cells cannot enter a later whole-record save")
      console.log("PASS: cancelling a failed table draft prevents its discarded cells from leaking into a later whole-record Save")

      editor = await openEditor("GENERAL SUPPLIERS")
      await cell(editor, 1, 1).fill("KEEP STALE DRAFT")
      const external = JSON.parse(record.summary)
      external.main_sections[0].table[1][1] = "COLLEAGUE WINNER"
      record.summary = JSON.stringify(external)
      record.updated_at = "2099-10-12T01:00:00.123456Z"
      const beforeStaleWrites = writes.length
      await editor.getByRole("button", { name: "Save", exact: true }).click()
      await editor.getByRole("alert").waitFor()
      assert.equal(await cell(editor, 1, 1).inputValue(), "KEEP STALE DRAFT")
      assert.equal(JSON.parse(record.summary).main_sections[0].table[1][1], "COLLEAGUE WINNER")
      await editor.getByRole("button", { name: "Save", exact: true }).click()
      await page.waitForTimeout(80)
      assert.equal(writes.length, beforeStaleWrites, "retry does not rebase the old draft onto the colleague's token")
      assert.equal(await cell(editor, 1, 1).inputValue(), "KEEP STALE DRAFT")
      console.log("PASS: an external edit rejects stale table saves and retries without overwriting the colleague or dropping local cells")
      await editor.getByRole("button", { name: "Cancel", exact: true }).click()
      await page.reload()
      await page.getByText("COLLEAGUE WINNER", { exact: true }).waitFor()
      for (const reject of [false, true]) {
        holdNextPatch = true
        heldPatch = null
        await page.getByRole("button", { name: "Save", exact: true }).click()
        await page.waitForFunction(() => document.querySelector('button') !== null)
        while (!releasePatch) await new Promise((resolve) => setTimeout(resolve, 10))
        await page.getByPlaceholder("Search company, country or port...").fill("SECOND")
        await page.getByRole("button", { name: /SECOND SYNTHETIC COMPANY/ }).click()
        await page.getByText(/Please wait for the current save/).waitFor()
        assert.match(page.url(), new RegExp(id), "pending saves cannot leave their only retained draft behind")
        if (reject) failNextPatch = true
        const finished = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes(id))
        releasePatch()
        await finished
        await page.waitForTimeout(80)
        await page.getByRole("button", { name: /SECOND SYNTHETIC COMPANY/ }).click()
        await page.getByText("Second company note", { exact: true }).waitFor()
        assert.match(page.url(), new RegExp(other.id))
        assert.equal(await page.getByRole("status").count(), 0, "opening the next entry clears only the completed previous entry status")
        assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isEnabled(), true)
        assert.equal(other.notes, "Second company note")
        assert.match(heldPatch.version, /^eq\./)
        await page.goto(`${baseUrl}/admin/ccinfo?kind=company&id=${id}`)
        await page.getByText("COLLEAGUE WINNER", { exact: true }).waitFor()
      }
      console.log("PASS: navigation waits for pending success/rejection, retains the first entry, then opens the next entry with its own data, message, saving state and URL")

      await page.getByText(record.notes, { exact: true }).dblclick()
      await page.locator("textarea").fill("ACKNOWLEDGED FIRST TEXT")
      holdNextPatch = true
      await page.getByRole("button", { name: "Save", exact: true }).last().click()
      while (!releasePatch) await new Promise((resolve) => setTimeout(resolve, 10))
      await page.locator("textarea").fill("KEEP NEWER TYPING DURING SAVE")
      await page.getByRole("button", { name: "Cancel", exact: true }).click()
      assert.equal(await page.locator("textarea").inputValue(), "KEEP NEWER TYPING DURING SAVE", "General Cancel also waits for the pending save")
      const firstTextFinished = page.waitForResponse((response) => response.request().method() === "PATCH")
      releasePatch()
      await firstTextFinished
      await page.waitForTimeout(50)
      assert.equal(await page.locator("textarea").inputValue(), "KEEP NEWER TYPING DURING SAVE")
      assert.equal(record.notes, "ACKNOWLEDGED FIRST TEXT")
      await page.getByRole("button", { name: "Save", exact: true }).last().click()
      await page.locator("textarea").waitFor({ state: "hidden" })
      assert.equal(record.notes, "KEEP NEWER TYPING DURING SAVE")
      console.log("PASS: typing during a pending text save stays editable and unsaved until its own acknowledged Save")

      for (const [tab, original, key, read] of [
        ["NESTED TAB", "ORIGINAL TAB NOTE", "TAB", (summary) => summary.sections[0].info],
        ["NESTED TAB", "ORIGINAL NESTED NOTE", "NESTED", (summary) => summary.sections[0].sections[1].info],
        ["GENERAL INFORMATION", "ORIGINAL MAIN SECTION NOTE", "MAIN SECTION", (summary) => summary.main_sections[2].info],
      ]) {
        await page.getByText(tab, { exact: true }).click()
        await page.getByText(original, { exact: true }).dblclick()
        await page.locator("textarea").fill(`ACKNOWLEDGED ${key} TEXT`)
        holdNextPatch = true
        await page.getByRole("button", { name: "Save", exact: true }).last().click()
        while (!releasePatch) await new Promise((resolve) => setTimeout(resolve, 10))
        await page.locator("textarea").fill(`NEWER UNSAVED ${key} TYPING`)
        await page.getByRole("button", { name: "Cancel", exact: true }).click()
        assert.equal(await page.locator("textarea").inputValue(), `NEWER UNSAVED ${key} TYPING`, "Cancel cannot discard a draft while its earlier save is pending")
        const finished = page.waitForResponse((response) => response.request().method() === "PATCH")
        releasePatch()
        await finished
        await page.waitForTimeout(50)
        assert.equal(await page.locator("textarea").inputValue(), `NEWER UNSAVED ${key} TYPING`)
        assert.equal(read(JSON.parse(record.summary)), `ACKNOWLEDGED ${key} TEXT`)
        await page.getByRole("button", { name: "Cancel", exact: true }).click()
        await page.locator("textarea").waitFor({ state: "hidden" })
        await page.getByText(`ACKNOWLEDGED ${key} TEXT`, { exact: true }).waitFor()
        await page.getByRole("button", { name: "Save", exact: true }).click()
        await page.getByText("Saved.", { exact: true }).waitFor()
        assert.equal(read(JSON.parse(record.summary)), `ACKNOWLEDGED ${key} TEXT`, "Cancel discards only the newer typing, not the acknowledged save")
      }
      console.log("PASS: tab, nested and main-section Cancel preserves acknowledged text after typing during Save, and waits while Save is pending")

      await page.locator("input[readonly]").dblclick()
      await page.locator("input:focus").fill("RENAMED SYNTHETIC COMPANY")
      await page.getByRole("button", { name: "Save", exact: true }).last().click()
      await page.getByText("Renamed.", { exact: true }).waitFor()
      await page.getByRole("button", { name: "Save", exact: true }).click()
      await page.getByText("Saved.", { exact: true }).waitFor()
      assert.equal(record.name, "RENAMED SYNTHETIC COMPANY")
      assert.equal(record.notes, "KEEP NEWER TYPING DURING SAVE")
      console.log("PASS: rename then ordinary content Save consumes the acknowledged rename version without a false conflict")

      holdCompanyRead = other.id
      await page.getByPlaceholder("Search company, country or port...").fill("SECOND")
      await page.getByRole("button", { name: /SECOND SYNTHETIC COMPANY/ }).click()
      while (!releaseRead) await new Promise((resolve) => setTimeout(resolve, 10))
      await page.getByPlaceholder("Search company, country or port...").fill("SYNTHETIC COUNTRY")
      await page.getByRole("button", { name: /SYNTHETIC COUNTRY/ }).click()
      await page.getByText("Old country note", { exact: true }).waitFor()
      assert.match(page.url(), new RegExp(countryId))
      releaseRead()
      await page.waitForTimeout(80)
      assert.equal(await page.getByText("Second company note", { exact: true }).count(), 0)
      assert.match(page.url(), new RegExp(countryId))
      console.log("PASS: an earlier delayed record load cannot replace a later selection or rewrite its URL")

      await page.locator("input[readonly]").dblclick()
      await page.locator("input:focus").fill("RENAMED SYNTHETIC COUNTRY")
      renameFailure = "ports-stage"
      const beforeRename = structuredClone({ country, port })
      await page.getByRole("button", { name: "Save", exact: true }).last().click()
      await dialog("Country").getByRole("alert").waitFor()
      assert.deepEqual({ country, port }, beforeRename, "atomic rename failure cannot leave a partially renamed country")
      await dialog("Country").getByRole("button", { name: "Save", exact: true }).click()
      await dialog("Country").waitFor({ state: "hidden" })
      assert.equal(country.name, "RENAMED SYNTHETIC COUNTRY")
      await page.getByRole("button", { name: "Save", exact: true }).click()
      await page.getByText("Saved.", { exact: true }).waitFor()
      assert.equal(country.name, "RENAMED SYNTHETIC COUNTRY", "ordinary content Save preserves the acknowledged atomic country rename")
      await page.getByPlaceholder("Search company, country or port...").fill("SYNTHETIC PORT")
      await page.getByRole("button", { name: /SYNTHETIC PORT/ }).click()
      await page.getByText("Unchanged port note", { exact: true }).waitFor()
      await page.getByRole("button", { name: "Save", exact: true }).click()
      await page.getByText("Saved.", { exact: true }).waitFor()
      assert.equal(port.country_name, "RENAMED SYNTHETIC COUNTRY", "same-page country options use the acknowledged rename for later port saves")
      assert.deepEqual(errors, [])
      console.log("PASS: atomic country rename failure retains both records, same-name retry works, later Save retains its name, and same-page port Save uses refreshed country options")
      return
    }
    await page.goto(`${baseUrl}/admin/ccinfo?kind=company&id=${id}`)
    await page.getByText("General supplier", { exact: true }).waitFor()
    await page.getByText("Untitled general supplier", { exact: true }).waitFor()
    let editor = await openEditor("GENERAL SUPPLIERS")
    await cell(editor, 1, 0).fill("Updated general supplier")
    await editor.getByRole("button", { name: "Add Row", exact: true }).click()
    await cell(editor, 2, 0).fill("Appended general supplier")
    await editor.getByRole("button", { name: "Save", exact: true }).click()
    await editor.waitFor({ state: "hidden" })
    assert.equal(writes.length, 1)
    let summary = JSON.parse(record.summary)
    assert.equal(summary.main_sections[0].table[1][0], "Updated general supplier")
    assert.equal(summary.main_sections[0].table[2][0], "Appended general supplier")
    assert.deepEqual(summary.main_sections[0].column_widths, generalTable.column_widths)
    assert.equal(summary.main_sections[0].table_row_updates.length, 3)
    assert.equal(summary.main_sections[1].table[1][0], "Untitled general supplier")
    assert.equal(summary.sections[1].sections[0].table[1][0], "Untitled nested supplier")

    await page.reload()
    await page.getByText("Updated general supplier", { exact: true }).waitFor()
    await page.getByText("Appended general supplier", { exact: true }).waitFor()
    await page.getByText("Untitled general supplier", { exact: true }).waitFor()
    editor = await openEditor("GENERAL SUPPLIERS")
    assert.equal(await cell(editor, 2, 0).inputValue(), "Appended general supplier")
    assert.equal(await editor.locator("col").first().evaluate((node) => node.style.width), "65%")
    await editor.getByRole("button", { name: "Cancel", exact: true }).click()

    await page.getByText("NESTED TAB", { exact: true }).click()
    await page.getByText("Nested supplier", { exact: true }).waitFor()
    editor = await openEditor("NESTED SUPPLIERS")
    await cell(editor, 1, 1).fill("Updated nested remark")
    await editor.getByRole("button", { name: "Save", exact: true }).click()
    await editor.waitFor({ state: "hidden" })
    assert.equal(writes.length, 2)
    summary = JSON.parse(record.summary)
    assert.equal(summary.sections[0].sections[0].table[1][1], "Updated nested remark")
    assert.equal(summary.main_sections[0].table[2][0], "Appended general supplier", "another tab save must preserve reloaded General table")
    assert.equal(summary.main_sections[1].table[1][0], "Untitled general supplier", "another save preserves legacy untitled General table")
    assert.equal(summary.sections[1].sections[0].table[1][0], "Untitled nested supplier", "another save preserves legacy untitled parent tab")
    assert.equal(record.notes, "Unchanged general note")
    await page.reload()
    await page.getByText("Appended general supplier", { exact: true }).waitFor()
    await page.getByText("NESTED TAB", { exact: true }).click()
    await page.getByText("Updated nested remark", { exact: true }).waitFor()
    console.log("PASS: actual CCINFO page loads, edits, saves and reloads General and nested tables; cross-tab saves preserve named and legacy untitled table data")

    const beforeFailedSave = structuredClone(record)
    const beforeFailureWriteCount = writes.length
    failNextPatch = true
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await page.getByRole("status").getByText("Unable to save.", { exact: true }).waitFor()
    assert.deepEqual(record, beforeFailedSave, "a failed synthetic PATCH does not mutate the database")
    assert.equal(writes.length, beforeFailureWriteCount)
    assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isEnabled(), true, "saving finishes after failure")
    await page.getByRole("button", { name: "Dismiss message", exact: true }).click()
    assert.equal(await page.getByRole("status").count(), 0, "the failure status can be dismissed")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await page.getByRole("status").getByText("Saved.", { exact: true }).waitFor()
    assert.equal(writes.length, beforeFailureWriteCount + 1)
    assert.equal(writes.at(-1).table, "cc_companies")
    console.log("PASS: failed save shows a dismissible status, keeps database unchanged, ends saving and allows a confirmed retry")

    await page.goto(`${baseUrl}/admin/ccinfo?kind=port&id=${portId}`)
    await page.getByRole("button", { name: "COUNTRY: SYNTHETIC COUNTRY", exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "Finish Editing", exact: true }).count(), 0, "linked-country editing is not enabled")
    const externalCountry = { ...country, name: "EXTERNALLY UPDATED COUNTRY", summary: "New external country summary", notes: "New external country note", updated_at: "2026-10-09T02:00:00.000Z" }
    Object.assign(country, externalCountry)
    const beforePortSave = writes.length
    const portSaveResponse = page.waitForResponse((response) => response.url().includes("/rest/v1/cc_ports?") && response.request().method() === "PATCH")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await portSaveResponse
    await page.getByRole("status").getByText("Saved.", { exact: true }).waitFor()
    assert.equal(writes.length, beforePortSave + 1, "ordinary port save issues exactly one write")
    assert.equal(writes.at(-1).table, "cc_ports")
    assert.equal(port.country_id, countryId, "the existing country relation is preserved")
    assert.equal(port.country_name, "SYNTHETIC COUNTRY", "the selected valid country name remains associated with the port")
    assert.equal(port.notes, "Unchanged port note")
    assert.deepEqual(country, externalCountry, "port save must not rewrite externally changed linked-country fields")
    console.log("PASS: ordinary port save updates only the port and preserves newer linked-country name, summary, notes and timestamp")

    countryOptionAvailable = false
    await page.reload()
    await page.getByRole("button", { name: "COUNTRY: EXTERNALLY UPDATED COUNTRY", exact: true }).waitFor()
    const beforeInvalidCountrySave = writes.length
    const unchangedPort = { ...port }
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await page.getByRole("status").getByText("Please select an existing country.", { exact: true }).waitFor()
    assert.equal(writes.length, beforeInvalidCountrySave, "an unmatched nonempty country still blocks port save")
    assert.deepEqual(port, unchangedPort)
    assert.deepEqual(country, externalCountry)
    console.log("PASS: port save still validates a nonempty country against existing country options")

    Object.assign(port, { country_id: null, country_name: "" })
    await page.reload()
    await page.getByText("Unchanged port note", { exact: true }).waitFor()
    const beforeUnlinkedPortSave = writes.length
    const unlinkedPortSaveResponse = page.waitForResponse((response) => response.url().includes("/rest/v1/cc_ports?") && response.request().method() === "PATCH")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await unlinkedPortSaveResponse
    await page.getByRole("status").getByText("Saved.", { exact: true }).waitFor()
    assert.equal(writes.length, beforeUnlinkedPortSave + 1)
    assert.equal(writes.at(-1).table, "cc_ports")
    assert.equal(port.country_id, null)
    assert.equal(port.country_name, null)
    assert.deepEqual(country, externalCountry)
    assert.deepEqual(errors, [])
    console.log("PASS: an intentionally unlinked port remains unlinked and never writes a country")
  } finally {
    if (browser) await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
