// Actual SPC enquiry page/SpcAuthProvider/SpcShell/global CSS. No parser/hook/SDK
// replacement, no AI/send/report, and no real API or provider transport.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), http = require("node:http")
const { createHash } = require("node:crypto"), { createRequire } = require("node:module")
const root = path.resolve(process.env.SPC_ENQUIRY_METADATA_SOURCE_ROOT || path.join(__dirname, "..")), repo = createRequire(path.join(root, "package.json"))
const { build } = repo("esbuild"), postcss = repo("postcss"), tailwind = repo("@tailwindcss/postcss")
const cases = require("./fixtures/enquiry-metadata-cases.cjs")
assert.equal(cases.length, 24); assert.equal(new Set(cases.map(item => item.id)).size, 24)
const output = process.env.SPC_ENQUIRY_METADATA_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), "fcuno-spc-enquiry-metadata-"))
assert.ok(path.isAbsolute(output)); fs.mkdirSync(output, { recursive: true })
const names = ["app/spc/enquiries/page.tsx", "components/SpcShell.tsx", "app/globals.css", "lib/useSpcAuth.ts", "lib/clientSessionStore.ts", "lib/spcEnquiryText.ts", "lib/enquiryShortener.ts", "lib/enquiryWorksheetParser.ts", "tests/fixtures/spc-enquiry-metadata.tsx"]
const hashSources = () => Object.fromEntries(names.map(name => [name, createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex")]))
const sources = hashSources(), results = [], failures = [], cleanup = { servers: 0, browsers: 0, contexts: 0 }
async function main() {
  const bundle = await build({ absWorkingDir: root, entryPoints: ["tests/fixtures/spc-enquiry-metadata.tsx"], outfile: "fixture.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' }, plugins: [{ name: "synthetic-router-only", setup(builder) {
    builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "router", namespace: "fixture" }))
    builder.onLoad({ filter: /^router$/, namespace: "fixture" }, () => ({ contents: "const router={replace:path=>window.__spcMetadata.routes.push(path),push:path=>window.__spcMetadata.routes.push(path)};export const useRouter=()=>router;", loader: "js" }))
  } }] })
  const css = await postcss([tailwind()]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })
  const assets = new Map(bundle.outputFiles.map(file => ["/" + path.basename(file.path), file.contents]))
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1")
    if (req.method !== "GET") { res.writeHead(405); return res.end() }
    if (assets.has(url.pathname)) { res.setHeader("Content-Type", url.pathname.endsWith("css") ? "text/css" : "text/javascript"); return res.end(assets.get(url.pathname)) }
    if (url.pathname === "/globals.css") { res.setHeader("Content-Type", "text/css"); return res.end(css.css) }
    if (url.pathname !== "/spc/enquiries") { res.writeHead(404); return res.end() }
    res.setHeader("Content-Type", "text/html")
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/globals.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>')
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) }); cleanup.servers++
  const origin = "http://127.0.0.1:" + server.address().port, { chromium, webkit } = require("playwright")
  try {
    for (const [engine, launcher] of [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await launcher.launch({ headless: true }); cleanup.browsers++
      try { for (const width of [320, 390, 1440]) for (const scheme of ["light", "dark"]) for (const mode of ["edit", "view", "none", "signed-out"]) {
        const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, colorScheme: scheme, timezoneId: "Asia/Hong_Kong" }); cleanup.contexts++
        const blocked = [], errors = []
        try {
          await context.route("**/*", route => {
            const request = route.request(), url = new URL(request.url())
            if (url.origin === origin && request.method() === "GET" && ["/spc/enquiries", "/fixture.js", "/fixture.css", "/globals.css"].includes(url.pathname)) return route.continue()
            blocked.push({ method: request.method(), url: url.href }); return route.abort()
          })
          const page = await context.newPage(); page.setDefaultTimeout(10000); page.on("pageerror", error => errors.push(error.message))
          page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
          await page.goto(origin + "/spc/enquiries?mode=" + mode)
          const screenshot = async id => {
            const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, fields: [...document.querySelectorAll(".spc-enquiry-entry-form input,.spc-enquiry-entry-form textarea")].map(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right })) }))
            assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout))
            for (const box of layout.fields) assert.ok(box.left >= -1 && box.right <= width + 1, JSON.stringify(box))
            await page.screenshot({ path: path.join(output, `${engine}-${width}-${scheme}-${id}.png`), fullPage: true })
          }
          if (mode === "edit") {
            const parser = page.getByRole("textbox", { name: "Parser", exact: true }), standard = page.getByRole("textbox", { name: "Standard Format", exact: true })
            await parser.waitFor(); assert.equal(await parser.isDisabled(), false)
            await page.waitForFunction(() => window.__spcMetadata.requests.some(item => item.path === "/api/spc/enquiries?limit=200&bootstrap=1"))
            for (const item of cases) {
              await parser.fill(item.raw)
              const actual = { hsfo: await page.getByRole("textbox", { name: "HSFO", exact: true }).inputValue(), vlsfo: await page.getByRole("textbox", { name: "VLSFO", exact: true }).inputValue(), lsmgo: await page.getByRole("textbox", { name: "LSMGO", exact: true }).inputValue(), standard: await standard.inputValue() }
              let passed = true
              try { assert.deepEqual(actual, item.spc) } catch (error) { passed = false; failures.push({ engine, width, scheme, mode, id: item.id, actual, expected: item.spc, message: error.message }) }
              results.push({ engine, browserVersion: browser.version(), width, scheme, mode, id: item.id, passed, actual, expected: item.spc })
              if (["metadata-retained-exact-metadata", "metadata-quantity-before-later-product"].includes(item.id)) await screenshot(item.id)
            }
            // Observe the real page's debounced GET history path without invoking
            // Send/AI/Report or substituting normaliseDraft with a window helper.
            await page.waitForFunction(() => window.__spcMetadata.requests.some(item => item.path.startsWith("/api/spc/enquiry-history?")))
          } else if (mode === "view") {
            const parser = page.getByRole("textbox", { name: "Parser", exact: true }); await parser.waitFor()
            assert.equal(await parser.isDisabled(), true)
            assert.equal(await page.getByRole("button", { name: "SEND", exact: true }).isDisabled(), true)
            await page.waitForFunction(() => window.__spcMetadata.requests.some(item => item.path === "/api/spc/enquiries?limit=200&bootstrap=1"))
            results.push({ engine, browserVersion: browser.version(), width, scheme, mode, id: "view-read-only", passed: true }); await screenshot(mode)
          } else {
            await page.waitForFunction(() => window.__spcMetadata?.routes.includes("/spc"))
            assert.equal(await page.getByRole("textbox", { name: "Parser", exact: true }).count(), 0)
            assert.equal(await page.evaluate(() => window.__spcMetadata.requests.filter(item => item.path !== "/api/spc/session").length), 0)
            results.push({ engine, browserVersion: browser.version(), width, scheme, mode, id: "access-not-rendered", passed: true }); await screenshot(mode)
          }
          assert.deepEqual(blocked, []); assert.deepEqual(errors, [])
          const trace = await page.evaluate(() => window.__spcMetadata)
          assert.deepEqual(trace.forbidden, []); assert.deepEqual(trace.messages, [])
          assert.ok(trace.requests.length > 0 && trace.requests.every(item => item.method === "GET"))
        } finally { await context.close(); cleanup.contexts-- }
      } } finally { await browser.close(); cleanup.browsers-- }
    }
  } finally { await new Promise(resolve => server.close(resolve)); cleanup.servers-- }
  assert.deepEqual(hashSources(), sources)
  const receipt = { sourceRoot: root, sources, sourceStable: true, contexts: 48, editCasesPerLayout: 24, cases: results.length, passed: results.length - failures.length, failures, results, ownedResourcesClosed: true, cleanup, externalRequests: 0, actualApiRequests: 0, scope: "Actual SPC enquiry page, SpcAuthProvider/session parser, SpcShell and global CSS; synthetic GET-only session/bootstrap/history and router. In-memory fixture, not deployed Next/API/RLS, provider, physical iPhone or complete authentication verification. OS color preferences exercised; no new dark theme asserted." }
  fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(receipt, null, 2) + "\n")
  console.log(JSON.stringify({ evidence: output, contexts: 48, cases: results.length, failures: failures.length, cleanup }))
  assert.equal(results.length, 324); assert.equal(failures.length, 0); assert.deepEqual(cleanup, { servers: 0, browsers: 0, contexts: 0 })
}
main().catch(error => { console.error(error); process.exitCode = 1 })
