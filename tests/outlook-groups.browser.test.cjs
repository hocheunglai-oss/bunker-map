// Start a local production/dev server with synthetic public env first. This
// test intercepts every API/external request and never accesses live accounts.
const assert = require('node:assert/strict')
const { mkdirSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const https = require('node:https')
const { createLoopbackProxyHandler } = require('./fixtures/loopback-test-proxy.cjs')
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const origin = process.env.FCUNO_GROUP_TEST_ORIGIN || 'http://127.0.0.1:38519'
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'Only an isolated loopback server is allowed')
const output = process.env.FCUNO_GROUP_SCREENSHOTS || '/private/tmp/fcuno-outlook-groups-20261014'
mkdirSync(output, { recursive: true })
const expectedCases = []
const upstream = process.env.FCUNO_GROUP_TEST_UPSTREAM ? new URL(process.env.FCUNO_GROUP_TEST_UPSTREAM) : null
const proxy = upstream ? https.createServer({ key: readFileSync(process.env.FCUNO_GROUP_TEST_TLS_KEY), cert: readFileSync(process.env.FCUNO_GROUP_TEST_TLS_CERT) }, createLoopbackProxyHandler(upstream)) : null

async function runCase(browser, engine, width, mode) {
  const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: mode, timezoneId: 'Asia/Hong_Kong', ignoreHTTPSErrors: true })
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  const pageErrors = [], unexpected = [], writes = []
  page.on('pageerror', error => pageErrors.push(error.message))
  let authenticated = true, sequence = 1, releaseSave, heldSave, holdSave = false, loseSave = false, loseInsert = false, failGroupRead = 0
  const version = () => `2026-10-14T10:00:00.${String(sequence++).padStart(6, '0')}+00:00`
  const contacts = [1, 2].map(i => ({ id: `contact-${i}`, source_book: 'FC-GENERAL', source_card: `card-${i}`, display_name: `SYNTHETIC CONTACT ${i}`, primary_email: `contact-${i}@example.invalid`, nickname: null, first_name: null, last_name: null, vcard: null, properties: {} }))
  const originalId = 'group-original'
  const groups = [{ id: originalId, source_uid: 'stable-original-source', source_book: 'FC-GENERAL', name: 'ORIGINAL GROUP', nickname: null, description: null, member_count: 1, updated_at: version() }, { id: 'group-other', source_uid: 'stable-other-source', source_book: 'FC-GENERAL', name: 'OTHER GROUP', nickname: null, description: null, member_count: 0, updated_at: version() }]
  let members = [{ group_id: originalId, contact_id: contacts[0].id, source_book: 'FC-GENERAL' }]
  const original = () => groups.find(row => row.id === originalId)
  const fulfill = (route, body, status = 200) => route.fulfill({ status, json: body })
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method()
    if (url.origin !== origin) {
      if (!(url.origin === 'https://va.vercel-scripts.com' && ['/v1/script.debug.js', '/v1/speed-insights/script.debug.js'].includes(url.pathname))) unexpected.push(url.origin + url.pathname)
      return route.abort()
    }
    if (url.pathname.startsWith('/_vercel/')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* isolated */' })
    if (!url.pathname.startsWith('/api/')) return route.continue()
    if (method !== 'GET') writes.push({ path: url.pathname, method, body: request.postDataJSON() })
    if (url.pathname === '/api/admin/session') return fulfill(route, authenticated ? { authenticated: true, username: 'synthetic', displayName: 'Synthetic verifier', role: 'ADMIN', permissions: {} } : { authenticated: false })
    if (url.pathname === '/api/outlook-addressbook/bootstrap') return fulfill(route, { contacts, groups, members })
    if (url.pathname === '/api/admin/audit-logs') return fulfill(route, { logs: [] })
    if (url.pathname === '/api/outlook-addressbook/exchange-sync' && method === 'GET') return fulfill(route, { webhookConfigured: true, status: { status: 'completed', requestedAt: '2026-10-14T10:00:00Z', message: 'Current' } })
    if (url.pathname === '/api/parser-reports') return fulfill(route, { source: 'enquiryworksheet', unresolvedReports: 0, pendingAiReview: 0, readyForUserReview: 0, totalReports: 0 })
    if (url.pathname === '/api/admin/email-templates') return fulfill(route, { templates: [], folders: [] })
    if (url.pathname === '/api/admin/tech-stack') return fulfill(route, {
      generatedAt: '2026-10-15T07:45:00Z',
      deployment: { platform: 'Synthetic isolated build', project: 'bunker-map-c2ks', productionUrl: 'https://fcuno.com', gitRepository: 'hocheunglai-oss/bunker-map', environment: 'test', branch: 'isolated', commit: 'synthetic', functionRegion: 'test', configuredRegions: [] },
      databaseInventory: { schema: 'bunker-map.backup-inventory/v1', migrationHead: '20261014082839', tables: ['synthetic_table'], checkedAt: '2026-10-15T07:45:00Z' },
      verification: { responseTimeOnly: true, externalServices: 'No live infrastructure query in this fixture', environmentValues: 'No live credentials in this fixture' },
      schedules: [], secrets: [],
    })
    if (url.pathname === '/api/outlook-addressbook/groups' && method === 'POST') {
      const body = request.postDataJSON()
      if (holdSave && body.action === 'save') {
        holdSave = false
        heldSave()
        await new Promise(resolve => { releaseSave = resolve })
      }
      const row = groups.find(group => group.id === body.id)
      if (!row || row.updated_at !== body.expectedUpdatedAt) return fulfill(route, { message: 'This group changed or was deleted. Your edits are still here. Copy them before reloading the group.' }, 409)
      if (body.action === 'save') {
        assert.deepEqual(Object.keys(body).sort(), ['action', 'changes', 'expectedUpdatedAt', 'id'])
        assert.ok(Object.keys(body.changes).every(key => ['name', 'source_book', 'nickname', 'description'].includes(key)))
        Object.assign(row, body.changes, { updated_at: version() })
        if (loseSave) { loseSave = false; return route.abort() }
        return fulfill(route, { group: row })
      }
      assert.equal(body.action, 'delete')
      const deleted = { id: row.id, updated_at: row.updated_at }
      groups.splice(groups.indexOf(row), 1)
      members = members.filter(member => member.group_id !== row.id)
      return fulfill(route, { deleted })
    }
    if (url.pathname === '/api/admin/supabase') {
      const target = new URL(url.searchParams.get('target'))
      const table = target.pathname.split('/').pop()
      const id = target.searchParams.get('id')?.slice(3)
      if (table === 'shared_addressbook_groups' && method === 'GET') {
        if (failGroupRead > 0) { failGroupRead -= 1; return fulfill(route, { message: 'Synthetic refresh failure' }, 500) }
        const row = groups.find(group => group.id === id)
        return fulfill(route, row || { message: 'Not found' }, row ? 200 : 404)
      }
      if (table === 'shared_addressbook_groups' && method === 'POST') {
        assert.ok(!(request.headers().prefer || '').includes('resolution=merge-duplicates'), 'No group upsert is permitted')
        const body = request.postDataJSON()
        assert.equal(body.updated_at, undefined)
        if (groups.some(row => row.id === body.id)) return fulfill(route, { code: '23505', message: 'duplicate' }, 409)
        const row = { ...body, updated_at: version() }
        groups.push(row)
        if (loseInsert) { loseInsert = false; return route.abort() }
        return fulfill(route, row)
      }
      if (table === 'shared_addressbook_group_members') {
        const groupId = target.searchParams.get('group_id')?.slice(3)
        if (method === 'GET') return fulfill(route, members.filter(member => member.group_id === groupId).sort((a, b) => a.contact_id.localeCompare(b.contact_id)))
        if (method === 'DELETE') {
          const contactId = target.searchParams.get('contact_id')?.slice(3)
          const deleted = members.filter(row => row.group_id === groupId && row.contact_id === contactId)
          members = members.filter(row => !(row.group_id === groupId && row.contact_id === contactId))
          const group = groups.find(row => row.id === groupId)
          if (group) { group.member_count = members.filter(row => row.group_id === groupId).length; group.updated_at = version() }
          return fulfill(route, deleted)
        }
      }
      unexpected.push(`${method} ${table}`)
      return fulfill(route, { message: 'Unexpected isolated operation' }, 500)
    }
    unexpected.push(`${method} ${url.pathname}`)
    return fulfill(route, { message: 'Unexpected isolated request' }, 500)
  })
  const name = () => page.getByLabel('Group Name', { exact: true })
  const save = () => page.getByRole('button', { name: 'Save', exact: true })
  const reload = () => page.getByRole('button', { name: 'Reload group', exact: true })
  const acceptNext = () => page.once('dialog', dialog => dialog.accept())
  try {
    await page.goto(origin + '/admin/outlookaddressbook')
    await page.getByRole('button', { name: /ORIGINAL GROUP/ }).click()
    await name().fill('')
    assert.equal(writes.length, 0, 'Typing and clearing must not persist intermediate drafts')
    await save().click()
    await page.getByRole('alert').filter({ hasText: 'Group name is required.' }).waitFor()
    assert.equal(writes.length, 0)
    await name().fill('EDITED GROUP')
    assert.equal(await page.getByRole('button', { name: 'Add Member', exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: 'Sync now', exact: true }).isDisabled(), true)
    holdSave = true
    const reached = new Promise(resolve => { heldSave = resolve })
    await save().click(); await reached
    assert.equal(await name().isDisabled(), true)
    for (const label of ['Delete', 'Cancel', 'Reload group']) assert.equal(await page.getByRole('button', { name: label, exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: /OTHER GROUP/ }).isDisabled(), true)
    releaseSave()
    await page.getByRole('status').filter({ hasText: 'Group saved.' }).waitFor()
    assert.equal(original().name, 'EDITED GROUP')
    assert.deepEqual(writes[0].body.changes, { name: 'EDITED GROUP' })
    assert.equal(original().source_uid, 'stable-original-source')

    original().name = 'REMOTE GROUP'; original().updated_at = version(); original().member_count = 2
    members.push({ group_id: originalId, contact_id: contacts[1].id, source_book: 'FC-GENERAL' })
    await name().fill('MY DRAFT'); await save().click()
    await page.getByRole('alert').filter({ hasText: 'Your edits are still here' }).waitFor()
    assert.equal(await name().inputValue(), 'MY DRAFT')
    assert.equal(await name().getAttribute('readonly'), '')
    acceptNext(); await reload().click()
    await page.getByRole('status').filter({ hasText: 'Group reloaded.' }).waitFor()
    assert.equal(await name().inputValue(), 'REMOTE GROUP')
    assert.equal(await page.getByRole('button', { name: 'Remove', exact: true }).count(), 2)

    loseSave = true
    await name().fill('LATE ACK GROUP'); await save().click()
    await page.getByRole('status').filter({ hasText: 'Reload this group before editing.' }).waitFor()
    assert.equal(await name().inputValue(), 'LATE ACK GROUP')
    const beforeReload = writes.length
    acceptNext(); await reload().click()
    await page.getByRole('status').filter({ hasText: 'Group reloaded.' }).waitFor()
    assert.equal(writes.length, beforeReload, 'A lost save reply must not trigger another write')
    assert.equal(original().name, 'LATE ACK GROUP')

    failGroupRead = 1
    await page.getByRole('button', { name: 'Remove', exact: true }).nth(1).click()
    await page.getByRole('alert').filter({ hasText: 'member change was saved' }).waitFor()
    assert.equal(await name().getAttribute('readonly'), '')
    assert.equal(await page.getByRole('button', { name: 'Remove', exact: true }).count(), 1)
    await reload().click()
    await page.getByRole('status').filter({ hasText: 'Group reloaded.' }).waitFor()
    assert.equal(await name().getAttribute('readonly'), null)

    await page.getByLabel('Source Book', { exact: true }).selectOption('__new_source_book__')
    const beforeSource = writes.length
    await save().click()
    await page.getByRole('alert').filter({ hasText: 'Source book is required.' }).waitFor()
    assert.equal(writes.length, beforeSource)
    await page.getByLabel('New Source Book', { exact: true }).fill('FC-NEW')
    await save().click()
    await page.getByRole('status').filter({ hasText: 'Group saved.' }).waitFor()
    assert.deepEqual(writes.at(-1).body.changes, { source_book: 'FC-NEW' })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page overflow')
    await page.screenshot({ path: resolve(output, `groups-${engine}-${width}-${mode}.png`), fullPage: true })

    await page.getByRole('button', { name: 'Add contact or group', exact: true }).click()
    await page.getByRole('button', { name: 'New Group', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'New Group', exact: true })
    await dialog.getByLabel('Group Name', { exact: true }).fill('NEW SAFE GROUP')
    loseInsert = true
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(groups.filter(row => row.name === 'NEW SAFE GROUP').length, 1)
    assert.equal(await name().inputValue(), 'NEW SAFE GROUP')
    const newId = groups.find(row => row.name === 'NEW SAFE GROUP').id
    acceptNext(); await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('button', { name: /NEW SAFE GROUP/ }).waitFor({ state: 'hidden' })
    assert.ok(!groups.some(row => row.id === newId), 'Deleted group remains absent')

    await page.goto(origin + '/admin/techstack')
    await page.getByRole('heading', { name: 'CURRENT DEPLOYMENT', exact: true }).waitFor()
    const worker = page.getByRole('row').filter({ hasText: 'EXCHANGE WORKER' })
    const account = worker.getByRole('cell').nth(3)
    assert.match(await account.innerText(), /2026-10-09\.1; PUBLISHED AZURE VERSION NOT VERIFIED BY THIS PAGE/)
    await worker.scrollIntoViewIfNeeded()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Tech Stack has no horizontal page overflow')
    await page.screenshot({ path: resolve(output, `tech-stack-worker-${engine}-${width}-${mode}.png`) })
    await account.scrollIntoViewIfNeeded()
    assert.equal(await account.evaluate(cell => cell.scrollHeight <= cell.clientHeight + 1), true, 'Worker register text is not vertically clipped')
    await page.screenshot({ path: resolve(output, `tech-stack-version-${engine}-${width}-${mode}.png`) })

    authenticated = false
    await page.goto(origin + '/admin/techstack')
    await page.getByRole('heading', { name: 'Access Denied', exact: true }).waitFor()
    assert.equal(await page.getByRole('row').filter({ hasText: 'EXCHANGE WORKER' }).count(), 0)
    await page.goto(origin + '/admin/outlookaddressbook')
    await page.getByRole('heading', { name: 'Access Denied', exact: true }).waitFor()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    await page.screenshot({ path: resolve(output, `groups-signed-out-${engine}-${width}-${mode}.png`), fullPage: true })
    assert.deepEqual(unexpected, [])
    assert.deepEqual(pageErrors, [])
    expectedCases.push({ engine, width, mode, writes: writes.length })
  } catch (error) {
    if (releaseSave) releaseSave()
    await page.screenshot({ path: resolve(output, `failure-${engine}-${width}-${mode}.png`), fullPage: true })
    console.error(JSON.stringify({ engine, width, mode, unexpected, pageErrors, writes, text: await page.locator('body').innerText() }))
    throw error
  } finally { await context.close() }
}

;(async () => {
  if (proxy) await new Promise(resolve => proxy.listen(new URL(origin).port, '127.0.0.1', resolve))
  try {
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    if (process.env.FCUNO_GROUP_TEST_ENGINE && process.env.FCUNO_GROUP_TEST_ENGINE !== engine) continue
    const browser = await launcher.launch({ headless: true, ...(engine === 'chromium' && process.env.FCUNO_CHROMIUM_EXECUTABLE ? { executablePath: process.env.FCUNO_CHROMIUM_EXECUTABLE } : {}) })
    try { for (const width of [320, 390, 1440]) for (const mode of ['light', 'dark']) await runCase(browser, engine, width, mode) }
    finally { await browser.close() }
  }
  console.log(JSON.stringify({ passed: expectedCases.length, cases: expectedCases, screenshots: output }, null, 2))
  } finally { if (proxy) await new Promise(resolve => proxy.close(resolve)) }
})().catch(error => { console.error(error); process.exitCode = 1 })
