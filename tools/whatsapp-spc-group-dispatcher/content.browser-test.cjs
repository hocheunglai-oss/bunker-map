const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const path = require("node:path")
const vm = require("node:vm")
const { chromium } = require("playwright")

const source = fs.readFileSync(path.join(__dirname, "content.js"), "utf8")
const backgroundSource = fs.readFileSync(path.join(__dirname, "background.js"), "utf8")
const updaterBridgeSource = fs.readFileSync(path.join(__dirname, "updater-bridge.js"), "utf8")
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
    <div id="main"><header><button><span dir="auto" title="+65 8453 0317, +852 6995 0950, +65 9679 1141">+65 8453 0317, +852 6995 0950, +65 9679 1141</span><span id="chatTitle" title="OTHER GROUP">OTHER GROUP</span></button></header>
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
      window.chrome={runtime:{lastError:null,getManifest:()=>({version:'1.2.2'}),getURL:(asset)=>new URL(asset,location.href).href,sendMessage:(request,callback)=>{
        if(request.type==='dispatcher-state'){callback({ok:true,token:window.initiallyPaired?'paired':'',deviceLabel:'TEST DESKTOP',paused:false});return;}
        if(request.type==='dispatcher-pair'){window.pairRequests+=1;window.initiallyPaired=true;callback({ok:true,token:'paired',deviceLabel:'SPC Trading Desktop'});return;}
        if(request.type==='dispatcher-latest'){callback({ok:true,job:null});return;}
        if(request.type==='dispatcher-claim'){
          if(window.claimed){callback({ok:true,dispatcher:{groupName:${JSON.stringify(groupName)}},job:null});return;}
          window.claimed=true;callback({ok:true,dispatcher:{},claimToken:'claim',job:{id:'job-1',revisionNumber:2,eventType:'amended',routeLabel:'TEST ROUTE',groupName:${JSON.stringify(groupName)},messageText:${JSON.stringify(message)}}});return;
        }
        if(request.type==='dispatcher-complete'){window.completions.push(request);callback({ok:true});return;}
        if(request.type==='native-replace-text'){callback({ok:window.applyText(request.text)});return;}
        if(request.type==='native-send-text'){
          const current=document.getElementById('composer');const replacement=current.cloneNode(false);
          const text=String(request.text||'');replacement.textContent=text;current.replaceWith(replacement);replacement.focus();
          if(!${ambiguous ? "true" : "false"} && text){const row=document.createElement('div');row.className='message-out';row.textContent=text;document.getElementById('messages').appendChild(row);window.sent.push(text);replacement.replaceChildren();}
          callback({ok:true,accepted:true,submitted:true});return;
        }
        if(request.type==='native-click'){
          const target=document.elementFromPoint(Number(request.x),Number(request.y));window.nativeClick=true;target?.closest('.row')?.click();window.nativeClick=false;callback({ok:true});return;
        }
        if(request.type==='native-enter'){
          const c=document.getElementById('composer');const text=c.innerText||c.textContent||'';
          if(!${ambiguous ? "true" : "false"} && text){const row=document.createElement('div');row.className='message-out';row.textContent=text;document.getElementById('messages').appendChild(row);window.sent.push(text);c.replaceChildren();}
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
      getManifest: () => ({ version: "1.2.2" }),
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

async function verifyUnpairedBackgroundState() {
  let messageListener = null
  let storedState = {}
  const chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: "1.2.2" }),
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: (listener) => { messageListener = listener } },
    },
    tabs: { query: () => {}, reload: () => {} },
    storage: {
      local: {
        get: (_keys, callback) => callback({ fcunoSpcGroupDispatcherV1: storedState }),
        set: (value, callback) => {
          storedState = value.fcunoSpcGroupDispatcherV1
          callback()
        },
      },
    },
    debugger: { attach: () => {}, detach: () => {}, sendCommand: () => {} },
  }
  const fetchCalls = []
  const fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    fetchCalls.push(body)
    return {
      ok: true,
      json: async () => ({
        dispatcherId: "dispatcher-1",
        token: "paired-token",
        deviceLabel: body.deviceLabel,
      }),
    }
  }
  vm.runInNewContext(backgroundSource, { chrome, fetch })
  assert.equal(typeof messageListener, "function")

  const send = (request) => new Promise((resolve) => {
    assert.equal(messageListener(request, {}, resolve), true)
  })
  const empty = await send({ type: "dispatcher-state" })
  assert.equal(empty.ok, true)
  assert.equal(empty.token, undefined)

  const paired = await send({ type: "dispatcher-pair", deviceLabel: "SPC Trading Desktop" })
  assert.equal(paired.ok, true)
  assert.equal(paired.token, "paired-token")
  assert.equal(storedState.token, "paired-token")
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].action, "pair")
}

