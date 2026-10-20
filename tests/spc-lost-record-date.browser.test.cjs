// Actual source page/navigation/CSS; synthetic legacy GET transport and auth only.
// No pagination candidate imports or repository dependency changes.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http"), crypto = require("node:crypto")
const { createRequire } = require("node:module")
const root = process.argv[2] || path.resolve(__dirname, ".."), output = process.argv[3] || process.env.SPC_LOST_DATE_SCREENSHOTS, baseline = process.argv.includes("--baseline-timezone")
assert.ok(root && path.isAbsolute(root) && output && path.isAbsolute(output), "Pass absolute site and evidence directories.")
const siteRequire = createRequire(path.join(root, "package.json"))
const { build } = siteRequire("esbuild"), postcss = siteRequire("postcss"), tailwind = siteRequire("@tailwindcss/postcss")
const { chromium, webkit } = require("playwright")
const sourcePath = path.join(root, "app/spc/lost-record/page.tsx")
const fixture = `import React from 'react';import{createRoot}from'react-dom/client';import Lost from'record-page-under-test';import{SpcNavigationShell}from'@/components/SpcNavigationShell';import{SPC_PAGE_DEFINITIONS}from'@/lib/spcPages';
const params=new URLSearchParams(location.search),mode=params.get('mode')||'view';
const h=window.__lostDate={outcomeDate:null,createdOnly:false,requests:[],auth:{loading:false,authenticated:mode!=='signed-out',username:'synthetic@example.invalid',actorKey:'a'.repeat(64),displayName:'Synthetic User',mustChangePassword:false,role:mode==='edit'?'ADMIN':'BUYER TRADER',office:'HONG KONG',permissions:{'spc-lost-record':mode==='none'?'none':mode==='edit'?'edit':'view'},pages:SPC_PAGE_DEFINITIONS}};
window.fetch=async(input,init={})=>{const u=new URL(String(input),location.origin);if(u.origin!==location.origin)throw Error('External request blocked');h.requests.push({path:u.pathname,method:init.method||'GET'});if((init.method||'GET')!=='GET')throw Error('Writes forbidden in date test');if(u.pathname==='/api/parser-reports')return Response.json({readyForUserReview:0});if(u.pathname==='/api/spc/mobile-mode')return Response.json({eligible:false,enabled:false});if(u.pathname==='/api/spc/lost-reasons')return Response.json({buyerReasons:['PRICE'],supplierReasons:['OTHER']});if(u.pathname!=='/api/spc/enquiries')throw Error('Unexpected record transport '+u.pathname);const at='2026-10-16T01:02:03.123456Z';return Response.json({enquiries:[{id:'00000000-0000-4000-8000-000000000001',title:'DATE CONTROL VESSEL',vesselName:'DATE CONTROL VESSEL',deliveryDate:'2026-10-20',formattedText:'DATE CONTROL VESSEL / SINGAPORE',createdByDisplayName:'SYNTHETIC BUYER',createdAt:at,updatedAt:h.createdOnly?'':at,meta:{lostReason:'PRICE',...(h.outcomeDate?{outcomeAt:h.outcomeDate}:{})}}]})};
createRoot(document.getElementById('root')).render(<React.StrictMode><div className='fc-admin-scope spc-scope'><SpcNavigationShell><Lost/></SpcNavigationShell></div></React.StrictMode>);`
const mocks = {
  "@/lib/useSpcAuth": "export const useSpcAuth=()=>window.__lostDate.auth;export const clearSpcClientSessionCache=()=>{};export const primeSpcClientSessionCache=()=>{};",
  "next/navigation": "const r={push:()=>{},replace:()=>{},prefetch:()=>{}};export const useRouter=()=>r;export const usePathname=()=>'/spc/lost-record';",
  "next/link": "import React from'react';export default function Link({prefetch,...p}){return <a {...p}/>}",
  "next/image": "import React from'react';export default function Image({priority,unoptimized,fill,...p}){return <img {...p}/>}",
}
async function main() {
  fs.mkdirSync(output, { recursive: true })
  const bundle = await build({ absWorkingDir: root, stdin: { contents: fixture, sourcefile: "lost-date-fixture.tsx", resolveDir: root, loader: "tsx" }, bundle: true, write: false, outdir: "date-fixture", platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' }, plugins: [{ name: "date-fixture", setup(b) {
    b.onResolve({ filter: /^record-page-under-test$/ }, () => ({ path: sourcePath }))
    b.onResolve({ filter: /^(?:@\/lib\/useSpcAuth|next\/(?:navigation|link|image))$/ }, a => ({ path: a.path, namespace: "synthetic" }))
    b.onLoad({ filter: /.*/, namespace: "synthetic" }, a => ({ contents: mocks[a.path], loader: "jsx", resolveDir: root }))
    if (baseline) b.onLoad({ filter: /app\/spc\/lost-record\/page\.tsx$/ }, a => {
      const source = fs.readFileSync(a.path, "utf8"), line = '    timeZone: "Asia/Hong_Kong",\n'
      assert.ok(source.includes(line), "Baseline control removes only the exact correction in memory.")
      return { contents: source.replace(line, ""), loader: "tsx", resolveDir: path.dirname(a.path) }
    })
  } }] })
  const assets = new Map(bundle.outputFiles.map(f => ["/" + path.basename(f.path), f.contents]))
  const script = [...assets.keys()].find(p => p.endsWith(".js"))
  const css = await postcss([tailwind()]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1")
    if (req.method !== "GET") { res.writeHead(405); return res.end() }
    if (assets.has(u.pathname)) { res.setHeader("Content-Type", "text/javascript"); return res.end(assets.get(u.pathname)) }
    if (u.pathname === "/globals.css") { res.setHeader("Content-Type", "text/css"); return res.end(css.css) }
    const publicRoot = path.resolve(root, "public"), file = path.resolve(publicRoot, "." + u.pathname)
    if (file.startsWith(publicRoot + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) return res.end(fs.readFileSync(file))
    res.setHeader("Content-Type", "text/html");res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/globals.css"></head><body><div id="root"></div><script src="'+script+'"></script></body></html>')
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const origin = "http://127.0.0.1:" + server.address().port, results = []
  try {
    for (const [engine, launcher] of [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await launcher.launch({ headless: true })
      try { for (const timezoneId of ["America/Los_Angeles", "Asia/Hong_Kong"]) for (const width of [320,390,1440]) for (const scheme of ["light","dark"]) {
        const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, timezoneId, colorScheme: scheme })
        try {
          const external = [], errors = [], page = await context.newPage()
          page.on("pageerror", e => errors.push(e.message))
          await context.route("**/*", r => { if(new URL(r.request().url()).origin===origin)return r.continue();external.push(r.request().url());return r.abort() })
          await page.clock.install({ time: new Date("2026-10-16T01:02:03.123Z") })
          await page.goto(origin + "/?mode=view");await page.getByText("DATE CONTROL VESSEL",{exact:true}).waitFor()
          const cells = () => page.locator(".spc-lost-record-table tbody tr").nth(1).locator("td")
          const prefix = engine + "-" + timezoneId.replaceAll("/", "-") + "-" + width + "-" + scheme, result = { engine, timezoneId, width, scheme, timestampDate: await cells().first().innerText(), eta: await cells().nth(4).innerText() }
          await page.screenshot({path:path.join(output,prefix+"-timestamp.png")})
          const reload = async () => { await page.getByRole("button",{name:"REFRESH",exact:true}).click();await page.waitForFunction(()=>![...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="REFRESHING...")) }
          await page.evaluate(()=>{window.__lostDate.createdOnly=true});await reload();result.createdAtDate=await cells().first().innerText()
          await page.evaluate(()=>{window.__lostDate.outcomeDate="2026-10-20"});await reload();result.outcomeDate=await cells().first().innerText()
          await page.screenshot({path:path.join(output,prefix+"-date-only.png")})
          assert.deepEqual(errors,[]);assert.deepEqual(external,[])
          assert.ok((await page.evaluate(()=>window.__lostDate.requests)).every(r=>r.method==="GET"))
          const layout=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth}));assert.ok(layout.width<=layout.viewport+1,JSON.stringify(layout));
          for(const mode of ["edit","none","signed-out"]){
            await page.goto(origin+"/?mode="+mode);
            await page.waitForFunction(()=>Boolean(window.__lostDate));
            if(mode==="edit"){await page.getByText("DATE CONTROL VESSEL",{exact:true}).waitFor();assert.equal(await cells().first().innerText(),"16 OCT 2026");await page.getByPlaceholder("ADD SPC COMMENT",{exact:true}).waitFor();}
            else {assert.equal(await page.getByText("DATE CONTROL VESSEL",{exact:true}).count(),0);assert.equal(await page.evaluate(()=>window.__lostDate.requests.filter(r=>r.path==="/api/spc/enquiries").length),0);}
            await page.screenshot({path:path.join(output,prefix+"-"+mode+".png")});
          }
          assert.deepEqual(errors,[]);assert.deepEqual(external,[])
          assert.ok((await page.evaluate(()=>window.__lostDate.requests)).every(r=>r.method==="GET"))
          results.push({...result,accessStates:"View/Edit/none/signed-out checked"})
        } finally { await context.close() }
      } } finally { await browser.close() }
    }
    fs.writeFileSync(path.join(output,"results.json"),JSON.stringify({sourcePath,sourceSha256:crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex"),baseline,results,transport:"Legacy GET /api/spc/enquiries {enquiries}; no pagination code or helper.",cleanup:"All owned browsers/contexts closed; server closes in finally.",limits:["Synthetic auth/API; actual page/navigation/styles.","Emulated viewports, not physical phones."]},null,2))
    for(const r of results){assert.equal(r.timestampDate,"16 OCT 2026",JSON.stringify(r));assert.equal(r.createdAtDate,"16 OCT 2026",JSON.stringify(r));assert.equal(r.outcomeDate,"20 OCT 2026",JSON.stringify(r));assert.equal(r.eta,"2026-10-20",JSON.stringify(r))}
    assert.equal(results.length,24);console.log("24/24 actual-page timezone contexts passed; UTC timestamps/date-only DATE stable; date-only ETA unchanged.")
  } finally { await new Promise(resolve=>server.close(resolve)) }
}
main().catch(e=>{console.error(e);process.exitCode=1})
