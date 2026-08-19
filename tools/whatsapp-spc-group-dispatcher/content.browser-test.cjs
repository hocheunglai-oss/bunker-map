const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const path = require("node:path")
const vm = require("node:vm")
const { chromium } = require("playwright")

const source = fs.readFileSync(path.join(__dirname, "content.js"), "utf8")
const backgroundSource = fs.readFileSync(path.join(__dirname, "background.js"), "utf8")
const styles = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8")
const logo = fs.readFileSync(path.join(__dirname, "spc-sidebar-logo.png"))
const groupName = "FCUNO - SPC TRADING GROUP"
const message = "*AMENDED - REV 2*\n\nlong pu 16 / 8357588 / 10 - 18 aug / lsmgo 230mts\n\n*ETA:* *10 - 18 aug* (was 8 - 10 aug)"

function html(ambiguous = false, initiallyPaired = true) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;font-family:Arial}#side{float:left;width:340px;height:700px}#search{margin:12px;width:280px;padding:8px}
    .row{display:none;padding:14px;border-top:1px solid #ddd;cursor:pointer}#main{margin-left:340px;min-height:700px}
    header{height:56px;display:flex;align-items:center;padding:0 14px;border-bottom:1px solid #ddd}.messages{height:520px}
    #composer{min-height:60px;margin:10px;padding:10px;border:1px solid #ccc;white-space:pre-wrap}
    ${styles.replaceAll("</style>", "<\\/style>")}
  </style></head><body>
    <div id="side"><input id="search" type="text" aria-label="Search input textbox" />
      <div id="exact" class="row" data-testid="cell-frame-container" onclick="if(window.nativeClick)window.openGroup()"><div role="row"><span title="${groupName}">${groupName}</span></div></div>
      ${ambiguous ? `<div id="duplicate" class="row" data-testid="cell-frame-container"><div role="row"><span title="${groupName}">${groupName}</span></div></div>` : ""}
      <div id="partial" class="row" role="row"><span title="${groupName} OLD">${groupName} OLD</span></div>
    </div>
    <div id="main"><header><button><span id="chatTitle" title="OTHER GROUP">OTHER GROUP</span><span dir="auto" title="+65 8453 0317, +852 6995 0950, +65 9679 1141">+65 8453 0317, +852 6995 0950, +65 9679 1141</span></button></header>
      <div class="messages" id="messages"></div><div id="composer" contenteditable="true" role="textbox"></div>
    </div>
    <script>
      window.claimed = false; window.nativeClick = false; window.completions = []; window.searches = []; window.sent = [];
      window.initiallyPaired = ${initiallyPaired ? "true" : "false"}; window.pairRequests = 0;
      window.openGroup = () => { const title=document.getElementById('chatTitle'); title.textContent=${JSON.stringify(groupName)}; title.title=${JSON.stringify(groupName)}; document.getElementById('composer').focus(); };
      window.applyText = (text) => {
        const active=document.activeElement;
        if(active===document.getElementById('search')){
          active.value=String(text||''); window.searches.push(active.value);
          const show=active.value===${JSON.stringify(groupName)};
          document.querySelectorAll('.row').forEach(row=>row.style.display=show?'block':'none'); return true;
        }
        if(active===document.getElementById('composer')){active.textContent=String(text||''); return true;} return false;
      };
      window.chrome={runtime:{lastError:null,getManifest:()=>({version:'1.1.4'}),getURL:(asset)=>new URL(asset,location.href).href,sendMessage:(request,callback)=>{
        if(request.type==='dispatcher-state'){callback({ok:true,token:window.initiallyPaired?'paired':'',deviceLabel:'TEST DESKTOP',paused:false});return;}
        if(request.type==='dispatcher-pair'){window.pairRequests+=1;window.initiallyPaired=true;callback({ok:true,token:'paired',deviceLabel:'SPC Trading Desktop'});return;}
        if(request.type==='dispatcher-claim'){
          if(window.claimed){callback({ok:true,dispatcher:{groupName:${JSON.stringify(groupName)}},job:null});return;}
          window.claimed=true;callback({ok:true,dispatcher:{},claimToken:'claim',job:{id:'job-1',revisionNumber:2,eventType:'amended',routeLabel:'TEST ROUTE',groupName:${JSON.stringify(groupName)},messageText:${JSON.stringify(message)}}});return;
        }
        if(request.type==='dispatcher-complete'){window.completions.push(request);callback({ok:true});return;}
        if(request.type==='native-replace-text'){callback({ok:window.applyText(request.text)});return;}
        if(request.type==='native-insert-text'){const c=document.getElementById('composer');c.textContent=String(request.text||'');callback({ok:true});return;}
        if(request.type==='native-click'){
          const target=document.elementFromPoint(Number(request.x),Number(request.y));window.nativeClick=true;target?.closest('.row')?.click();window.nativeClick=false;callback({ok:true});return;
        }
        if(request.type==='native-enter'){
          const c=document.getElementById('composer');const text=c.innerText||c.textContent||'';
          if(!${ambiguous ? "true" : "false"} && text){const row=document.createElement('div');row.dataset.id='true_1';row.textContent=text;document.getElementById('messages').appendChild(row);window.sent.push(text);c.replaceChildren();}
          callback({ok:true});return;
        }
        if(request.type==='dispatcher-set-paused'){callback({ok:true});return;}callback({ok:false,message:'unexpected '+request.type});
      }}};
    </script><script>${source.replaceAll("</script>", "<\\/script>")}</script>
  </body></html>`
}

function verifyUpdateReloadsWhatsApp() {
  let installedListener = null
  const queries = []
  const reloads = []
  const chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: "1.1.4" }),
      onInstalled: { addListener: (listener) => { installedListener = listener } },
      onMessage: { addListener: () => {} },
    },
    tabs: {
      query: (query, callback) => { queries.push(query); callback([{ id: 14 }, { id: null }]) },
      reload: (tabId, callback) => { reloads.push(tabId); callback() },
    },
    storage: { local: { get: () => {}, set: () => {} } },
    debugger: { attach: () => {}, detach: () => {}, sendCommand: () => {} },
  }
  vm.runInNewContext(backgroundSource, { chrome, fetch: async () => ({ ok: true, json: async () => ({}) }) })
  assert.equal(typeof installedListener, "function")
  installedListener({ reason: "update" })
  assert.equal(queries.length, 1)
  assert.equal(queries[0].url, "https://web.whatsapp.com/*")
  assert.deepEqual(reloads, [14])
}

async function withServer(callback) {
  const server = http.createServer((request, response) => {
    if (request.url === "/spc-sidebar-logo.png") {
      response.writeHead(200, { "content-type": "image/png" }); response.end(logo); return
    }
    const requestUrl = new URL(request.url, "http://localhost")
    const ambiguous = requestUrl.searchParams.get("ambiguous") === "1"
    const initiallyPaired = requestUrl.searchParams.get("unpaired") !== "1"
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(html(ambiguous, initiallyPaired))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try { await callback(`http://127.0.0.1:${server.address().port}/`) }
  finally { await new Promise((resolve) => server.close(resolve)) }
}

async function main() {
  verifyUpdateReloadsWhatsApp()
  await withServer(async (url) => {
    const browser = await chromium.launch({
      executablePath: process.env.CHROME_EXECUTABLE_PATH || chromium.executablePath(),
      headless: true,
    })
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 800 } })
      await page.goto(url, { waitUntil: "domcontentloaded" })
      await page.waitForFunction(() => window.completions.length === 1, null, { timeout: 30000 })
      const sent = await page.evaluate(() => ({
        completions: window.completions,
        sent: window.sent,
        searches: window.searches,
        title: document.getElementById("chatTitle").textContent,
        panelText: document.getElementById("fcuno-spc-group-dispatcher").innerText,
      }))
      assert.equal(sent.sent.length, 1, JSON.stringify(sent))
      assert.equal(sent.sent[0], message)
      assert.equal(sent.completions[0].result, "sent")
      assert.equal(sent.title, groupName)
      assert.deepEqual(sent.searches.slice(0, 2), [groupName, ""])
      assert.match(sent.panelText, /DELIVERY\s+v1\.1\.4/)
      assert.doesNotMatch(sent.panelText, /DEVICE|CURRENT ROUTE|PAIR|PAUSE/)

      const ambiguousPage = await browser.newPage({ viewport: { width: 1400, height: 800 } })
      await ambiguousPage.goto(`${url}?ambiguous=1`, { waitUntil: "domcontentloaded" })
      await ambiguousPage.waitForFunction(() => window.completions.length === 1, null, { timeout: 30000 })
      const blocked = await ambiguousPage.evaluate(() => ({ completions: window.completions, sent: window.sent }))
      assert.equal(blocked.sent.length, 0)
      assert.equal(blocked.completions[0].result, "manual_review")
      assert.match(blocked.completions[0].error, /More than one exact WhatsApp group match/)

      const unpairedPage = await browser.newPage({ viewport: { width: 1400, height: 800 } })
      await unpairedPage.goto(`${url}?unpaired=1`, { waitUntil: "domcontentloaded" })
      await unpairedPage.waitForFunction(() => window.completions.length === 1, null, { timeout: 30000 })
      const autoPaired = await unpairedPage.evaluate(() => ({
        completions: window.completions,
        pairRequests: window.pairRequests,
        sent: window.sent,
        panelText: document.getElementById("fcuno-spc-group-dispatcher").innerText,
      }))
      assert.equal(autoPaired.pairRequests, 1, JSON.stringify(autoPaired))
      assert.equal(autoPaired.sent.length, 1, JSON.stringify(autoPaired))
      assert.equal(autoPaired.completions[0].result, "sent")
      assert.doesNotMatch(autoPaired.panelText, /DEVICE|CURRENT ROUTE|PAIR|PAUSE/)
    } finally {
      await browser.close()
    }
  })
  process.stdout.write("SPC group dispatcher browser tests passed.\n")
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