async function verifyAtomicNativeSend() {
  let messageListener = null
  let composerText = ""
  let attaches = 0
  let detaches = 0
  const commands = []
  const chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: "1.2.2" }),
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: (listener) => { messageListener = listener } },
    },
    tabs: { query: () => {}, reload: () => {} },
    storage: { local: { get: (_keys, callback) => callback({}), set: (_value, callback) => callback() } },
    debugger: {
      attach: (_target, _version, callback) => { attaches += 1; callback() },
      detach: (_target, callback) => { detaches += 1; callback() },
      sendCommand: (_target, method, params, callback) => {
        commands.push({ method, params })
        if (method === "Input.insertText") composerText = String(params.text || "")
        if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") composerText = ""
        if (method === "Runtime.evaluate" && params.expression.includes("document.createRange")) {
          callback({ result: { value: { found: true, focused: true, text: composerText } } })
        } else if (method === "Runtime.evaluate" && params.expression.includes("compose-btn-send")) {
          callback({ result: { value: composerText ? { count: 1, x: 700, y: 500 } : { count: 0 } } })
        } else if (method === "Runtime.evaluate") callback({ result: { value: composerText } })
        else callback({})
      },
    },
  }
  vm.runInNewContext(backgroundSource, {
    chrome,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout,
  })
  assert.equal(typeof messageListener, "function")
  const result = await new Promise((resolve) => {
    assert.equal(messageListener({ type: "native-send-text", text: message }, { tab: { id: 21 } }, resolve), true)
  })
  assert.equal(result.ok, true)
  assert.equal(result.accepted, true)
  assert.equal(result.submitted, true)
  assert.equal(attaches, 1)
  assert.equal(detaches, 1)
  assert.equal(commands.filter((command) => command.method === "Input.insertText").length, 1)
  assert.equal(commands.filter((command) => command.method === "Input.dispatchMouseEvent").length, 3)
  assert.equal(commands.some((command) => command.method === "Input.dispatchKeyEvent" && command.params.key === "Enter"), false)
}

async function verifyGuardedEnterFallback() {
  let messageListener = null
  let composerText = ""
  const commands = []
  const chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: "1.2.2" }),
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: (listener) => { messageListener = listener } },
    },
    tabs: { query: () => {}, reload: () => {} },
    storage: { local: { get: (_keys, callback) => callback({}), set: (_value, callback) => callback() } },
    debugger: {
      attach: (_target, _version, callback) => callback(),
      detach: (_target, callback) => callback(),
      sendCommand: (_target, method, params, callback) => {
        commands.push({ method, params })
        if (method === "Input.insertText") composerText = String(params.text || "")
        if (method === "Input.dispatchKeyEvent" && params.type === "rawKeyDown" && params.key === "Enter") {
          composerText = ""
        }
        if (method === "Runtime.evaluate" && params.expression.includes("document.createRange")) {
          callback({ result: { value: { found: true, focused: true, text: composerText } } })
        } else if (method === "Runtime.evaluate" && params.expression.includes("compose-btn-send")) {
          callback({ result: { value: { count: 0 } } })
        } else if (method === "Runtime.evaluate") callback({ result: { value: composerText } })
        else callback({})
      },
    },
  }
  vm.runInNewContext(backgroundSource, {
    chrome,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout,
  })
  const result = await new Promise((resolve) => {
    assert.equal(messageListener({ type: "native-send-text", text: message }, { tab: { id: 22 } }, resolve), true)
  })
  assert.deepEqual(
    { ok: result.ok, accepted: result.accepted, submitted: result.submitted },
    { ok: true, accepted: true, submitted: true },
  )
  assert.equal(
    commands.some((command) =>
      command.method === "Input.dispatchKeyEvent"
      && command.params.type === "rawKeyDown"
      && command.params.key === "Enter"),
    true,
  )
  assert.equal(commands.some((command) => command.method === "Input.dispatchMouseEvent"), false)
}

