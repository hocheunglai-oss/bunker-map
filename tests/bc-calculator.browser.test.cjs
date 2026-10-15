/* Real CCINFO page and styles, synthetic loopback database, isolated browsers.
 * NODE_PATH=<directory containing playwright> node tests/bc-calculator.browser.test.cjs
 * No production data, account credentials, or personal browser profile is used.
 */
const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const path = require("node:path")
const { build } = require("esbuild")
const postcss = require("postcss")
const tailwind = require("@tailwindcss/postcss")

const root = path.resolve(__dirname, "..")
const id = "00000000-0000-0000-0000-000000000001"
const timestamp = "2026-10-15T01:00:00.000Z"
const screenshotDirectory = process.env.BC_SCREENSHOT_DIR || "/tmp/bc-calculator-verification"
const untouchedTable = { title: "UNCHANGED TABLE", info: "", blocks: [], table: [["Supplier", "Remarks"], ["Synthetic supplier", "Preserve this table"]], column_widths: [65, 35], table_row_updates: ["", timestamp] }

async function main() {
  fs.mkdirSync(screenshotDirectory, { recursive: true })
  const record = {
    id, name: "SYNTHETIC BC CALCULATOR COMPANY", notes: "Unchanged general information", updated_at: timestamp,
    summary: JSON.stringify({
      sections: [
        { title: "BC CALCULATOR", info: "", blocks: [] },
        { title: "OTHER TAB", info: "Original unrelated tab note", blocks: [{ id: "other-note", content: "Original unrelated tab note", updated_at: timestamp }], sections: [untouchedTable] },
      ],
      main_line_updates: {}, main_blocks: [{ id: "main-note", content: "Unchanged general information", updated_at: timestamp }], main_sections: [untouchedTable],
    }),
  }
  const writes = []
  const reads = []
  let holdNextPatch = false
  let heldPatch = null
  let releasePatch = null
  let failNextPatch = false
  let sequence = 0
  const bundle = await build({
    absWorkingDir: root,
    stdin: {
      contents: 'import React from "react"; import { createRoot } from "react-dom/client"; import Page from "./app/admin/ccinfo/page"; createRoot(document.getElementById("root")).render(<div className="fc-admin-scope"><Page /></div>);',
      resolveDir: root, sourcefile: "bc-calculator-page-fixture.tsx", loader: "tsx",
    },
    bundle: true, write: false, outdir: "bc-calculator-browser-fixture",
    platform: "browser", format: "iife", jsx: "automatic", logLevel: "warning",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{
      name: "synthetic-local-ccinfo-dependencies",
      setup(builder) {
        builder.onResolve({ filter: /^@\/lib\/(supabase|useSimpleAdminAuth)$/ }, (args) => ({ path: args.path, namespace: "synthetic-local-bc" }))
        builder.onLoad({ filter: /.*/, namespace: "synthetic-local-bc" }, (args) => ({
          resolveDir: root,
          contents: args.path.endsWith("/supabase")
            ? 'import { createClient } from "@supabase/supabase-js"; export const supabase = createClient(location.origin, "synthetic-local-only-key", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });'
            : 'export const useSimpleAdminAuth = () => ({ loading: false, authenticated: !new URL(location.href).searchParams.has("signedOut") });',
        }))
      },
    }],
  })
  const stylesheet = await postcss([tailwind({ base: root })]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })
  const assets = new Map(bundle.outputFiles.map((file) => [`/${path.basename(file.path)}`, file.contents]))
  assets.set("/actual-global-styles.css", stylesheet.css)
  const js = [...assets.keys()].find((name) => name.endsWith(".js"))
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>BC Calculator verification</title><link rel="stylesheet" href="/actual-global-styles.css"></head><body><div id="root"></div><script src="${js}"></script></body></html>`
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1")
      response.setHeader("Cache-Control", "no-store")
      if (url.pathname.startsWith("/rest/v1/")) {
        const table = url.pathname.slice("/rest/v1/".length)
        response.setHeader("Content-Type", "application/json")
        if (request.method === "PATCH") {
          assert.equal(table, "cc_companies", "calculator may write only the synthetic company")
          assert.equal(url.searchParams.get("id"), `eq.${id}`)
          const chunks = []
          for await (const chunk of request) chunks.push(chunk)
          const body = JSON.parse(Buffer.concat(chunks).toString())
          if (holdNextPatch) {
            holdNextPatch = false
            heldPatch = { body, version: url.searchParams.get("updated_at") }
            await new Promise((resolve) => { releasePatch = resolve })
            releasePatch = null
          }
          if (failNextPatch) {
            failNextPatch = false
            response.writeHead(503).end(JSON.stringify({ message: "Synthetic database unavailable" }))
            return
          }
          if (url.searchParams.get("updated_at") !== `eq.${record.updated_at}`) {
            response.writeHead(406).end(JSON.stringify({ code: "PGRST116", message: "Synthetic version conflict" }))
            return
          }
          writes.push({ body, version: url.searchParams.get("updated_at") })
          Object.assign(record, body, { updated_at: `2026-10-15T01:00:${String(++sequence).padStart(2, "0")}.000Z` })
          response.end(JSON.stringify(request.headers.accept?.includes("application/vnd.pgrst.object+json") ? record : [record]))
          return
        }
        reads.push(table)
        response.end(JSON.stringify(table === "cc_companies" ? request.headers.accept?.includes("application/vnd.pgrst.object+json") ? record : [record] : []))
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
    } catch (error) {
      console.error(error)
      response.writeHead(500).end(JSON.stringify({ message: String(error) }))
    }
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const browsers = []
  const verified = []
  const unavailable = []
  const { chromium, webkit } = require("playwright")
  try {
    for (const [engine, browserType] of [["chromium", chromium], ["webkit", webkit]]) {
      let browser
      try {
        browser = await browserType.launch({ headless: true, ...(engine === "chromium" && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) })
      } catch (error) {
        unavailable.push({ engine, error: error.message.split("\n").slice(0, 5).join("\n") })
        continue
      }
      browsers.push(browser)
      const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, colorScheme: "light" })
      await context.route("**/*", (route) => route.request().url().startsWith(`${baseUrl}/`) ? route.continue() : route.abort())
      const page = await context.newPage()
      page.setDefaultTimeout(8000)
      const pageErrors = []
      page.on("pageerror", (error) => pageErrors.push(error.message))
      const calculator = () => page.locator('section[aria-label="BC Calculator"]')
      const openCalculator = async () => { await page.getByText("BC CALCULATOR", { exact: true }).click(); await calculator().waitFor() }
      const input = (name) => calculator().getByRole("spinbutton", { name, exact: true })
      const value = async (name, next) => input(name).fill(next)
      const result = async (expected, gradeCount) => {
        await calculator().getByText(`BC · ${expected}`, { exact: true }).waitFor()
        assert.equal(await calculator().getByText(`BC: ${expected}`, { exact: true }).count(), gradeCount)
      }
      const stored = () => JSON.parse(record.summary)
      const preserved = () => {
        assert.equal(record.notes, "Unchanged general information")
        assert.deepEqual(stored().main_sections[0].table, untouchedTable.table)
        assert.deepEqual(stored().sections[1].sections[0].table, untouchedTable.table)
      }
      const saveCalculator = async () => {
        await calculator().getByRole("button", { name: "Save calculator", exact: true }).click()
        await calculator().getByText("Saved", { exact: true }).waitFor()
      }
      const waitHeld = async () => {
        const deadline = Date.now() + 5000
        while (!releasePatch && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
        assert.ok(releasePatch, "calculator save reached the synthetic database")
      }
      await page.goto(`${baseUrl}/admin/ccinfo?kind=company&id=${id}`)
      await openCalculator()
      if (engine === "chromium") {
        await calculator().getByText("BC · —", { exact: true }).waitFor()
        assert.equal(await calculator().getByRole("spinbutton").count(), 11, "three grade quantity/buy/sell inputs plus two lumpsum inputs")
        assert.equal(await calculator().getByRole("spinbutton", { name: /Lumpsum quantity/ }).count(), 0)
        await value("Grade 1 quantity", "200")
        await value("Grade 1 buy", "886")
        await value("Grade 1 sell", "940")
        await value("Grade 2 quantity", "75")
        await value("Grade 2 buy", "1200")
        await value("Grade 2 sell", "1320")
        await result("59.4", 2)
        await calculator().getByText("BC: —", { exact: true }).waitFor()
        await saveCalculator()
        assert.equal(stored().sections[0].bc_calculator.grades[0].quantity, "200")
        assert.equal(stored().sections[0].bc_calculator.grades[1].sell, "1320")
        preserved()
        await page.reload()
        await openCalculator()
        await result("59.4", 2)
        assert.equal(await input("Grade 1 buy").inputValue(), "886")
        console.log("PASS: actual page calculates 59.4 for each active grade, excludes empty Grade 3, and saves/reloads all inputs while preserving unrelated data")

        await value("Grade 3 quantity", "25")
        await value("Grade 3 buy", "500")
        await value("Grade 3 sell", "700")
        await value("Lumpsum buy", "100")
        await value("Lumpsum sell", "400")
        await result("69.025", 3)
        await value("Grade 3 sell", "800")
        await result("75.9", 3)
        await page.getByRole("button", { name: "GENERAL INFORMATION", exact: true }).click()
        await page.getByRole("button", { name: "Save", exact: true }).click()
        await page.getByText("Saved.", { exact: true }).waitFor()
        assert.equal(stored().sections[0].bc_calculator.grades[2].sell, "800")
        await page.reload()
        await openCalculator()
        await result("75.9", 3)
        assert.equal(await input("Lumpsum buy").inputValue(), "100")
        preserved()
        console.log("PASS: Grade 3 and lump sum participate in arithmetic; tab switching retains edits and header Save persists the calculator")

        await value("Grade 1 sell", "950")
        heldPatch = null
        holdNextPatch = true
        await calculator().getByRole("button", { name: "Save calculator", exact: true }).click()
        await waitHeld()
        assert.equal(JSON.parse(heldPatch.body.summary).sections[0].bc_calculator.grades[0].sell, "950")
        await value("Grade 1 sell", "960")
        const firstFinished = page.waitForResponse((response) => response.request().method() === "PATCH")
        releasePatch()
        await firstFinished
        await calculator().getByText("Unsaved changes", { exact: true }).waitFor()
        assert.equal(stored().sections[0].bc_calculator.grades[0].sell, "950")
        assert.equal(await input("Grade 1 sell").inputValue(), "960")
        await result("86.9", 3)
        await saveCalculator()
        assert.equal(stored().sections[0].bc_calculator.grades[0].sell, "960")
        console.log("PASS: a delayed calculator acknowledgement preserves newer typing as unsaved until its own save")

        await value("Grade 1 sell", "970")
        holdNextPatch = true
        await calculator().getByRole("button", { name: "Save calculator", exact: true }).click()
        await waitHeld()
        await value("Grade 1 sell", "980")
        await page.getByText("OTHER TAB", { exact: true }).click()
        await page.getByText("Original unrelated tab note", { exact: true }).dblclick()
        await page.locator("textarea").fill("Updated unrelated tab note during calculator save")
        await page.getByRole("button", { name: "Save", exact: true }).last().click()
        const beforeQueued = writes.length
        releasePatch()
        await page.locator("textarea").waitFor({ state: "hidden" })
        await page.getByText("Updated unrelated tab note during calculator save", { exact: true }).waitFor()
        assert.equal(writes.length, beforeQueued + 2, "calculator and other-tab saves both acknowledge")
        assert.equal(stored().sections[0].bc_calculator.grades[0].sell, "980")
        assert.equal(stored().sections[1].info, "Updated unrelated tab note during calculator save")
        await openCalculator()
        assert.equal(await input("Grade 1 sell").inputValue(), "980")
        preserved()
        console.log("PASS: delayed calculator and queued other-tab saves advance the record version and preserve newer calculator edits plus other-tab changes")

        await value("Grade 2 sell", "1340")
        failNextPatch = true
        const beforeFailed = structuredClone(record)
        await calculator().getByRole("button", { name: "Save calculator", exact: true }).click()
        await calculator().getByText("Could not save. Your values are still here; try again.", { exact: true }).waitFor()
        assert.deepEqual(record, beforeFailed)
        assert.equal(await input("Grade 2 sell").inputValue(), "1340")
        await saveCalculator()
        await value("Grade 3 quantity", "-1")
        assert.equal(await calculator().getByRole("button", { name: "Save calculator" }).isDisabled(), true)
        await calculator().getByText("BC · —", { exact: true }).waitFor()
        await value("Grade 3 quantity", "25")
        await calculator().getByText("Saved", { exact: true }).waitFor()
        console.log("PASS: failed save retains values and supports retry; negative quantity suppresses BC and calculator saving")

        await value("Grade 1 sell", "940")
        await value("Grade 2 sell", "1320")
        for (const field of ["Grade 3 quantity", "Grade 3 buy", "Grade 3 sell", "Lumpsum buy", "Lumpsum sell"]) await value(field, "")
        await result("59.4", 2)
        await saveCalculator()
      }

      for (const width of [1440, 320, 390]) {
        await page.setViewportSize({ width, height: width > 500 ? 1100 : 844 })
        for (const colorScheme of ["light", "dark"]) {
          await page.emulateMedia({ colorScheme })
          await calculator().waitFor()
          await page.waitForTimeout(80)
          await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); document.querySelector("main").scrollTo(0, 0) })
          const geometry = await page.evaluate(() => {
            const region = document.querySelector('section[aria-label="BC Calculator"]')
            const rect = region.getBoundingClientRect()
            const inputs = [...region.querySelectorAll("input")].map((node) => ({ width: node.getBoundingClientRect().width, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right }))
            const settings = document.querySelector('[aria-label="CCINFO settings"]')?.getBoundingClientRect()
            const obstructedLabels = settings ? [...region.querySelectorAll("label")].filter((node) => {
              const bounds = node.getBoundingClientRect()
              return settings.left < bounds.right && settings.right > bounds.left && settings.top < bounds.bottom && settings.bottom > bounds.top
            }).map((node) => node.textContent.trim()) : []
            const styles = getComputedStyle(region)
            return { scrollWidth: document.documentElement.scrollWidth, width: innerWidth, regionLeft: rect.left, regionRight: rect.right, inputs, obstructedLabels, text: styles.color, panelBackground: getComputedStyle(region.querySelector("div h3").parentElement).backgroundColor }
          })
          assert.ok(geometry.scrollWidth <= width + 1, `${engine} ${width}px ${colorScheme}: no horizontal page overflow (${geometry.scrollWidth}px)`)
          assert.ok(geometry.regionLeft >= -1 && geometry.regionRight <= width + 1)
          assert.ok(geometry.inputs.every((item) => item.width > 100 && item.left >= 0 && item.right <= width + 1), "all grade and lumpsum inputs are contained and readable")
          assert.deepEqual(geometry.obstructedLabels, [], `${engine} ${width}px: CCINFO settings must not cover calculator labels or inputs`)
          if (width <= 500) {
            const settings = page.getByRole("button", { name: "CCINFO settings", exact: true })
            assert.equal(await settings.count(), 1)
            await settings.click()
            const countryIndex = page.getByRole("link", { name: "Country Index", exact: true })
            await countryIndex.waitFor()
            assert.ok((await countryIndex.boundingBox()).y > (await settings.boundingBox()).y, "mobile Settings menu opens below the toolbar")
            if (width === 320 && colorScheme === "light") await page.screenshot({ path: path.join(screenshotDirectory, `${engine}-${width}-settings-menu.png`), fullPage: true })
            await settings.click()
            await countryIndex.waitFor({ state: "hidden" })
          }
          const output = path.join(screenshotDirectory, `${engine}-${width}-${colorScheme}.png`)
          await page.screenshot({ path: output, fullPage: true })
          if (width > 500) {
            await page.evaluate(() => { const main = document.querySelector("main"); main.scrollTo(0, main.scrollHeight) })
            await page.screenshot({ path: path.join(screenshotDirectory, `${engine}-${width}-${colorScheme}-bottom.png`), fullPage: true })
          }
          verified.push({ engine, width, colorScheme, screenshot: output, geometry })
        }
      }
      const beforeDeniedReads = reads.length
      const beforeDeniedWrites = writes.length
      await page.goto(`${baseUrl}/admin/ccinfo?kind=company&id=${id}&signedOut=1`)
      await page.getByText("Access Denied", { exact: true }).waitFor()
      assert.equal(await calculator().count(), 0)
      assert.equal(reads.length, beforeDeniedReads, "signed-out page auth prevents database reads")
      assert.equal(writes.length, beforeDeniedWrites)
      assert.deepEqual(pageErrors, [], `${engine}: no uncaught browser errors`)
      await context.close()
      console.log(`PASS: ${engine} desktop, narrow and representative mobile layouts under light and dark OS preferences; signed-out page-level denial without database access`)
    }
    assert.ok(verified.some((entry) => entry.engine === "chromium"), "Chromium verification must run")
    fs.writeFileSync(path.join(screenshotDirectory, "verification.json"), JSON.stringify({ verified, unavailable, writes: writes.length, limitation: "Synthetic auth and database verify page integration; production session, RLS, AdminNavigationShell, and actual iOS devices are outside this fixture. Admin CSS uses a fixed light palette under both OS color preferences." }, null, 2))
    console.log(JSON.stringify({ screenshots: screenshotDirectory, engines: [...new Set(verified.map((entry) => entry.engine))], unavailable, writes: writes.length }))
  } finally {
    if (releasePatch) releasePatch()
    for (const browser of browsers) await browser.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
