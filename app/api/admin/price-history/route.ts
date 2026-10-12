import { NextResponse } from "next/server"
import { requireAdminPagePermissionForRequest } from "@/lib/adminAuth"
import { createAdminAuditContext, createAdminAuditedSupabaseClient } from "@/lib/adminAudit"
import { confirmMarketHistoryChange, HISTORY_MARKETS, HistoryValidationError, parseHistoryMarket, parseMarketHistorySnapshot, validateMarketHistoryChange } from "@/lib/marketPriceHistory"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
const HEADERS = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" }
function reply(value: unknown, status = 200) { return NextResponse.json(value, { status, headers: HEADERS }) }

export async function GET(request: Request) {
  try {
    const market = parseHistoryMarket(new URL(request.url).searchParams.get("market"))
    const page = HISTORY_MARKETS[market].page
    const session = await requireAdminPagePermissionForRequest(request, page, "view")
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw Error("History read unavailable")
    const client = createAdminAuditedSupabaseClient(createAdminAuditContext(session, undefined, page), { useServiceRole: true })
    const { data, error } = await client.rpc("read_market_price_history", { p_market: market })
    if (error) throw Error("History read failed")
    // Stored-data validation failures are load failures, not bad user input.
    try { return reply(parseMarketHistorySnapshot(data, market)) }
    catch { throw Error("History read incomplete") }
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message === "Unauthorized") return reply({ message: "Please sign in to read history." }, 401)
    if (message === "Forbidden") return reply({ message: "You do not have permission to read this market's history." }, 403)
    if (error instanceof HistoryValidationError) return reply({ message: error.message }, 400)
    return reply({ message: "Saved history could not be loaded completely. Nothing has been changed; please retry." }, 503)
  }
}

async function readBody(request: Request) {
  const limit = 131_072
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "") || !request.body
    || Number(request.headers.get("content-length")) > limit) throw new HistoryValidationError("Send complete history details as JSON.")
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let length = 0, rejectStopped: (error: Error) => void = () => {}
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject })
  const stop = () => { rejectStopped(new HistoryValidationError("History details could not be read. Please retry.")); void reader.cancel().catch(() => {}) }
  const timer = setTimeout(stop, 5_000)
  request.signal.addEventListener("abort", stop, { once: true })
  try {
    if (request.signal.aborted) throw new HistoryValidationError("The history change was cancelled.")
    while (true) {
      const part = await Promise.race([reader.read(), stopped])
      if (part.done) break
      length += part.value.byteLength
      if (length > limit) { void reader.cancel().catch(() => {}); throw new HistoryValidationError("History details are too large.") }
      chunks.push(part.value)
    }
  } finally { clearTimeout(timer); request.signal.removeEventListener("abort", stop); reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown }
  catch { throw new HistoryValidationError("History details must be valid JSON.") }
}

export async function POST(request: Request) {
  try {
    const market = parseHistoryMarket(new URL(request.url).searchParams.get("market"))
    const page = HISTORY_MARKETS[market].page
    const session = await requireAdminPagePermissionForRequest(request, page, "edit")
    const input = validateMarketHistoryChange(await readBody(request), market)
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw Error("History save unavailable")
    const client = createAdminAuditedSupabaseClient(createAdminAuditContext(session, undefined, page), { useServiceRole: true })
    const { data, error } = await client.rpc("change_market_price_history", {
      p_market: market, p_day: input.day, p_operation: input.operation,
      p_expected_ports: input.expectedPorts, p_expected_rows: input.expectedRows, p_values: input.values,
    })
    if (error?.code === "P0002") return reply({ code: "HISTORY_CONFLICT", message: "Saved history or prices changed while you were editing. Your draft is still here; reload saved history before retrying." }, 409)
    if (error?.code === "22023") return reply({ message: "Check the history date, ports and prices, then reload saved history before retrying." }, 400)
    if (error) throw Error("History save unconfirmed")
    return reply(confirmMarketHistoryChange(data, market, input))
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message === "Unauthorized") return reply({ message: "Please sign in before changing history." }, 401)
    if (message === "Forbidden") return reply({ message: "You do not have permission to edit this market's history." }, 403)
    if (error instanceof HistoryValidationError) return reply({ message: error.message }, 400)
    return reply({ message: "The history change could not be confirmed. Your draft is still here; reload saved history to check before retrying." }, 503)
  }
}
