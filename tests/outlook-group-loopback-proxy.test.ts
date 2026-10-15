import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { createLoopbackProxyHandler } = require('./fixtures/loopback-test-proxy.cjs') as {
  createLoopbackProxyHandler: (upstream: string | URL) => RequestListener
}

async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return new URL(`http://127.0.0.1:${address.port}`)
}

async function close(server: Server) {
  server.closeAllConnections()
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function send(origin: URL, path: string, method = 'GET', body = '') {
  return new Promise<{ status: number; body: string; headers: IncomingMessage['headers'] }>((resolve, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port: origin.port, path, method,
      headers: { host: 'untrusted.invalid', 'x-test-probe': 'synthetic', connection: 'close' } }, incoming => {
      const chunks: Buffer[] = []
      incoming.on('data', chunk => chunks.push(chunk))
      incoming.on('end', () => resolve({ status: incoming.statusCode!, headers: incoming.headers, body: Buffer.concat(chunks).toString() }))
      incoming.on('error', reject)
    })
    outgoing.on('error', reject)
    outgoing.end(body)
  })
}

test('local proxy forwards raw path/query, method, body and upstream Host without changing destination', async () => {
  const seen: { path?: string; host?: string; method?: string; body: string }[] = []
  const upstream = createServer(async (incoming, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    seen.push({ path: incoming.url, host: incoming.headers.host, method: incoming.method, body: Buffer.concat(chunks).toString() })
    response.writeHead(201, { 'x-upstream-test': 'preserved' })
    response.end('local upstream')
  })
  const base = await listen(upstream)
  const handler = createLoopbackProxyHandler(base)
  const expectedHost = base.host
  base.hostname = 'untrusted.invalid' // caller mutation cannot alter the snapshot
  const proxy = createServer(handler)
  try {
    const origin = await listen(proxy)
    for (const path of ['/admin/outlookaddressbook?next=http://untrusted.invalid/&encoded=%2F%2F', '/_next/static/chunks/a.js?v=1', '/%2f%2fencoded-path?fragment=%23&space=%20']) {
      const result = await send(origin, path, 'POST', 'synthetic body')
      assert.equal(result.status, 201)
      assert.equal(result.body, 'local upstream')
      assert.equal(result.headers['x-upstream-test'], 'preserved')
      assert.deepEqual(seen.at(-1), { path, host: expectedHost, method: 'POST', body: 'synthetic body' })
    }
  } finally { await close(proxy); await close(upstream) }
})

test('absolute and parser-equivalent authority targets contact neither the upstream nor a loopback canary', async () => {
  let upstreamCalls = 0, canaryCalls = 0
  const upstream = createServer((_incoming, response) => { upstreamCalls++; response.end('unexpected upstream') })
  const canary = createServer((_incoming, response) => { canaryCalls++; response.end('unexpected canary') })
  const base = await listen(upstream), forbidden = await listen(canary)
  const proxy = createServer(createLoopbackProxyHandler(base))
  try {
    const origin = await listen(proxy)
    for (const target of [forbidden.href + 'probe', `//${forbidden.host}/probe`, `/\\${forbidden.host}/probe`, `\\\\${forbidden.host}/probe`, `http:////${forbidden.host}/probe`, `http://synthetic:synthetic@${forbidden.host}/probe`, forbidden.host]) {
      assert.equal((await send(origin, target)).status, 400, target)
    }
    assert.equal(upstreamCalls, 0)
    assert.equal(canaryCalls, 0)
  } finally { await close(proxy); await close(upstream); await close(canary) }
})

test('malformed request targets are rejected before any forwarding', () => {
  const handler = createLoopbackProxyHandler('http://127.0.0.1:38519')
  for (const path of [undefined, '', '*', '/space here', '/line\r\nbreak', '/nul\0byte', '/tab\tbyte', '/fragment#not-on-wire', '/non-ascii-é', '/slash\\host', '/delete\x7fbyte']) {
    let status = 0, ended = false
    const incoming = Readable.from([]) as unknown as IncomingMessage
    Object.assign(incoming, { url: path, method: 'GET', headers: {} })
    const response = { writeHead(value: number) { status = value }, end() { ended = true } } as unknown as ServerResponse
    handler(incoming, response)
    assert.equal(status, 400, String(path))
    assert.equal(ended, true)
  }
})

test('proxy configuration admits only HTTP loopback and no credentials', () => {
  for (const value of ['https://127.0.0.1:38519', 'http://untrusted.invalid', 'http://127.0.0.1.untrusted.invalid', 'file:///tmp/fixture', 'http://synthetic:synthetic@localhost:38519']) {
    assert.throws(() => createLoopbackProxyHandler(value), /loopback HTTP/)
  }
  assert.equal(typeof createLoopbackProxyHandler('http://localhost:38519'), 'function')
})

test('localhost upstreams retain the local resolver address family instead of forcing IPv4', async () => {
  const upstream = createServer((_incoming, response) => response.end('owned localhost upstream'))
  upstream.listen(0, 'localhost')
  await once(upstream, 'listening')
  const address = upstream.address()
  assert.ok(address && typeof address === 'object')
  const proxy = createServer(createLoopbackProxyHandler(`http://localhost:${address.port}`))
  try {
    const result = await send(await listen(proxy), '/probe')
    assert.equal(result.status, 200)
    assert.equal(result.body, 'owned localhost upstream')
  } finally { await close(proxy); await close(upstream) }
})

test('an unavailable local upstream retains the explicit 502 error response', async () => {
  const unavailable = createServer()
  const base = await listen(unavailable)
  await close(unavailable)
  const proxy = createServer(createLoopbackProxyHandler(base))
  try { assert.equal((await send(await listen(proxy), '/admin/outlookaddressbook')).status, 502) }
  finally { await close(proxy) }
})
