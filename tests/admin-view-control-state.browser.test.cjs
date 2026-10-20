// Native properties and raw pointer probes: aria-disabled alone is insufficient.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const http = require("node:http")
const crypto = require("node:crypto")
const { build } = require("esbuild")
const postcss = require("postcss")
const tailwind = require("@tailwindcss/postcss")
const { chromium, webkit } = require("playwright")

const root = path.resolve(__dirname, "..")
const output = process.env.ADMIN_VIEW_CONTROL_EVIDENCE
assert.ok(output && path.isAbsolute(output), "Use an owned absolute evidence directory")
fs.mkdirSync(output, { recursive: true })
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex")
const sources = ["components/AdminRouteGuard.tsx", "lib/useSimpleAdminAuth.ts", "app/admin/phonebook/page.tsx", "tests/fixtures/phonebook-sync-mocks.ts", "tests/fixtures/admin-view-control-state.tsx", "tests/admin-view-control-state.browser.test.cjs"]
const sourceHashes = () => Object.fromEntries(sources.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]))
const before = sourceHashes()
const results = [], errors = [], blocked = [], serverRequests = [], versions = {}
const owned = { servers: 0, browsers: 0, contexts: 0 }
const disabled = ["busy-button", "idle-button", "always-busy", "busy-select", ...["checkbox", "radio", "file", "range", "color"].map(type => "busy-" + type)]
const readonly = ["busy-input", "busy-textarea", "idle-input", "idle-textarea", "always-readonly"]
const busy = ["busy-button", "busy-select", ...["checkbox", "radio", "file", "range", "color"].map(type => "busy-" + type)]
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const snapshot = page => page.evaluate(({ disabled, readonly }) => Object.fromEntries([...disabled, ...readonly].map(id => {
  const element = document.getElementById(id)
  return [id, { disabled: element.disabled, readOnly: element.readOnly, marker: element.dataset.adminViewOnlyDisabled, readonlyMarker: element.dataset.adminViewOnlyReadonly, original: element.dataset.adminOriginallyDisabled, originalReadonly: element.dataset.adminOriginallyReadonly, aria: element.getAttribute("aria-disabled") }]
})), { disabled, readonly })
async function guarded(page) {
  await page.waitForFunction(({ disabled, readonly }) => disabled.every(id => document.getElementById(id)?.disabled === true && document.getElementById(id)?.dataset.adminViewOnlyDisabled === "true") && readonly.every(id => document.getElementById(id)?.readOnly === true && document.getElementById(id)?.dataset.adminViewOnlyReadonly === "true"), { disabled, readonly })
  return snapshot(page)
}
async function probeWrites(page, expected) {
  const statuses = await page.evaluate(async () => {
    const result = []
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) result.push((await fetch("/api/admin/view-control-probe", { method, body: "{}" })).status)
    return result
  })
  assert.deepEqual(statuses, [expected, expected, expected, expected])
  return statuses
}
async function pointer(page, locator) {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  assert.ok(box)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}
async function generic(page) {
  const initial = await guarded(page)
  await page.locator("#busy-button").evaluate(element => { window.__guardOriginalNode = element })
  await page.getByRole("button", { name: "Finish loading", exact: true }).click()
  const afterReact = await guarded(page)
  await page.getByRole("button", { name: "Append row", exact: true }).click()
  await settle(page)
  const afterObserver = await guarded(page)
  for (const id of busy) assert.equal(afterObserver[id].original, "false", id + " latest busy=false intent")
  assert.equal(afterObserver["idle-button"].original, "true", "same-value native writes preserve idle=true intent")
  for (const id of ["busy-input", "busy-textarea"]) assert.equal(afterObserver[id].originalReadonly, "false", id)
  for (const id of ["idle-input", "idle-textarea"]) assert.equal(afterObserver[id].originalReadonly, "true", id)
  const edit = page.locator("#busy-button")
  assert.equal(await edit.isDisabled(), true)
  await pointer(page, edit)
  await pointer(page, page.locator("#idle-button"))
  await page.locator("#busy-input").click()
  await page.keyboard.type("changed")
  await page.locator("#busy-textarea").click()
  await page.keyboard.type("changed")
  assert.equal(await page.locator("#busy-input").inputValue(), "Original input")
  assert.equal(await page.locator("#busy-textarea").inputValue(), "Original textarea")
  await page.getByRole("button", { name: "Save safe fixture", exact: true }).click()
  await page.getByRole("button", { name: "Edit navigation fixture", exact: true }).click()
  await page.getByLabel("Safe filter", { exact: true }).selectOption("b")
  await page.getByLabel("Search fixture", { exact: true }).fill("query")
  assert.equal(await page.getByLabel("Safe filter", { exact: true }).inputValue(), "b")
  assert.equal(await page.getByLabel("Search fixture", { exact: true }).inputValue(), "query")
  const viewWrites = await probeWrites(page, 403)
  const counters = await page.evaluate(() => ({ clicks: window.__adminViewControlState.clicks, safe: window.__adminViewControlState.safeClicks, nav: window.__adminViewControlState.navClicks, writes: window.__adminViewControlState.forwardedWrites }))
  assert.deepEqual(counters, { clicks: 0, safe: 1, nav: 1, writes: [] })
  for (let index = 0; index < 3; index += 1) {
    await page.getByRole("button", { name: "Start loading", exact: true }).click()
    await guarded(page)
    await page.getByRole("button", { name: "Finish loading", exact: true }).click()
    await guarded(page)
  }
  await settle(page)
  const observerBefore = await page.evaluate(() => window.__adminViewControlState.observerCallbacks)
  await settle(page)
  const observerAfter = await page.evaluate(() => window.__adminViewControlState.observerCallbacks)
  assert.equal(observerAfter, observerBefore, "Guard enforcement must not observe its own writes forever")
  assert.ok(observerAfter < 100, "Bounded observer callbacks")

  // Keep the same React controls mounted while the guard leaves View. Pending
  // React writes and cleanup happen in one update, before observer delivery.
  await page.getByRole("button", { name: "Start loading", exact: true }).click()
  await guarded(page)
  await page.getByRole("button", { name: "Finish and leave View", exact: true }).click()
  await page.waitForFunction(() => document.getElementById("busy-button")?.dataset.adminViewOnlyDisabled === undefined)
  const restored = await snapshot(page)
  assert.equal(await edit.evaluate(element => element === window.__guardOriginalNode), true, "Restore the same native node")
  for (const id of busy) assert.equal(restored[id].disabled, false, id + " restored latest busy=false")
  assert.equal(restored["idle-button"].disabled, true, "Preserve app-owned idle=true")
  assert.equal(restored["always-busy"].disabled, true, "Preserve app-owned disabled=true")
  for (const id of ["busy-input", "busy-textarea"]) assert.equal(restored[id].readOnly, false, id)
  for (const id of ["idle-input", "idle-textarea", "always-readonly"]) assert.equal(restored[id].readOnly, true, id)
  assert.ok(Object.values(restored).every(item => !item.marker && !item.readonlyMarker))
  await pointer(page, edit)
  assert.equal(await page.evaluate(() => window.__adminViewControlState.clicks), 1, "Restored enabled button handles pointer normally")

  await page.evaluate(() => window.__adminViewControlState.route("/admin/phonebook"))
  await guarded(page)
  const returnedViewWrites = await probeWrites(page, 403)
  await page.evaluate(() => window.__adminViewControlState.setMode("edit"))
  await page.waitForFunction(() => document.getElementById("busy-button")?.disabled === false && !document.getElementById("busy-button")?.dataset.adminViewOnlyDisabled)
  const editWrites = await probeWrites(page, 200)
  const permissionEdit = await snapshot(page)
  assert.equal(permissionEdit["idle-button"].disabled, true)
  await page.evaluate(() => window.__adminViewControlState.setMode("view"))
  await guarded(page)
  const permissionViewWrites = await probeWrites(page, 403)
  for (const mode of ["none", "signed-out"]) {
    await page.evaluate(mode => window.__adminViewControlState.setMode(mode), mode)
    await page.getByRole("heading", { name: "Access Denied", exact: true }).waitFor()
    assert.equal(await page.locator("#busy-button").count(), 0)
  }
  await page.evaluate(() => window.__adminViewControlState.setMode("view"))
  await guarded(page)
  return { initial, afterReact, afterObserver, restored, permissionEdit, counters, observerCallbacks: observerAfter, viewWrites, returnedViewWrites, editWrites, permissionViewWrites, final: await snapshot(page) }
}
async function phonebook(page) {
  await page.getByRole("button", { name: /^ALPHA SHIPPING/ }).click()
  await page.getByRole("button", { name: /^ALICE TEST/ }).click()
  await page.waitForFunction(() => [...document.querySelectorAll("button")].find(element => element.textContent.trim() === "Edit")?.disabled === true)
  const edit = page.getByRole("button", { name: "Edit", exact: true })
  await edit.evaluate(element => { window.__guardOriginalNode = element })
  const states = []
  for (const name of ["BOB TEST", "ALICE TEST"]) {
    await page.getByRole("button", { name: new RegExp("^" + name) }).click()
    await page.getByRole("button", { name: "Copy name", exact: true }).locator("..").getByText(name, { exact: true }).waitFor()
    await settle(page)
    const state = await edit.evaluate(element => ({ nativeDisabled: element.disabled, marker: element.dataset.adminViewOnlyDisabled, sameNode: element === window.__guardOriginalNode }))
    assert.deepEqual(state, { nativeDisabled: true, marker: "true", sameNode: true })
    await pointer(page, edit)
    states.push(state)
  }
  const viewWrites = await probeWrites(page, 403)
  const transport = await page.evaluate(() => ({ operations: window.__phonebookSyncHarness.operations, writes: window.__adminViewControlState.forwardedWrites }))
  assert.deepEqual(transport, { operations: [], writes: [] })
  return { states, viewWrites, transport }
}