async function verifyInPlaceUpdateReload() {
  let messageListener = null
  const stored = {}
  const timers = []
  const reloadedTabs = []
  let extensionReloads = 0
  const chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: "1.2.2" }),
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: (listener) => { messageListener = listener } },
      reload: () => { extensionReloads += 1 },
    },
    tabs: {
      query: (_query, callback) => callback([{ id: 31 }]),
      reload: (tabId, callback) => { reloadedTabs.push(tabId); callback() },
    },
    storage: {
      local: {
        get: (keys, callback) => {
          const result = {}
          for (const key of keys) result[key] = stored[key]
          callback(result)
        },
        set: (value, callback) => { Object.assign(stored, value); callback() },
        remove: (keys, callback) => {
          for (const key of keys) delete stored[key]
          callback()
        },
      },
    },
    debugger: { attach: () => {}, detach: () => {}, sendCommand: () => {} },
  }
  vm.runInNewContext(backgroundSource, {
    chrome,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout: (callback) => { timers.push(callback); return timers.length },
  })

  const send = (request, url = "https://spc.fcuno.com/chrome") => new Promise((resolve) => {
    assert.equal(messageListener(request, { url, tab: { id: 8, url } }, resolve), true)
  })
  const scheduled = await send({ type: "extension-apply-update" })
  assert.equal(scheduled.ok, true)
  assert.equal(stored.fcunoSpcGroupDispatcherUpdatePendingV1, true)
  assert.equal(extensionReloads, 0)
  timers.shift()()
  assert.equal(extensionReloads, 1)

  const finished = await send({ type: "extension-update-page-ready" })
  assert.equal(finished.ok, true)
  assert.equal(finished.refreshedWhatsApp, true)
  assert.equal(stored.fcunoSpcGroupDispatcherUpdatePendingV1, undefined)
  assert.deepEqual(reloadedTabs, [31])

  const rejected = await send({ type: "extension-apply-update" }, "https://example.com/")
  assert.equal(rejected.ok, false)
  assert.match(rejected.message, /only from spc\.fcuno\.com/)
}

async function verifyUpdaterBridge() {
  let messageListener = null
  const runtimeMessages = []
  const postedMessages = []
  const window = {
    location: { origin: "https://spc.fcuno.com" },
    addEventListener: (type, listener) => {
      if (type === "message") messageListener = listener
    },
    postMessage: (message, origin) => postedMessages.push({ message, origin }),
  }
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message, callback) => {
        runtimeMessages.push(message)
        callback({ ok: true })
      },
    },
  }
  vm.runInNewContext(updaterBridgeSource, { chrome, window, Promise, Error })
  assert.deepEqual(JSON.parse(JSON.stringify(runtimeMessages)), [{ type: "extension-update-page-ready" }])
  assert.equal(typeof messageListener, "function")

  await messageListener({
    source: window,
    origin: window.location.origin,
    data: {
      source: "fcuno-spc-dispatcher-updater",
      action: "apply-update",
      requestId: "request-1",
    },
  })
  assert.deepEqual(JSON.parse(JSON.stringify(runtimeMessages.at(-1))), { type: "extension-apply-update" })
  assert.deepEqual(JSON.parse(JSON.stringify(postedMessages.at(-1))), {
    message: {
      source: "fcuno-spc-dispatcher-extension",
      action: "apply-update-result",
      requestId: "request-1",
      ok: true,
      message: "",
    },
    origin: window.location.origin,
  })
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
  await verifyUnpairedBackgroundState()
  await verifyAtomicNativeSend()
  await verifyGuardedEnterFallback()
  await verifyInPlaceUpdateReload()
  await verifyUpdaterBridge()
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
      assert.match(sent.panelText, /REDELIVERY\s+v1\.2\.2/)
      assert.match(sent.panelText, /long pu 16 \/ 8357588/)
      assert.match(sent.panelText, /To FCUNO - SPC TRADING GROUP/)
      assert.doesNotMatch(sent.panelText, /DEVICE|CURRENT ROUTE|PAIR|PAUSE/)
      if (process.env.SPC_DISPATCHER_SCREENSHOT) {
        await page.screenshot({ path: process.env.SPC_DISPATCHER_SCREENSHOT, fullPage: true })
      }
      const stableStatusNode = await page.evaluate(async () => {
        const node = document.querySelector("#fcuno-spc-group-dispatcher [data-role='status']")
        await new Promise((resolve) => setTimeout(resolve, 2300))
        return node === document.querySelector("#fcuno-spc-group-dispatcher [data-role='status']")
      })
      assert.equal(stableStatusNode, true)

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
