// Actual shared navigation shells and global CSS. Session adapters and page
// content are synthetic; no personal browser, hosted account or outbound fetch.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const path = require("node:path")
const { build } = require("esbuild")
const postcss = require("postcss")
const tailwind = require("@tailwindcss/postcss")
const { chromium, webkit } = require("playwright")
const root = path.resolve(__dirname, "..")

const entry = `
  import React from "react";
  import { createRoot } from "react-dom/client";
  import { AdminNavigationShell } from "./components/AdminNavigationShell";
  import { SpcNavigationShell } from "./components/SpcNavigationShell";
  import { ADMIN_PAGE_DEFINITIONS } from "./lib/adminPages";
  import { SPC_PAGE_DEFINITIONS } from "./lib/spcPages";
  const spc = new URLSearchParams(location.search).get("shell") === "spc";
  const harness = window.__navigationHarness = {
    auth: {loading:false,authenticated:true,resetRequired:false,mustChangePassword:false,
      role:"ADMIN",username:"synthetic@example.invalid",displayName:"Synthetic verifier",
      permissions:Object.fromEntries((spc?SPC_PAGE_DEFINITIONS:ADMIN_PAGE_DEFINITIONS).map(page=>[page.id,"edit"])),
      pages:spc?SPC_PAGE_DEFINITIONS:ADMIN_PAGE_DEFINITIONS},
    pathname:spc?"/spc/enquiries":"/admin/outlookaddressbook"
  };
  window.fetch=()=>{throw new Error("Unexpected fetch in isolated navigation fixture")};
  const Shell = spc ? SpcNavigationShell : AdminNavigationShell;
  const app = createRoot(document.getElementById("root"));
  harness.render=()=>app.render(<div className={"fc-admin-scope"+(spc?" spc-scope":"")}>
    <Shell>{harness.auth.authenticated ? <main style={{padding:12,minHeight:2400}}>
      <label style={{display:"block"}}>Top search<input aria-label="Top search" style={{display:"block",width:"100%"}}/></label>
      <div style={{height:700}}/>
      <label style={{display:"block"}}>Lower search<input aria-label="Lower search" style={{display:"block",width:"100%"}}/></label>
    </main> : <main>Signed-out placeholder</main>}</Shell>
  </div>);
  harness.render();
`