async function main() {
  assert.equal(require("playwright/package.json").version, "1.62.1")
  const bundle = await build({
    absWorkingDir: root, entryPoints: ["tests/fixtures/admin-view-control-state.tsx"],
    bundle: true, write: false, metafile: true, outdir: "view-control-fixture", platform: "browser", format: "iife", jsx: "automatic",
    nodePaths: (process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean),
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "synthetic-sdk-and-navigation-only", setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/supabase$/ }, () => ({ path: path.join(root, "tests/fixtures/phonebook-sync-mocks.ts") }))
      builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" }))
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "import{useSyncExternalStore}from'react';const router={push:()=>{}};const subscribe=fn=>{window.addEventListener('fixture-route',fn);return()=>window.removeEventListener('fixture-route',fn)};export const useRouter=()=>router;export const usePathname=()=>useSyncExternalStore(subscribe,()=>location.pathname);", loader: "js", resolveDir: root }))
    } }],
  })
  const bundled = new Map(bundle.outputFiles.map(file => ["/" + path.basename(file.path), file.contents]))
  const script = [...bundled.keys()].find(file => file.endsWith(".js"))
  const cssPaths = [...bundled.keys()].filter(file => file.endsWith(".css"))
  const globalCss = await postcss([tailwind()]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })
  const publicRoot = fs.realpathSync(path.join(root, "public"))
  const assets = {}
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/globals.css"><link rel="stylesheet" href="/roboto.css">' + cssPaths.map(href => '<link rel="stylesheet" href="' + href + '">').join("") + '<style>main{padding:12px}main>button,main>input,main>textarea,main>select{display:block;margin:6px;max-width:calc(100% - 12px)}button{min-height:36px}body{margin:0}</style></head><body><div id="root"></div><script src="' + script + '"></script></body></html>'
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1")
    serverRequests.push({ method: request.method, path: url.pathname })
    if (request.method !== "GET" || url.pathname.startsWith("/api/")) { response.writeHead(405); response.end(); return }
    if (bundled.has(url.pathname)) { response.setHeader("Content-Type", url.pathname.endsWith(".css") ? "text/css" : "text/javascript"); response.end(bundled.get(url.pathname)); return }
    if (url.pathname === "/globals.css") { response.setHeader("Content-Type", "text/css"); response.end(globalCss.css); return }
    if (url.pathname === "/roboto.css") { const file = path.join(root, "app/fonts/roboto.css"); assets["app/fonts/roboto.css"] = hash(fs.readFileSync(file)); response.setHeader("Content-Type", "text/css"); response.end(fs.readFileSync(file)); return }
    if (url.pathname === "/admin/phonebook") { response.setHeader("Content-Type", "text/html"); response.end(html); return }
    if (url.pathname === "/favicon.ico") { response.writeHead(204); response.end(); return }
    const file = path.resolve(publicRoot, "." + url.pathname)
    if (file.startsWith(publicRoot + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) { const bytes = fs.readFileSync(file); assets[path.relative(root, file)] = hash(bytes); response.setHeader("Content-Type", ({ ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" })[path.extname(file)] || "application/octet-stream"); response.end(bytes); return }
    response.writeHead(404); response.end()
  })
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
    owned.servers += 1
    const origin = "http://127.0.0.1:" + server.address().port
    for (const [engine, browserType] of [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await browserType.launch({ headless: true, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_OPTIONS")) })
      owned.browsers += 1
      versions[engine] = browser.version()
      try {
        for (const width of [320, 390, 1440]) for (const scheme of ["light", "dark"]) for (const variant of ["generic", "phonebook"]) {
          const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, serviceWorkers: "block", acceptDownloads: false })
          owned.contexts += 1
          try {
            await context.route("**/*", route => {
              const request = route.request(), url = new URL(request.url())
              if (url.origin === origin && request.method() === "GET" && !url.pathname.startsWith("/api/")) return route.continue()
              blocked.push({ engine, width, scheme, variant, method: request.method(), origin: url.origin, path: url.pathname })
              return route.abort()
            })
            const page = await context.newPage()
            page.setDefaultTimeout(10000)
            page.on("pageerror", error => errors.push({ engine, width, scheme, variant, error: error.message }))
            await page.goto(origin + "/admin/phonebook?variant=" + variant, { waitUntil: "domcontentloaded" })
            await page.getByText("View-only access. Changes, uploads, syncs, and record actions are disabled.", { exact: true }).waitFor()
            const proof = await (variant === "generic" ? generic(page) : phonebook(page))
            await page.evaluate(() => document.fonts.ready)
            if (width === 320 || width === 1440) await page.screenshot({ path: path.join(output, `${engine}-${width}-${scheme}-${variant}.png`), fullPage: true })
            results.push({ engine, width, scheme, variant, status: "passed", ...proof })
          } finally { await context.close(); owned.contexts -= 1 }
        }
      } finally { await browser.close(); owned.browsers -= 1 }
    }
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      owned.servers -= 1
    }
  }
  assert.deepEqual(sourceHashes(), before)
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  assert.equal(serverRequests.some(request => request.method !== "GET" || request.path.startsWith("/api/")), false)
  assert.equal(results.length, 24)
  assert.deepEqual(owned, { servers: 0, browsers: 0, contexts: 0 })
  const report = { schema: "fcuno.admin-view-control-state/v1", sourceHashes: before, bundleHashes: Object.fromEntries([...bundled].map(([name, bytes]) => [name, hash(bytes)])), assets, versions, results, errors, blocked, serverRequests, cleanup: { allOwnedClosed: true, outstanding: owned, personalBrowserTouched: false }, limits: ["Actual React/provider/guard and Phonebook page; only Next navigation, session and SDK/backend data are synthetic.", "Generic controls prove native state enforcement/restoration, not all existing admin workflows. No real business/provider/server authorization or physical device certification.", "Existing fixed-light styles exercised under both OS color schemes; this change does not add a dark theme."] }
  fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 })
  console.log(JSON.stringify({ results: results.length, output, sha256: hash(fs.readFileSync(path.join(output, "results.json"))), cleanup: report.cleanup }))
}
main().catch(error => {
  fs.writeFileSync(path.join(output, "failure-" + Date.now() + ".json"), JSON.stringify({ error: error.stack, sourceHashes: before, results, errors, blocked, serverRequests, cleanup: { outstanding: owned, allOwnedClosed: Object.values(owned).every(count => count === 0) } }, null, 2) + "\n", { flag: "wx", mode: 0o600 })
  console.error(error.stack)
  process.exitCode = 1
})
