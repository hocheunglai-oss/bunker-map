// Real admin layout/provider/guard + actual pages/hooks/styles. Only framework
// navigation facades and in-memory API transport are synthetic. No credentials.
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
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex")
const baseline = process.argv.includes("--expect-disabled")
const smoke = process.argv.includes("--smoke")
const pages = [
  { key: "usage", path: "/admin/openaiusage", id: "openai-usage", selectors: ["Usage period"] },
  { key: "hongkong", path: "/admin/hongkongpricehistory", id: "hongkong-price-history", selectors: ["Year", "Month"] },
  { key: "taiwan", path: "/admin/taiwanpricehistory", id: "taiwan-price-history", selectors: ["Year", "Month"] },
  { key: "outlook", path: "/admin/outlookaddressbook", id: "outlook-addressbook", selectors: ["Directory source book"] },
]
const framework = {
  "next/navigation": "const router={push:path=>window.__viewFilterHarness.routes.push(path),replace:path=>window.__viewFilterHarness.routes.push(path),prefetch:()=>{}};export const useRouter=()=>router;export const usePathname=()=>location.pathname;",
  "next/link": "import React from 'react';export default function Link({prefetch,...props}){return <a {...props}/>;}",
  "next/image": "import React from 'react';export default function Image({priority,unoptimized,fill,...props}){return <img {...props}/>;}",
}

