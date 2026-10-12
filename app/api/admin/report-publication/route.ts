import { createHash } from "node:crypto"
import { NextResponse } from "next/server"
import { requireAdminPagePermissionForRequest } from "@/lib/adminAuth"
import { createAdminAuditContext, createAdminAuditedSupabaseClient } from "@/lib/adminAudit"
import { buildReportPublication, inspectSavedReportPublication, parseReportPublicationInput, parseReportPublicationSource, parseReportPublicationTarget, ReportPublicationInputError, REPORT_PUBLICATIONS } from "@/lib/reportPublication"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
const HEADERS = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" }
function reply(body: unknown, status = 200) { return NextResponse.json(body, { status, headers: HEADERS }) }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
  return JSON.stringify(value)
}
function version(value: unknown) { return createHash("sha256").update(canonical(value)).digest("hex") }
function versions(raw: unknown) {
  const { publication, ...source } = raw as Record<string, unknown>
  return { sourceVersion: version(source), publicationVersion: version(publication) }
}
function conflict() {
  return reply({ code: "REPORT_CONFLICT", message: "Saved report data or its publication changed. Nothing was replaced; reload and review before publishing." }, 409)
}
function errorReply(error: unknown, readOnly = false) {
  const message = error instanceof Error ? error.message : ""
  if (message === "Unauthorized") return reply({ message: "Please sign in to use report publishing." }, 401)
  if (message === "Forbidden") return reply({ message: "You do not have permission to use this report action." }, 403)
  if (error instanceof ReportPublicationInputError) return reply({ message: error.message }, 400)
  if (readOnly) return reply({ message: "Saved report data could not be loaded completely. No report was published; please retry." }, 503)
  return reply({ message: "Report publication could not be confirmed. Reload to check the saved report before retrying; your inputs have not been changed." }, 503)
}
async function context(request: Request, access: "view" | "edit") {
  const query = new URL(request.url).searchParams
  const target = parseReportPublicationTarget(query.get("report"), query.get("page"))
  const session = await requireAdminPagePermissionForRequest(request, target.page, access)
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw Error("Report service unavailable")
  const client = createAdminAuditedSupabaseClient(createAdminAuditContext(session, undefined, target.page), { useServiceRole: true })
  return { ...target, client }
}
async function readSource(ctx: Awaited<ReturnType<typeof context>>) {
  const { data, error } = await ctx.client.rpc("read_report_publication_source", { p_report: ctx.report, p_port_names: ctx.names })
  if (error) throw Error("Report source unavailable")
  // Invalid stored data is a load failure, never a user-input validation error.
  try { return { raw: data, source: parseReportPublicationSource(data, ctx.report), ...versions(data) } }
  catch { throw Error("Incomplete report source") }
}
export async function GET(request: Request) {
  try {
    const ctx = await context(request, "view"), loaded = await readSource(ctx)
    const saved = inspectSavedReportPublication(loaded.source.publication?.content, ctx.report)
    return reply({ report: ctx.report, sourceVersion: loaded.sourceVersion, publicationVersion: loaded.publicationVersion,
      preview: buildReportPublication(loaded.source),
      publishedReportDate: saved.snapshot?.reportDate ?? null, publishedReportDamaged: saved.damaged })
  } catch (error) { return errorReply(error, true) }
}
async function readInput(request: Request) {
  const invalid = () => new ReportPublicationInputError("Send complete report publication details.")
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "") || !request.body
    || Number(request.headers.get("content-length")) > 4096) throw invalid()
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let length = 0, rejectStopped: (error: Error) => void = () => {}
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject })
  const stop = () => { rejectStopped(invalid()); void reader.cancel().catch(() => {}) }
  const timer = setTimeout(stop, 5000)
  request.signal.addEventListener("abort", stop, { once: true })
  try {
    if (request.signal.aborted) throw invalid()
    while (true) {
      const part = await Promise.race([reader.read(), stopped])
      if (part.done) break
      length += part.value.byteLength
      if (length > 4096) { void reader.cancel().catch(() => {}); throw invalid() }
      chunks.push(part.value)
    }
  } finally { clearTimeout(timer); request.signal.removeEventListener("abort", stop); reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return parseReportPublicationInput(JSON.parse(new TextDecoder().decode(bytes))) }
  catch { throw invalid() }
}
export async function POST(request: Request) {
  try {
    const ctx = await context(request, "edit"), input = await readInput(request), loaded = await readSource(ctx)
    if (loaded.sourceVersion !== input.sourceVersion) return conflict()
    const payload = buildReportPublication(loaded.source, input.dateOverride)
    const saved = inspectSavedReportPublication(loaded.source.publication?.content, ctx.report)
    const alreadyPublished = saved.snapshot !== null && canonical(saved.snapshot) === canonical(payload)
    if (loaded.publicationVersion !== input.publicationVersion && !alreadyPublished) return conflict()
    const { data, error } = await ctx.client.rpc("publish_report_snapshot", {
      p_report: ctx.report, p_port_names: ctx.names, p_expected_source: loaded.raw, p_payload: payload,
    })
    if (error?.code === "P0002") return conflict()
    if (error) throw Error("Report write unconfirmed")
    if (!data || data.report !== ctx.report || typeof data.replayed !== "boolean" || canonical(data.payload) !== canonical(payload)) throw Error("Report confirmation incomplete")
    // The next baseline uses exactly the content persisted by PostgreSQL, not
    // JSON.stringify's different whitespace. Fetching again would risk adopting
    // a different publisher's later version as this publication's confirmation.
    if (typeof data.content !== "string" || canonical(JSON.parse(data.content)) !== canonical(payload)) throw Error("Report content unconfirmed")
    return reply({ report: ctx.report, reportDate: payload.reportDate, replayed: data.replayed,
      sourceVersion: loaded.sourceVersion, publicationVersion: version({ id: REPORT_PUBLICATIONS[ctx.report].id, content: data.content }) })
  } catch (error) { return errorReply(error) }
}
