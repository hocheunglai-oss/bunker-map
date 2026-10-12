import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"
import * as settings from "../lib/priceSetterSettings"
import * as keys from "../lib/reportFallbackKeys"

const fallback = { operation: "fallback", key: "hong kong::hsfo", expectedValue: null, value: "NA" }
const divider = { operation: "divider", portId: "00000000-0000-4000-8000-000000000001", expectedName: "Old", name: " New " }

test("saving one override cannot refresh another unresolved draft's conflict baseline", () => {
  const confirmed = { "basis::hsfo": "SE", "basis::vlsfo": "NA", "other::mgo": "SE" } as const
  const previous = { "basis::hsfo": "NA" } as const
  assert.deepEqual(settings.mergeConfirmedFallbackBaseline(confirmed, previous, ["basis::hsfo", "basis::vlsfo"], "basis::vlsfo"), { ...confirmed, "basis::hsfo": "NA" })
  assert.deepEqual(settings.mergeConfirmedFallbackBaseline(confirmed, {}, ["basis::hsfo"], "basis::vlsfo"), { "basis::vlsfo": "NA", "other::mgo": "SE" })
  assert.deepEqual(confirmed, { "basis::hsfo": "SE", "basis::vlsfo": "NA", "other::mgo": "SE" })
})

test("divider success requires a complete authoritative row before advancing its baseline", () => {
  const port = { id: divider.portId, type: "divider", name: "New", lat: null, lng: null, hsfo: null, vlsfo: null, mgo: null, hsfo_formula: null, vlsfo_formula: null, mgo_formula: null, updated_at: null }
  assert.equal(settings.confirmPriceSetterDivider({ port }, divider.portId, "New").snapshot.name, "New")
  for (const invalid of [null, {}, { port: { id: divider.portId, type: "divider", name: "New" } }, { port: { ...port, id: "other" } }, { port: { ...port, name: "Other" } }, { port: { ...port, type: "port" } }, { port: { ...port, updated_at: "bad" } }]) {
    assert.throws(() => settings.confirmPriceSetterDivider(invalid, divider.portId, "New"), /could not be confirmed/)
  }
})

test("fallback parser distinguishes genuinely absent settings from unreadable settings", () => {
  for (const empty of [null, "", "{}"]) assert.deepEqual(settings.parsePriceSetterFallbacks(empty), {})
  const map = { "hong kong::hsfo": "NA", "taichung::vlsfo": "SE", "dalian::mgo": "-" }
  assert.deepEqual(settings.parsePriceSetterFallbacks(JSON.stringify(map)), map)
  for (const invalid of [undefined, {}, [], "{broken", "null", "[]", "true", '"text"', '{"hong kong::hsfo":null}', '{"hong kong::hsfo":"UNKNOWN"}', '{"Hong Kong::hsfo":"NA"}', '{"::hsfo":"NA"}', '{"x::other":"SE"}', JSON.stringify({ [`${"x".repeat(260)}::hsfo`]: "NA" })]) {
    assert.throws(() => settings.parsePriceSetterFallbacks(invalid), /could not be read/)
  }
})

test("setting changes accept only a single narrow operation with a typed conflict baseline", () => {
  assert.deepEqual(settings.validatePriceSetterSettingChange(fallback), fallback)
  assert.deepEqual(settings.validatePriceSetterSettingChange(divider), { ...divider, name: "New" })
  for (const invalid of [null, [], {}, { ...fallback, extra: true }, { ...fallback, expectedValue: undefined }, { ...fallback, expectedValue: { toString: () => "NA" } }, { ...fallback, expectedValue: false }, { ...fallback, value: null }, { ...fallback, key: "X::hsfo" }, { ...fallback, key: " ::hsfo" }, { ...divider, operation: "delete" }, { ...divider, portId: "wrong" }, { ...divider, expectedName: null }, { ...divider, name: " " }, { ...divider, name: "x".repeat(201) }]) {
    assert.throws(() => settings.validatePriceSetterSettingChange(invalid), /before saving/)
  }
})