async function main() {
  const output = process.env.ADMIN_VIEW_FILTERS_SCREENSHOTS
  assert.ok(output && path.isAbsolute(output), "Use an owned absolute evidence directory")
  fs.mkdirSync(output, { recursive: true })
  const bundle = await build({
    absWorkingDir: root, entryPoints: ["tests/fixtures/admin-view-filters.tsx"],
    bundle: true, write: false, metafile: true, outdir: "admin-view-filters-fixture",
    platform: "browser", format: "iife", jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"development"',
      "process.env.NEXT_PUBLIC_SUPABASE_URL": '"http://127.0.0.1:65535"',
      "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": '"synthetic-view-filter-anonymous-key"',
    },
    plugins: [{ name: "framework-navigation-only", setup(builder) {
      builder.onResolve({ filter: /^next\/(?:navigation|link|image)$/ }, args => ({ path: args.path, namespace: "framework" }))
      builder.onLoad({ filter: /.*/, namespace: "framework" }, args => ({ contents: framework[args.path], loader: "jsx", resolveDir: root }))
    } }],
  })
  const bundled = new Map(bundle.outputFiles.map(file => ["/" + path.basename(file.path), file.contents]))
  const script = [...bundled.keys()].find(name => name.endsWith(".js"))
  const cssPaths = [...bundled.keys()].filter(name => name.endsWith(".css"))
  const globalCss = await postcss([tailwind()]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })
  const fontPath = "/fonts/roboto/roboto-v51-latin.0a44e0bb6ba5c853.woff2"
  const fontCss = fs.readFileSync(path.join(root, "app/fonts/roboto.css"))
  const publicRoot = fs.realpathSync(path.join(root, "public")), assets = new Map(), missing = []
  const contentTypes = { ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" }
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="preload" href="'+fontPath+'" as="font" type="font/woff2" crossorigin="anonymous"><link rel="stylesheet" href="/roboto.css"><link rel="stylesheet" href="/globals.css">'+cssPaths.map(href=>'<link rel="stylesheet" href="'+href+'">').join("")+'</head><body><div id="root"></div><script src="'+script+'"></script></body></html>'
  const server = http.createServer((request, response) => {
    if (request.method !== "GET") { response.writeHead(405); response.end(); return }
    let pathname
    try { pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname) } catch { response.writeHead(400); response.end(); return }
    if (bundled.has(pathname)) { response.setHeader("Content-Type", pathname.endsWith(".css") ? "text/css" : "text/javascript"); response.end(bundled.get(pathname)); return }
    if (pathname === "/globals.css") { response.setHeader("Content-Type", "text/css"); response.end(globalCss.css); return }
    if (pathname === "/roboto.css") { assets.set("app/fonts/roboto.css", hash(fontCss)); response.setHeader("Content-Type", "text/css"); response.end(fontCss); return }
    if (pathname === "/favicon.ico") { response.writeHead(204); response.end(); return }
    const candidate = path.resolve(publicRoot, "." + pathname)
    if (candidate.startsWith(publicRoot + path.sep) && fs.existsSync(candidate)) {
      const file = fs.realpathSync(candidate)
      if (file.startsWith(publicRoot + path.sep) && fs.statSync(file).isFile()) {
        const bytes = fs.readFileSync(file); assets.set(path.relative(root, file), hash(bytes))
        response.setHeader("Content-Type", contentTypes[path.extname(file)] || "application/octet-stream"); response.end(bytes); return
      }
    }
    if (!pages.some(page => page.path === pathname)) { missing.push(pathname); response.writeHead(404); response.end(); return }
    response.setHeader("Content-Type", "text/html"); response.end(html)
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const origin = "http://127.0.0.1:" + server.address().port
  const results = [], screenshots = []
  try {
    for (const [engine, launcher] of baseline || smoke ? [["chromium", chromium]] : [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await launcher.launch({ headless: true })
      try {
        for (const width of baseline || smoke ? [390] : [320, 390, 1440]) for (const scheme of baseline || smoke ? ["light"] : ["light", "dark"]) for (const config of pages) {
          const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, colorScheme: scheme, timezoneId: "Asia/Hong_Kong" })
          try {
            const page = await context.newPage(), errors = [], consoleErrors = [], external = [], failed = []
            page.setDefaultTimeout(12_000)
            page.on("pageerror", error => errors.push(error.message))
            page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()) })
            page.on("response", response => { if (response.status() >= 400) failed.push({ url: response.url(), status: response.status() }) })
            await context.route("**/*", route => {
              if (new URL(route.request().url()).origin === origin) return route.continue()
              external.push(route.request().url()); return route.abort()
            })
            const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
            // Existing wrapping labels include option text in getByLabel's
            // exact text. Stable fixture values identify only these read
            // controls; their visible/ARIA labels are checked separately.
            const target = label => label === "Directory source book"
              ? page.locator('select:has(option[value="__all_contacts__"])')
              : label === "Year" ? page.locator('select:has(option[value="all"]):has(option[value="2026"])')
              : label === "Month" ? page.locator('select:has(option[value="all"]):has(option[value="09"])')
              : page.getByLabel(label, { exact: true })
            const table = () => page.getByRole("table", { name: config.key === "hongkong" ? "Hong Kong price history" : "Taiwan price history", exact: true })
            const editorSource = () => page.locator('select:has(option[value="__new_source_book__"])')
            const waitRows = async count => {
              await page.waitForFunction(({ label, count }) => [...document.querySelectorAll(`table[aria-label="${label}"] tbody tr`)].filter(row => row.querySelectorAll("td").length > 1).length === count,
                { label: config.key === "hongkong" ? "Hong Kong price history" : "Taiwan price history", count })
            }
            const screenshot = async mode => {
              const layout = await page.evaluate(async () => {
                const faces = await document.fonts.load('400 13px "Roboto"', "VERIFIED VIEW FILTER")
                await document.fonts.ready
                return { width: innerWidth, scroll: document.documentElement.scrollWidth, bodyFont: getComputedStyle(document.body).fontFamily, robotoLoaded: faces.length > 0 && faces.every(face => face.status === "loaded") }
              })
              assert.equal(layout.robotoLoaded, true)
              assert.match(layout.bodyFont, /Roboto/)
              assert.ok(layout.scroll <= layout.width + 1, JSON.stringify({ config: config.key, mode, ...layout }))
              const filename = `${engine}-${width}-${scheme}-${config.key}-${mode}.png`
              await page.screenshot({ path: path.join(output, filename), fullPage: true }); screenshots.push(filename)
            }
            for (const mode of baseline ? ["view"] : ["view", "edit", "none", "signed-out"]) {
              await page.goto(origin + config.path + "?mode=" + mode)
              if (mode === "none" || mode === "signed-out") {
                await page.getByRole("heading", { name: "Access Denied", exact: true }).waitFor()
                await settle()
                const reads = await page.evaluate(() => window.__viewFilterHarness.requests.filter(item => item.method === "GET" && !["/api/admin/session", "/api/parser-reports"].includes(item.path)))
                assert.deepEqual(reads, [], "Denied/signed-out pages must not request private report or directory data")
                assert.equal(await page.getByLabel("Unsafe fixture", { exact: true }).count(), 0)
                await screenshot(mode)
                results.push({ engine, width, scheme, page: config.key, mode, status: "passed", actualProviderGuardAndShell: true, privateDataRequests: 0 })
                continue
              }
              await page.getByLabel("Unsafe fixture", { exact: true }).waitFor()
              if (config.key === "usage") await page.waitForFunction(() => document.querySelector("main")?.textContent?.includes("3,000"))
              else if (config.key === "outlook") await page.getByRole("button", { name: /^ALPHA CONTACT\b/ }).waitFor()
              else await waitRows(3)
              await settle()
              const actor = await page.evaluate(() => JSON.parse(localStorage.getItem("bunker_admin_actor") || "null"))
              assert.equal(actor.role, "USER", "View and Edit controls must not bypass the guard as ADMIN")
              assert.equal(actor.permissions[config.id], mode)
              assert.ok(await page.evaluate(() => window.__viewFilterHarness.requests.some(item => item.path === "/api/admin/session" && item.method === "GET")), "The real provider must verify the session")
              if (mode === "view") {
                await page.waitForFunction(() => document.querySelector('select[aria-label="Unsafe fixture"]')?.disabled === true)
                assert.equal(await page.getByLabel("Unsafe fixture", { exact: true }).isDisabled(), true)
                assert.equal(await page.getByLabel("Unsafe editor", { exact: true }).getAttribute("readonly"), "")
                assert.equal(await page.getByLabel("Unsafe textarea", { exact: true }).getAttribute("readonly"), "")
                assert.equal(await page.getByLabel("Unsafe checkbox", { exact: true }).isDisabled(), true)
                for (const action of ["Save", "Delete", "Publish"]) assert.equal(await page.getByRole("button", { name: action + " fixture", exact: true }).isDisabled(), true)
              } else assert.equal(await page.getByLabel("Unsafe fixture", { exact: true }).isEnabled(), true)
              for (const label of config.selectors) {
                assert.equal(await target(label).isDisabled(), baseline, `${config.key}/${label}: View read selection must remain usable`)
                if (label === "Year" || label === "Month") assert.equal(await target(label).evaluate((element, label) => [...element.labels].some(item => item.textContent.trim().startsWith(label)), label), true)
                if (!baseline) {
                  assert.equal(await target(label).getAttribute("data-admin-view-safe"), "true")
                  assert.equal(await target(label).evaluate(element => element.closest('[data-admin-view-safe="true"]') === element), true)
                  if (label === "Directory source book") assert.equal(await target(label).getAttribute("aria-label"), label)
                }
              }
              if (baseline) {
                await screenshot("baseline-disabled")
                results.push({ engine, width, scheme, page: config.key, mode, status: "baseline-disabled-reproduced", disabledReadSelectors: config.selectors })
                continue
              }
              if (config.key === "usage") {
                const metric = name => page.locator("main span", { hasText: new RegExp("^" + name + "$") }).locator("..").locator("strong")
                for (const [days, tokens] of [["7", "700"], ["90", "9,000"], ["30", "3,000"]]) {
                  await target("Usage period").selectOption(days)
                  await page.waitForFunction(tokens => [...document.querySelectorAll("main strong")].some(element => element.textContent === tokens), tokens)
                  assert.equal(await metric("TOTAL TOKENS").innerText(), tokens)
                }
              } else if (config.key === "outlook") {
                for (const book of ["ALPHA", "BETA"]) {
                  await target("Directory source book").selectOption("BOOK-" + book); await settle()
                  for (const kind of ["CONTACT", "GROUP"]) {
                    assert.equal(await page.getByRole("button", { name: new RegExp("^" + book + " " + kind + "\\b") }).count(), 1)
                    assert.equal(await page.getByRole("button", { name: new RegExp("^" + (book === "ALPHA" ? "BETA" : "ALPHA") + " " + kind + "\\b") }).count(), 0)
                  }
                }
                await target("Directory source book").selectOption("__all_contacts__")
                await page.getByRole("button", { name: /^ALPHA CONTACT\b/ }).click(); await settle()
                assert.equal(await editorSource().isDisabled(), mode === "view")
                assert.equal(await editorSource().evaluate(element => element.closest('[data-admin-view-safe="true"]') === null), true)
                assert.equal(await page.getByLabel("Display Name", { exact: true }).isEditable(), mode === "edit")
                await page.getByRole("button", { name: /^ALPHA GROUP\b/ }).click(); await settle()
                assert.equal(await editorSource().isDisabled(), mode === "view")
                assert.equal(await editorSource().evaluate(element => element.closest('[data-admin-view-safe="true"]') === null), true)
                if (mode === "view") {
                  await page.waitForFunction(() => [...document.querySelectorAll("label")].find(label => label.textContent.trim() === "Group Name")?.querySelector("input")?.readOnly === true)
                }
                assert.equal(await page.getByLabel("Group Name", { exact: true }).isEditable(), mode === "edit")
                for (const label of ["Nickname / Alias Seed", "Description"]) assert.equal(await page.getByLabel(label, { exact: true }).isEditable(), mode === "edit")
                const beforeReload = await page.evaluate(() => {
                  window.__viewFilterHarness.holdNextGroupRead = true
                  return window.__viewFilterHarness.requests.length
                })
                await page.getByRole("button", { name: "Reload group", exact: true }).click()
                await page.waitForFunction(() => window.__viewFilterHarness.pendingGroupRead)
                for (const label of ["Group Name", "Nickname / Alias Seed", "Description"]) assert.equal(await page.getByLabel(label, { exact: true }).isEditable(), false)
                assert.equal(await editorSource().isDisabled(), true)
                assert.equal(await page.getByRole("button", { name: /^ALPHA CONTACT\b/ }).isDisabled(), true)
                await page.evaluate(() => window.__viewFilterHarness.releaseGroupRead())
                await page.getByText("Group reloaded.", { exact: true }).waitFor()
                await settle()
                assert.equal(await page.getByLabel("Description", { exact: true }).inputValue(), "RELOADED SYNTHETIC GROUP")
                for (const label of ["Group Name", "Nickname / Alias Seed", "Description"]) assert.equal(await page.getByLabel(label, { exact: true }).isEditable(), mode === "edit")
                assert.equal(await editorSource().isDisabled(), mode === "view")
                const reloadTrace = await page.evaluate(before => window.__viewFilterHarness.requests.slice(before).filter(item => item.path === "/api/admin/supabase"), beforeReload)
                assert.deepEqual(reloadTrace.map(item => ({ method: item.method, table: new URL(new URLSearchParams(item.query).get("target")).pathname.split("/").pop() })), [
                  { method: "GET", table: "shared_addressbook_groups" }, { method: "GET", table: "shared_addressbook_group_members" },
                  { method: "GET", table: "shared_addressbook_groups" }, { method: "GET", table: "shared_addressbook_group_members" },
                ])
                await page.getByRole("button", { name: /^ALPHA CONTACT\b/ }).click(); await settle()
                const contactEditability = Object.fromEntries(await Promise.all(["Display Name", "Email", "Nickname", "First Name", "Last Name"].map(async label => [label, await page.getByLabel(label, { exact: true }).isEditable()])))
                assert.deepEqual(contactEditability, Object.fromEntries(Object.keys(contactEditability).map(label => [label, mode === "edit"])))
                assert.equal(await editorSource().isDisabled(), mode === "view")
                await page.getByRole("button", { name: /^ALPHA GROUP\b/ }).click(); await settle()
                for (const label of ["Group Name", "Nickname / Alias Seed", "Description"]) assert.equal(await page.getByLabel(label, { exact: true }).isEditable(), mode === "edit")
                assert.equal(await editorSource().isDisabled(), mode === "view")
                if (mode === "view") {
                  assert.equal(await page.getByRole("button", { name: "Add contact or group", exact: true }).isDisabled(), true)
                  assert.equal(await page.getByRole("button", { name: "Delete", exact: true }).isDisabled(), true)
                  assert.equal(await page.getByRole("button", { name: "Sync now", exact: true }).isDisabled(), true)
                  assert.equal(await page.getByRole("button", { name: "Add Member", exact: true }).isDisabled(), true)
                  assert.equal(await page.getByRole("button", { name: "Remove", exact: true }).isDisabled(), true)
                }
              } else {
                await target("Year").selectOption("2026"); await waitRows(2)
                await target("Month").selectOption("10"); await waitRows(1)
                assert.equal(await table().locator("tbody tr td").nth(1).innerText(), "300")
                assert.match(await page.getByText(/^HSFO: 300 \|/).innerText(), /HSFO: 300/)
                await target("Year").selectOption("2025"); await waitRows(1)
                assert.equal(await table().locator("tbody tr td").nth(1).innerText(), "100")
                await target("Month").selectOption("09"); await waitRows(0)
                assert.equal(await table().getByText("No history records found for the current filters.", { exact: true }).count(), 1)
                await target("Year").selectOption("2026"); await waitRows(1)
                assert.equal(await table().locator("tbody tr td").nth(1).innerText(), "200")
                await target("Month").selectOption("10"); await waitRows(1)
                assert.equal(await page.getByLabel("Date", { exact: true }).isDisabled(), mode === "view")
                if (mode === "view") {
                  assert.equal(await page.getByRole("button", { name: "Add As Latest", exact: true }).isDisabled(), true)
                  assert.equal(await page.getByRole("button", { name: "Add Missing Record", exact: true }).isDisabled(), true)
                }
              }
              const probe = await page.evaluate(async () => {
                const harness = window.__viewFilterHarness, before = harness.requests.length
                const noise = Promise.resolve().then(() => fetch("/api/admin/session"))
                const replies = []
                for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
                  const response = await fetch("/api/admin/view-filter-probe", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ syntheticOnly: true }) })
                  replies.push({ method, status: response.status, body: await response.json() })
                }
                const read = await noise, trace = harness.requests.slice(before)
                return { replies, readStatus: read.status, trace,
                  forwardedWrites: trace.filter(item => item.path === "/api/admin/view-filter-probe" && ["POST", "PUT", "PATCH", "DELETE"].includes(item.method)).length }
              })
              assert.equal(probe.readStatus, 200)
              assert.ok(probe.trace.some(item => item.path === "/api/admin/session" && item.method === "GET"))
              assert.equal(probe.forwardedWrites, mode === "view" ? 0 : 4)
              for (const reply of probe.replies) {
                assert.equal(reply.status, mode === "view" ? 403 : 200)
                if (mode === "view") assert.match(reply.body.message, /view-only/)
                else assert.equal(reply.body.syntheticOnly, true)
              }
              await screenshot(mode)
              results.push({ engine, width, scheme, page: config.key, mode, status: "passed", actualProviderGuardAndShell: true,
                readSelectorsFunctional: true, unsafeControlsRetained: true, probe })
            }
            assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []); assert.deepEqual(external, []); assert.deepEqual(failed, [])
            console.log(`${engine} ${width} ${scheme} ${config.key}: ${baseline ? "disabled baseline reproduced" : "View/Edit/none/signed-out passed"}`)
          } finally { await context.close() }
        }
      } finally { await browser.close() }
    }
    assert.deepEqual(missing, [])
    const sources = {}
    for (const file of [...new Set([...Object.keys(bundle.metafile.inputs).filter(file => !file.includes("node_modules") && fs.existsSync(path.join(root, file))), "tests/admin-view-filters.browser.test.cjs", "app/globals.css", "app/fonts/roboto.css", "package-lock.json"])].sort()) sources[file] = hash(fs.readFileSync(path.join(root, file)))
    const playwrightPackage = JSON.parse(fs.readFileSync(require.resolve("playwright/package.json"), "utf8"))
    const receipt = { phase: baseline ? "actual-source-disabled-baseline" : smoke ? "smoke" : "full", results, screenshots, sources,
      assets: Object.fromEntries(assets), browserRuntime: { playwright: playwrightPackage.version, node: process.version, platform: process.platform },
      limits: ["Actual layout, auth provider/guard, four pages, hooks, SDK and styles; synthetic verified sessions/API only. Next navigation/link/image are framework facades.", "Existing fixed-light palette tested under light/dark OS preferences; no new dark theme.", "No true signed-in provider, physical device/iOS Safari, Firefox or real business mutation."],
      cleanup: "All owned headless contexts, browsers and loopback server closed; personal browser untouched." }
    fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(receipt, null, 2) + "\n")
    console.log(`${results.length} scoped results; ${screenshots.length} screenshots; ${baseline ? "baseline" : "green"}`)
  } finally { await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => {
  const output = process.env.ADMIN_VIEW_FILTERS_SCREENSHOTS
  if (output && path.isAbsolute(output)) {
    fs.mkdirSync(output, { recursive: true })
    fs.writeFileSync(path.join(output, "failure.json"), JSON.stringify({ error: error.message, stack: error.stack,
      runnerSha256: hash(fs.readFileSync(__filename)), cleanup: "Owned contexts, browsers and server close through finally handlers." }, null, 2) + "\n")
  }
  console.error(error); process.exitCode = 1
})
