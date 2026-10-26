// Actual System Health page/navigation/CSS; synthetic auth and API only.
// Isolated headless contexts, no personal Chrome, live services or mutations.
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
  "@/lib/useSimpleAdminAuth": "export const useSimpleAdminAuth=()=>window.__storageMediaHealthHarness.auth;export const clearAdminClientSessionCache=()=>{};",
  "next/navigation": "const router={push:p=>window.__storageMediaHealthHarness.routes.push(p),replace:p=>window.__storageMediaHealthHarness.routes.push(p),prefetch:()=>{}};export const useRouter=()=>router;export const usePathname=()=>'/admin/systemhealth';",
  "next/link": "import React from 'react';export default function Link({prefetch,...props}){return <a {...props}/>;}",
  "next/image": "import React from 'react';export default function Image({priority,unoptimized,fill,...props}){return <img {...props}/>;}",
}
async function main() {
  const output = process.env.STORAGE_MEDIA_HEALTH_SCREENSHOTS
  assert.ok(output && path.isAbsolute(output), "Owned absolute screenshot directory required")
  fs.mkdirSync(output, { recursive: true })
  const bundle = await build({ absWorkingDir: root, entryPoints: ["tests/fixtures/storage-media-system-health.tsx"], bundle: true,
    write: false, outdir: "storage-media-health-fixture", platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "synthetic-auth-navigation", setup(builder) {
      builder.onResolve({ filter: /^(?:@\/lib\/useSimpleAdminAuth|next\/(?:navigation|link|image))$/ }, args => ({ path: args.path, namespace: "synthetic" }))
      builder.onLoad({ filter: /.*/, namespace: "synthetic" }, args => ({ contents: mocks[args.path], loader: "jsx", resolveDir: root }))
    } }],
  })
  const assets = new Map(bundle.outputFiles.map(file => ["/" + path.basename(file.path), file.contents]))
  const global = await postcss([tailwind()]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })
  const js = [...assets.keys()].find(key => key.endsWith(".js")), css = [...assets.keys()].filter(key => key.endsWith(".css"))
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/globals.css">' + css.map(href => `<link rel="stylesheet" href="${href}">`).join("") + `</head><body><div id="root"></div><script src="${js}"></script></body></html>`
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname
    if (req.method !== "GET") { res.writeHead(405); return res.end() }
    if (assets.has(pathname)) { res.setHeader("Content-Type", pathname.endsWith(".css") ? "text/css" : "text/javascript"); return res.end(assets.get(pathname)) }
    if (pathname === "/globals.css") { res.setHeader("Content-Type", "text/css"); return res.end(global.css) }
    if (pathname === "/fc-uno-sidebar-logo.png") { res.setHeader("Content-Type", "image/png"); return res.end(fs.readFileSync(path.join(root, "public/fc-uno-sidebar-logo.png"))) }
    if (pathname !== "/") { res.writeHead(404); return res.end() }
    res.setHeader("Content-Type", "text/html"); res.end(html)
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`, results = []
  try {
    for (const [engine, launcher] of [["chromium", chromium], ["webkit", webkit]]) {
      const executablePath = engine === "chromium" ? process.env.CHROME_EXECUTABLE_PATH : process.env.WEBKIT_EXECUTABLE_PATH
      const browser = await launcher.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
      try {
        for (const width of [320, 390, 1440]) for (const scheme of ["light", "dark"]) {
          const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: scheme })
          try {
            const page = await context.newPage(), errors = [], external = []
            page.setDefaultTimeout(6000)
            page.on("pageerror", error => errors.push(error.message))
            await context.route("**/*", route => {
              if (new URL(route.request().url()).origin === origin) return route.continue()
              external.push(route.request().url()); return route.abort()
            })
            await page.goto(origin)
            const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "UPLOADED-FILE BACKUP", exact: true }) })
            await card.waitFor()
            const states = []
            for (const mode of ["inactive", "pending", "verified", "paused", "overdue", "unknown"]) {
              await page.evaluate(mode => { window.__storageMediaHealthHarness.mode = mode }, mode)
              await page.getByRole("button", { name: "REFRESH", exact: true }).click()
              await page.getByRole("button", { name: "REFRESH", exact: true }).waitFor()
              const text = await card.innerText()
              assert.match(text, /UPLOADED-FILE BACKUP/)
              if (mode === "verified") assert.match(text, /EVERY CURRENT UPLOADED FILE HAS A RECENT VERIFIED CLOUD BACKUP/)
              if (mode === "paused") assert.match(text, /PAUSED.*CLOUD BUDGET/)
              if (mode === "unknown") assert.match(text, /NOT BEEN MARKED AS RECOVERED/)
              const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
              assert.ok(dimensions.scroll <= dimensions.width + 1, `${engine} ${width} ${scheme} ${mode} ${JSON.stringify(dimensions)}`)
              await card.scrollIntoViewIfNeeded()
              const screenshot = `${engine}-${width}-${scheme}-${mode}.png`
              await page.screenshot({ path: path.join(output, screenshot), fullPage: true })
              const bounds = await card.boundingBox()
              assert.ok(bounds && bounds.width > 150 && bounds.x >= 0 && bounds.x + bounds.width <= width + 1)
              states.push({ mode, dimensions, screenshot })
            }
            await page.evaluate(() => {
              const h = window.__storageMediaHealthHarness; h.auth = { ...h.auth, authenticated: false }; h.render()
            })
            await page.waitForFunction(() => window.__storageMediaHealthHarness.routes.includes("/admin"))
            assert.equal(await card.count(), 0)
            await page.screenshot({ path: path.join(output, `${engine}-${width}-${scheme}-signed-out.png`), fullPage: true })
            assert.deepEqual(errors, []); assert.deepEqual(external, [])
            results.push({ engine, width, scheme, states, signedOut: "no backup data" })
          } finally { await context.close() }
        }
      } finally { await browser.close() }
    }
    assert.equal(results.length, 12)
    const receipt = { cases: results.length, stateChecks: results.length * 6, passed: true, output, results,
      limitations: ["Actual component, navigation and module/global CSS; synthetic auth/API.", "Fixed shipped admin palette checked under both OS colour preferences.", "No physical phone or native Safari, Outlook email transformation or live service mutation."] }
    fs.writeFileSync(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt))
  } finally { await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
