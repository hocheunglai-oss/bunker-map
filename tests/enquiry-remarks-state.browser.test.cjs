// Actual React pages; synthetic session/database/extension transports only.
// No hosted writes, email, personal Chrome, or provider requests.
const assert = require("node:assert/strict")
const http = require("node:http")
const path = require("node:path")
const os = require("node:os")
const { mkdtempSync } = require("node:fs")
const { build } = require("esbuild")

async function main() {
  const root = path.resolve(__dirname, "..")
  const screenshots = process.env.ENQUIRY_REMARKS_SCREENSHOTS || mkdtempSync(path.join(os.tmpdir(), "fcuno-enquiry-remarks-ui-"))
  const mocks = `
    const params=new URLSearchParams(location.search), access=params.get('access')||'edit';
    export function useSimpleAdminAuth(){return {loading:false,authenticated:access!=='signed-out',role:'BT',permissions:{'taiwan-remarks':access},displayName:'Synthetic',username:'synthetic'}}
    const s=window.__state={rows:[{id:1,content:'OLD REMARK'},{id:2,content:'OLD NOTICE'},{id:3,content:'{}'}],reads:0,writes:[],reports:[],wa:[],closeTimers:[],defer:false,release:null,fail:false,loseAck:false};
    export const supabase={from(table){if(table!=='remarks')throw Error('Unexpected table');return {select(){return {async in(){s.reads++;return {data:structuredClone(s.rows),error:null}}}},upsert(){throw Error('Unchecked legacy write')}}}};
    const actualTimeout=window.setTimeout.bind(window);
    window.setTimeout=(fn,ms,...args)=>{if(ms===900){s.closeTimers.push(()=>fn(...args));return 1000000+s.closeTimers.length;}return actualTimeout(fn,ms,...args)};
    window.addEventListener('message',event=>{if(event.data?.type==='fcuno-wa-enquiry-send')s.wa.push(event.data)});
    window.fetch=async(url,init={})=>{
      if(String(url).startsWith('/api/admin/enquiryworksheet/ports'))return Response.json({ports:[]});
      if(url==='/api/parser-reports'){s.reports.push(JSON.parse(init.body));return Response.json({success:true,report:{id:'SYNTHETIC'}})}
      if(url!=='/api/admin/taiwan-remarks')throw Error('Unexpected request '+url);
      const input=JSON.parse(init.body);s.writes.push(structuredClone(input));
      if(s.defer){s.defer=false;await new Promise(resolve=>s.release=resolve)}
      if(s.fail){s.fail=false;throw Error('SYNTHETIC NETWORK FAILURE')}
      const changes=input.changes,replayed=changes.every(change=>s.rows.some(row=>row.id===change.id&&row.content===change.content));
      if(!replayed&&changes.some(change=>{const row=s.rows.find(row=>row.id===change.id);return Boolean(row)!==change.expected.exists||(row?.content??null)!==change.expected.content}))return Response.json({code:'REMARKS_CONFLICT',message:'The remarks changed in another session. Your draft is still here; reload the saved remarks before trying again.'},{status:409});
      for(const change of changes){const row=s.rows.find(row=>row.id===change.id);if(row)row.content=change.content;else s.rows.push({id:change.id,content:change.content})}
      if(s.loseAck){s.loseAck=false;throw Error('SYNTHETIC LOST ACK')}
      return Response.json({rows:changes.map(({id,content})=>({id,content})),replayed});
    };
  `
  const bundle = await build({absWorkingDir:root,stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import Worksheet from './app/admin/enquiryworksheet/page';import Taiwan from './app/admin/taiwanremarks/page';createRoot(document.getElementById('root')).render(location.pathname.includes('taiwan')?<Taiwan/>:<Worksheet/>);`,resolveDir:root,loader:"tsx"},outfile:"fixture.js",bundle:true,write:false,platform:"browser",format:"iife",jsx:"automatic",define:{"process.env.NODE_ENV":'"development"'},plugins:[{name:"synthetic-boundaries",setup(b){
    b.onResolve({filter:/^@\/lib\/(supabase|useSimpleAdminAuth)$/},()=>({path:"mocks",namespace:"fixture"}));b.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:mocks,loader:"js"}));
  }}]})
  const assets=new Map(bundle.outputFiles.map(file=>[path.basename(file.path),file.contents]))
  const server=http.createServer((req,res)=>{
    const name=new URL(req.url,"http://localhost").pathname.slice(1),asset=assets.get(name)
    if(asset){res.setHeader("Content-Type",name.endsWith("css")?"text/css":"text/javascript");return res.end(asset)}
    res.setHeader("Content-Type","text/html");res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>
      :root{--fc-admin-font:Arial,sans-serif;--fc-admin-page-bg:#f4f5f8;--fc-admin-panel-bg:#fff;--fc-admin-panel-soft-bg:#fbfbfd;--fc-admin-panel-text:#20242c;--fc-admin-heading:#20242c;--fc-admin-muted:#5a677a;--fc-admin-border:#b7bfcb;--fc-admin-border-soft:#d4dae2;--fc-tool-input-bg:#fff;--fc-tool-input-text:#20242c;--fc-input-border:#b7bfcb;--fc-admin-button-bg:#eef1f6;--fc-admin-button-text:#20242c;--fc-admin-button-border:#b7bfcb;--fc-admin-primary-button-bg:#0672ed;--fc-admin-primary-button-text:#fff;--fc-admin-selected-border:#0672ed;--fc-admin-selected-bg:#e5f0ff;--fc-admin-selected-text:#054c9e;--fc-admin-success-bg:#21883a;--fc-admin-success-text:#fff;--fc-admin-success-border:#166429;--fc-admin-warning-bg:#fff1ca;--fc-admin-warning-text:#392700;--fc-admin-warning-border:#e2b74e;--fc-admin-danger-text:#b00020;}
      @media(prefers-color-scheme:dark){:root{--fc-admin-page-bg:#10151e;--fc-admin-panel-bg:#192332;--fc-admin-panel-soft-bg:#1e2b3e;--fc-admin-panel-text:#eef3fb;--fc-admin-heading:#eef3fb;--fc-admin-muted:#c7d3e3;--fc-admin-border:#718097;--fc-admin-border-soft:#48566c;--fc-tool-input-bg:#101a29;--fc-tool-input-text:#eef3fb;--fc-input-border:#718097;--fc-admin-button-bg:#26354a;--fc-admin-button-text:#eef3fb;--fc-admin-button-border:#718097;--fc-admin-selected-bg:#17385c;--fc-admin-selected-text:#dcecff;--fc-admin-warning-bg:#3d3218;--fc-admin-warning-text:#ffe8a7;}}
      body{margin:0;background:var(--fc-admin-page-bg);color:var(--fc-admin-panel-text);font-family:Arial}button,input,select,textarea{font:inherit}button:disabled{opacity:.5}
      </style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`)
  })
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve))
  const origin=`http://127.0.0.1:${server.address().port}`,results=[]
  let browser
  try{
    const {chromium,webkit}=require("playwright")
    for(const [engine,type] of [["chromium",chromium],["webkit",webkit]]){
      browser=await type.launch({headless:true,...(engine==="chromium"?{executablePath:process.env.CHROME_EXECUTABLE_PATH||"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}:{})})
      for(const width of [1440,320,390])for(const colorScheme of ["light","dark"]){
        const context=await browser.newContext({viewport:{width,height:1000},colorScheme}),errors=[],blocked=[]
        await context.route("**/*",route=>{if(new URL(route.request().url()).origin===origin)return route.continue();blocked.push(route.request().url());return route.abort()})
        const page=await context.newPage();page.setDefaultTimeout(7000);page.on("pageerror",error=>errors.push(error.message))
        const button=name=>page.getByRole("button",{name,exact:true}),raw=()=>page.getByRole("textbox",{name:"Enquiry text",exact:true}),output=()=>page.getByRole("textbox",{name:"Editable shortened enquiry",exact:true})
        const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
        const capture=async name=>{await page.evaluate(()=>window.scrollTo(0,0));await settle();await page.screenshot({path:path.join(screenshots,name),fullPage:true})}
        const ack=index=>page.evaluate(index=>{const request=window.__state.wa[index];window.postMessage({type:'fcuno-wa-enquiry-send-result',requestId:request.requestId,ok:true},location.origin)},index)
        await page.goto(origin+"/worksheet");await raw().fill("Vessel: ALPHA\nPort: Singapore\nVLSFO 100MT")
        await button("Send shortened enquiry to FCUNO WhatsApp Speed Board").click();await page.waitForFunction(()=>window.__state.wa.length===1)
        await output().fill("BETA / BUSAN / VLSFO 200MTS");await ack(0);await settle()
        assert.equal(await page.getByText("Sent to FCUNO WhatsApp Speed Board.",{exact:true}).count(),0)
        await button("Send shortened enquiry to FCUNO WhatsApp Speed Board").click();await page.waitForFunction(()=>window.__state.wa.length===2);await ack(0);await settle()
        assert.equal(await page.getByText("Sent to FCUNO WhatsApp Speed Board.",{exact:true}).count(),0)
        await ack(1);await page.getByText("Sent to FCUNO WhatsApp Speed Board.",{exact:true}).waitFor()
        assert.equal(await page.evaluate(()=>window.__state.wa[1].text),await output().inputValue())
        await button("Report incorrect parser output").click();await button("Submit Report").click();await page.getByText("Report saved.",{exact:true}).waitFor()
        await button("Close report dialog").click();await button("Report incorrect parser output").click();await page.evaluate(()=>window.__state.closeTimers[0]());await settle()
        assert.equal(await page.getByRole("dialog").count(),1,"old submitted-session timer cannot close a newly opened report")
        await capture(`${engine}-${width}-${colorScheme}-worksheet.png`)
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
        results.push({engine,width,colorScheme,page:"worksheet",access:"edit",pass:true})
        for(const access of ["edit","view","signed-out"]){
          await page.goto(origin+"/taiwan?access="+access)
          if(access==="signed-out"){
            await page.getByText("Access Denied",{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__state.reads),0);assert.equal(await page.getByRole("textbox").count(),0)
          }else{
            const notice=page.getByLabel("Special Notice",{exact:true});await notice.waitFor()
            assert.equal(await page.getByRole("link",{name:"Open Taiwan Price History → Publish",exact:true}).getAttribute("href"),"/admin/taiwanpricehistory")
            await page.getByText(/report keeps its previously published remarks and saved quote date/).waitFor()
            await page.getByText(/No separate Publish is needed for these notices/).waitFor()
            if(access==="view"){assert.equal(await notice.isDisabled(),true);assert.equal(await button("Saved").isDisabled(),true);assert.equal(await page.evaluate(()=>window.__state.writes.length),0)}
            else{
              await notice.fill("EXACT DRAFT\nSECOND LINE");await page.evaluate(()=>{window.__state.defer=true;window.__state.fail=true})
              await button("Save").click();await page.waitForFunction(()=>Boolean(window.__state.release));assert.equal(await notice.isDisabled(),true)
              await page.evaluate(()=>window.__state.release());await page.getByText(/save could not be confirmed/).first().waitFor();assert.equal(await notice.inputValue(),"EXACT DRAFT\nSECOND LINE")
              await page.evaluate(()=>{window.__state.loseAck=true});await button("Save").click();await page.getByText(/save could not be confirmed/).first().waitFor()
              await button("Save").click();await button("Saved").waitFor();assert.equal(await notice.inputValue(),"EXACT DRAFT\nSECOND LINE")
              assert.deepEqual(await page.evaluate(()=>window.__state.writes[1]),await page.evaluate(()=>window.__state.writes[2]),"lost reply retry retains the exact captured baseline and intended content")
              await notice.fill("KEEP CONFLICTED DRAFT");await page.evaluate(()=>{window.__state.rows.find(row=>row.id===2).content='COLLEAGUE WINNER'})
              await button("Save").click();await page.getByText(/remarks changed in another session/).first().waitFor();assert.equal(await notice.inputValue(),"KEEP CONFLICTED DRAFT")
              const contrasts=await page.getByText('The remarks changed in another session. Your draft is still here; reload the saved remarks before trying again.',{exact:true}).evaluateAll(nodes=>nodes.map(node=>{
                const rgb=value=>value.match(/[\d.]+/g).map(Number),lum=values=>values.slice(0,3).map(value=>{const channel=value/255;return channel<=0.04045?channel/12.92:((channel+0.055)/1.055)**2.4}).reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0)
                let ancestor=node,background
                while(ancestor){const value=rgb(getComputedStyle(ancestor).backgroundColor);if(value.length<4||value[3]===1){background=value;break}ancestor=ancestor.parentElement}
                if(!background)throw Error('No opaque status background')
                const foreground=lum(rgb(getComputedStyle(node).color)),back=lum(background)
                return (Math.max(foreground,back)+0.05)/(Math.min(foreground,back)+0.05)
              }))
              assert.equal(contrasts.length,2);assert.ok(contrasts.every(ratio=>ratio>=4.5),`Both conflict status copies need readable contrast: ${contrasts}`)
              assert.equal(await button("Save").isDisabled(),true)
              page.once("dialog",dialog=>dialog.dismiss());await button("Reload saved remarks").click();assert.equal(await notice.inputValue(),"KEEP CONFLICTED DRAFT")
            }
          }
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
          await capture(`${engine}-${width}-${colorScheme}-taiwan-${access}.png`)
          if(access==="edit"){page.once("dialog",dialog=>dialog.accept());await button("Reload saved remarks").click();await button("Saved").waitFor();assert.equal(await page.getByLabel("Special Notice",{exact:true}).inputValue(),"COLLEAGUE WINNER")}
          results.push({engine,width,colorScheme,page:"taiwan",access,pass:true})
        }
        assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);await context.close()
      }
      await browser.close();browser=null
    }
    console.log(JSON.stringify({cases:results.length,results,screenshots,scope:"Actual page components with synthetic auth/API/extension; dark variables are fixture contrast coverage, not a claim that the admin shell ships a night theme.",personalBrowserTouched:false},null,2))
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
}
main().catch(error=>{console.error(error);process.exitCode=1})
