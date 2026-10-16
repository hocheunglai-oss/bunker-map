/* Actual CCINFO page + deletion helper/queue, isolated synthetic APIs only. */
const assert=require("node:assert/strict")
const http=require("node:http")
const {mkdtempSync,mkdirSync,readFileSync,writeFileSync}=require("node:fs")
const {join,resolve,basename,isAbsolute}=require("node:path")
const {tmpdir}=require("node:os")
const {build}=require("esbuild")
const postcss=require("postcss"),tailwind=require("@tailwindcss/postcss")
const {chromium,webkit}=require(process.env.PLAYWRIGHT_MODULE||"playwright")
const root=resolve(__dirname,".."),output=process.env.CCINFO_DELETE_SCREENSHOTS||mkdtempSync(join(tmpdir(),"fcuno-ccinfo-core-delete-"))
assert.ok(isAbsolute(output),"Use an owned absolute CCINFO_DELETE_SCREENSHOTS directory");mkdirSync(output,{recursive:true})
const id="11111111-1111-4111-8111-111111111111",secondId="22222222-2222-4222-8222-222222222222",version="2026-10-16T07:00:00.123456Z"
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(predicate,label){for(let n=0;n<200;n++){if(predicate())return;await delay(10)}assert.fail(label)}
async function main(){
  const fixture=`import React from "react";import{createRoot}from"react-dom/client";import Page from"./app/admin/ccinfo/page";import{AdminNavigationShell}from"./components/AdminNavigationShell";import{AdminRouteGuard}from"./components/AdminRouteGuard";import{ADMIN_PAGE_DEFINITIONS,normaliseAdminPagePermissions}from"./lib/adminPages";import{writeClientStorage}from"./lib/clientStorage";
const permission=new URL(location.href).searchParams.get("permission")||"edit";
window.__coreAuth={loading:false,authenticated:permission!=="signedout",resetRequired:false,username:"FIRST USER",displayName:"Synthetic Editor",role:"STAFF",permissions:normaliseAdminPagePermissions({ccinfo:permission==="signedout"?"none":permission}),pages:ADMIN_PAGE_DEFINITIONS};
const app=createRoot(document.getElementById("root"));function render(){writeClientStorage("bunker_admin_actor",JSON.stringify(window.__coreAuth));app.render(<div className="fc-admin-scope"><AdminNavigationShell><AdminRouteGuard><Page/></AdminRouteGuard></AdminNavigationShell></div>)}window.__setAuth=changes=>{window.__coreAuth={...window.__coreAuth,...changes};render()};render();`
  const mocks={"next/navigation":"const router={push:()=>{},replace:()=>{},prefetch:()=>{}};export const useRouter=()=>router;export const usePathname=()=>location.pathname;","next/link":"import React from'react';export default function Link({prefetch,...props}){return <a {...props}/>;}","next/image":"import React from'react';export default function Image({priority,unoptimized,fill,...props}){return <img {...props}/>;}"}
  const bundle=await build({absWorkingDir:root,stdin:{contents:fixture,resolveDir:root,sourcefile:"ccinfo-core-delete-fixture.tsx",loader:"tsx"},bundle:true,write:false,outdir:"fixture",platform:"browser",format:"iife",jsx:"automatic",logLevel:"warning",define:{"process.env.NODE_ENV":'"development"'},plugins:[{name:"isolated-core-dependencies",setup(builder){
    builder.onResolve({filter:/^(?:@\/lib\/(supabase|useSimpleAdminAuth|ccinfoSave)|next\/(navigation|link|image))$/},args=>({path:args.path,namespace:"fixture"}))
    builder.onLoad({filter:/.*/,namespace:"fixture"},args=>({resolveDir:root,loader:"tsx",contents:args.path.endsWith("/supabase")
      ?'import{createClient}from"@supabase/supabase-js";export const supabase=createClient(location.origin,"synthetic-only",{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});'
      :args.path.endsWith("/ccinfoSave")?`import{createCcinfoSaveQueue as original}from${JSON.stringify(join(root,"lib/ccinfoSave.ts"))};export*from${JSON.stringify(join(root,"lib/ccinfoSave.ts"))};export function createCcinfoSaveQueue(write){const q=original(write),loaded=q.loaded.bind(q);q.loaded=(...args)=>{loaded(...args);window.__activeCoreQueue=q;};return q;}`
      :args.path.endsWith("/useSimpleAdminAuth")?'export const useSimpleAdminAuth=()=>window.__coreAuth; export const clearAdminClientSessionCache=()=>{};':mocks[args.path]
    }))
  }}]})
  const assets=new Map(bundle.outputFiles.map(file=>[`/${basename(file.path)}`,file.contents]))
  const js=[...assets.keys()].find(name=>name.endsWith(".js")),css=[...assets.keys()].find(name=>name.endsWith(".css"))
  const globals=(await postcss([tailwind()]).process(readFileSync(join(root,"app/globals.css"),"utf8"),{from:join(root,"app/globals.css")})).css
  const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/globals.css">${css?`<link rel="stylesheet" href="${css}">`:""}</head><body><div id="root"></div><script src="${js}"></script></body></html>`
  let companies,mode,requests,holds,patches,patchHold,patchRelease,bodyRelease,reads
  function reset(){companies=[{id,name:"FIRST SYNTHETIC COMPANY",notes:"FIRST SYNTHETIC NOTE",summary:null,updated_at:version},{id:secondId,name:"SECOND SYNTHETIC COMPANY",notes:"SECOND SYNTHETIC NOTE",summary:null,updated_at:version}];mode="conflict";requests=[];holds=[];patches=[];patchHold=false;patchRelease=null;bodyRelease=null;reads=0}
  reset()
  const json=(res,value,status=200)=>res.writeHead(status,{"content-type":"application/json"}).end(JSON.stringify(value))
  const server=http.createServer(async(req,res)=>{try{
    const url=new URL(req.url,"http://127.0.0.1");res.setHeader("Cache-Control","no-store")
    if(url.pathname==="/api/ccinfo/delete-record"){
      const chunks=[];for await(const chunk of req)chunks.push(chunk)
      const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body)
      assert.deepEqual(Object.keys(body).sort(),["deletePorts","expectedUpdatedAt","id","kind"])
      assert.equal(body.expectedUpdatedAt,version)
      const receipt={schema:"fcuno.ccinfo-delete/v1",kind:body.kind,id:body.id,deletedAt:new Date().toISOString(),deletedCount:1,portsDeleted:0,portsDetached:0}
      if(mode==="conflict")return json(res,{message:"The entry changed. Your draft is still here."},409)
      if(mode==="badack")return json(res,{deletion:{...receipt,id:"WRONG ID"}})
      if(mode==="bodyhold"){
        const encoded=JSON.stringify({deletion:receipt});res.writeHead(200,{"content-type":"application/json"});res.write(encoded.slice(0,10))
        await new Promise(resolve=>{bodyRelease=resolve});return res.end(encoded.slice(10))
      }
      if(mode==="hold")await new Promise(resolve=>holds.push({body,resolve}))
      companies=companies.filter(row=>row.id!==body.id)
      return json(res,{deletion:receipt})
    }
    if(url.pathname.startsWith("/rest/v1/")){
      reads++
      const table=url.pathname.slice(9)
      if(req.method==="PATCH"){
        assert.equal(table,"cc_companies")
        const chunks=[];for await(const chunk of req)chunks.push(chunk)
        const body=JSON.parse(Buffer.concat(chunks).toString());patches.push({body,target:url.searchParams.get("id")})
        if(patchHold)await new Promise(resolve=>{patchRelease=resolve})
        const record=companies.find(row=>`eq.${row.id}`===url.searchParams.get("id"))
        if(!record||`eq.${record.updated_at}`!==url.searchParams.get("updated_at"))return json(res,{code:"PGRST116"},406)
        Object.assign(record,body,{updated_at:"2026-10-16T08:00:00.654321Z"});return json(res,record)
      }
      assert.equal(req.method,"GET")
      let rows=table==="cc_companies"?companies:[]
      rows=rows.filter(row=>[...url.searchParams].every(([key,value])=>!value.startsWith("eq.")||row[key]===value.slice(3)))
      if(url.searchParams.has("name"))rows=rows.filter(row=>row.name.includes(url.searchParams.get("name").slice(6).replaceAll("%","")))
      return json(res,req.headers.accept?.includes("application/vnd.pgrst.object+json")?rows[0]||null:rows)
    }
    if(url.pathname==="/api/admin/audit-logs")return json(res,{logs:[]})
    if(url.pathname==="/api/parser-reports")return json(res,{readyForUserReview:0})
    if(url.pathname==="/fc-uno-sidebar-logo.png")return res.writeHead(200,{"content-type":"image/png"}).end(readFileSync(join(root,"public/fc-uno-sidebar-logo.png")))
    if(url.pathname==="/globals.css")return res.writeHead(200,{"content-type":"text/css"}).end(globals)
    const asset=assets.get(url.pathname)
    res.writeHead(200,{"content-type":asset?url.pathname.endsWith(".css")?"text/css":"text/javascript":"text/html"}).end(asset||html)
  }catch(error){json(res,{message:error.message},500)}})
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve))
  const origin=`http://127.0.0.1:${server.address().port}`,results=[]
  try{
    for(const[engineName,engine]of[["chromium",chromium],["webkit",webkit]]){
      const browser=await engine.launch({headless:true,...(engineName==="chromium"&&process.env.CHROME_EXECUTABLE_PATH?{executablePath:process.env.CHROME_EXECUTABLE_PATH}:{})})
      try{for(const width of[320,390,1440])for(const scheme of["light","dark"])for(const permission of["edit","view","none","signedout"]){
        reset();const context=await browser.newContext({viewport:{width,height:1000},colorScheme:scheme})
        await context.route("**/*",route=>route.request().url().startsWith(`${origin}/`)?route.continue():route.abort())
        const page=await context.newPage(),errors=[];page.setDefaultTimeout(10000);page.on("pageerror",error=>errors.push(error.message));page.on("dialog",dialog=>dialog.accept())
        try{
          const url=`${origin}/admin/ccinfo?kind=company&id=${id}&permission=${permission}`
          await page.goto(url)
          const modal=page.getByRole("dialog",{name:"Edit Company Name",exact:true})
          if(permission==="none"||permission==="signedout"){
            await page.getByText("Access Denied",{exact:true}).waitFor();assert.equal(reads,0);assert.equal(requests.length,0)
          }else{
            await page.getByText("FIRST SYNTHETIC NOTE",{exact:true}).waitFor()
            await page.locator('input[value="FIRST SYNTHETIC COMPANY"]').dblclick();await modal.waitFor()
            if(permission==="view")assert.equal(await modal.getByRole("button",{name:"Delete this Company",exact:true}).isDisabled(),true)
            else{
              await modal.locator("input").fill("KEEP UNSAVED DRAFT")
              await modal.getByRole("button",{name:"Delete this Company",exact:true}).click();await modal.getByRole("alert").waitFor()
              assert.equal(await modal.locator("input").inputValue(),"KEEP UNSAVED DRAFT");assert.equal(companies.length,2)
              mode="badack";await modal.getByRole("button",{name:"Delete this Company",exact:true}).click();await modal.getByRole("alert").filter({hasText:"could not be confirmed"}).waitFor()
              assert.equal(await modal.locator("input").inputValue(),"KEEP UNSAVED DRAFT")
              const contrast=await modal.getByRole("alert").evaluate(alert=>{
                const rgb=value=>value.match(/[\d.]+/g).slice(0,3).map(Number)
                const luminance=value=>rgb(value).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0)
                const text=getComputedStyle(alert).color,panel=getComputedStyle(alert.closest('[role="dialog"]')).backgroundColor
                const a=luminance(text),b=luminance(panel);return{ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),text,panel}
              });assert.ok(contrast.ratio>=4.5,JSON.stringify(contrast))
              await page.screenshot({path:join(output,`${engineName}-${width}-${scheme}-conflict.png`),fullPage:true})
              requests=[];mode="hold";await modal.getByRole("button",{name:"Delete this Company",exact:true}).click();await until(()=>holds.length===1,"first held deletion")
              assert.equal(await modal.getByRole("button",{name:"Deleting…",exact:true}).isDisabled(),true)
              await page.keyboard.press("Escape");assert.equal(await modal.count(),1)
              await page.evaluate(next=>{history.replaceState(null,"",`/admin/ccinfo?kind=company&id=${next}`);window.__setAuth({username:"SECOND USER"})},secondId)
              await page.getByText("SECOND SYNTHETIC NOTE",{exact:true}).waitFor();assert.equal(await modal.count(),0)
              await page.locator('input[value="SECOND SYNTHETIC COMPANY"]').dblclick();await modal.locator("input").fill("NEW ACCOUNT DRAFT")
              await modal.getByRole("button",{name:"Delete this Company",exact:true}).click();await until(()=>holds.length===2,"second independent held deletion")
              holds[0].resolve();await delay(30)
              assert.equal(await modal.locator("input").inputValue(),"NEW ACCOUNT DRAFT");assert.equal(await modal.getByRole("button",{name:"Deleting…",exact:true}).isDisabled(),true)
              await page.screenshot({path:join(output,`${engineName}-${width}-${scheme}-new-owner-pending.png`),fullPage:true})
              holds[1].resolve();await modal.waitFor({state:"detached"});assert.equal(companies.length,0)
              reset();patchHold=true;await page.goto(url);await page.getByText("FIRST SYNTHETIC NOTE",{exact:true}).waitFor()
              await page.evaluate(({id})=>{const q=window.__activeCoreQueue;window.__oldCoreSaves=[q.save({kind:"company",id},{notes:"FIRST QUEUED SAVE"}).then(()=>"saved",e=>e.message),q.save({kind:"company",id},{notes:"MUST NOT DISPATCH AFTER UNMOUNT"}).then(()=>"saved",e=>e.message)]},{id})
              await until(()=>patchRelease,"held save")
              await page.evaluate(next=>{history.replaceState(null,"",`/admin/ccinfo?kind=company&id=${next}`);window.__setAuth({username:"THIRD USER"})},secondId)
              await page.getByText("SECOND SYNTHETIC NOTE",{exact:true}).waitFor();patchRelease()
              const outcomes=await page.evaluate(()=>Promise.all(window.__oldCoreSaves))
              assert.equal(outcomes[0],"saved");assert.match(outcomes[1],/no longer open/);assert.equal(patches.length,1)
              reset();await page.goto(url);await page.getByText("FIRST SYNTHETIC NOTE",{exact:true}).waitFor()
              await page.locator('input[value="FIRST SYNTHETIC COMPANY"]').dblclick();await modal.locator("input").fill("KEEP TIMEOUT DRAFT")
              await page.evaluate(()=>{const original=window.setTimeout;window.setTimeout=(fn,ms,...args)=>original(fn,ms===30000?30:ms,...args)})
              mode="bodyhold";await modal.getByRole("button",{name:"Delete this Company",exact:true}).click()
              await modal.getByRole("alert").filter({hasText:"could not be confirmed"}).waitFor();assert.equal(await modal.locator("input").inputValue(),"KEEP TIMEOUT DRAFT")
              assert.equal(await modal.getByRole("button",{name:"Delete this Company",exact:true}).isEnabled(),true)
              if(bodyRelease)bodyRelease();await delay(30);assert.equal(await modal.count(),1)
            }
          }
          const dimensions=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}))
          assert.equal(dimensions.scroll,dimensions.width);assert.deepEqual(errors,[])
          await page.screenshot({path:join(output,`${engineName}-${width}-${scheme}-${permission}.png`),fullPage:true})
          results.push({engine:engineName,width,scheme,permission,passed:true,dimensions})
        }catch(error){console.error(JSON.stringify({engineName,width,scheme,permission,errors,body:await page.locator("body").innerText()}));await page.screenshot({path:join(output,`${engineName}-${width}-${scheme}-${permission}-failure.png`),fullPage:true});throw error}
        finally{for(const hold of holds)hold.resolve();patchRelease?.();bodyRelease?.();await context.close()}
      }}finally{await browser.close()}
    }
    writeFileSync(join(output,"results.json"),JSON.stringify({passed:results.length,failed:0,results,limitations:["Actual CCINFO page/helper/queue, navigation, permission guard and compiled global CSS; shared synthetic session and API transport only.","Old in-flight server writes cannot be recalled; queued follow-on writes after unmount are blocked.","Admin palette intentionally fixed; both OS preferences exercised. No physical Safari or live data."]},null,2))
    console.log(JSON.stringify({passed:results.length,failed:0,output,results},null,2))
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
}
main().catch(error=>{console.error(error);process.exitCode=1})
