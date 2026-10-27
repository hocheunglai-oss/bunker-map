const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { transformSync } = require("esbuild")

const root = path.resolve(__dirname, "../..")
const port = (id, name, lat, lng) => ({ id, name, type: "port", lat, lng,
  hsfo: null, vlsfo: 800, mgo: 1000, hsfo_formula: null, vlsfo_formula: null, mgo_formula: null, updated_at: "2026-10-27" })
const syntheticPorts = [port(1, "Hong Kong", 22.3, 114.2), port(2, "Singapore", 1.3, 103.8)]
const syntheticFallbacks = { "hong kong::hsfo": "SE", "singapore::hsfo": "NA" }

// Actual reader, public GET and initial-page data boundary. Only SDK/Next
// primitives are synthetic; no environment file, credentials or provider IO.
function createHomepageMarketApp(options = {}) {
  const state = { portsResult: { data: structuredClone(syntheticPorts), error: null },
    fallbackResult: { data: { content: JSON.stringify(syntheticFallbacks) }, error: null }, ...options }
  const calls = [], caches = [], errors = [], loaded = new Map()
  const modules = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "next/cache": { unstable_cache(fn, keys, settings) { caches.push({ keys, settings }); return fn } },
    "react/jsx-runtime": require("react/jsx-runtime"),
    "@/components/HomepageClient": { default: () => null },
    "@supabase/supabase-js": { createClient(url, key) {
      assert.equal(url, "https://synthetic.invalid"); assert.equal(key, "synthetic-only")
      return { from(table) { calls.push(table); assert.ok(["ports", "remarks"].includes(table)); return {
        select(columns) {
          if (table === "ports") return { async order(field, order) {
            assert.equal(field, "id"); assert.deepEqual(order, { ascending: true });
            if (state.portsFailure) throw Error("Synthetic ports connection failure")
            return structuredClone(state.portsResult)
          } }
          assert.equal(columns, "content")
          return { eq(field, value) { assert.equal(field, "id"); assert.equal(value, 105); return { async maybeSingle() {
            if (state.fallbackFailure) throw Error("Synthetic settings connection failure")
            return structuredClone(state.fallbackResult)
          } } } }
        },
      } } }
    } },
  }
  function load(file) {
    if (loaded.has(file)) return loaded.get(file)
    const result = { exports: {} }
    const code = transformSync(fs.readFileSync(path.join(root, file), "utf8"), {
      loader: file.endsWith(".tsx") ? "tsx" : "ts", format: "cjs", jsx: "automatic", target: "node24",
    }).code
    new Function("require", "module", "exports", "process", "console", code)(name => {
      if (Object.hasOwn(modules, name)) return modules[name]
      assert.ok(name.startsWith("@/"), `Unexpected server dependency: ${name}`)
      const stem = name.slice(2), candidate = [stem, stem + ".ts", stem + ".tsx"].find(file => fs.existsSync(path.join(root, file)))
      assert.ok(candidate, name); return load(candidate)
    }, result, result.exports, { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" } },
    { error(...args) { errors.push(args.map(String).join(" ")) } })
    loaded.set(file, result.exports); return result.exports
  }
  const market = load("lib/publicMarketData.ts")
  modules["@/lib/publicMarketData"] = market
  const route = load("app/api/homepage-data/route.ts"), page = load("app/page.tsx")
  return { state, calls, caches, errors, route, market,
    async initialData() { return (await page.default()).props.initialData } }
}

module.exports = { createHomepageMarketApp, syntheticPorts, syntheticFallbacks }
