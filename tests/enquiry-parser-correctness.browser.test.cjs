// Actual worksheet/parser. Synthetic auth + local port GET only; never AI/send/report.
const assert = require("node:assert/strict")
const http = require("node:http")
const path = require("node:path")
const os = require("node:os")
const { mkdtempSync, writeFileSync, readFileSync, mkdirSync } = require("node:fs")
const { createHash } = require("node:crypto")
const { build } = require("esbuild")

// Optional actual old source tree for RED comparison; parser modules themselves
// are never mocked/replaced, and the same desired expectations remain in force.
const root = path.resolve(process.env.ENQUIRY_CORRECTNESS_SOURCE_ROOT || path.join(__dirname, ".."))
const evidence = process.env.ENQUIRY_CORRECTNESS_EVIDENCE || mkdtempSync(path.join(os.tmpdir(), "fcuno-parser-correctness-browser-"))
mkdirSync(evidence, { recursive: true })
const sourceNames = ["app/admin/enquiryworksheet/page.tsx", "lib/enquiryShortener.ts", "lib/enquiryWorksheetParser.ts", "lib/spcEnquiryText.ts"]
const hashSources = () => Object.fromEntries(sourceNames.map(name => [name, createHash("sha256").update(readFileSync(path.join(root, name))).digest("hex")]))
const sources = hashSources()
const fields = "PORT: SINGAPORE\nETA: 12 JUL\nVLSFO 100MT"
const cases = [
  { id: "telephone-not-imo", raw: `VESSEL: ALPHA\nIMO: 9450670\nTEL: 9450674\n${fields}`, vessel: "ALPHA", imo: "", output: "alpha / singapore 12 jul / vlsfo 100mts", invalidImoWarning: true },
  { id: "embedded-ifo-name", raw: `VESSEL: CALIFORNIA\nIMO: 9450674\n${fields}`, vessel: "CALIFORNIA", imo: "9450674", output: "california / 9450674 / singapore 12 jul / vlsfo 100mts" },
  { id: "embedded-mt-name", raw: `VESSEL: SAMTONG\nIMO: 9450674\n${fields}`, vessel: "SAMTONG", imo: "9450674", output: "samtong / 9450674 / singapore 12 jul / vlsfo 100mts" },
  { id: "invalid-nonleap-year", raw: "VESSEL: ALPHA\nIMO: 9450674\nPORT: SINGAPORE\nETA: 29 FEB 2026\nVLSFO 100MT", vessel: "ALPHA", imo: "9450674", output: "alpha / 9450674 / singapore / vlsfo 100mts" },
  { id: "valid-leap-year", raw: "VESSEL: ALPHA\nIMO: 9450674\nPORT: SINGAPORE\nETA: 29 FEB 2028\nVLSFO 100MT", vessel: "ALPHA", imo: "9450674", output: "alpha / 9450674 / singapore 29 feb / vlsfo 100mts" },
  { id: "valid-later-labelled-imo", raw: `VESSEL: ALPHA\nIMO: 9450670\nIMO No.: 9450674\nFax: 1094644\n${fields}`, vessel: "ALPHA", imo: "9450674", output: "alpha / 9450674 / singapore 12 jul / vlsfo 100mts" },
  { id: "unlabelled-adjacent-imo", raw: "ALPHA (9450674) / SINGAPORE / 12 JUL / VLSFO 100MT", vessel: "ALPHA", imo: "9450674", output: "alpha / 9450674 / singapore 12 jul / vlsfo 100mts" },
  { id: "actual-fuel-not-vessel", raw: `VESSEL: IFO380\nIMO: 9450674\n${fields}`, vessel: "", imo: "9450674", output: "9450674 / singapore 12 jul / vlsfo 100mts" },
  { id: "spaced-fuel-attached-quantity-not-vessel", raw: "IMO: 9450674\nV L S F O380\nPORT: SINGAPORE\nETA: 12 JUL", vessel: "", imo: "9450674", output: "9450674 / singapore 12 jul / vlsfo 380mts" },
  { id: "quantity-not-explicit-year", raw: "VESSEL: ALPHA\nIMO: 9450674\nPORT: SINGAPORE\nETA: 29 FEB 1000 MT VLSFO", vessel: "ALPHA", imo: "9450674", output: "alpha / 9450674 / singapore 29 feb / vlsfo 1,000mts" },
  { id: "lf-quantity-unit-not-explicit-year", raw: "VESSEL: ALPHA\nIMO: 9450674\nPORT: SINGAPORE\nETA: 29 FEB 1000\nMT VLSFO", vessel: "ALPHA", imo: "9450674", output: "alpha / 9450674 / singapore 29 feb" },
  { id: "crlf-quantity-unit-not-explicit-year", raw: "VESSEL: ALPHA\r\nIMO: 9450674\r\nPORT: SINGAPORE\r\nETA: 29 FEB 1000\r\nMT VLSFO", vessel: "ALPHA", imo: "9450674", output: "alpha / 9450674 / singapore 29 feb" },
  { id: "separate-quantity-unit-grade-not-explicit-year", raw: "VESSEL: ALPHA\nIMO: 9450674\nPORT: SINGAPORE\nETA: 29 FEB 1000\nMT\nVLSFO", vessel: "ALPHA", imo: "9450674", output: "alpha / 9450674 / singapore 29 feb" },
  { id: "eta-continuation-date-stays-separate", raw: "VESSEL: ALPHA\nIMO: 9450674\nPORT: SINGAPORE\nETA: 1000\nMT 12 JUL", vessel: "ALPHA", imo: "9450674", output: "alpha / 9450674 / singapore" },
  { id: "delivery-continuation-date-stays-separate", raw: "VESSEL: ALPHA\nIMO: 9450674\nPORT: SINGAPORE\nDELIVERY: 1000\nMT 12 JUL", vessel: "ALPHA", imo: "9450674", output: "alpha / 9450674 / singapore" },
  { id: "continuation-port-keeps-own-date", raw: "VESSEL: ALPHA\nIMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL 1000\nMT ROTTERDAM 13 JUL", vessel: "ALPHA", imo: "9450674", output: "alpha / 9450674 / rotterdam 13 jul" },
  ...require("./fixtures/enquiry-metadata-cases.cjs"),
]
assert.equal(cases.length, 40)
assert.equal(new Set(cases.map(item => item.id)).size, cases.length)