function loadHelper(path: string, result: unknown, reject = false) {
  const calls: unknown[][] = []
  const query = {
    select(value: string) { calls.push(["select", value]); return query },
    eq(key: string, value: unknown) { calls.push(["eq", key, value]); return query },
    in(key: string, value: unknown) { calls.push(["in", key, value]); return query },
    maybeSingle() { calls.push(["maybeSingle"]); return query },
    then(resolve: (value: unknown) => unknown, rejecter: (error: unknown) => unknown) { return (reject ? Promise.reject(new Error("Synthetic offline")) : Promise.resolve(result)).then(resolve, rejecter) },
  }
  const modules: Record<string, unknown> = {
    "@/lib/supabase": { supabase: { from(table: string) { calls.push(["from", table]); return query } } },
    "@/lib/reportFallbackKeys": keys,
    "@/lib/priceSetterSettings": settings,
  }
  const loaded = { exports: {} as { loadReportFallbacks: () => Promise<unknown>; loadReportSnapshots: (keys: string[]) => Promise<unknown> } }
  const code = transformSync(readFileSync(new URL(path, import.meta.url), "utf8"), { loader: "ts", format: "cjs" }).code
  new Function("require", "module", "exports", code)((name: string) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected helper dependency ${name}`); return modules[name]
  }, loaded, loaded.exports)
  return { ...loaded.exports, calls }
}

test("fallback reads propagate database/network/schema failures; only a confirmed missing row is empty", async () => {
  for (const result of [{ data: null, error: null }, { data: { content: null }, error: null }]) {
    const helper = loadHelper("../lib/reportFallbacks.ts", result)
    assert.deepEqual(await helper.loadReportFallbacks(), {})
    assert.deepEqual(helper.calls, [["from", "remarks"], ["select", "content"], ["eq", "id", 105], ["maybeSingle"]])
  }
  const map = { "hong kong::hsfo": "NA" }
  assert.deepEqual(await loadHelper("../lib/reportFallbacks.ts", { data: { content: JSON.stringify(map) }, error: null }).loadReportFallbacks(), map)
  for (const result of [{ data: null, error: { message: "Synthetic failure" } }, { data: undefined, error: null }, { data: [], error: null }, { data: {}, error: null }, { data: { content: undefined }, error: null }, { data: { content: "{bad" }, error: null }]) {
    await assert.rejects(loadHelper("../lib/reportFallbacks.ts", result).loadReportFallbacks(), /could not be read/)
  }
  await assert.rejects(loadHelper("../lib/reportFallbacks.ts", null, true).loadReportFallbacks(), /Synthetic offline/)
})

test("report date reads are all-or-nothing, not a partially empty success after a failed read", async () => {
  assert.deepEqual(await loadHelper("../lib/reportSnapshots.ts", { data: [], error: null }).loadReportSnapshots(["taiwan", "hongkong"]), {})
  const helper = loadHelper("../lib/reportSnapshots.ts", { data: [{ id: 101, content: '{"reportDate":"08 Oct 2026"}' }, { id: 102, content: null }], error: null })
  assert.deepEqual(await helper.loadReportSnapshots(["taiwan", "hongkong"]), { taiwan: { reportDate: "08 Oct 2026" } })
  assert.deepEqual(helper.calls, [["from", "remarks"], ["select", "id,content"], ["in", "id", [101, 102]]])
  for (const result of [{ data: null, error: null }, { data: [], error: {} }, { data: [null], error: null }, { data: [{ id: "101", content: "{}" }], error: null }, ...["{bad", "[]", "null", '{"reportDate":42}', JSON.stringify({ reportDate: "x".repeat(81) })].map(content => ({ data: [{ id: 101, content: '{"reportDate":"valid"}' }, { id: 102, content }], error: null }))]) {
    await assert.rejects(loadHelper("../lib/reportSnapshots.ts", result).loadReportSnapshots(["taiwan", "hongkong"]), /could not be read/)
  }
  await assert.rejects(loadHelper("../lib/reportSnapshots.ts", null, true).loadReportSnapshots(["taiwan"]), /Synthetic offline/)
})
