// Actual SPC page + navigation + global CSS, with isolated synthetic session
// and API boundaries. The real API/native PostgreSQL flow is verified separately
// by spc-stem-native.test.mjs. No personal browser/session or hosted writes.
const assert = require("node:assert/strict")
const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")
const { build } = require("esbuild")
const postcss = require("postcss")
const tailwind = require("@tailwindcss/postcss")

const root = path.resolve(__dirname, "..")
const pageEntry = `
  import React from "react";
  import { createRoot } from "react-dom/client";
  import Page from "./app/spc/enquiries/page";
  import { SpcNavigationShell } from "./components/SpcNavigationShell";
  import { SPC_PAGE_DEFINITIONS } from "./lib/spcPages";
  const row = {
    id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",enquiryNumber:"SPC-SYNTHETIC",title:"SYNTHETIC VESSEL",vesselName:"SYNTHETIC VESSEL",port:"Singapore",
    product:"VLSFO",quantity:"500",deliveryDate:"2026-10-20",supplierName:null,status:"sent",notes:"synthetic vessel / singapore 20 oct / vlsfo 500mts",
    meta:{},formattedText:"synthetic vessel / singapore 20 oct / vlsfo 500mts",createdByDisplayName:"Synthetic Buyer",revisionNumber:1,
    lastAmendedAt:null,lastAmendedByUsername:null,amendmentChanges:[],createdAt:"2026-10-14T01:02:03.123456Z",updatedAt:"2026-10-14T01:02:03.123456Z"
  };
  const harness = window.__spcStemHarness = {
    auth:{loading:false,authenticated:true,username:"buyer@example.test",displayName:"Synthetic Buyer",role:"BUYER TRADER",mustChangePassword:false,
      permissions:{"spc-buyer-enquiries":"edit"},pages:SPC_PAGE_DEFINITIONS},
    requests:[],pending:[],routes:[],row,
    release(status=200,message="") {
      const next=this.pending.shift();if(!next)throw new Error("No held synthetic request");
      if(status===200){this.row={...this.row,status:"quoted",meta:{stemSupplierTraderUsername:next.body.supplierTraderUsername,stemSupplierTraderDisplayName:"Synthetic Supplier"}};}
      next.resolve(new Response(JSON.stringify(status===200?{success:true,enquiry:this.row}:{message}),{status,headers:{"Content-Type":"application/json"}}));
    }
  };
  window.fetch=async(input,init={})=>{
    const url=new URL(typeof input==="string"?input:input.url,window.location.origin),method=init.method||"GET";
    if(url.origin!==window.location.origin)throw new Error("External fetch blocked");
    const body=init.body?JSON.parse(init.body):null;
    harness.requests.push({url:url.pathname+url.search,method,body});
    const json=value=>new Response(JSON.stringify(value),{headers:{"Content-Type":"application/json"}});
    if(url.pathname==="/api/spc/enquiries"&&method==="GET")return json({enquiries:[harness.row],sessionKey:harness.auth.username,supplierTraders:[
      {username:"supplier@example.test",displayName:"Synthetic Supplier"},{username:"second@example.test",displayName:"Second Supplier"}],buyerLostReasons:["PRICE","NO AVAILABILITY"]});
    if(url.pathname==="/api/spc/enquiries"&&method==="PATCH")return new Promise(resolve=>harness.pending.push({body,resolve}));
    if(url.pathname==="/api/spc/mobile-mode"&&method==="GET")return json({eligible:false,enabled:false,expiresAt:null,maskedPhone:""});
    throw new Error("Unexpected synthetic fetch: "+method+" "+url.pathname);
  };
  const app=createRoot(document.getElementById("root"));
  harness.render=()=>app.render(<div className="fc-admin-scope spc-scope"><SpcNavigationShell><Page/></SpcNavigationShell></div>);
  harness.render();
`
const mocks = {
  "@/lib/useSpcAuth": `export const useSpcAuth=()=>window.__spcStemHarness.auth; export const clearSpcClientSessionCache=()=>{}; export const primeSpcClientSessionCache=()=>{};`,
  "next/navigation": `const router={replace:path=>window.__spcStemHarness.routes.push(path),prefetch:()=>{}};export const useRouter=()=>router;export const usePathname=()=>"/spc/enquiries";`,
  "next/link": `import React from "react";export default function Link({prefetch,...props}){return <a {...props}/>;}`,
  "next/image": `import React from "react";export default function Image({priority,unoptimized,fill,...props}){return <img {...props}/>;}`,
}

