const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

async function harness() {
  let now = 1000
  let attachDelay = 0
  let requestDelay = 0
  const commands = []
  const chrome = {
    runtime: { getManifest: () => ({version:'1.3.2'}), onInstalled: {addListener() {}}, onMessage: {addListener() {}} },
    storage: {local: {get: (_keys, callback) => callback({fcunoSpcGroupDispatcherV1:{token:'paired'}})}},
    debugger: {
      attach: (_target, _version, callback) => {now += attachDelay; callback()},
      detach: (_target, callback) => callback(),
      sendCommand: (_target, method, args, callback) => {commands.push({method,...args}); callback({})},
    },
  }
  const context = vm.createContext({chrome, performance:{now:() => now}, Date, Number, Map, Promise, setTimeout,
    fetch: async () => {
      now += requestDelay
      return {ok:true,json:async() => ({success:true,job:{leaseExpiresAt:'2026-09-15T00:01:30Z',serverNow:'2026-09-15T00:00:00Z'}})}
    },
  })
  vm.runInContext(await fs.readFile(path.join(__dirname,'../tools/whatsapp-spc-group-dispatcher/background.js'),'utf8'), context)
  const fence = {jobId:'job-1',claimToken:'claim-1'}
  return {
    commands, fence,
    prepare: (tabId=1) => context.handleApiMessage({type:'dispatcher-prepare',...fence},{tab:{id:tabId}}),
    click: (tabId=1, permit=fence) => context.nativeClick(tabId,100,100,permit),
    enter: (tabId=1, permit=fence) => context.nativeEnter(tabId,permit),
    setAttachDelay: value => {attachDelay=value},
    setRequestDelay: value => {requestDelay=value},
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
  assert.equal(h.commands.length,0)
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
