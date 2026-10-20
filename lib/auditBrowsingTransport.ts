import "server-only"
import { AuditBrowsingError } from "@/lib/auditBrowsingCursor"

/** This fetch is injected into an audit-read-only SDK client, never global. */
export function createAuditBrowsingTransport(requestSignal?: AbortSignal, options: {
  fetcher?: typeof fetch; deadlineMs?: number; responseBytes?: number; totalBytes?: number
} = {}) {
  const controller = new AbortController()
  const stop = () => controller.abort()
  requestSignal?.addEventListener("abort", stop, { once: true })
  if (requestSignal?.aborted) stop()
  const timer = setTimeout(stop, options.deadlineMs ?? 8000)
  let totalBytes = 0
  const fetcher = options.fetcher ?? fetch
  async function bounded<T>(work: Promise<T>): Promise<T> {
    if (controller.signal.aborted) throw new AuditBrowsingError(503)
    let listener: (() => void) | undefined
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        listener = () => reject(new AuditBrowsingError(503))
        controller.signal.addEventListener("abort", listener, { once: true })
        if (controller.signal.aborted) listener()
      })])
    } finally { if (listener) controller.signal.removeEventListener("abort", listener) }
  }
  const wrapped: typeof fetch = async (input, init) => {
    const method = init?.method || (input instanceof Request ? input.method : "GET")
    if (!["GET", "HEAD"].includes(method.toUpperCase())) throw new AuditBrowsingError(503)
    if (controller.signal.aborted) throw new AuditBrowsingError(503)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let finished = false
    try {
      const work = fetcher(input, { ...init, redirect: "error", signal: controller.signal })
      // Also dispose of a late response from a transport that ignores abort.
      void work.then(response => { if (controller.signal.aborted) void response.body?.cancel().catch(() => {}) }, () => {})
      const response = await bounded(work)
      reader = response.body?.getReader()
      const advertised = response.headers.get("content-length")
      const maximum = options.responseBytes ?? 4 * 1024 * 1024
      if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > maximum)) throw new AuditBrowsingError(503)
      const chunks: Uint8Array[] = []
      let bytes = 0
      if (reader) for (;;) {
        const part = await bounded(reader.read())
        if (part.done) { finished = true; break }
        bytes += part.value.byteLength
        totalBytes += part.value.byteLength
        if (bytes > maximum || totalBytes > (options.totalBytes ?? 8 * 1024 * 1024)) throw new AuditBrowsingError(503)
        chunks.push(part.value)
      }
      const headers = new Headers(response.headers)
      headers.delete("content-encoding")
      headers.set("content-length", String(bytes))
      return new Response(reader ? Buffer.concat(chunks) : null, { status: response.status, statusText: response.statusText, headers })
    } catch { throw new AuditBrowsingError(503) }
    finally {
      if (reader && !finished) void reader.cancel().catch(() => {})
      reader?.releaseLock()
    }
  }
  return {
    fetch: wrapped,
    wait: bounded,
    finish() { clearTimeout(timer); requestSignal?.removeEventListener("abort", stop); stop() },
  }
}
