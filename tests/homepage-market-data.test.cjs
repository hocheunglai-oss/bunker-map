const assert = require("node:assert/strict")
const test = require("node:test")
const { createHomepageMarketApp, syntheticPorts, syntheticFallbacks } = require("./fixtures/homepage-market-app.cjs")

function noStore(response) {
  for (const header of ["cache-control", "cdn-cache-control", "vercel-cdn-cache-control"]) {
    assert.match(response.headers.get(header), /no-store/)
    assert.doesNotMatch(response.headers.get(header), /s-maxage|stale-while-revalidate/)
  }
}
test("actual homepage reader and route retain valid markers and existing successful cache policy", async () => {
  const app = createHomepageMarketApp(), response = await app.route.GET()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ports: syntheticPorts, fallbacks: syntheticFallbacks })
  assert.deepEqual(app.caches, [{ keys: ["public-homepage-market-data-v1"], settings: { revalidate: 120 } }])
  for (const name of ["cache-control", "cdn-cache-control", "vercel-cdn-cache-control"]) assert.match(response.headers.get(name), /s-maxage=120, stale-while-revalidate=600/)
  assert.deepEqual(await app.initialData(), { ports: syntheticPorts, fallbacks: syntheticFallbacks })
  assert.deepEqual(app.errors, [])
})
test("confirmed absent, SQL-null and legacy empty fallback settings remain valid empty maps", async t => {
  for (const content of [undefined, null, "", " \n ", "null", "{}"]) await t.test(String(content), async () => {
    const app = createHomepageMarketApp({ fallbackResult: { data: content === undefined ? null : { content }, error: null } })
    const response = await app.route.GET(); assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).fallbacks, {})
  })
})
test("actual homepage route never returns a cacheable partial success after settings/read/schema failure", async t => {
  const damaged = [undefined, [], {}, { content: undefined }, { content: false }, { content: 7 }, { content: {} },
    ...["{broken", "[]", "true", '"text"', '{"hong kong::hsfo":"INVALID"}', '{"hong kong::hsfo":{}}', '{"hong kong::other":"NA"}', " ".repeat(4_194_304) + "{}"].map(content => ({ content }))]
  const cases = [
    { fallbackFailure: true }, { portsFailure: true },
    { fallbackResult: { data: null, error: { message: "PRIVATE SYNTHETIC SETTINGS FAILURE" } } },
    { portsResult: { data: null, error: { message: "PRIVATE SYNTHETIC PORT FAILURE" } } },
    ...[null, undefined, {}].map(data => ({ portsResult: { data, error: null } })),
    ...damaged.map(data => ({ fallbackResult: { data, error: null } })),
  ]
  for (const [index, options] of cases.entries()) await t.test(String(index), async () => {
    const app = createHomepageMarketApp(options), response = await app.route.GET()
    assert.equal(response.status, 502); noStore(response)
    assert.deepEqual(await response.json(), { message: "Unable to load homepage data." })
    assert.deepEqual(await app.initialData(), { ports: [], fallbacks: {}, unavailable: true })
  })
})
test("a failed homepage read does not poison a later successful read or change public report behavior", async () => {
  const app = createHomepageMarketApp({ fallbackFailure: true })
  assert.equal((await app.route.GET()).status, 502)
  app.state.fallbackFailure = false
  const recovered = await app.route.GET(); assert.equal(recovered.status, 200)
  assert.deepEqual((await recovered.json()).fallbacks, syntheticFallbacks)
  assert.deepEqual(app.market.publicMarketCacheHeaders(), {
    "Cache-Control": "public, max-age=0, s-maxage=120, stale-while-revalidate=600",
    "CDN-Cache-Control": "public, s-maxage=120, stale-while-revalidate=600",
    "Vercel-CDN-Cache-Control": "public, s-maxage=120, stale-while-revalidate=600",
  })
})
