// Actual homepage components + reader + GET + initial server-page data path.
// Supabase/Next primitives, map tiles and the overview widget are synthetic; no provider,
// personal browser, customer data, authentication or CDN is exercised.
const assert = require("node:assert/strict")
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), crypto = require("node:crypto")
const { build } = require("esbuild"), postcss = require("postcss"), tailwind = require("@tailwindcss/postcss")
const { chromium, webkit } = require("playwright")
const { createHomepageMarketApp } = require("./fixtures/homepage-market-app.cjs")
const root = path.resolve(__dirname, ".."), results = []
const tile = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><path fill="#071a2c" d="M0 0h256v256H0z"/><path fill="none" stroke="#12334b" d="M0 0h256v256H0zM128 0v256M0 128h256"/></svg>'
async function main() {
  const output = process.env.HOMEPAGE_SCREENSHOTS
  assert.ok(output && path.isAbsolute(output), "Use an owned absolute evidence directory")
  fs.mkdirSync(output, { recursive: true })
  const mocks = {
    "next/navigation": "const router={push:p=>window.__homepageHarness.routes.push(p)};export const useRouter=()=>router;",
    "next/link": "import React from 'react';export default function Link({prefetch,...props}){return <a {...props}/>;}",
    "next/image": "import React from 'react';export default function Image({priority,unoptimized,fill,...props}){return <img {...props}/>;}",
  }
  const bundle = await build({ absWorkingDir: root, entryPoints: ["tests/fixtures/homepage-market-browser.tsx"], bundle: true,
    write: false, outdir: "homepage-fixture", platform: "browser", format: "iife", jsx: "automatic",
    loader: { ".png": "dataurl" }, define: { "process.env.NODE_ENV": '"development"', "process.env.NEXT_PUBLIC_MAPTILER_KEY": "undefined", "process.env.NEXT_PUBLIC_MAPTILER_RASTER_STYLE": "undefined" },
    plugins: [{ name: "explicit-next-boundaries", setup(builder) {
      builder.onResolve({ filter: /^next\/(?:navigation|link|image)$/ }, args => ({ path: args.path, namespace: "synthetic" }))
      builder.onLoad({ filter: /.*/, namespace: "synthetic" }, args => ({ contents: mocks[args.path], loader: "jsx", resolveDir: root }))
    } }],
  })
  const assets = new Map(bundle.outputFiles.map(file => ["/" + path.basename(file.path), file.contents]))
  const script = [...assets.keys()].find(name => name.endsWith(".js")), css = [...assets.keys()].filter(name => name.endsWith(".css"))
  const globalCss = (await postcss([tailwind()]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })).css
  let app = createHomepageMarketApp(), apiReads = 0
  const serverErrors = []
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, "GET")
      const url = new URL(request.url, "http://localhost")
      if (assets.has(url.pathname)) { response.setHeader("Content-Type", url.pathname.endsWith(".css") ? "text/css" : "text/javascript"); return response.end(assets.get(url.pathname)) }
      if (url.pathname === "/globals.css") { response.setHeader("Content-Type", "text/css"); return response.end(globalCss) }
      if (url.pathname === "/uno-transparent.png") { response.setHeader("Content-Type", "image/png"); return response.end(fs.readFileSync(path.join(root, "public/uno-transparent.png"))) }
      if (url.pathname === "/favicon.ico") { response.writeHead(204); return response.end() }
      if (url.pathname === "/api/homepage-data") {
        apiReads++; const result = await app.route.GET()
        response.writeHead(result.status, Object.fromEntries(result.headers)); return response.end(await result.text())
      }
      assert.equal(url.pathname, "/")
      const initial = await app.initialData()
      response.setHeader("Content-Type", "text/html")
      response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/globals.css">' + css.map(href => '<link rel="stylesheet" href="' + href + '">').join("") + '</head><body><div id="root" style="width:100vw;height:100vh;overflow:hidden"></div><script>window.__homepageInitial=' + JSON.stringify(initial).replaceAll("<", "\\u003c") + ';window.__homepageShellOnly=' + JSON.stringify(url.searchParams.has("shell")) + ';</script><script src="' + script + '"></script></body></html>')
    } catch (error) { serverErrors.push(error.message); response.writeHead(500); response.end() }
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = "http://127.0.0.1:" + server.address().port
  try {
    for (const [engine, launcher] of [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await launcher.launch({ headless: true })
      try {
        for (const width of [320, 390, 1440]) for (const scheme of ["light", "dark"]) {
          const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, colorScheme: scheme })
          try {
            const page = await context.newPage(), errors = [], external = [], statuses = [], screenshots = []
            page.setDefaultTimeout(12000)
            page.on("pageerror", error => errors.push(error.message))
            page.on("response", response => { if (response.url().endsWith("/api/homepage-data")) statuses.push(response.status()) })
            await context.route("**/*", route => {
              const url = new URL(route.request().url())
              if (url.origin === origin) return route.continue()
              if (/^[abc]\.tile\.openstreetmap\.org$/.test(url.hostname)) return route.fulfill({ status: 200, contentType: "image/svg+xml", body: tile })
              if (url.href === "https://s3.tradingview.com/external-embedding/embed-widget-market-overview.js") {
                return route.fulfill({ status: 200, contentType: "text/javascript", body: "document.currentScript.parentElement.setAttribute('data-synthetic-overview','true')" })
              }
              external.push(url.href); return route.abort()
            })
            const label = `${engine}-${width}-${scheme}`
            const shot = async suffix => {
              const name = `${label}-${suffix}.png`; await page.screenshot({ path: path.join(output, name) }); screenshots.push(name)
              assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "No document horizontal overflow")
            }
            const error = () => page.getByText("Market data is temporarily unavailable.", { exact: true })
            const ready = () => page.waitForFunction(() => window.__homepageHarness?.ready)
            const select = async () => {
              await page.getByPlaceholder(/search/i).fill("Hong Kong")
              await page.getByRole("button", { name: "Hong Kong View", exact: true }).click()
              await page.getByText("Port Pricing", { exact: true }).waitFor()
              await page.getByText("SE", { exact: true }).first().waitFor()
              // The actual page opens/recentres the popup after 700ms, then
              // Leaflet animates it. Inspect the stable view, not a fade frame.
              await page.waitForTimeout(1200)
              await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".leaflet-popup")).opacity) === 1)
            }
            app = createHomepageMarketApp(); await page.goto(origin + "/?shell"); await page.getByRole("img").first().waitFor()
            await shot("server-preview")
            await page.goto(origin); await ready(); await select(); await shot("verified-markers")
            assert.equal(await error().count(), 0)
            app.state.fallbackFailure = true
            await page.evaluate(() => window.__homepageHarness.refresh())
            await error().waitFor(); assert.ok(await page.getByText("SE", { exact: true }).count() > 0)
            if (width < 500) await page.waitForFunction(() => {
              const popup = document.querySelector(".leaflet-popup")
              const warning = document.querySelector('[role="status"]')
              if (!popup || !warning) return false
              const bounds = popup.getBoundingClientRect(), panel = warning.parentElement.getBoundingClientRect()
              return bounds.top >= panel.bottom + 10 && bounds.bottom <= innerHeight
            })
            assert.equal(statuses.at(-1), 502); await shot("refresh-failure-retains-markers")
            await page.reload(); await ready(); await error().waitFor()
            assert.equal(await page.getByText("SE", { exact: true }).count(), 0)
            await shot("cold-failure-unavailable")
            await page.goto(origin + "/?shell"); await error().waitFor()
            assert.equal(await page.getByText("Market data is loading.", { exact: true }).count(), 0)
            await shot("server-failure-unavailable")
            app.state.fallbackFailure = false
            app.state.fallbackResult = { data: { content: '{"hong kong::hsfo":"INVALID"}' }, error: null }
            await page.goto(origin); await ready(); await error().waitFor()
            assert.equal(await page.getByText("INVALID", { exact: true }).count(), 0)
            await shot("corrupt-settings-unavailable")
            app = createHomepageMarketApp(); await page.reload(); await ready(); await select(); await shot("recovered-markers")
            assert.equal(await error().count(), 0)
            assert.deepEqual(errors, []); assert.deepEqual(external, [])
            results.push({ engine, width, scheme, publicSignedOut: true, screenshots, apiStatuses: statuses, pageErrors: errors, externalRequests: external })
          } finally { await context.close() }
        }
      } finally { await browser.close() }
    }
    assert.deepEqual(serverErrors, [])
    const sources = ["lib/publicMarketData.ts", "app/api/homepage-data/route.ts", "app/page.tsx", "components/Homepage.tsx", "components/HomepageShell.tsx"]
    const receipt = { passed: true, matrix: results.length, screenshots: results.reduce((n, item) => n + item.screenshots.length, 0), apiReads, results,
      sourceHashes: Object.fromEntries(sources.map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")])),
      limits: "Actual components/reader/route and initial server-page data; synthetic SDK/Next cache/rendering primitives, map tiles and overview widget. Not hosted SSR/CDN, real provider or physical-device evidence. Existing homepage night palette exercised under both OS preferences." }
    fs.writeFileSync(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n")
    console.log(JSON.stringify(receipt))
  } finally { await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
