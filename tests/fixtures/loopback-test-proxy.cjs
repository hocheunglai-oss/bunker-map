const assert = require('node:assert/strict')
const http = require('node:http')

// This handler is only for an owned local browser-test server. Snapshot the
// trusted upstream once; an incoming request target must never select a socket.
function createLoopbackProxyHandler(upstream) {
  const base = new URL(upstream)
  assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname)
    && !base.username && !base.password, 'Proxy upstream must be loopback HTTP without credentials')
  const port = Number(base.port || 80)
  const host = base.host
  const hostname = base.hostname === 'localhost' ? 'localhost' : '127.0.0.1'

  return (request, response) => {
    const path = request.url
    // Browsers send origin-form, with non-ASCII and fragment characters encoded.
    // Reject authority/absolute forms and parser-confusing bytes, not app paths.
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')
      || /[\\#\u0000-\u0020\u007f-\uffff]/.test(path)) {
      response.writeHead(400)
      response.end('Invalid local test request target')
      request.resume()
      return
    }
    const forward = http.request({
      protocol: 'http:', hostname, port, path,
      method: request.method, headers: { ...request.headers, host },
    }, received => {
      response.writeHead(received.statusCode, received.headers)
      received.pipe(response)
    })
    forward.on('error', error => { response.writeHead(502); response.end(String(error)) })
    request.pipe(forward)
  }
}

module.exports = { createLoopbackProxyHandler }