async function main() {
  const mocks = {
    "@/lib/useSimpleAdminAuth": "export const useSimpleAdminAuth=()=>window.__navigationHarness.auth; export const clearAdminClientSessionCache=()=>{};",
    "@/lib/useSpcAuth": "export const useSpcAuth=()=>window.__navigationHarness.auth;export const clearSpcClientSessionCache=()=>{};",
    "@/components/ParserReportSidebarBadge": "export const ParserReportSidebarBadge=()=>null;",
    "@/components/SpcMobileModeControl": "export const SpcMobileModeControl=()=>null;",
    "@/components/SpcForcedPasswordChange": "export const SpcForcedPasswordChange=()=>null;",
    "next/navigation": "const router={replace:()=>{},prefetch:()=>{}};export const useRouter=()=>router;export const usePathname=()=>window.__navigationHarness.pathname;",
    "next/link": "import React from 'react';export default function Link({prefetch,...props}){return <a {...props}/>;}",
    "next/image": "import React from 'react';export default function Image({priority,unoptimized,fill,...props}){return <img {...props}/>;}",
  }
  const bundle = await build({absWorkingDir:root,stdin:{contents:entry,resolveDir:root,loader:"tsx"},bundle:true,write:false,
    platform:"browser",format:"iife",jsx:"automatic",define:{"process.env.NODE_ENV":'"development"'},
    plugins:[{name:"synthetic-session-and-next-adapters",setup(builder){
      builder.onResolve({filter:/^(?:@\/lib\/(?:useSimpleAdminAuth|useSpcAuth)|@\/components\/(?:ParserReportSidebarBadge|SpcMobileModeControl|SpcForcedPasswordChange)|next\/(?:navigation|link|image))$/},args=>({path:args.path,namespace:"synthetic"}))
      builder.onLoad({filter:/.*/,namespace:"synthetic"},args=>({contents:mocks[args.path],loader:"jsx",resolveDir:root}))
    }}]})
  const cssSource = process.env.FCUNO_NAV_BASELINE === "1"
    ? require("node:child_process").execFileSync("git",["show","ae758c5b780d7c65b9d683cb455e6e5d8a7b5d86:app/globals.css"],{cwd:root,encoding:"utf8"})
    : fs.readFileSync(path.join(root,"app/globals.css"),"utf8")
  const css = await postcss([tailwind()]).process(cssSource,{from:path.join(root,"app/globals.css")})
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/globals.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'
  const server = http.createServer((request,response)=>{
    const pathname = new URL(request.url,"http://127.0.0.1").pathname
    if(request.method!=="GET"){response.writeHead(405);response.end();return}
    if(pathname==="/bundle.js"){response.setHeader("Content-Type","text/javascript");response.end(bundle.outputFiles[0].contents);return}
    if(pathname==="/globals.css"){response.setHeader("Content-Type","text/css");response.end(css.css);return}
    if(["/fc-uno-sidebar-logo.png","/spc-sidebar-logo.png"].includes(pathname)){response.setHeader("Content-Type","image/png");response.end(fs.readFileSync(path.join(root,"public",pathname)));return}
    response.setHeader("Content-Type","text/html");response.end(html)
  })
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const output = process.env.FCUNO_NAV_SCREENSHOTS || "/private/tmp/fcuno-mobile-navigation-20261015"
  fs.mkdirSync(output,{recursive:true})
  const results=[]
  try {
    for(const [engine,launcher] of [["chromium",chromium],["webkit",webkit]]) {
      const browser=await launcher.launch({headless:true,...(engine==="chromium"&&process.env.CHROME_EXECUTABLE_PATH?{executablePath:process.env.CHROME_EXECUTABLE_PATH}:{})})
      try {
        for(const shell of ["admin","spc"]) for(const width of [320,390,1440]) for(const scheme of ["light","dark"]) {
          const context=await browser.newContext({viewport:{width,height:844},colorScheme:scheme})
          try {
            const unexpected=[],errors=[]
            await context.route("**/*",route=>{if(new URL(route.request().url()).origin===origin)return route.continue();unexpected.push(route.request().url());return route.abort()})
            const page=await context.newPage()
            page.setDefaultTimeout(10000)
            page.on("pageerror",error=>errors.push(error.message))
            await page.goto(origin+"/?shell="+shell)
            const menu=page.getByRole("button",{name:shell==="admin"?"Open admin navigation":"Open SPC navigation",exact:true})
            const search=page.getByLabel("Top search",{exact:true})
            await search.waitFor()
            assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${shell}/${width}: horizontal overflow`)
            if(width<981) {
              const top=await search.boundingBox(),button=await menu.boundingBox()
              assert.ok(button.y+button.height<=top.y,`${shell}/${width}: navigation covers initial search`)
              await menu.click()
              const close=page.getByRole("button",{name:shell==="admin"?"Close admin navigation":"Close SPC navigation",exact:true}).filter({has:page.locator("span")})
              await close.click()
              await page.waitForFunction(()=>{const aside=document.querySelector('.fc-admin-sidebar');const r=aside.getBoundingClientRect();return r.right<=0})
              await page.evaluate(()=>{const input=document.querySelector('input[aria-label="Lower search"]');scrollTo(0,input.getBoundingClientRect().top+scrollY-20)})
              const lower=page.getByLabel("Lower search",{exact:true})
              const bounds=await lower.boundingBox()
              const hit=await lower.evaluate(element=>{const r=element.getBoundingClientRect();const target=document.elementFromPoint(r.left+Math.min(20,r.width/2),r.top+r.height/2);return {matches:target===element,cover:target?.outerHTML.slice(0,300)}})
              assert.equal(hit.matches,true,`${shell}/${width}: scrolled search is covered: ${hit.cover}`)
              await lower.fill("accessible after scrolling")
              await page.screenshot({path:path.join(output,`${shell}-${engine}-${width}-${scheme}-scrolled.png`)})
              assert.ok(bounds.y>=0)
              await page.evaluate(()=>scrollTo(0,0))
              await lower.evaluate(element=>element.blur())
              await page.keyboard.press("/")
              await page.waitForFunction(()=>document.querySelector('.fc-admin-mobile-menu')?.getAttribute('aria-expanded')==='true')
              const toolsSearch=page.getByRole("searchbox",{name:shell==="admin"?"Search admin tools":"Search SPC tools",exact:true})
              await toolsSearch.waitFor()
              await page.waitForFunction(()=>document.activeElement?.matches('.fc-admin-sidebar-search input'))
              assert.equal(await toolsSearch.evaluate(element=>element===document.activeElement),true)
              await page.keyboard.press("Escape")
              assert.equal(await menu.getAttribute("aria-expanded"),"false")
            } else {
              assert.equal(await menu.isVisible(),false)
              await page.getByRole("button",{name:shell==="admin"?"Collapse admin navigation":"Collapse SPC navigation",exact:true}).click()
              await page.getByRole("button",{name:shell==="admin"?"Expand admin navigation":"Expand SPC navigation",exact:true}).first().click()
            }
            await page.screenshot({path:path.join(output,`${shell}-${engine}-${width}-${scheme}.png`)})
            await page.evaluate(()=>{window.__navigationHarness.auth={...window.__navigationHarness.auth,authenticated:false};window.__navigationHarness.render()})
            await page.getByText("Signed-out placeholder",{exact:true}).waitFor()
            assert.equal(await menu.count(),0)
            assert.equal(await page.getByRole("navigation").count(),0)
            assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[])
            results.push({engine,shell,width,scheme})
          } finally {await context.close()}
        }
      } finally {await browser.close()}
    }
    console.log(JSON.stringify({passed:results.length,screenshots:output,cases:results},null,2))
  } finally {await new Promise(resolve=>server.close(resolve))}
}
main().catch(error=>{console.error(error);process.exitCode=1})
