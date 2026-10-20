// Actual audit pages/CSS; core synthetic auth plus a real admin provider/guard
// shell with a synthetic verified session endpoint. No provider access.
const assert = require("node:assert/strict")
const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const { createRequire } = require("node:module")
const root = path.resolve(__dirname, "..")
const repoRequire = createRequire(path.join(root, "package.json"))
const { build } = repoRequire("esbuild")
const postcss = repoRequire("postcss")
const tailwind = repoRequire("@tailwindcss/postcss")
const entry = `
import React from "react"; import {createRoot} from "react-dom/client";
import Admin from "./app/admin/auditlog/page"; import Spc from "./app/spc/auditlog/page";
const mode=new URLSearchParams(location.search).get("mode"), area=location.pathname.includes("/spc/")?"spc":"admin";
const permission=mode==="none"?"none":mode==="view"?"view":"edit";
const h=window.__auditHarness={requests:[],pending:[],routes:[],listMode:"normal",detailMode:"normal",undoMode:"normal",undoneIds:new Set(),owner:"VERIFIED USER",
 auth:{loading:false,authenticated:mode!=="signed-out",actorKey:"a".repeat(64),username:"VERIFIED USER",displayName:"Verified user",role:"USER",resetRequired:false,mustChangePassword:false,permissions:{"audit-log":permission,"spc-audit-log":permission},pages:[{id:"audit-log",label:"Audit Log",group:"management",path:"/admin/auditlog"}]},
 log(id,loaded=false){return {id,occurredAt:"2026-10-20T01:02:03.123456Z",actorId:"verified",actorName:this.owner,operation:"UPDATE",displayOperation:"UPDATE",pageId:area==="spc"?"spc-suppliers":"event-calendar",pageLabel:"Calendar",recordLabel:"SYNTHETIC ONLY",summary:id==="first"?"FIRST VERIFIED CHANGE":id==="second"?"SECOND VERIFIED CHANGE":id==="third"?"OLDER VERIFIED CHANGE":"PAGED CHANGE "+id,details:loaded?["VERIFIED DETAIL "+id+" / "+this.owner]:[],detailsLoaded:loaded,undoable:!this.undoneIds.has(id),undoOfLogId:null,undoneAt:this.undoneIds.has(id)?"2026-10-20T03:00:00Z":null}},
 payload(url){const cursor=url.searchParams.get("cursor");let logs,cursorNext,state;if(this.listMode==="many"){const n=Number(cursor?.slice(4)||0);logs=[this.log("many-"+n)];cursorNext="many"+(n+1);state="more";}else if(cursor==="cursor1"){logs=[];cursorNext="cursor2";state="scan-pending";}else if(cursor==="cursor2"){logs=[this.log("third")];cursorNext=null;state="exhausted";}else{logs=[this.log("first"),this.log("second")];cursorNext="cursor1";state="more";}return {logs,pages:[{id:area==="spc"?"spc-suppliers":"event-calendar",label:"Calendar"}],users:cursor?[]:[{value:"verified",label:"Verified user"}],totalMatches:null,pageInfo:{pageSize:150,returnedMatches:logs.length,state,hasMoreMatches:state==="more"?true:state==="exhausted"?false:null,nextCursor:cursorNext,consistency:"live-keyset"}}},
 release(kind,body,status=200){const index=this.pending.findIndex(item=>item.kind===kind);if(index<0)throw new Error("No pending "+kind);const [item]=this.pending.splice(index,1);if(kind==="undo"&&status===200)this.undoneIds.add(item.id);item.resolve(Response.json(body??item.body,{status}));},
};
window.fetch=async(input,init={})=>{const url=new URL(typeof input==="string"?input:input.url,location.origin);if(url.origin!==location.origin)throw new Error("External API forbidden");const method=init.method||"GET",id=url.searchParams.get("id");h.requests.push({method,path:url.pathname,query:url.search,body:init.body?JSON.parse(init.body):null});if(url.pathname==="/api/admin/session")return Response.json(h.auth);if(method==="POST"){const target=JSON.parse(init.body).id;if(h.undoMode==="hold")return new Promise(resolve=>h.pending.push({kind:"undo",id:target,body:{success:true},resolve}));h.undoneIds.add(target);return Response.json({success:true});}const kind=id?"detail":"list",setting=id?h.detailMode:h.listMode,body=id?{log:h.log(id,true)}:h.payload(url);if(setting==="hold")return new Promise(resolve=>h.pending.push({kind,body,resolve}));if(setting==="fail")return Response.json({message:"SYNTHETIC RETRYABLE FAILURE"},{status:503});if(setting==="deny")return Response.json({message:"DENIED"},{status:id?403:401});if(setting==="malformed")body.pageInfo.hasMoreMatches=false;return Response.json(body);};
const app=createRoot(document.getElementById("root"));h.unmount=()=>app.unmount();h.render=()=>app.render(<div className="fc-admin-scope spc-scope">{area==="spc"?<Spc/>:<Admin/>}</div>);h.render();
`
const mocks = {
  "@/lib/useSpcAuth": "export const useSpcAuth=()=>window.__auditHarness.auth;",
  "@/lib/useSimpleAdminAuth": "export const useSimpleAdminAuth=()=>window.__auditHarness.auth;",
  "next/navigation": "const router={replace:path=>window.__auditHarness.routes.push(path),push:path=>window.__auditHarness.routes.push(path)};export const useRouter=()=>router;export const usePathname=()=>location.pathname;",
}
const guardedEntry = entry.replace('import Admin from "./app/admin/auditlog/page";', 'import {AdminRouteGuard} from "./components/AdminRouteGuard"; import {SimpleAdminAuthProvider} from "./lib/useSimpleAdminAuth"; import Admin from "./app/admin/auditlog/page";')
  .replace('{area==="spc"?<Spc/>:<Admin/>}', '<SimpleAdminAuthProvider><AdminRouteGuard><div aria-label="Unsafe shell fixture"><select aria-label="Unsafe fixture"><option>Unsafe</option></select><button type="button">Delete fixture</button></div><Admin/></AdminRouteGuard></SimpleAdminAuthProvider>')

