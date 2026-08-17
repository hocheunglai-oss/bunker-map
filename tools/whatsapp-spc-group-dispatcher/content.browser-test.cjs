const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const path = require("node:path")
const { chromium } = require("playwright")

const source = fs.readFileSync(path.join(__dirname, "content.js"), "utf8")
const styles = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8")
const logo = fs.readFileSync(path.join(__dirname, "spc-sidebar-logo.png"))
const groupName = "FCUNO - SPC TRADING GROUP"
const message = "*AMENDED - REV 2*\n\nlong pu 16 / 8357588 / 10 - 18 aug / lsmgo 230mts\n\n*ETA:* *10 - 18 aug* (was 8 - 10 aug)"

function html(ambiguous = false) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;font-family:Arial}#side{float:left;width:340px;height:700px}#search{margin:12px;width:280px;padding:8px}
    .row{display:none;padding:14px;border-top:1px solid #ddd;cursor:pointer}#main{margin-left:340px;min-height:700px}
    header{height:56px;display:flex;align-items:center;padding:0 14px;border-bottom:1px solid #ddd}.messages{height:520px}
    #composer{min-height:60px;margin:10px;padding:10px;border:1px solid #ccc;white-space:pre-wrap}
    ${styles.replaceAll("</style>", "<\\/style>")}
  </style></head><body>
    <div id="side"><input id="search" type="text" aria-label="Search input textbox" />
      <div id="exact" class="row" role="row" onclick="if(window.nativeClick)window.openGroup()"><span title="${groupName}">${groupName}</span></div>
      ${ambiguous ? `<div id="duplicate" class="row" role="row"><span title="${groupName}">${groupName}</span></div>` : ""}
      <div id="partial" class="row" role="row"><span title="${groupName} OLD">${groupName} OLD</span></div>
    </div>
    <div id="main"><header><button aria-label="Group info"><span id="chatTitle" title="OTHER GROUP">OTHER GROUP</span></button></header>
      <div class="messages" id="messages"></div><div id="composer" contenteditable="true" role="textbox"></div>
    </div>
    <script>
      window.claimed = false; window.nativeClick = false; window.completions = []; window.searches = []; window.sent = [];
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
      window.chrome={runtime:{lastError:null,getManifest:()=>({version:'1.0.0'}),getURL:(asset)=>new URL(asset,location.href).href,sendMessage:(request,callback)=>{
        if(request.type==='dispatcher-state'){callback({ok:true,token:'paired',groupName:${JSON.stringify(groupName)},deviceLabel:'TEST DESKTOP',paused:false});return;}
        if(request.type==='dispatcher-claim'){
          if(window.claimed){callback({ok:true,dispatcher:{groupName:${JSON.stringify(groupName)}},job:null});return;}
          window.claimed=true;callback({ok:true,dispatcher:{groupName:${JSON.stringify(groupName)}},claimToken:'claim',job:{id:'job-1',revisionNumber:2,eventType:'amended',messageText:${JSON.stringify(message)}}});return;
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

async function withServer(callback) {
  const server = http.createServer((request, response) => {
    if (request.url === "/spc-sidebar-logo.png") {
      response.writeHead(200, { "content-type": "image/png" }); response.end(logo); return
    }
    const ambiguous = new URL(request.url, "http://localhost").searchParams.get("ambiguous") === "1"
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(html(ambiguous))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try { await callback(`http://127.0.0.1:${server.address().port}/`) }
  finally { await new Promise((resolve) => server.close(resolve)) }
}

async function main() {
  await withServer(async (url) => {
    const browser = await chromium.launch({
      executablePath: process.env.CHROME_EXECUTABLE_PATH || chromium.executablePath(),
      headless: true,
    })
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 800 } })
      await page.goto(url, { waitUntil: "domcontentloaded" })
      await page.waitForFunction(() => window.completions.length === 1, null, { timeout: 10000 })
      const sent = await page.evaluate(() => ({
        completions: window.completions,
        sent: window.sent,
        searches: window.searches,
        title: document.getElementById("chatTitle").textContent,
      }))
      assert.equal(sent.sent.length, 1, JSON.stringify(sent))
      assert.equal(sent.sent[0], message)
      assert.equal(sent.completions[0].result, "sent")
      assert.equal(sent.title, groupName)
      assert.deepEqual(sent.searches.slice(0, 2), [groupName, ""])

      const ambiguousPage = await browser.newPage({ viewport: { width: 1400, height: 800 } })
      await ambiguousPage.goto(`${url}?ambiguous=1`, { waitUntil: "domcontentloaded" })
      await ambiguousPage.waitForFunction(() => window.completions.length === 1, null, { timeout: 10000 })
      const blocked = await ambiguousPage.evaluate(() => ({ completions: window.completions, sent: window.sent }))
      assert.equal(blocked.sent.length, 0)
      assert.equal(blocked.completions[0].result, "manual_review")
      assert.match(blocked.completions[0].error, /More than one exact WhatsApp group match/)
    } finally {
      await browser.close()
    }
  })
  process.stdout.write("SPC group dispatcher browser tests passed.\n")
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
