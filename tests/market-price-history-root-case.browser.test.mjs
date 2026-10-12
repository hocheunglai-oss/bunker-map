import assert from "node:assert/strict"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { build } from "esbuild"
import { setupMarketHistoryApp } from "./fixtures/market-price-history-app.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const bundle = await build({ absWorkingDir: root,
  stdin: { contents: 'import React from "react";import {createRoot} from "react-dom/client";import HK from "./app/admin/hongkongpricehistory/page";import TW from "./app/admin/taiwanpricehistory/page";const Page=location.pathname==="/taiwan"?TW:HK;createRoot(document.getElementById("root")).render(<React.StrictMode><Page/></React.StrictMode>);', resolveDir: root, loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "synthetic-session", setup(builder) {
    builder.onResolve({ filter: /^@\/lib\/(supabase|useSimpleAdminAuth)$/ }, () => ({ path: "fixture", namespace: "fixture" }))
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export function useSimpleAdminAuth(){return {loading:false,authenticated:true,role:"BT",permissions:{"hongkong-price-history":"edit","taiwan-price-history":"edit"}}}export const supabase={from(){throw Error("Legacy write used")}};', loader: "js" }))
  } }],
})
let app, browser
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1")
    if (url.pathname === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].contents); return }
    if (["/api/admin/price-history", "/api/admin/report-publication"].includes(url.pathname)) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const route = url.pathname.endsWith("report-publication") ? app.publicationRoute : app.route
      const response = await route[req.method](new Request(url, { method: req.method, headers: req.headers, ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}) }))
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return
    }
    res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>')
  } catch { res.statusCode = 500; res.end("Synthetic fixture failure") }
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const origin = `http://127.0.0.1:${server.address().port}`
try {
  browser = await require("playwright").chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" })
  for (const market of ["hongkong", "taiwan"]) {
    app = await setupMarketHistoryApp()
    const context = await browser.newContext({ timezoneId: "America/Los_Angeles", viewport: { width: 1400, height: 1000 } })
    try {
      await app.db.exec(`reset role;${readFileSync(path.join(root, "supabase/migrations/20261012114731_normalize_market_history_root_lookup.sql"), "utf8")};set role service_role`)
      const rawNames = (await app.db.query("update ports set name=' '||upper(name)||' ' where lower(name) in ('hong kong','kaohsiung','taichung','keelung','suao','hualien') returning id,name")).rows
      const page = await context.newPage(), errors = [], external = []
      page.setDefaultTimeout(5000); page.on("pageerror", error => errors.push(error.message)); page.on("dialog", dialog => dialog.accept())
      await context.route("**/*", route => { if (new URL(route.request().url()).origin === origin) return route.continue(); external.push(route.request().url()); return route.abort() })
      await page.goto(`${origin}/${market}`)
      const save = page.getByRole("button", { name: "Add Missing Record", exact: true })
      await page.waitForFunction(() => { const button = [...document.querySelectorAll("button")].find(b => b.textContent === "Add As Latest"); return button && !button.disabled }, { timeout: 5000 })
      await page.getByLabel("Date", { exact: true }).fill("2026-10-11")
      await page.getByRole("textbox", { name: "HSFO", exact: true }).fill("0")
      const labels = market === "taiwan" ? ["VLSFO Kaohsiung", "VLSFO Taichung", "MGO Kaohsiung", "MGO Taichung"] : ["VLSFO", "MGO"]
      for (let i = 0; i < labels.length; i++) await page.getByRole("textbox", { name: labels[i], exact: true }).fill(String(800 + i * 10))
      await save.click()
      await page.getByText("History saved. The public report is unchanged until Publish.", { exact: true }).waitFor()
      const sent = app.calls.find(call => call.name === "change_market_price_history")
      assert.ok(sent, "Actual page reached audited history API and SQL")
      assert.ok(sent.args.p_expected_ports.every(p => p.name === rawNames.find(row => row.id === p.id).name), "Raw persisted names retained in CAS")
      const rows = (await app.db.query("select p.name,h.hsfo,h.vlsfo,h.mgo from price_history h join ports p on p.id=h.port_id where h.recorded_at::date='2026-10-11' order by p.id")).rows
      assert.equal(rows.length, market === "taiwan" ? 2 : 1)
      const hsfo = rows.find(row => row.name.trim().toLowerCase() === (market === "taiwan" ? "kaohsiung" : "hong kong"))
      assert.equal(Number(hsfo.hsfo), 0)
      if (market === "taiwan") { const taichung = rows.find(row => row.name.trim().toLowerCase() === "taichung"); assert.equal(taichung.hsfo, null); assert.equal(Number(taichung.vlsfo), 810); assert.equal(Number(taichung.mgo), 830) }
      assert.deepEqual((await app.db.query("select id,name from ports where id=any($1::uuid[]) order by id", [rawNames.map(row => row.id)])).rows, [...rawNames].sort((a, b) => a.id.localeCompare(b.id)))
      assert.deepEqual(errors, []); assert.deepEqual(external, [])
      console.log(`PASS ${market}: actual page → API → SQL with all six capitalised/padded roots, correct per-product mapping and exact raw-name CAS`)
    } finally { await context.close(); await app.db.close(); app = null }
  }
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)) }
