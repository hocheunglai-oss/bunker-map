// Actual supplier page/navigation/global CSS; isolated synthetic transport.
// Actual API/SQL/native transaction boundaries have separate executable tests.
const assert = require("node:assert/strict")
const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")
const { build } = require("esbuild")
const postcss = require("postcss")
const tailwind = require("@tailwindcss/postcss")
const root = path.resolve(__dirname, "..")
const entry = `import React from "react";import{createRoot}from"react-dom/client";import Page from"./app/spc/suppliers/page";import{SpcNavigationShell}from"./components/SpcNavigationShell";import{SPC_PAGE_DEFINITIONS}from"./lib/spcPages";
const record={key:"SYNTHETICALPHA",name:"SYNTHETIC ALPHA",aliases:[],info:{paymentTerms:"15",qualityClaimBar:"30",supplierTrader:"SYNTHETIC TRADER",availableGrade:"VLSFO",foBdn:"SYNTHETIC",goBdn:"SYNTHETIC",rowNumber:2},fixtures:[],barges:[{id:"synthetic-barge",bargeName:"SYNTHETIC BARGE",imo:"9999999",grade:"VLSFO",capacity:"500",source:"sheet"}],contacts:[{id:"synthetic-contact",role:"sales",name:"SYNTHETIC CONTACT",mobile:"synthetic-number",source:"sheet"}],searchText:"synthetic alpha",updatedAt:"2026-10-16T01:00:00Z",editVersions:{details:"a".repeat(64),barges:"b".repeat(64),contacts:"c".repeat(64)}};
const h=window.__supplierHarness={requests:[],pending:[],routes:[],dataset:{records:[record],suppliers:[record.name],legacyFixtures:[],generatedAt:"2026-10-16T01:00:00Z",spreadsheetUrl:"https://synthetic.invalid",source:"public-csv",counts:{suppliers:1,fixtureRows:0,legacyFixtureRows:0,bargeRows:1,contactRows:1}},auth:{loading:false,authenticated:true,username:"synthetic@example.test",displayName:"Synthetic Editor",role:"ADMIN",mustChangePassword:false,permissions:{"spc-suppliers":"edit"},pages:SPC_PAGE_DEFINITIONS},release(status=200,message="",badAck=false){const next=this.pending.shift();if(!next)throw new Error("No pending save");const requestId=next.body.supplier?.requestId||next.body.barges?.requestId||next.body.contacts?.requestId||next.body.requestId;next.resolve(new Response(JSON.stringify(status===200?{...this.dataset,mutation:badAck?undefined:{requestId,replayed:false}}:{message}),{status,headers:{"Content-Type":"application/json"}}));}};
window.fetch=async(input,init={})=>{const url=new URL(typeof input==="string"?input:input.url,location.origin);if(url.origin!==location.origin)throw new Error("External fetch blocked");const method=init.method||"GET",body=init.body?JSON.parse(init.body):null;h.requests.push({method,path:url.pathname,body});if(url.pathname!=="/api/spc/suppliers")throw new Error("Unexpected synthetic API "+url.pathname);if(method==="GET")return new Response(JSON.stringify(h.dataset),{headers:{"Content-Type":"application/json"}});return new Promise(resolve=>h.pending.push({body,resolve}));};
const app=createRoot(document.getElementById("root"));h.render=()=>app.render(<div className="fc-admin-scope spc-scope"><SpcNavigationShell><Page/></SpcNavigationShell></div>);h.render();`
const mocks = {
  "@/lib/useSpcAuth": `export const useSpcAuth=()=>window.__supplierHarness.auth;export const clearSpcClientSessionCache=()=>{};export const primeSpcClientSessionCache=()=>{};`,
  "next/navigation": `const router={replace:path=>window.__supplierHarness.routes.push(path),prefetch:()=>{}};export const useRouter=()=>router;export const usePathname=()=>"/spc/suppliers";`,
  "next/link": `import React from"react";export default function Link({prefetch,...props}){return <a {...props}/>;}`,
  "next/image": `import React from"react";export default function Image({priority,unoptimized,fill,...props}){return <img {...props}/>;}`,
}
async function main() {
  const bundle = await build({ absWorkingDir: root, stdin: { contents: entry, resolveDir: root, loader: "tsx" }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' }, plugins: [{ name: "synthetic-adapters", setup(builder) {
    builder.onResolve({ filter: /^(?:@\/lib\/useSpcAuth|next\/(?:navigation|link|image))$/ }, args => ({ path: args.path, namespace: "synthetic" }))
    builder.onLoad({ filter: /.*/, namespace: "synthetic" }, args => ({ contents: mocks[args.path], loader: "jsx", resolveDir: root }))
  } }] })
  const css = await postcss([tailwind()]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname
    if (pathname === "/bundle.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle.outputFiles[0].contents) }
    else if (pathname === "/globals.css") { response.setHeader("Content-Type", "text/css"); response.end(css.css) }
    else if (pathname === "/spc-sidebar-logo.png") { response.setHeader("Content-Type", "image/png"); response.end(fs.readFileSync(path.join(root, "public/spc-sidebar-logo.png"))) }
    else { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/globals.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>') }
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const output = process.env.SPC_SUPPLIER_SCREENSHOTS
  assert.ok(output && path.isAbsolute(output), "Use an owned absolute screenshot output directory")
  fs.mkdirSync(output, { recursive: true })
  const { chromium, webkit } = require("playwright"), results = []
  try {
    for (const [engine, launcher] of [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await launcher.launch({ headless: true, ...(engine === "chromium" && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) })
      try { for (const width of [320, 390, 1440]) for (const scheme of ["light", "dark"]) {
        const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, colorScheme: scheme, timezoneId: "Asia/Hong_Kong" })
        try {
          const page = await context.newPage(), errors = [], unexpected = []
          page.setDefaultTimeout(10000); page.on("pageerror", error => errors.push(error.message)); page.on("dialog", dialog => dialog.accept())
          await context.route("**/*", route => { if (new URL(route.request().url()).origin === origin) return route.continue(); unexpected.push(route.request().url()); return route.abort() })
          await page.goto(origin)
          const supplier = page.getByRole("button", { name: "SYNTHETIC ALPHA", exact: true })
          await supplier.waitFor(); await page.screenshot({ path: path.join(output, `${engine}-${width}-${scheme}-initial.png`) })
          await supplier.click()
          let dialog = page.getByRole("dialog", { name: "Edit supplier", exact: true })
          const terms = dialog.getByLabel("PAYMENT TERMS", { exact: true })
          await terms.fill("30"); await dialog.getByRole("button", { name: "SAVE", exact: true }).click()
          await page.waitForFunction(() => window.__supplierHarness.pending.length === 1)
          assert.equal(await dialog.locator("input:not(:disabled),select:not(:disabled),button:not(:disabled)").count(), 0)
          await page.locator(".spc-supplier-modal-backdrop").dispatchEvent("mousedown")
          assert.equal(await dialog.count(), 1)
          await page.screenshot({ path: path.join(output, `${engine}-${width}-${scheme}-pending.png`) })
          await page.evaluate(() => window.__supplierHarness.release(409, "This supplier changed while you were editing. Your draft is kept. Close and refresh, then review the latest details."))
          const alert = dialog.getByRole("alert"); await alert.waitFor(); assert.equal(await terms.inputValue(), "30")
          const bounds = await alert.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, JSON.stringify(bounds))
          await page.screenshot({ path: path.join(output, `${engine}-${width}-${scheme}-conflict.png`) })
          await dialog.getByRole("button", { name: "SAVE", exact: true }).click(); await page.waitForFunction(() => window.__supplierHarness.pending.length === 1)
          let writes = await page.evaluate(() => window.__supplierHarness.requests.filter(row => row.method === "PATCH"))
          assert.deepEqual(writes[0].body, writes[1].body)
          assert.equal(writes[0].body.supplier.expectedVersions.details, "a".repeat(64))
          await page.evaluate(() => window.__supplierHarness.release(503, "Synthetic response lost. Retry to check the same save.")); await alert.waitFor()
          await dialog.getByRole("button", { name: "SAVE", exact: true }).click(); await page.waitForFunction(() => window.__supplierHarness.pending.length === 1)
          writes = await page.evaluate(() => window.__supplierHarness.requests.filter(row => row.method === "PATCH")); assert.deepEqual(writes[1].body, writes[2].body)
          await page.evaluate(() => window.__supplierHarness.release(200)); await dialog.waitFor({ state: "detached" })
          for (const section of ["barge", "contact"]) {
            await page.getByRole("button", { name: section === "barge" ? "BARGE FLEET (1)" : "CONTACT", exact: true }).click()
            dialog = page.getByRole("dialog", { name: section === "barge" ? "SYNTHETIC ALPHA barge fleet" : "SYNTHETIC ALPHA contacts", exact: true })
            const text = dialog.locator("tbody input").first(); await text.fill(`SYNTHETIC ${section.toUpperCase()} EDIT`)
            await dialog.getByRole("button", { name: "SAVE", exact: true }).click(); await page.waitForFunction(() => window.__supplierHarness.pending.length === 1)
            await page.locator(".spc-supplier-modal-backdrop").dispatchEvent("mousedown"); assert.equal(await dialog.count(), 1)
            await page.evaluate(() => window.__supplierHarness.release(200, "", true)); await dialog.getByRole("alert").waitFor()
            assert.equal(await text.inputValue(), `SYNTHETIC ${section.toUpperCase()} EDIT`)
            const alertBounds = await dialog.getByRole("alert").boundingBox()
            assert.ok(alertBounds.height < 200, "Error must not consume the flexible table body")
            if (section === "contact" && width < 500) {
              const footer = await dialog.locator(".is-contact-actions").evaluate(node => {
                const box = rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
                return { bounds: box(node.getBoundingClientRect()), buttons: [...node.querySelectorAll("button")].map(button => {
                  const range = document.createRange(); range.selectNodeContents(button)
                  return { box: box(button.getBoundingClientRect()), text: [...range.getClientRects()].map(box) }
                }) }
              })
              for (const button of footer.buttons) {
                assert.ok(button.box.left >= footer.bounds.left && button.box.right <= footer.bounds.right)
                for (const text of button.text) assert.ok(text.left >= button.box.left && text.right <= button.box.right && text.top >= button.box.top && text.bottom <= button.box.bottom, JSON.stringify(footer))
              }
              for (let i = 0; i < footer.buttons.length; i++) for (let j = i + 1; j < footer.buttons.length; j++) {
                const a = footer.buttons[i].box, b = footer.buttons[j].box
                assert.ok(Math.min(a.right, b.right) <= Math.max(a.left, b.left) || Math.min(a.bottom, b.bottom) <= Math.max(a.top, b.top), "Mobile footer buttons must not overlap")
              }
            }
            await page.screenshot({ path: path.join(output, `${engine}-${width}-${scheme}-${section}-ack-error.png`) })
            const prior = await page.evaluate(() => window.__supplierHarness.requests.filter(row => row.method === "PATCH").at(-1).body)
            await dialog.getByRole("button", { name: "SAVE", exact: true }).click(); await page.waitForFunction(() => window.__supplierHarness.pending.length === 1)
            const retry = await page.evaluate(() => window.__supplierHarness.pending[0].body); assert.deepEqual(retry, prior)
            const key = section === "barge" ? "barges" : "contacts"; assert.deepEqual(Object.keys(retry[key].expectedVersions), [key])
            await page.evaluate(() => window.__supplierHarness.release(200)); await dialog.waitFor({ state: "detached" })
          }
          await page.evaluate(() => { window.__supplierHarness.auth = { ...window.__supplierHarness.auth, permissions: { "spc-suppliers": "view" } }; window.__supplierHarness.render() })
          assert.equal(await supplier.isDisabled(), true)
          await page.getByRole("button", { name: "CONTACT", exact: true }).click(); dialog = page.getByRole("dialog", { name: "SYNTHETIC ALPHA contacts", exact: true })
          assert.equal(await dialog.getByRole("button", { name: "SAVE", exact: true }).isDisabled(), true)
          assert.equal(await dialog.locator("input:not(:disabled),select:not(:disabled)").count(), 0)
          await dialog.getByRole("button", { name: "Close", exact: true }).click()
          const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
          assert.ok(dimensions.scroll <= dimensions.width + 1, JSON.stringify(dimensions))
          await page.evaluate(() => { window.__supplierHarness.auth = { ...window.__supplierHarness.auth, authenticated: false, permissions: {} }; window.__supplierHarness.render() })
          await page.getByText("Loading...", { exact: true }).waitFor(); assert.equal(await page.getByRole("table").count(), 0)
          assert.deepEqual(errors, []); assert.deepEqual(unexpected, [])
          results.push({ engine, width, scheme, pending: "locked", conflict: "draft and original baseline retained", retry: "stable operation id and intent", acknowledgement: "verified before close", viewOnly: "no editable fields", signedOut: "no supplier data" })
        } finally { await context.close() }
      } } finally { await browser.close() }
    }
    assert.equal(results.length, 12)
    console.log(JSON.stringify({ passed: results.length, screenshots: output, verification: "actual supplier component/navigation/global CSS with synthetic auth/API; native transactions separately tested", results }, null, 2))
  } finally { await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