async function main() {
  const bundle = await build({ absWorkingDir: root, stdin: { contents: pageEntry, resolveDir: root, loader: "tsx" }, bundle: true, write: false,
    platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "isolated-spc-session-and-next-adapters", setup(builder) {
      builder.onResolve({ filter: /^(?:@\/lib\/useSpcAuth|next\/(?:navigation|link|image))$/ }, args => ({ path: args.path, namespace: "synthetic" }))
      builder.onLoad({ filter: /.*/, namespace: "synthetic" }, args => ({ contents: mocks[args.path], loader: "jsx", resolveDir: root }))
    } }],
  })
  const css = await postcss([tailwind()]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/globals.css"><title>Isolated SPC STEM component verification</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'
  const server = http.createServer((request, response) => {
    if (request.method !== "GET") { response.writeHead(405); response.end(); return }
    const pathname = new URL(request.url, "http://127.0.0.1").pathname
    if (pathname === "/bundle.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle.outputFiles[0].contents); return }
    if (pathname === "/globals.css") { response.setHeader("Content-Type", "text/css"); response.end(css.css); return }
    if (pathname === "/spc-sidebar-logo.png") { response.setHeader("Content-Type", "image/png"); response.end(fs.readFileSync(path.join(root, "public/spc-sidebar-logo.png"))); return }
    response.setHeader("Content-Type", "text/html"); response.end(html)
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const output = process.env.SPC_STEM_SCREENSHOTS || "/private/tmp/fcuno-spc-stem-ui-20261014"
  fs.mkdirSync(output, { recursive: true })
  const { chromium, webkit } = require("playwright")
  const results = []
  try {
    for (const [engine, launcher] of [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await launcher.launch({ headless: true, ...(engine === "chromium" && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) })
      try {
        for (const width of [320, 390, 1440]) for (const scheme of ["light", "dark"]) {
          const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, colorScheme: scheme, timezoneId: "Asia/Hong_Kong" })
          try {
            const unexpected = [], errors = []
            await context.route("**/*", route => {
              if (new URL(route.request().url()).origin === origin) return route.continue()
              unexpected.push(route.request().url()); return route.abort()
            })
            const page = await context.newPage()
            page.setDefaultTimeout(10000)
            page.on("pageerror", error => errors.push(error.message))
            page.on("console", message => { if (message.type() === "error" && !["Synthetic unavailable; retry is safe.", "This enquiry changed; refresh and try again."].includes(message.text())) errors.push(message.text()) })
            await page.goto(origin)
            await page.getByRole("button", { name: "STEM", exact: true }).waitFor()
            const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
            assert.ok(dimensions.scroll <= dimensions.width + 1, `${engine}/${width}/${scheme}: page overflow ${JSON.stringify(dimensions)}`)
            await page.getByRole("button", { name: "LOST", exact: true }).click()
            let dialog = page.getByRole("dialog", { name: "Update enquiry outcome" })
            await dialog.getByRole("button", { name: "Confirm", exact: true }).click()
            await page.waitForFunction(() => window.__spcStemHarness.pending.length === 1)
            for (const element of [dialog.getByRole("combobox"), dialog.getByRole("button", { name: "Cancel", exact: true }), dialog.getByRole("button", { name: "Close outcome dialog" }), dialog.getByRole("button", { name: "Saving...", exact: true })]) assert.equal(await element.isDisabled(), true)
            await page.screenshot({ path: path.join(output, `${engine}-${width}-${scheme}-lost-pending.png`) })
            await page.evaluate(() => window.__spcStemHarness.release(409, "This enquiry changed; refresh and try again."))
            await dialog.getByRole("alert").waitFor()
            await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
            await page.getByRole("button", { name: "STEM", exact: true }).click()
            dialog = page.getByRole("dialog", { name: "Update enquiry outcome" })
            const bounds = await dialog.boundingBox()
            assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1)
            await dialog.getByRole("combobox").selectOption("second@example.test")
            await dialog.getByRole("button", { name: "Confirm", exact: true }).click()
            await page.waitForFunction(() => window.__spcStemHarness.pending.length === 1)
            assert.equal(await dialog.getByRole("combobox").isDisabled(), true)
            assert.equal(await dialog.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true)
            assert.equal(await dialog.getByRole("button", { name: "Close outcome dialog" }).isDisabled(), true)
            await page.screenshot({ path: path.join(output, `${engine}-${width}-${scheme}-stem-pending.png`) })
            await page.evaluate(() => window.__spcStemHarness.release(503, "Synthetic unavailable; retry is safe."))
            await dialog.getByRole("alert").waitFor()
            await page.screenshot({ path: path.join(output, `${engine}-${width}-${scheme}-retry-error.png`) })
            await dialog.getByRole("button", { name: "Confirm", exact: true }).click()
            await page.waitForFunction(() => window.__spcStemHarness.pending.length === 1)
            const writes = await page.evaluate(() => window.__spcStemHarness.requests.filter(request => request.method === "PATCH" && request.body.outcome === "stem"))
            assert.equal(writes.length, 2)
            assert.deepEqual(writes[0].body, writes[1].body, "retry preserves the operation UUID, source version and selected supplier")
            assert.equal(writes[0].body.expectedUpdatedAt, "2026-10-14T01:02:03.123456Z")
            assert.match(writes[0].body.stemRequestId, /^[0-9a-f-]{36}$/i)
            await page.evaluate(() => window.__spcStemHarness.release(200))
            await dialog.waitFor({ state: "hidden" })
            assert.equal(await page.getByRole("button", { name: "STEM", exact: true }).count(), 0)
            await page.evaluate(() => { window.__spcStemHarness.auth = { ...window.__spcStemHarness.auth, authenticated: false, username: "", permissions: {} }; window.__spcStemHarness.render() })
            await page.getByText("Loading...", { exact: true }).waitFor()
            assert.equal(await page.getByText(/synthetic vessel \/ singapore/i).count(), 0)
            assert.deepEqual(errors, [])
            assert.deepEqual(unexpected, [])
            results.push({ engine, width, scheme, pendingControls: "disabled", retry: "same request", failure: "visible", signedOut: "no enquiry data" })
          } finally { await context.close() }
        }
      } finally { await browser.close() }
    }
    console.log(JSON.stringify({ passed: results.length, verification: "actual page/navigation/global CSS with synthetic session and API adapters; native real-API/database tests are separate", administratorTheme: "SPC admin is fixed light; both OS light/dark preferences exercised without inventing a theme", screenshots: output, results }, null, 2))
  } finally { await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
