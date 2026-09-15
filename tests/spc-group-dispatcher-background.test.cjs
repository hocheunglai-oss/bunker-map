const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

async function harness() {
  let now = 1000
  let attachDelay = 0
  let requestDelay = 0
  let submission = {verified:true,method:'click',x:740,y:680}
  const commands = []
  const chrome = {
    runtime: { getManifest: () => ({version:'1.3.3'}), onInstalled: {addListener() {}}, onMessage: {addListener() {}} },
    storage: {local: {get: (_keys, callback) => callback({fcunoSpcGroupDispatcherV1:{token:'paired'}})}},
    debugger: {
      attach: (_target, _version, callback) => {now += attachDelay; callback()},
      detach: (_target, callback) => callback(),
      sendCommand: (_target, method, args, callback) => {
        commands.push({method,...args})
        if (method === 'Runtime.evaluate') new vm.Script(args.expression)
        callback(method === 'Runtime.evaluate' ? {result:{value:submission}} : {})
      },
    },
  }
  const context = vm.createContext({chrome, performance:{now:() => now}, Date, Number, Map, Promise, setTimeout,
    fetch: async () => {
      now += requestDelay
      return {ok:true,json:async() => ({success:true,job:{leaseExpiresAt:'2026-09-15T00:01:30Z',serverNow:'2026-09-15T00:00:00Z'}})}
    },
  })
  vm.runInContext(await fs.readFile(path.join(__dirname,'../tools/whatsapp-spc-group-dispatcher/background.js'),'utf8'), context)
  const fence = {jobId:'job-1',claimToken:'claim-1',groupName:'TEST GROUP',expectedMessage:'TEST ENQUIRY'}
  return {
    commands, fence,
    prepare: (tabId=1) => context.handleApiMessage({type:'dispatcher-prepare',...fence},{tab:{id:tabId}}),
    click: (tabId=1, permit=fence) => context.nativeClick(tabId,100,100,permit),
    enter: (tabId=1, permit=fence) => context.nativeEnter(tabId,permit),
    setAttachDelay: value => {attachDelay=value},
    setRequestDelay: value => {requestDelay=value},
    setSubmission: value => {submission=value},
  }
}

test('a prepared permit permits one click and cannot be reused for Enter', async () => {
  const h = await harness(); await h.prepare(); await h.click()
  assert.equal(h.commands.filter(command => command.type==='mousePressed').length,1)
  await assert.rejects(h.enter(), /expired or was already used/)
  assert.equal(h.commands.filter(command => command.type==='rawKeyDown').length,0)
})
test('permit expiry is checked after debugger attach, before an input submission', async () => {
  const h = await harness(); await h.prepare(); h.setAttachDelay(90001)
  await assert.rejects(h.click(), /expired or was already used/)
  assert.equal(h.commands.filter(command => command.type==='mousePressed').length,0)
})
test('prepare network delay consumes the permit lifetime without trusting the local wall clock', async () => {
  const h = await harness(); h.setRequestDelay(89000); await h.prepare(); h.setAttachDelay(1001)
  await assert.rejects(h.enter(), /expired or was already used/)
  assert.equal(h.commands.filter(command => ['mousePressed','rawKeyDown'].includes(command.type)).length,0)
  const delayed = await harness(); delayed.setRequestDelay(90001)
  await assert.rejects(delayed.prepare(), /expired before WhatsApp could send/)
})
test('permits are tied to the exact tab, job and claim while navigation clicks still work', async () => {
  const h = await harness(); await h.prepare()
  await assert.rejects(h.enter(2), /expired or was already used/)
  await assert.rejects(h.enter(1,{...h.fence,claimToken:'other'}), /expired or was already used/)
  await h.click(1,null)
  assert.equal(h.commands.filter(command => command.type==='mousePressed').length,1)
})

test('fenced clicks use the verified post-attachment target instead of stale content coordinates', async () => {
  const h = await harness(); await h.prepare(); await h.click()
  const mouseDown = h.commands.find(command => command.type === 'mousePressed')
  assert.deepEqual({x:mouseDown.x,y:mouseDown.y}, {x:740,y:680})
  assert.equal(h.commands[0].method,'Runtime.evaluate')
  assert.equal(h.commands.filter(command => command.type === 'rawKeyDown').length,0)
})

test('a covered post-attachment Send control uses exactly one verified Enter', async () => {
  const h = await harness(); await h.prepare(); h.setSubmission({verified:true,method:'enter'})
  await h.click()
  assert.equal(h.commands.filter(command => command.type === 'mousePressed').length,0)
  assert.equal(h.commands.filter(command => command.type === 'rawKeyDown').length,1)
  await assert.rejects(h.click(), /expired or was already used/)
  assert.equal(h.commands.filter(command => command.type === 'rawKeyDown').length,1)
})

test('a changed post-attachment chat, enquiry or composer focus stops before input', async () => {
  const h = await harness(); await h.prepare(); h.setSubmission({verified:false})
  await assert.rejects(h.click(), /changed the prepared chat/)
  assert.equal(h.commands.filter(command => command.method.startsWith('Input.')).length,0)
})

async function updateHarness(stored = {fcunoSpcGroupDispatcherUpdatePendingV1:true}) {
  let installedListener
  const reloads = []
  const chrome = {
    runtime: {getManifest:() => ({version:'1.3.3'}),onInstalled:{addListener:listener => {installedListener=listener}},onMessage:{addListener() {}}},
    tabs: {query:(_query,callback) => callback([{id:11}]),reload:(id,callback) => {reloads.push(id);callback()}},
    storage: {local: {
      get:(keys,callback) => queueMicrotask(() => callback(Object.fromEntries(keys.filter(key => key in stored).map(key => [key,stored[key]])))),
      remove:(keys,callback) => queueMicrotask(() => {for (const key of keys) delete stored[key];callback()}),
    }},
  }
  const context = vm.createContext({chrome})
  vm.runInContext(await fs.readFile(path.join(__dirname,'../tools/whatsapp-spc-group-dispatcher/background.js'),'utf8'),context)
  return {stored,reloads,installed:() => installedListener({reason:'update'}),pageReady:() => context.finishInPlaceUpdate({url:'https://spc.fcuno.com/chrome'})}
}

test('install then updater page-ready reloads WhatsApp once and consumes the legacy pending flag', async () => {
  const h = await updateHarness()
  await h.installed(); await h.pageReady()
  assert.deepEqual(h.reloads,[11])
  assert.equal(h.stored.fcunoSpcGroupDispatcherUpdatePendingV1,undefined)
})

test('updater page-ready fallback and a later install event share one reload', async () => {
  const h = await updateHarness()
  await h.pageReady(); await h.installed()
  assert.deepEqual(h.reloads,[11])
})

test('concurrent install and updater events cannot interrupt the first new claim with a second reload', async () => {
  const h = await updateHarness()
  await Promise.all([h.pageReady(),h.installed(),h.pageReady()])
  assert.deepEqual(h.reloads,[11])
})

test('consumed pending state prevents page-ready reload after service-worker restart', async () => {
  const h = await updateHarness()
  await h.installed()
  const restarted = await updateHarness(h.stored)
  await restarted.pageReady()
  assert.deepEqual(restarted.reloads,[])
})

test('ordinary installs reload WhatsApp without an updater pending flag', async () => {
  const h = await updateHarness({})
  await h.installed()
  assert.deepEqual(h.reloads,[11])
})
