// Actual page + navigation + module/global CSS; all service data is synthetic.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const path = require("node:path")
const { build } = require("esbuild")
const postcss = require("postcss")
const tailwind = require("@tailwindcss/postcss")
const { chromium, webkit } = require("playwright")
const root = path.resolve(__dirname, "..")
const mocks = {
  "@/lib/useSimpleAdminAuth": "export const useSimpleAdminAuth=()=>window.__techStackHarness.auth;",
  "next/navigation": "const router={push:path=>window.__techStackHarness.routes.push(path),replace:path=>window.__techStackHarness.routes.push(path),prefetch:()=>{}};export const useRouter=()=>router;export const usePathname=()=>'/admin/techstack';",
  "next/link": "import React from 'react';export default function Link({prefetch,...props}){return <a {...props}/>;}",
  "next/image": "import React from 'react';export default function Image({priority,unoptimized,fill,...props}){return <img {...props}/>;}",
}
async function main() {
  const output = process.env.TECH_STACK_SCREENSHOTS
  assert.ok(output && path.isAbsolute(output), "An owned absolute evidence directory is required.")
  fs.mkdirSync(output, { recursive: true })
  const bundle = await build({
    absWorkingDir: root, entryPoints: ["tests/fixtures/tech-stack-reliability.tsx"],
    bundle: true, write: false, outdir: "tech-stack-fixture", platform: "browser", format: "iife",
    jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "synthetic-auth-and-navigation", setup(builder) {
      builder.onResolve({ filter: /^(?:@\/lib\/useSimpleAdminAuth|next\/(?:navigation|link|image))$/ }, args => ({ path: args.path, namespace: "synthetic" }))
      builder.onLoad({ filter: /.*/, namespace: "synthetic" }, args => ({ contents: mocks[args.path], loader: "jsx", resolveDir: root }))
    } }],
  })
  const assets = new Map(bundle.outputFiles.map(file => ["/" + path.basename(file.path), file.contents]))
  const script = [...assets.keys()].find(name => name.endsWith(".js"))
  const styles = [...assets.keys()].filter(name => name.endsWith(".css"))
  const globalCss = await postcss([tailwind()]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/globals.css">' + styles.map(href => '<link rel="stylesheet" href="' + href + '">').join("") + '</head><body><div id="root"></div><script src="' + script + '"></script></body></html>'
  const server = http.createServer((request, response) => {
    if (request.method !== "GET") { response.writeHead(405); return response.end() }
    const pathname = new URL(request.url, "http://127.0.0.1").pathname
    if (assets.has(pathname)) { response.setHeader("Content-Type", pathname.endsWith(".css") ? "text/css" : "text/javascript"); return response.end(assets.get(pathname)) }
    if (pathname === "/globals.css") { response.setHeader("Content-Type", "text/css"); return response.end(globalCss.css) }
    if (pathname === "/fc-uno-sidebar-logo.png") { response.setHeader("Content-Type", "image/png"); return response.end(fs.readFileSync(path.join(root, "public/fc-uno-sidebar-logo.png"))) }
    if (pathname !== "/") { response.writeHead(404); return response.end() }
    response.setHeader("Content-Type", "text/html"); response.end(html)
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = "http://127.0.0.1:" + server.address().port
  const results = []
  try {
    for (const [engine, launcher] of [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await launcher.launch({ headless: true, ...(engine === "chromium" && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) })
      try {
        for (const width of [320, 390, 1440]) for (const scheme of ["light", "dark"]) {
          const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, colorScheme: scheme })
          try {
            const page = await context.newPage(), errors = [], unexpected = []
            page.setDefaultTimeout(6000)
            page.on("pageerror", error => errors.push(error.message))
            await context.route("**/*", route => {
              if (new URL(route.request().url()).origin === origin) return route.continue()
              unexpected.push(route.request().url()); return route.abort()
            })
            await page.goto(origin)
            await page.getByRole("heading", { name: "CURRENT DEPLOYMENT", exact: true }).waitFor()
            const label = engine + "-" + width + "-" + scheme
            await page.screenshot({ path: path.join(output, label + "-initial-error.png"), fullPage: true })
            const alert = page.getByRole("alert")
            await alert.waitFor()
            assert.match(await alert.innerText(), /unavailable|could not|unable/i)
            await page.screenshot({ path: path.join(output, label + "-error-viewport.png") })
            const refresh = () => page.getByRole("button", { name: "REFRESH", exact: true })
            await page.evaluate(() => { window.__techStackHarness.mode = "ok" })
            await refresh().click()
            await page.getByText("aaaaaaa", { exact: true }).waitFor()
            assert.equal(await alert.count(), 0)
            for (const mode of ["http", "invalid"]) {
              await page.evaluate(mode => { window.__techStackHarness.mode = mode }, mode)
              await refresh().click(); await alert.waitFor()
              assert.equal(await page.getByText("aaaaaaa", { exact: true }).count(), 1, "Last verified response is retained.")
              assert.match(await alert.innerText(), /last|previous/i)
            }
            await page.evaluate(() => { window.__techStackHarness.mode = "defer" })
            await refresh().click()
            await page.waitForFunction(() => window.__techStackHarness.pending.length === 1)
            assert.equal(await page.getByRole("button", { name: "REFRESHING...", exact: true }).isDisabled(), true)
            await page.evaluate(() => {
              const h = window.__techStackHarness
              h.auth = { ...h.auth, authenticated: false }; h.render()
            })
            await page.waitForFunction(() => window.__techStackHarness.routes.includes("/admin"))
            assert.equal(await page.getByRole("heading", { name: "CURRENT DEPLOYMENT", exact: true }).count(), 0)
            await page.evaluate(() => {
              const h = window.__techStackHarness
              h.mode = "ok"; h.auth = { ...h.auth, authenticated: true }; h.render()
            })
            await page.getByText("aaaaaaa", { exact: true }).waitFor()
            await page.evaluate(() => {
              const h = window.__techStackHarness
              h.pending.shift().resolve(Response.json(h.response("b".repeat(40))))
            })
            await page.waitForTimeout(50)
            assert.equal(await page.getByText("bbbbbbb", { exact: true }).count(), 0, "Cancelled old response cannot overwrite the new session.")
            const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
            assert.ok(dimensions.scroll <= dimensions.width + 1, JSON.stringify(dimensions))
            await page.screenshot({ path: path.join(output, label + "-verified.png"), fullPage: true })
            await page.screenshot({ path: path.join(output, label + "-verified-viewport.png") })
            assert.deepEqual(errors, []); assert.deepEqual(unexpected, [])
            results.push({ engine, width, scheme, networkRecovery: "pass", invalidResponse: "pass", staleResponse: "ignored", signedOut: "no data", dimensions })
          } finally { await context.close() }
        }
      } finally { await browser.close() }
    }
    assert.equal(results.length, 12)
    const receipt = { passed: results.length, failed: 0, screenshots: output, results, limits: ["Synthetic auth and API; actual component/navigation/module/global CSS.", "The shipped admin palette is fixed light under both OS preferences.", "No physical device or production mutation."] }
    fs.writeFileSync(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2))
    console.log(JSON.stringify(receipt))
  } finally { await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
