const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const { chromium } = require('playwright')

test('prepared submission resolves the real browser target after debugger attachment', async (t) => {
  const source = await fs.readFile(path.join(__dirname, '../tools/whatsapp-spc-group-dispatcher/background.js'), 'utf8')
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) })
  try {
    async function run(options = {}) {
      const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
      try {
        await page.setContent(`<style>
          #main{width:900px}header{height:60px}#composeLine{display:flex;gap:10px;margin-top:200px}
          #composer{width:740px;height:60px;border:1px solid black}#send{width:70px;height:60px}
          #otherSend{position:absolute;top:20px;left:800px}#cover{position:fixed;background:pink;z-index:10;display:none}
        </style><main id="main"><header><span title="TEST GROUP">TEST GROUP</span></header>
          <button id="otherSend" aria-label="Send">Unrelated Send</button>
          <div id="composeLine"><div id="composer" contenteditable="true" role="textbox">TEST ENQUIRY</div><button id="send" aria-label="Send">Send</button></div>
        </main><div id="cover">REDelivery</div><script>
          window.submissions=[];
          document.querySelector('#send').addEventListener('click',()=>window.submissions.push('click'));
          document.querySelector('#otherSend').addEventListener('click',()=>window.submissions.push('wrong'));
          document.querySelector('#composer').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();window.submissions.push('enter')}});
        </script>`)
        const originalPoint = await page.locator('#send').evaluate(element => {
          const r = element.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        })
        const session = await page.context().newCDPSession(page)
        const input = []
        const chrome = {
          runtime: { getManifest: () => ({ version: '1.3.3' }), onInstalled: { addListener() {} }, onMessage: { addListener() {} } },
          storage: { local: { get: (_keys, callback) => callback({ fcunoSpcGroupDispatcherV1: { token: 'paired' } }) } },
          debugger: {
            attach: (_target, _version, callback) => {
              page.evaluate(options => {
                document.querySelector('#composeLine').style.marginTop = '320px';
                if(options.cover) {
                  const rect = document.querySelector('#send').getBoundingClientRect();
                  Object.assign(document.querySelector('#cover').style,{display:'block',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px'});
                }
                if(options.wrongChat) document.querySelector('header span').title='OTHER GROUP';
                if(options.wrongText) document.querySelector('#composer').textContent='CHANGED TEXT';
                if(options.blockFocus) document.querySelector('#composer').focus=()=>{};
              }, options).then(callback)
            },
            detach: (_target, callback) => callback(),
            sendCommand: (_target, method, params, callback) => {
              if(method.startsWith('Input.')) input.push({method,...params})
              session.send(method, params).then(callback)
            },
          },
        }
        const context = vm.createContext({chrome,performance,Date,Map,Promise,setTimeout,fetch:async()=>({ok:true,json:async()=>({job:{serverNow:new Date().toISOString(),leaseExpiresAt:new Date(Date.now()+90000).toISOString()}})})})
        vm.runInContext(source, context)
        const fence = {jobId:'job-1',claimToken:'claim-1',groupName:'TEST GROUP',expectedMessage:'TEST ENQUIRY'}
        await context.handleApiMessage({type:'dispatcher-prepare',...fence},{tab:{id:1}})
        let error = ''
        try { await context.nativeClick(1,originalPoint.x,originalPoint.y,fence) } catch(cause) { error=cause.message }
        const submissions = await page.evaluate(()=>window.submissions)
        if(options.reuse) await assert.rejects(context.nativeEnter(1,fence),/expired or was already used/)
        return {input,submissions,error,originalPoint}
      } finally { await page.close() }
    }

    await t.test('remeasured Send clicks despite the attachment layout shift and ignores unrelated Send', async () => {
      const result = await run({reuse:true})
      assert.equal(result.error,'')
      assert.deepEqual(result.submissions,['click'])
      const press = result.input.find(event=>event.type==='mousePressed')
      assert.equal(press.y,result.originalPoint.y+120)
      assert.equal(result.input.filter(event=>event.type==='mousePressed').length,1)
      assert.equal(result.input.filter(event=>event.type==='rawKeyDown').length,0)
    })
    await t.test('covered Send uses one Enter in the exact focused composer', async () => {
      const result = await run({cover:true,reuse:true})
      assert.equal(result.error,'')
      assert.deepEqual(result.submissions,['enter'])
      assert.equal(result.input.filter(event=>event.type==='mousePressed').length,0)
      assert.equal(result.input.filter(event=>event.type==='rawKeyDown').length,1)
    })
    for (const option of ['wrongChat','wrongText','blockFocus']) {
      await t.test(`${option} stops before any input`,async()=>{
        const result = await run({[option]:true})
        assert.match(result.error,/changed the prepared chat/)
        assert.deepEqual(result.submissions,[])
        assert.equal(result.input.length,0)
      })
    }
  } finally { await browser.close() }
})
