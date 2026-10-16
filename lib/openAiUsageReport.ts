export const OPENAI_USAGE_DAYS = [7, 30, 90] as const
export type OpenAiUsageDays = typeof OPENAI_USAGE_DAYS[number]
const counterKeys = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens", "webSearchCalls"] as const
type Counters = Record<typeof counterKeys[number], number>
export type OpenAiUsageRow = {
  occurred_at: string; page_id: string; page_path: string; feature: string; model: string; status: "success" | "error"
  input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_tokens: number
  total_tokens: number; web_search_calls: number; duration_ms: number
}
export type OpenAiPageUsage = Counters & {
  pageId: string; pagePath: string; requests: number; errors: number; durationMs: number
  tokenPercentage: number; requestPercentage: number; averageDurationMs: number; features: string[]; models: string[]
}
export type OpenAiUsageReport = {
  generatedAt: string; since: string; days: OpenAiUsageDays
  totals: Counters & { requests: number; errors: number }; pages: OpenAiPageUsage[]; recent: OpenAiUsageRow[]
}
export class OpenAiUsageReportError extends Error {
  constructor() { super("OpenAI usage could not be verified. Please refresh."); this.name = "OpenAiUsageReportError" }
}
function fail(): never { throw new OpenAiUsageReportError() }
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail()
}
function keys(value: Record<string, unknown>, expected: readonly string[]) {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) fail()
}
function integer(value: unknown) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail() }
function text(value: unknown) { return typeof value === "string" ? value : fail() }
// Analytics labels may include API routes or legacy values. Keep them as text;
// only these verified local page families should become navigation links.
export function isSafeOpenAiUsagePagePath(value: unknown): value is string {
  if (typeof value !== "string") return false
  const raw = value
  let decoded: string
  try { decoded = decodeURIComponent(raw) } catch { return false }
  if ([raw, decoded].some(candidate => !/^\/(admin|spc)(?:\/|$)/.test(candidate) || /[\u0000-\u0020\u007f\\]/.test(candidate)
    || candidate.split(/[?#]/)[0].split("/").some(part => part === "." || part === ".."))) return false
  return true
}
function timestamp(value: unknown) {
  const string = text(value)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(string) || !Number.isFinite(Date.parse(string))) fail()
  const date = string.split("T")[0]
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) fail()
  return string
}
function counters(value: Record<string, unknown>): Counters {
  return Object.fromEntries(counterKeys.map(key => [key, integer(value[key])])) as Counters
}
function strings(value: unknown) {
  if (!Array.isArray(value)) return fail()
  const result = value.map(text)
  if (result.some(item => !item) || new Set(result).size !== result.length) fail()
  return result
}
function percentage(value: unknown, expected: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100 || Math.abs(value - expected) > 1e-7) fail()
  return value
}
function roundedAverage(sum: number, count: number) {
  // Match PostgreSQL numeric round exactly, including near-half safe integers.
  const two = BigInt(2)
  return Number((BigInt(sum) * two + BigInt(count)) / (BigInt(count) * two))
}
const plus = (a: number, b: number) => integer(a + b)
const rowCounters = (row: OpenAiUsageRow): Counters => ({ inputTokens: row.input_tokens, cachedInputTokens: row.cached_input_tokens,
  outputTokens: row.output_tokens, reasoningTokens: row.reasoning_tokens, totalTokens: row.total_tokens, webSearchCalls: row.web_search_calls })

// Token fields are independently measured: do not invent input+output equality.
export function parseOpenAiUsageReport(value: unknown, expectedDays: number): OpenAiUsageReport {
  const report = record(value)
  keys(report, ["generatedAt", "since", "days", "totals", "pages", "recent"])
  if (!OPENAI_USAGE_DAYS.some(days => days === expectedDays) || report.days !== expectedDays) fail()
  const generatedAt = timestamp(report.generatedAt), since = timestamp(report.since)
  if (Date.parse(generatedAt) - Date.parse(since) !== expectedDays * 86400000) fail()
  const rawTotals = record(report.totals)
  keys(rawTotals, ["requests", "errors", ...counterKeys])
  const totals = { requests: integer(rawTotals.requests), errors: integer(rawTotals.errors), ...counters(rawTotals) }
  if (totals.errors > totals.requests || !Array.isArray(report.pages) || !Array.isArray(report.recent)) fail()
  const pages = report.pages.map((value): OpenAiPageUsage => {
    const page = record(value)
    keys(page, ["pageId", "pagePath", "requests", "errors", ...counterKeys, "durationMs", "averageDurationMs", "tokenPercentage", "requestPercentage", "features", "models"])
    const requests = integer(page.requests), errors = integer(page.errors), durationMs = integer(page.durationMs), counts = counters(page)
    const pageId = text(page.pageId)
    if (!requests || errors > requests || page.averageDurationMs !== roundedAverage(durationMs, requests)) fail()
    return { pageId, pagePath: text(page.pagePath), requests, errors, durationMs, ...counts, averageDurationMs: integer(page.averageDurationMs),
      tokenPercentage: percentage(page.tokenPercentage, totals.totalTokens ? counts.totalTokens / totals.totalTokens * 100 : 0),
      requestPercentage: percentage(page.requestPercentage, totals.requests ? requests / totals.requests * 100 : 0),
      features: strings(page.features), models: strings(page.models) }
  })
  const pageMap = new Map(pages.map(page => [page.pageId, page]))
  if (pageMap.size !== pages.length || pages.some((page, index) => index && pages[index - 1].totalTokens < page.totalTokens)) fail()
  for (const key of ["requests", "errors", ...counterKeys] as const) {
    if (pages.reduce((sum, page) => plus(sum, page[key]), 0) !== totals[key]) fail()
  }
  if (!totals.requests && counterKeys.some(key => totals[key] !== 0)) fail()
  const recent = report.recent.map((value): OpenAiUsageRow => {
    const row = record(value)
    keys(row, ["occurred_at", "page_id", "page_path", "feature", "model", "status", "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_tokens", "total_tokens", "web_search_calls", "duration_ms"])
    if (row.status !== "success" && row.status !== "error") fail()
    return { occurred_at: timestamp(row.occurred_at), page_id: text(row.page_id), page_path: text(row.page_path), feature: text(row.feature), model: text(row.model), status: row.status,
      input_tokens: integer(row.input_tokens), cached_input_tokens: integer(row.cached_input_tokens), output_tokens: integer(row.output_tokens), reasoning_tokens: integer(row.reasoning_tokens),
      total_tokens: integer(row.total_tokens), web_search_calls: integer(row.web_search_calls), duration_ms: integer(row.duration_ms) }
  })
  if (recent.length !== Math.min(20, totals.requests)) fail()
  const seen = new Map<string, { requests: number; errors: number; durationMs: number; counts: Counters; features: Set<string>; models: Set<string> }>()
  for (const [index, row] of recent.entries()) {
    const at = Date.parse(row.occurred_at), page = pageMap.get(row.page_id)
    if (!page || at < Date.parse(since) || at > Date.parse(generatedAt) || index && at > Date.parse(recent[index - 1].occurred_at)) fail()
    if (!seen.has(row.page_id) && page.pagePath !== row.page_path) fail()
    if (row.feature && !page.features.includes(row.feature) || row.model && !page.models.includes(row.model)) fail()
    const sum = seen.get(row.page_id) || { requests: 0, errors: 0, durationMs: 0, counts: Object.fromEntries(counterKeys.map(key => [key, 0])) as Counters, features: new Set<string>(), models: new Set<string>() }
    sum.requests++; sum.errors += row.status === "error" ? 1 : 0; sum.durationMs = plus(sum.durationMs, row.duration_ms)
    const counts = rowCounters(row)
    for (const key of counterKeys) { sum.counts[key] = plus(sum.counts[key], counts[key]); if (sum.counts[key] > page[key]) fail() }
    if (sum.requests > page.requests || sum.errors > page.errors || sum.durationMs > page.durationMs) fail()
    if (row.feature) sum.features.add(row.feature)
    if (row.model) sum.models.add(row.model)
    seen.set(row.page_id, sum)
  }
  // When recent20 contains every event of a group, its evidence is exact, not
  // merely a lower bound. This also verifies empty/error-only small reports.
  for (const [id, sum] of seen) {
    const page = pageMap.get(id)!
    if (sum.requests !== page.requests) continue
    if (sum.errors !== page.errors || sum.durationMs !== page.durationMs || counterKeys.some(key => sum.counts[key] !== page[key])
      || page.features.length !== sum.features.size || page.models.length !== sum.models.size) fail()
  }
  return { generatedAt, since, days: expectedDays as OpenAiUsageDays, totals, pages, recent }
}
