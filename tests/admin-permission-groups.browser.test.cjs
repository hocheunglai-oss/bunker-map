// Source-bound repository software test: synthetic auth/data, owned headless
// Chromium/WebKit and loopback HTTP only. Never uses a personal browser.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const http = require("node:http")
const { createHash } = require("node:crypto")
const { build } = require("esbuild")
const postcss = require("postcss")
const tailwind = require("@tailwindcss/postcss")
const { chromium, webkit } = require("playwright")
const root = path.resolve(__dirname, "..")
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
const sources = ["app/admin/usermanagement/page.tsx", "app/api/admin/users/route.ts", "lib/adminUsers.ts", "lib/auditLog.ts",
  "tests/fixtures/admin-permission-groups.tsx", "app/globals.css", "components/AdminNavigationShell.tsx"]
const bindings = () => Object.fromEntries(sources.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]))
const mocks = {
  "@/lib/useSimpleAdminAuth": "export const useSimpleAdminAuth=()=>window.__permissionGroupHarness.auth;export const clearAdminClientSessionCache=()=>{};",
  "next/navigation": "const router={push:p=>window.__permissionGroupHarness.routes.push(p),replace:p=>window.__permissionGroupHarness.routes.push(p),prefetch:()=>{}};export const useRouter=()=>router;export const usePathname=()=>'/admin/usermanagement';",
  "next/link": "import React from 'react';export default function Link({prefetch,...props}){return <a {...props}/>;}",
  "next/image": "import React from 'react';export default function Image({priority,unoptimized,fill,...props}){return <img {...props}/>;}",
}
async function main() {
  const output = process.env.PERMISSION_GROUP_SCREENSHOTS
  assert.ok(output && path.isAbsolute(output), "An owned absolute evidence directory is required")
  fs.mkdirSync(output, { recursive: true, mode: 0o700 })
  const before = bindings()
  const bundle = await build({ absWorkingDir: root, entryPoints: ["tests/fixtures/admin-permission-groups.tsx"],
    bundle: true, write: false, outdir: "group-software-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' }, plugins: [{ name: "synthetic-auth-navigation", setup(builder) {
      builder.onResolve({ filter: /^(?:@\/lib\/useSimpleAdminAuth|next\/(?:navigation|link|image))$/ }, args => ({ path: args.path, namespace: "synthetic" }))
      builder.onLoad({ filter: /.*/, namespace: "synthetic" }, args => ({ contents: mocks[args.path], loader: "jsx", resolveDir: root }))
    } }] })
  const assets = new Map(bundle.outputFiles.map(file => ["/" + path.basename(file.path), file.contents]))
  const script = [...assets.keys()].find(name => name.endsWith(".js"))
  const css = await postcss([tailwind()]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/globals.css"></head><body><div id="root"></div><script src="' + script + '"></script></body></html>'
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname
    if (request.method !== "GET") { response.writeHead(405); return response.end() }
    if (assets.has(pathname)) { response.setHeader("content-type", "text/javascript"); return response.end(assets.get(pathname)) }
    if (pathname === "/globals.css") { response.setHeader("content-type", "text/css"); return response.end(css.css) }
    if (pathname === "/fc-uno-sidebar-logo.png") { response.setHeader("content-type", "image/png"); return response.end(fs.readFileSync(path.join(root, "public/fc-uno-sidebar-logo.png"))) }
    if (pathname !== "/") { response.writeHead(404); return response.end() }
    response.setHeader("content-type", "text/html"); response.end(html)
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = "http://127.0.0.1:" + server.address().port, results = []
  try {
    for (const [engine, launcher] of [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await launcher.launch({ headless: true })
      try {
        for (const width of [320, 390, 1440]) for (const scheme of ["light", "dark"]) {
          const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, colorScheme: scheme })
          try {
            const page = await context.newPage(), errors = [], unexpected = [], label = `${engine}-${width}-${scheme}`
            page.setDefaultTimeout(8000)
            page.on("pageerror", error => errors.push(error.message))
            await context.route("**/*", route => {
              if (new URL(route.request().url()).origin === origin) return route.continue()
              unexpected.push(route.request().url()); return route.abort()
            })
            await page.goto(origin)
            const field = () => page.getByRole("group", { name: "User Management permission", exact: true })
            await field().waitFor()
            await field().getByRole("button", { name: "Edit", exact: true }).click()
            const draftVersion = await page.evaluate(() => window.__permissionGroupHarness.groups.find(g => g.role === "AC").version)
            const reads = await page.evaluate(() => window.__permissionGroupHarness.reads)
            await page.getByRole("button", { name: "Save Permissions", exact: true }).click()
            await page.getByRole("alert").waitFor()
            assert.equal(await field().getByRole("button", { name: "Edit", exact: true }).getAttribute("aria-pressed"), "true")
            const request = await page.evaluate(() => window.__permissionGroupHarness.requests.at(-1))
            assert.equal(request.roleDefault.expectedVersion, draftVersion)
            assert.equal(request.roleDefault.permissions["user-management"], "edit")
            assert.equal(await page.evaluate(() => window.__permissionGroupHarness.reads), reads, "409 must not reload or silently discard a draft")
            const reload = page.getByRole("button", { name: "Reload groups", exact: true })
            const box = await reload.boundingBox()
            assert.ok(box.x >= 0 && box.x + box.width <= width + 1)
            await page.screenshot({ path: path.join(output, label + "-conflict.png"), fullPage: true })
            page.once("dialog", dialog => dialog.dismiss())
            await reload.click()
            assert.equal(await field().getByRole("button", { name: "Edit", exact: true }).getAttribute("aria-pressed"), "true")
            page.once("dialog", dialog => dialog.accept())
            await reload.click()
            await page.waitForFunction(count => window.__permissionGroupHarness.reads > count, reads)
            await field().locator('button[aria-pressed="true"]').filter({ hasText: /^View$/ }).waitFor()
            assert.equal(await field().getByRole("button", { name: "View", exact: true }).getAttribute("aria-pressed"), "true")
            assert.equal(await page.getByRole("alert").count(), 0)
            await page.evaluate(() => { window.__permissionGroupHarness.mode = "ok" })
            await field().getByRole("button", { name: "Edit", exact: true }).click()
            await page.getByRole("button", { name: "Save Permissions", exact: true }).click()
            await page.getByRole("status").filter({ hasText: "AC permissions saved." }).waitFor()
            assert.equal(await field().getByRole("button", { name: "Edit", exact: true }).getAttribute("aria-pressed"), "true")
            await page.screenshot({ path: path.join(output, label + "-edit.png"), fullPage: true })
            await page.evaluate(() => { const h = window.__permissionGroupHarness; h.auth = { ...h.auth, permissions: { "user-management": "view" } }; h.render() })
            await page.waitForFunction(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'Save Permissions')?.disabled)
            for (const button of await field().getByRole("button").all()) assert.equal(await button.isDisabled(), true)
            await page.screenshot({ path: path.join(output, label + "-view.png"), fullPage: true })
            const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
            assert.ok(dimensions.scroll <= dimensions.width + 1, JSON.stringify(dimensions))
            await page.evaluate(() => { const h = window.__permissionGroupHarness; h.auth = { ...h.auth, authenticated: false }; h.render() })
            await page.getByText("Please log in from the admin homepage first.", { exact: true }).waitFor()
            assert.equal(await page.getByText("Permission Groups", { exact: true }).count(), 0)
            await page.screenshot({ path: path.join(output, label + "-signed-out.png"), fullPage: true })
            assert.deepEqual(errors, []); assert.deepEqual(unexpected, [])
            results.push({ engine, width, scheme, conflictDraftPreserved: true, explicitReloadConfirmation: true,
              correctVersionSent: true, saveResponseRendered: true, viewWritesDisabled: true, signedOutProtected: true, dimensions })
          } finally { await context.close() }
        }
      } finally { await browser.close() }
    }
    const after = bindings(); assert.deepEqual(after, before); assert.equal(results.length, 12)
    const receipt = { schema: "fcuno.permission-groups-browser/v1", checkedAt: new Date().toISOString(), sourceBefore: before, sourceAfter: after,
      sourceUnchanged: true, passed: 12, failed: 0, results, resourcesClosed: true,
      limits: ["Actual page/navigation/global CSS; synthetic auth and API responses only.", "Owned headless Chromium/WebKit on loopback, not physical phones or live production login."] }
    fs.writeFileSync(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt))
  } finally { await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