;(async () => {
  const output = process.env.AUDIT_BROWSING_SCREENSHOTS
  assert.ok(output && path.isAbsolute(output), "Use an owned absolute screenshot directory")
  fs.mkdirSync(output, { recursive: true })
  const makeBundle = (guarded = false, removeViewMarkers = false) => build({
    absWorkingDir: root, stdin: { contents: guarded ? guardedEntry : entry, resolveDir: root, loader: "tsx" },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "synthetic-auth", setup(builder) {
      builder.onResolve({ filter: /^(?:@\/lib\/useSpcAuth|@\/lib\/useSimpleAdminAuth|next\/navigation)$/ }, args => {
        if (guarded && args.path === "@/lib/useSimpleAdminAuth") return undefined
        return { path: args.path, namespace: "synthetic" }
      })
      builder.onLoad({ filter: /.*/, namespace: "synthetic" }, args => ({ contents: mocks[args.path], loader: "jsx", resolveDir: root }))
      // Next consumes this compiler-only prop. Keep the actual page CSS in
      // the isolated DOM without leaking an invalid boolean JSX attribute.
      builder.onLoad({ filter: /app\/admin\/auditlog\/page\.tsx$/ }, args => {
        let contents = fs.readFileSync(args.path, "utf8").replace("<style jsx>", "<style>")
        if (removeViewMarkers) contents = contents.replace(/data-admin-view-safe="true"/g, "")
        return { contents, loader: "tsx", resolveDir: path.dirname(args.path) }
      })
    } }],
  })
  const [bundle, guardedBundle, guardedBeforeBundle] = await Promise.all([makeBundle(), makeBundle(true), makeBundle(true, true)])
  const css = await postcss([tailwind()]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })
  const fontCss = fs.readFileSync(path.join(root, "app/fonts/roboto.css"))
  const publicRoot = fs.realpathSync(path.join(root, "public")), missingAssets = [], assets = new Map()
  const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex")
  const contentTypes = { ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8" }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1")
    if (req.method !== "GET") { res.writeHead(405); res.end(); return }
    if (url.pathname === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].contents); return }
    if (url.pathname === "/bundle-guard.js") { res.setHeader("Content-Type", "text/javascript"); res.end(guardedBundle.outputFiles[0].contents); return }
    if (url.pathname === "/bundle-guard-before.js") { res.setHeader("Content-Type", "text/javascript"); res.end(guardedBeforeBundle.outputFiles[0].contents); return }
    if (url.pathname === "/globals.css") { res.setHeader("Content-Type", "text/css"); res.end(css.css); return }
    if (url.pathname === "/roboto.css") { res.setHeader("Content-Type", "text/css"); assets.set("app/fonts/roboto.css", hash(fontCss)); res.end(fontCss); return }
    let pathname
    try { pathname = decodeURIComponent(url.pathname) } catch { res.writeHead(400); res.end(); return }
    const candidate = path.resolve(publicRoot, "." + pathname)
    if (candidate.startsWith(publicRoot + path.sep) && fs.existsSync(candidate)) {
      const file = fs.realpathSync(candidate)
      if (file.startsWith(publicRoot + path.sep) && fs.statSync(file).isFile()) {
        const bytes = fs.readFileSync(file)
        assets.set(path.relative(root, file), hash(bytes))
        res.setHeader("Content-Type", contentTypes[path.extname(file).toLowerCase()] || "application/octet-stream")
        res.end(bytes); return
      }
    }
    if (!["/admin/auditlog", "/spc/auditlog"].includes(url.pathname)) { missingAssets.push(url.pathname); res.writeHead(404); res.end(); return }
    res.setHeader("Content-Type", "text/html")
    const script = url.searchParams.get("shell") === "before" ? "/bundle-guard-before.js" : url.searchParams.has("shell") ? "/bundle-guard.js" : "/bundle.js"
    res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="preload" href="/fonts/roboto/roboto-v51-latin.0a44e0bb6ba5c853.woff2" as="font" type="font/woff2" crossorigin="anonymous"><link rel="stylesheet" href="/roboto.css"><link rel="stylesheet" href="/globals.css"></head><body><div id="root"></div><script src="'+script+'"></script></body></html>')
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = "http://127.0.0.1:" + server.address().port
  const { chromium, webkit } = require("playwright")
  const results = [], shellResults = []
  try {
    for (const [engine, launcher] of [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await launcher.launch({ headless: true })
      try {
        for (const width of [320, 390, 1440]) for (const scheme of ["light", "dark"]) for (const area of ["admin", "spc"]) {
          const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, colorScheme: scheme, timezoneId: "Asia/Hong_Kong" })
          try {
            const page = await context.newPage(), errors = [], consoleErrors = [], external = [], responseErrors = []
            page.setDefaultTimeout(10_000)
            page.on("pageerror", error => errors.push(error.message))
            page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()) })
            page.on("response", response => { if (response.status() >= 400) responseErrors.push({ url: response.url(), status: response.status() }) })
            page.on("dialog", dialog => dialog.accept())
            await context.route("**/*", route => {
              if (new URL(route.request().url()).origin === origin) return route.continue()
              external.push(route.request().url()); return route.abort()
            })
            const route = origin + "/" + area + "/auditlog"
            const first = page.getByText("FIRST VERIFIED CHANGE", { exact: true }).first()
            const second = page.getByText("SECOND VERIFIED CHANGE", { exact: true }).first()
            const refresh = page.getByRole("button", { name: "Refresh", exact: true })
            const screenshot = async suffix => {
              const layout = await page.evaluate(async () => {
                const faces = await document.fonts.load('400 13px "Roboto"', "VERIFIED USER")
                await document.fonts.ready
                return { width: innerWidth, scroll: document.documentElement.scrollWidth, fontFamily: getComputedStyle(document.body).fontFamily,
                  robotoLoaded: faces.length > 0 && faces.every(face => face.status === "loaded") && document.fonts.check('400 13px "Roboto"', "VERIFIED USER") }
              })
              assert.equal(layout.robotoLoaded, true, JSON.stringify(layout))
              assert.match(layout.fontFamily, /Roboto/)
              assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout))
              await page.screenshot({ path: path.join(output, `${engine}-${width}-${scheme}-${area}-${suffix}.png`), fullPage: true })
            }
            const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
            await page.goto(route)
            await page.getByText("VERIFIED DETAIL first / VERIFIED USER", { exact: true }).waitFor()
            await screenshot("initial")

            // A legacy same-ID detail response may use an old actor map. It
            // owns only detail text/Undo status, never the verified list labels.
            await page.evaluate(() => { window.__auditHarness.detailMode = "hold" })
            await page.getByLabel("User", { exact: true }).selectOption("verified")
            await page.waitForFunction(() => window.__auditHarness.pending.some(item => item.kind === "detail"))
            await page.evaluate(() => {
              const h = window.__auditHarness, body = h.pending.find(item => item.kind === "detail").body
              Object.assign(body.log, {
                occurredAt: "2035-01-01T01:02:03Z", actorId: "LEGACY ACTOR ID", actorName: "LEGACY ACTOR NAME",
                operation: "DELETE", displayOperation: "DELETE", pageId: "wrong-page", pageLabel: "WRONG DETAIL PAGE",
                recordLabel: "WRONG DETAIL LABEL", summary: "WRONG DETAIL SUMMARY",
                details: ["AUTHORIZED CURRENT DETAIL TEXT"], detailsLoaded: true,
                undoable: false, undoOfLogId: "synthetic-undo-receipt", undoneAt: "2026-10-20T03:00:00Z",
              })
              h.release("detail", body)
            })
            await page.getByText("AUTHORIZED CURRENT DETAIL TEXT", { exact: true }).waitFor()
            assert.equal(await first.count(), 1)
            assert.equal(await second.count(), 1)
            assert.equal(await page.getByText(/LEGACY ACTOR|WRONG DETAIL/).count(), 0)
            assert.equal(await page.getByText(/2035/).count(), 0)
            assert.equal(await page.getByLabel("User", { exact: true }).inputValue(), "verified")
            assert.equal(await page.getByRole("button", { name: "Undo", exact: true }).first().isDisabled(), true)
            if (area === "spc") assert.match(await page.locator(".spc-audit-detail > p").textContent(), /Calendar · UPDATE/)
            else {
              assert.equal(await page.locator("tbody").getByText("DELETE", { exact: true }).count(), 0)
              await page.getByText("Undone", { exact: true }).waitFor()
            }
            await screenshot("detail-preserves-list")
            await page.goto(route)
            await page.getByText("VERIFIED DETAIL first / VERIFIED USER", { exact: true }).waitFor()
            await second.click()
            await page.getByText("VERIFIED DETAIL second / VERIFIED USER", { exact: true }).waitFor()
            await page.getByRole("button", { name: "Load older", exact: true }).click()
            await page.getByText("More history needs to be checked. Continue searching for matching changes.", { exact: true }).waitFor()
            assert.equal(await page.getByText(/No (changes|SPC audit records)/).count(), 0)
            await screenshot("scan-pending")
            await page.getByRole("button", { name: "Continue searching", exact: true }).click()
            await page.getByText("OLDER VERIFIED CHANGE", { exact: true }).first().waitFor()
            await page.getByRole("button", { name: "Previous", exact: true }).click()
            await page.getByRole("button", { name: "Continue searching", exact: true }).waitFor()
            await refresh.click(); await first.waitFor()
            await page.getByLabel("User", { exact: true }).selectOption("verified")
            await first.waitFor()
            await page.getByRole("button", { name: "Load older", exact: true }).click()
            await page.getByRole("button", { name: "Continue searching", exact: true }).waitFor()
            assert.equal(await page.getByLabel("User", { exact: true }).inputValue(), "verified")
            await page.goto(route); await first.waitFor()

            // Retryable/malformed list failures keep the last verified page.
            await page.evaluate(() => { window.__auditHarness.listMode = "fail" })
            await refresh.click(); await page.getByText("SYNTHETIC RETRYABLE FAILURE", { exact: false }).waitFor()
            assert.equal(await first.count(), 1)
            await page.evaluate(() => { window.__auditHarness.listMode = "normal" })
            await page.getByRole("button", { name: "Retry", exact: true }).click()
            await page.waitForFunction(() => !document.body.textContent.includes("SYNTHETIC RETRYABLE FAILURE"))
            await page.evaluate(() => { window.__auditHarness.listMode = "malformed" })
            await refresh.click(); await page.getByText("The audit records could not be verified. Please retry.", { exact: false }).waitFor()
            assert.equal(await first.count(), 1)
            await screenshot("malformed-kept")
            await page.evaluate(() => { window.__auditHarness.listMode = "normal" })
            await page.getByRole("button", { name: "Retry", exact: true }).click()
            await page.waitForFunction(() => !document.body.textContent.includes("could not be verified"))

            // Detail retry is explicit, and late detail/list responses cannot cross a filter boundary.
            await page.evaluate(() => { window.__auditHarness.detailMode = "fail" })
            await second.click(); await page.getByText("SYNTHETIC RETRYABLE FAILURE", { exact: false }).waitFor()
            await page.evaluate(() => { window.__auditHarness.detailMode = "normal" })
            await page.getByRole("button", { name: "Retry", exact: true }).click()
            await page.getByText("VERIFIED DETAIL second / VERIFIED USER", { exact: true }).waitFor()
            await settle()
            assert.equal(await page.getByText("SYNTHETIC RETRYABLE FAILURE", { exact: false }).count(), 0)
            assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).count(), 0)
            await page.evaluate(() => { window.__auditHarness.listMode = "hold" })
            await page.getByLabel("Page", { exact: true }).selectOption(area === "spc" ? "spc-suppliers" : "event-calendar")
            await page.waitForFunction(() => window.__auditHarness.pending.some(item => item.kind === "list"))
            assert.equal(await first.count(), 0)
            await page.evaluate(() => { window.__auditHarness.listMode = "normal" })
            await page.getByLabel("Page", { exact: true }).selectOption("all")
            await first.waitFor()
            await page.evaluate(() => {
              const h = window.__auditHarness, body = h.pending.find(item => item.kind === "list").body
              body.logs[0].summary = "STALE LIST MUST NOT APPEAR"; h.release("list", body)
            })
            await settle(); assert.equal(await page.getByText("STALE LIST MUST NOT APPEAR", { exact: true }).count(), 0)
            await page.evaluate(() => { window.__auditHarness.detailMode = "hold" })
            await second.click(); await page.waitForFunction(() => window.__auditHarness.pending.some(item => item.kind === "detail"))
            await page.evaluate(() => { const h = window.__auditHarness; h.owner = "NEW VERIFIED USER"; h.detailMode = "normal"; h.auth = { ...h.auth, username: h.owner, actorKey: "b".repeat(64) }; h.render() })
            await page.getByText("VERIFIED DETAIL first / NEW VERIFIED USER", { exact: true }).waitFor()
            await page.evaluate(() => { const h = window.__auditHarness, body = h.pending.find(item => item.kind === "detail").body; body.log.details = ["STALE PRIVATE DETAIL"]; h.release("detail", body) })
            await settle(); assert.equal(await page.getByText("STALE PRIVATE DETAIL", { exact: true }).count(), 0)

            // Access failures clear data immediately, rather than retaining private rows.
            await page.evaluate(() => { window.__auditHarness.listMode = "deny" })
            await refresh.click(); await page.getByText(/Access to these audit records is no longer available/).waitFor()
            assert.equal(await first.count(), 0); assert.equal(await second.count(), 0)
            await screenshot("access-cleared")
            await page.evaluate(() => { window.__auditHarness.listMode = "normal" })
            await page.getByRole("button", { name: "Retry", exact: true }).click(); await first.waitFor()
            await page.evaluate(() => { window.__auditHarness.detailMode = "deny" })
            await second.click(); await page.getByText(/Access to these audit records is no longer available/).waitFor()
            assert.equal(await first.count(), 0)
            const beforeDeniedRetry = await page.evaluate(() => window.__auditHarness.requests.length)
            await page.evaluate(() => { window.__auditHarness.detailMode = "normal" })
            await page.getByRole("button", { name: "Retry", exact: true }).click()
            await page.getByText("VERIFIED DETAIL first / NEW VERIFIED USER", { exact: true }).waitFor()
            const deniedRetry = await page.evaluate(before => window.__auditHarness.requests.slice(before), beforeDeniedRetry)
            const recoveredList = deniedRetry.find(item => item.method === "GET" && !new URLSearchParams(item.query).has("id"))
            assert.ok(recoveredList, "Denied detail Retry must recover the verified list, not a null selection")
            assert.equal(new URLSearchParams(recoveredList.query).has("cursor"), false)
            assert.equal(await first.count(), 1)

            // A manual list refresh must not discard a later successful Undo.
            await page.goto(route); await first.waitFor()
            await page.evaluate(() => { window.__auditHarness.undoMode = "hold" })
            await page.getByRole("button", { name: "Undo", exact: true }).first().click()
            await page.waitForFunction(() => window.__auditHarness.pending.some(item => item.kind === "undo"))
            await page.evaluate(() => { window.__auditHarness.detailMode = "hold" })
            await refresh.click()
            await page.waitForFunction(() => window.__auditHarness.pending.some(item => item.kind === "detail"))
            await page.evaluate(() => { window.__auditHarness.detailMode = "normal"; window.__auditHarness.release("detail") })
            await page.getByText("VERIFIED DETAIL first / VERIFIED USER", { exact: true }).waitFor()
            const beforeUndoRelease = await page.evaluate(() => window.__auditHarness.requests.length)
            await page.evaluate(() => window.__auditHarness.release("undo"))
            await page.getByText("Undo applied.", { exact: false }).waitFor()
            await page.waitForFunction(before => window.__auditHarness.requests.slice(before).some(item => item.method === "GET" && !new URLSearchParams(item.query).has("id")), beforeUndoRelease)
            await page.getByText("VERIFIED DETAIL first / VERIFIED USER", { exact: true }).waitFor()
            assert.equal(await page.getByRole("button", { name: "Undo", exact: true }).first().isDisabled(), true)
            const afterUndo = await page.evaluate(before => window.__auditHarness.requests.slice(before), beforeUndoRelease)
            const refreshedAfterUndo = afterUndo.find(item => item.method === "GET" && !new URLSearchParams(item.query).has("id"))
            assert.ok(refreshedAfterUndo)
            assert.equal(new URLSearchParams(refreshedAfterUndo.query).has("cursor"), false)

            // Successful detail work cannot erase a newer failed list read.
            await page.goto(route)
            await page.getByText("VERIFIED DETAIL first / VERIFIED USER", { exact: true }).waitFor()
            await page.evaluate(() => { window.__auditHarness.detailMode = "hold" })
            await second.click()
            await page.waitForFunction(() => window.__auditHarness.pending.some(item => item.kind === "detail"))
            await page.evaluate(() => { window.__auditHarness.listMode = "fail" })
            await refresh.click()
            await page.getByText("SYNTHETIC RETRYABLE FAILURE", { exact: false }).waitFor()
            await page.waitForFunction(() => window.__auditHarness.pending.filter(item => item.kind === "detail").length >= 2)
            await page.evaluate(() => { window.__auditHarness.release("detail"); window.__auditHarness.release("detail") })
            await page.getByText("VERIFIED DETAIL second / VERIFIED USER", { exact: true }).waitFor()
            await settle()
            assert.equal(await page.getByText("SYNTHETIC RETRYABLE FAILURE", { exact: false }).count(), 1)
            assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).count(), 1)
            await page.evaluate(() => { window.__auditHarness.listMode = "normal"; window.__auditHarness.detailMode = "normal" })
            await page.getByRole("button", { name: "Retry", exact: true }).click()
            await page.waitForFunction(() => !document.body.textContent.includes("SYNTHETIC RETRYABLE FAILURE"))

            // A failed pending list remains the primary retry target even if
            // its old selected detail fails too, or the user selects an old row.
            await page.goto(route)
            await page.getByText("VERIFIED DETAIL first / VERIFIED USER", { exact: true }).waitFor()
            await page.evaluate(() => { window.__auditHarness.detailMode = "hold" })
            await second.click()
            await page.waitForFunction(() => window.__auditHarness.pending.some(item => item.kind === "detail"))
            await page.evaluate(() => { window.__auditHarness.listMode = "fail" })
            await page.getByRole("button", { name: "Load older", exact: true }).click()
            await page.getByText("SYNTHETIC RETRYABLE FAILURE", { exact: false }).waitFor()
            await page.waitForFunction(() => window.__auditHarness.pending.filter(item => item.kind === "detail").length >= 2)
            await page.evaluate(() => { window.__auditHarness.release("detail"); window.__auditHarness.release("detail", {message:"SYNTHETIC DETAIL FAILURE"}, 503) })
            await settle()
            assert.equal(await page.getByText("SYNTHETIC RETRYABLE FAILURE", { exact: false }).count(), 1)
            assert.equal(await page.getByText("SYNTHETIC DETAIL FAILURE", { exact: false }).count(), 0)
            await first.click()
            assert.equal(await page.getByText("SYNTHETIC RETRYABLE FAILURE", { exact: false }).count(), 1)
            const beforeListPriorityRetry = await page.evaluate(() => window.__auditHarness.requests.length)
            await page.evaluate(() => { window.__auditHarness.listMode = "normal"; window.__auditHarness.detailMode = "normal" })
            await page.getByRole("button", { name: "Retry", exact: true }).click()
            await page.getByRole("button", { name: "Continue searching", exact: true }).waitFor()
            const prioritizedRetry = await page.evaluate(before => window.__auditHarness.requests.slice(before), beforeListPriorityRetry)
            const retriedList = prioritizedRetry.find(item => item.method === "GET" && !new URLSearchParams(item.query).has("id"))
            assert.ok(retriedList)
            assert.equal(new URLSearchParams(retriedList.query).get("cursor"), "cursor1")

            // Existing undo method/body retained; refresh starts at the newest history.
            await page.goto(route); await first.waitFor()
            await page.getByRole("button", { name: "Undo", exact: true }).first().click()
            await page.getByText("Undo applied.", { exact: false }).waitFor()
            const undo = await page.evaluate(() => { const h = window.__auditHarness, index = h.requests.findIndex(item => item.method === "POST"); return { request: h.requests[index], following: h.requests.slice(index + 1).find(item => item.method === "GET" && !new URLSearchParams(item.query).has("id")) } })
            assert.deepEqual(undo.request.body, { action: "undo", id: "first" })
            assert.ok(undo.following); assert.equal(new URLSearchParams(undo.following.query).has("cursor"), false)

            // All affected permission states; denied users issue no audit requests.
            await page.goto(route + "?mode=view"); await first.waitFor()
            assert.equal(await page.getByRole("button", { name: "Undo", exact: true }).first().isDisabled(), true)
            await screenshot("view")
            if (area === "admin") {
              // The actual global guard must run with a verified non-admin
              // View session. First reproduce the missing-marker failure,
              // then prove only read controls are exempt in the fixed page.
              await page.goto(route + "?mode=view&shell=before")
              await page.getByText("VERIFIED DETAIL first / VERIFIED USER", { exact: true }).waitFor()
              await page.waitForFunction(() => document.querySelector('select[aria-label="Unsafe fixture"]')?.disabled === true)
              for (const label of ["Page", "Operation", "User"]) assert.equal(await page.getByLabel(label, { exact: true }).isDisabled(), true)
              assert.equal(await page.getByRole("button", { name: "Delete fixture", exact: true }).isDisabled(), true)
              await page.evaluate(() => { window.__auditHarness.listMode = "fail" })
              await refresh.click()
              await page.getByText("SYNTHETIC RETRYABLE FAILURE", { exact: false }).waitFor()
              await page.waitForFunction(() => [...document.querySelectorAll("button")].find(button => button.textContent === "Retry")?.dataset.adminViewOnlyDisabled === "true")
              assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).isDisabled(), true)

              await page.goto(route + "?mode=view&shell=guarded")
              await page.getByText("VERIFIED DETAIL first / VERIFIED USER", { exact: true }).waitFor()
              await page.waitForFunction(() => document.querySelector('select[aria-label="Unsafe fixture"]')?.disabled === true)
              assert.equal(await page.getByRole("button", { name: "Delete fixture", exact: true }).isDisabled(), true)
              for (const label of ["Page", "Operation", "User"]) assert.equal(await page.getByLabel(label, { exact: true }).isEnabled(), true)
              const sessionReads = await page.evaluate(() => window.__auditHarness.requests.filter(item => item.path === "/api/admin/session"))
              assert.ok(sessionReads.length > 0, "The actual auth provider must verify its synthetic session endpoint")
              await page.getByLabel("Page", { exact: true }).selectOption("event-calendar")
              await page.getByText("VERIFIED DETAIL first / VERIFIED USER", { exact: true }).waitFor()
              await page.getByLabel("Operation", { exact: true }).selectOption("UPDATE")
              await page.getByText("VERIFIED DETAIL first / VERIFIED USER", { exact: true }).waitFor()
              await page.getByLabel("User", { exact: true }).selectOption("verified")
              await page.getByText("VERIFIED DETAIL first / VERIFIED USER", { exact: true }).waitFor()
              const filteredRead = await page.evaluate(() => window.__auditHarness.requests.filter(item => item.path === "/api/admin/audit-logs" && item.method === "GET" && !new URLSearchParams(item.query).has("id")).at(-1))
              const filterQuery = new URLSearchParams(filteredRead.query)
              assert.equal(filterQuery.get("page"), "event-calendar")
              assert.equal(filterQuery.get("operation"), "UPDATE")
              assert.equal(filterQuery.get("actor"), "verified")
              await page.evaluate(() => { window.__auditHarness.listMode = "fail" })
              await refresh.click()
              await page.getByText("SYNTHETIC RETRYABLE FAILURE", { exact: false }).waitFor()
              await settle()
              assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).isEnabled(), true)
              assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).getAttribute("data-admin-view-safe"), "true")
              await page.evaluate(() => { window.__auditHarness.listMode = "normal" })
              await page.getByRole("button", { name: "Retry", exact: true }).click()
              await page.waitForFunction(() => !document.body.textContent.includes("SYNTHETIC RETRYABLE FAILURE"))
              await page.getByText("VERIFIED DETAIL first / VERIFIED USER", { exact: true }).waitFor()
              const undoButton = page.getByRole("button", { name: "Undo", exact: true }).first()
              assert.equal(await undoButton.isDisabled(), true)
              assert.equal(await undoButton.evaluate(button => button.closest('[data-admin-view-safe="true"]') !== null), false)
              const deniedWrite = await page.evaluate(async () => {
                const h = window.__auditHarness, before = h.requests.length
                // A verified session read can legitimately run while the
                // async guard rejects a write. Count only writes, not all I/O.
                const unrelatedRead = Promise.resolve().then(() => fetch("/api/admin/session"))
                const response = await fetch("/api/admin/audit-logs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "undo", id: "first" }) })
                const readResponse = await unrelatedRead, message = (await response.json()).message
                const requestsDuringProbe = h.requests.slice(before)
                const countAuditPosts = requests => requests.filter(item => item.method === "POST" && item.path === "/api/admin/audit-logs").length
                return { status: response.status, message, readStatus: readResponse.status, requestsDuringProbe,
                  forwardedAuditPosts: countAuditPosts(requestsDuringProbe),
                  // Detector control only: never sent or added to the trace.
                  matchingPostPositiveControl: countAuditPosts([...requestsDuringProbe, { method: "POST", path: "/api/admin/audit-logs", body: { unexpected: "wrong-body-must-still-count" } }]),
                  undone: [...h.undoneIds] }
              })
              console.log("View guard probe " + JSON.stringify(deniedWrite))
              assert.equal(deniedWrite.status, 403)
              assert.match(deniedWrite.message, /view-only/)
              assert.equal(deniedWrite.readStatus, 200)
              assert.ok(deniedWrite.requestsDuringProbe.some(item => item.method === "GET" && item.path === "/api/admin/session"))
              assert.equal(deniedWrite.forwardedAuditPosts, 0)
              assert.equal(deniedWrite.matchingPostPositiveControl, 1)
              assert.deepEqual(deniedWrite.undone, [])
              await screenshot("actual-guard-view")
              for (const mode of ["none", "signed-out"]) {
                await page.goto(route + "?mode=" + mode + "&shell=guarded")
                await page.getByRole("heading", { name: "Access Denied", exact: true }).waitFor()
                assert.equal(await page.evaluate(() => window.__auditHarness.requests.filter(item => item.path === "/api/admin/audit-logs").length), 0)
                await screenshot("actual-guard-" + mode)
              }
              shellResults.push({ engine, width, scheme, area, status: "passed", actualProviderAndGuard: true, noMarkerNegativeReproduced: true, viewFiltersAndRetryEnabled: true, unsafeControlsDisabled: true, undoPostBlockedBeforeTransport: true, unrelatedSessionReadObserved: true, matchingPostPositiveControl: true })
            }
            for (const mode of ["none", "signed-out"]) {
              await page.goto(route + "?mode=" + mode)
              if (area === "spc") await page.waitForFunction(() => window.__auditHarness.routes.includes("/spc"))
              else await page.getByText(mode === "none" ? "You do not have permission to view audit records." : "Please log in from the admin homepage first.", { exact: true }).waitFor()
              assert.equal(await page.evaluate(() => window.__auditHarness.requests.length), 0)
              assert.equal(await first.count(), 0)
              await screenshot(mode)
            }
            // Exercise the bounded cursor window once per page, not hundreds of duplicate reads.
            if (engine === "chromium" && width === 1440 && scheme === "light") {
              await page.goto(route); await first.waitFor()
              await page.evaluate(() => { window.__auditHarness.listMode = "many" })
              await refresh.click(); await page.getByText("PAGED CHANGE many-0", { exact: true }).first().waitFor()
              for (let n = 1; n <= 21; n++) {
                await page.getByRole("button", { name: "Load older", exact: true }).click()
                await page.getByText("PAGED CHANGE many-" + n, { exact: true }).first().waitFor()
              }
              await page.getByText("Only the last 20 pages are kept for Previous. Refresh to restart from the newest changes.", { exact: true }).waitFor()
              assert.equal(await page.getByText("PAGED CHANGE many-0", { exact: true }).count(), 0)
              for (let n = 20; n >= 2; n--) {
                await page.getByRole("button", { name: "Previous", exact: true }).click()
                await page.getByText("PAGED CHANGE many-" + n, { exact: true }).first().waitFor()
              }
              assert.equal(await page.getByRole("button", { name: "Previous", exact: true }).isDisabled(), true)
            }
            // An unmounted hook must not start a background list read after
            // an already-sent Undo resolves. This does not cancel the write.
            await page.goto(route)
            await page.getByText("VERIFIED DETAIL first / VERIFIED USER", { exact: true }).waitFor()
            await page.evaluate(() => { window.__auditHarness.undoMode = "hold" })
            await page.getByRole("button", { name: "Undo", exact: true }).first().click()
            await page.waitForFunction(() => window.__auditHarness.pending.some(item => item.kind === "undo"))
            await page.evaluate(() => window.__auditHarness.unmount())
            const beforeUnmountRelease = await page.evaluate(() => window.__auditHarness.requests.length)
            await page.evaluate(() => window.__auditHarness.release("undo"))
            await settle()
            assert.equal(await page.evaluate(() => window.__auditHarness.requests.length), beforeUnmountRelease)
            assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []); assert.deepEqual(external, []); assert.deepEqual(responseErrors, []); assert.deepEqual(missingAssets, [])
            results.push({ engine, width, scheme, area, status: "passed", detailPreservesList: true, productionRobotoLoaded: true, consoleErrors: 0, missingAssets: 0 })
            console.log(`${engine} ${width} ${scheme} ${area} passed`)
          } finally { await context.close() }
        }
      } finally { await browser.close() }
    }
    assert.equal(results.length, 24)
    assert.equal(shellResults.length, 12)
    fs.writeFileSync(path.join(output, "results.json"), JSON.stringify({ results, shellResults, assets: Object.fromEntries([...assets].sort()),
      sources: Object.fromEntries(["app/admin/auditlog/page.tsx", "app/spc/auditlog/page.tsx", "lib/useAuditBrowsing.ts", "components/AdminRouteGuard.tsx", "lib/useSimpleAdminAuth.ts", "lib/clientSessionStore.ts", "lib/adminPageRegistry.ts", "lib/adminPages.ts", "lib/adminViewOnlyRequests.ts", "tests/audit-browsing-state.browser.test.cjs"].map(file => [file, hash(fs.readFileSync(path.join(root, file)))])),
      limits: ["Actual pages, root font stylesheet/preload and global CSS; core synthetic auth/API, plus real admin provider/guard with a synthetic session endpoint. Backend permission tests are separate.", "Next navigation is stubbed to the actual fixture pathname; Next's compiler-only style jsx prop is consumed in esbuild; actual CSS is unchanged.", "The no-marker negative variant removes only the two View-safe page attributes in its in-memory bundle; no guard source is modified.", "No personal browser, provider writes, real undo, physical device or iOS Safari."], cleanup: "All owned contexts, browsers and local server closed." }, null, 2))
    console.log("24/24 core audit browser contexts and 12/12 actual admin-shell matrices passed")
  } finally { await new Promise(resolve => server.close(resolve)) }
})().catch(error => { console.error(error); process.exitCode = 1 })