async function main() {
  const bundle = await build({
    absWorkingDir: root,
    stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import Worksheet from './app/admin/enquiryworksheet/page';
      window.__requests=[];window.__messages=[];
      window.addEventListener('message',event=>window.__messages.push(event.data?.type));
      window.fetch=async(url,init={})=>{window.__requests.push({url:String(url),method:init.method||'GET'});if(url==='/api/admin/enquiryworksheet/ports'&&(!init.method||init.method==='GET'))return Response.json({ports:['SINGAPORE','ROTTERDAM']});throw Error('Forbidden fixture request '+url)};
      createRoot(document.getElementById('root')).render(<Worksheet/>);`, resolveDir: root, loader: "tsx" },
    outfile: "fixture.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "synthetic-auth-only", setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/useSimpleAdminAuth$/ }, () => ({ path: "auth", namespace: "fixture" }))
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export function useSimpleAdminAuth(){return{authenticated:true,loading:false,displayName:'Synthetic User',username:'synthetic',role:'BT',permissions:{'enquiry-worksheet':'edit'}}}", loader: "js" }))
    } }],
  })
  const assets = new Map(bundle.outputFiles.map(file => [path.basename(file.path), file.contents]))
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, "http://127.0.0.1").pathname.slice(1)
    if (assets.has(name)) { res.setHeader("Content-Type", name.endsWith("css") ? "text/css" : "text/javascript"); return res.end(assets.get(name)) }
    res.setHeader("Content-Type", "text/html")
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>
      :root{--fc-admin-font:Arial,sans-serif;--fc-admin-page-bg:#f4f5f8;--fc-admin-panel-bg:#fff;--fc-admin-panel-soft-bg:#fbfbfd;--fc-admin-panel-text:#20242c;--fc-admin-heading:#20242c;--fc-admin-muted:#5a677a;--fc-admin-border:#b7bfcb;--fc-admin-border-soft:#d4dae2;--fc-tool-input-bg:#fff;--fc-tool-input-text:#20242c;--fc-input-border:#b7bfcb;--fc-admin-button-bg:#eef1f6;--fc-admin-button-text:#20242c;--fc-admin-button-border:#b7bfcb;--fc-admin-primary-button-bg:#0672ed;--fc-admin-primary-button-text:#fff;--fc-admin-selected-border:#0672ed;--fc-admin-selected-bg:#e5f0ff;--fc-admin-selected-text:#054c9e;--fc-admin-success-bg:#21883a;--fc-admin-success-text:#fff;--fc-admin-success-border:#166429;--fc-admin-warning-bg:#fff1ca;--fc-admin-warning-text:#392700;--fc-admin-warning-border:#e2b74e;--fc-admin-danger-text:#b00020;}
      @media(prefers-color-scheme:dark){:root{--fc-admin-page-bg:#10151e;--fc-admin-panel-bg:#192332;--fc-admin-panel-soft-bg:#1e2b3e;--fc-admin-panel-text:#eef3fb;--fc-admin-heading:#eef3fb;--fc-admin-muted:#c7d3e3;--fc-admin-border:#718097;--fc-admin-border-soft:#48566c;--fc-tool-input-bg:#101a29;--fc-tool-input-text:#eef3fb;--fc-input-border:#718097;--fc-admin-button-bg:#26354a;--fc-admin-button-text:#eef3fb;--fc-admin-button-border:#718097;--fc-admin-selected-bg:#17385c;--fc-admin-selected-text:#dcecff;--fc-admin-warning-bg:#3d3218;--fc-admin-warning-text:#ffe8a7;}}
      body{margin:0;background:var(--fc-admin-page-bg);color:var(--fc-admin-panel-text);font-family:Arial}button,input,select,textarea{font:inherit}button:disabled{opacity:.5}
      </style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`)
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const origin = `http://127.0.0.1:${server.address().port}`, results = [], failures = []
  let browser
  try {
    const { chromium, webkit } = require("playwright")
    for (const [engine, type] of [["chromium", chromium], ["webkit", webkit]]) {
      browser = await type.launch({ headless: true })
      for (const width of [1440, 320, 390]) for (const colorScheme of ["light", "dark"]) {
        const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme }), blocked = [], errors = []
        await context.route("**/*", route => { if (new URL(route.request().url()).origin === origin) return route.continue(); blocked.push(route.request().url()); return route.abort() })
        const page = await context.newPage(); page.setDefaultTimeout(7000); page.on("pageerror", error => errors.push(error.message))
        await page.goto(`${origin}/admin/enquiryworksheet`)
        const raw = page.getByRole("textbox", { name: "Enquiry text", exact: true }), output = page.getByRole("textbox", { name: "Editable shortened enquiry", exact: true })
        await raw.waitFor()
        for (const item of cases) {
          await raw.fill(item.raw)
          await page.getByRole("button", { name: "Generate", exact: true }).click()
          const actual = { vessel: await page.getByLabel("VESSEL NAME", { exact: true }).inputValue(), imo: await page.locator('input[maxlength="7"]').inputValue(), output: await output.inputValue(), header: await page.getByRole("textbox", { name: "Vessel name and IMO", exact: true }).inputValue(), invalidImoWarning: await page.getByText("Found 9450670, but it failed IMO check digit validation.", { exact: true }).count() > 0 }
          const expected = { vessel: item.vessel, imo: item.imo, output: item.output, header: [item.vessel, item.imo].filter(Boolean).join(" - "), invalidImoWarning: item.invalidImoWarning === true }
          let passed = true
          try { assert.deepEqual(actual, expected) } catch (error) { passed = false; failures.push({ engine, width, colorScheme, id: item.id, actual, expected, message: error.message }) }
          results.push({ engine, browserVersion: browser.version(), width, colorScheme, id: item.id, passed, actual, expected })
          if (item.id === "telephone-not-imo") { await raw.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(evidence, `${engine}-${width}-${colorScheme}-phone-imo.png`), fullPage: true }) }
          if (item.id === "lf-quantity-unit-not-explicit-year") { await raw.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(evidence, `${engine}-${width}-${colorScheme}-newline-quantity.png`), fullPage: true }) }
          if (item.id === "metadata-quantity-prefix-multiple-clauses" || item.id === "metadata-retained-exact-metadata") {
            await raw.scrollIntoViewIfNeeded()
            const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
            assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout))
            await page.screenshot({ path: path.join(evidence, `${engine}-${width}-${colorScheme}-${item.id}.png`), fullPage: true })
          }
        }
        assert.deepEqual(blocked, []); assert.deepEqual(errors, [])
        assert.deepEqual(await page.evaluate(() => window.__messages), [])
        assert.ok((await page.evaluate(() => window.__requests)).every(request => request.url === "/api/admin/enquiryworksheet/ports" && request.method === "GET"))
        await context.close()
      }
      await browser.close(); browser = null
    }
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }
  assert.deepEqual(hashSources(), sources)
  const receipt = { sourceRoot: root, sources, sourceStable: true, contexts: 12, casesPerContext: cases.length, originalCaseIdsPreserved: 16, originalExpectedOutputChanges: ["actual-fuel-not-vessel"], cases: results.length, passed: results.length - failures.length, failures, results, scope: "Actual worksheet/parser; synthetic auth/port response/theme variables. Chromium/WebKit phone-width contexts, not physical iPhone or complete shell permission/theme verification.", externalRequests: 0, messages: 0, ownedResourcesClosed: true }
  assert.equal(results.length, 480)
  writeFileSync(path.join(evidence, "results.json"), JSON.stringify(receipt, null, 2) + "\n")
  console.log(JSON.stringify({ contexts: receipt.contexts, cases: receipt.cases, passed: receipt.passed, failed: failures.length, evidence, ownedResourcesClosed: true }))
  assert.equal(failures.length, 0, "Actual worksheet parser correctness regressions")
}
main().catch(error => { console.error(error); process.exitCode = 1 })
