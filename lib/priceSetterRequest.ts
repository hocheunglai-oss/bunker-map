import { PriceSetterValidationError } from "@/lib/priceSetterMutation"

/** Shared bounded, abortable JSON transport for price writes and recovery. */
export async function readPriceSetterJsonBody(request: Request, maxBytes = 8_192) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) throw new PriceSetterValidationError("Send price details as JSON.")
  if (Number(request.headers.get("content-length")) > maxBytes || !request.body) throw new PriceSetterValidationError("Price details are missing or too large.")
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let length = 0, rejectStopped: (error: Error) => void = () => {}
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject })
  const stop = () => { rejectStopped(new PriceSetterValidationError("Price details could not be read. Please retry.")); void reader.cancel().catch(() => {}) }
  const timer = setTimeout(stop, 5_000)
  request.signal.addEventListener("abort", stop, { once: true })
  try {
    if (request.signal.aborted) throw new PriceSetterValidationError("The save was cancelled.")
    while (true) {
      const part = await Promise.race([reader.read(), stopped])
      if (part.done) break
      length += part.value.byteLength
      if (length > maxBytes) { void reader.cancel().catch(() => {}); throw new PriceSetterValidationError("Price details are too large.") }
      chunks.push(part.value)
    }
  } finally { clearTimeout(timer); request.signal.removeEventListener("abort", stop); reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown }
  catch { throw new PriceSetterValidationError("Price details must be valid JSON.") }
}
