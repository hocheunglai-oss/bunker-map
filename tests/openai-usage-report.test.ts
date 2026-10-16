import assert from "node:assert/strict"
import test from "node:test"
import { isSafeOpenAiUsagePagePath, OpenAiUsageReportError, parseOpenAiUsageReport } from "../lib/openAiUsageReport"
import { usageReportFixture, usageRouteHarness } from "./fixtures/openai-usage-report"

test("usage contract validates complete exact windows, counters, shares and recent evidence", () => {
  for (const days of [7, 30, 90] as const) assert.deepEqual(parseOpenAiUsageReport(usageReportFixture(days), days), usageReportFixture(days))
  const empty = usageReportFixture(); empty.pages = []; empty.recent = []
  for (const key of Object.keys(empty.totals) as Array<keyof typeof empty.totals>) empty.totals[key] = 0
  assert.deepEqual(parseOpenAiUsageReport(empty, 30), empty)
  for (const value of [null, [], {}, { ...usageReportFixture(), days: 7 }]) assert.throws(() => parseOpenAiUsageReport(value, 30), OpenAiUsageReportError)
  const mutations = [
    (r: ReturnType<typeof usageReportFixture>) => { r.totals.totalTokens++ },
    (r: ReturnType<typeof usageReportFixture>) => { r.pages[0].requests++ },
    (r: ReturnType<typeof usageReportFixture>) => { r.pages[0].tokenPercentage = 99 },
    (r: ReturnType<typeof usageReportFixture>) => { r.pages[0].averageDurationMs = 8 },
    (r: ReturnType<typeof usageReportFixture>) => { r.pages.push(r.pages[0]) },
    (r: ReturnType<typeof usageReportFixture>) => { r.recent = [] },
    (r: ReturnType<typeof usageReportFixture>) => { r.recent[0].input_tokens = 4 },
    (r: ReturnType<typeof usageReportFixture>) => { r.recent[0].page_id = "missing" },
    (r: ReturnType<typeof usageReportFixture>) => { r.recent[0].occurred_at = "2027-01-01T00:00:00Z" },
    (r: ReturnType<typeof usageReportFixture>) => { r.pages[0].features = ["wrong"] },
    (r: ReturnType<typeof usageReportFixture>) => { r.pages[0].features.push("phantom") },
    (r: ReturnType<typeof usageReportFixture>) => { r.totals.inputTokens++; r.pages[0].inputTokens++ },
    (r: ReturnType<typeof usageReportFixture>) => { r.totals.errors++; r.pages[0].errors++ },
    (r: ReturnType<typeof usageReportFixture>) => { r.since = "not-a-date" },
  ]
  for (const mutate of mutations) { const report = usageReportFixture(); mutate(report); assert.throws(() => parseOpenAiUsageReport(report, 30), OpenAiUsageReportError) }
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "5"]) {
    const report = usageReportFixture() as unknown as { totals: { totalTokens: unknown } }; report.totals.totalTokens = invalid
    assert.throws(() => parseOpenAiUsageReport(report, 30), OpenAiUsageReportError)
  }
  const nearHalf = usageReportFixture(), duration = 3002399751580329
  nearHalf.pages[0].requests = nearHalf.totals.requests = 3
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens", "webSearchCalls"] as const) {
    nearHalf.pages[0][key] *= 3; nearHalf.totals[key] *= 3
  }
  nearHalf.pages[0].durationMs = 9007199254740988; nearHalf.pages[0].averageDurationMs = duration
  nearHalf.recent = [duration, duration, duration + 1].map(duration_ms => ({ ...nearHalf.recent[0], duration_ms }))
  assert.equal(parseOpenAiUsageReport(nearHalf, 30).pages[0].averageDurationMs, duration)
})

test("usage paths preserve legitimate API/legacy labels while only safe known pages become links", () => {
  for (const path of ["/admin", "/admin/enquiryworksheet", "/spc/enquiries"]) assert.equal(isSafeOpenAiUsagePagePath(path), true)
  for (const path of ["/api/ecosystem/knowledge-extract", "javascript:alert(1)", "//evil.invalid", "/admin/../evil", "/admin/%2e%2e/evil", "/admin/\\evil", "/admin/%5cevil", "/admin/%00", "/admin/\n", "/admin/%"]) {
    assert.equal(isSafeOpenAiUsagePagePath(path), false)
    const report = usageReportFixture(); report.pages[0].pagePath = path; report.recent[0].page_path = path
    assert.equal(parseOpenAiUsageReport(report, 30).pages[0].pagePath, path)
  }
})

test("actual usage route enforces exact View auth before configuration/client and returns private no-store", async () => {
  for (const [auth, status] of [["Unauthorized", 401], ["Forbidden", 403]] as const) {
    const f = usageRouteHarness(); f.controls.auth = auth; f.controls.configured = false
    const response = await f.send(); assert.equal(response.status, status); assert.deepEqual(f.calls, [])
    assert.deepEqual(f.permissions, [{ page: "openai-usage", access: "view" }]); assert.equal(response.headers.get("cache-control"), "private, no-store")
  }
  for (const [query, days] of [[7, 7], [30, 30], [90, 90], ["8", 30], ["Infinity", 30], ["", 30]] as const) {
    const f = usageRouteHarness(), response = await f.send(query)
    assert.equal(response.status, 200); assert.equal((await response.json()).days, days)
    assert.deepEqual(f.calls, [{ name: "createClient", args: null }, { name: "get_openai_usage_report", args: { p_days: days } }])
    assert.equal(response.headers.get("cache-control"), "private, no-store")
  }
})

test("actual usage route fails unavailable for missing config, malformed/partial/unsafe reply and DB/transport failure", async () => {
  const missing = usageRouteHarness(); missing.controls.configured = false
  assert.equal((await missing.send()).status, 503); assert.deepEqual(missing.calls, [])
  for (const data of [null, {}, { ...usageReportFixture(), recent: [] }, { ...usageReportFixture(), days: 90 }]) {
    const f = usageRouteHarness(async () => ({ data, error: null })), response = await f.send()
    assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "private, no-store")
  }
  const failed = usageRouteHarness(async () => ({ data: usageReportFixture(), error: { message: "PRIVATE DB DETAIL" } }))
  const failedResponse = await failed.send(); assert.equal(failedResponse.status, 503); assert.doesNotMatch(await failedResponse.text(), /PRIVATE/)
  const lost = usageRouteHarness(); lost.controls.throw = true
  const response = await lost.send(); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /PRIVATE/)
})
