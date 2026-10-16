import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { dirname, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { transformSync } from "esbuild"
import { createClient } from "@supabase/supabase-js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const require = createRequire(import.meta.url)

// Real route, cache, timing/private-response helpers and Supabase SDK. Only the
// credential-free actor, environment, clock and database HTTP transport differ.
export function operationalRuntime(environment = {}) {
  const state = { now: Date.parse("2026-10-16T12:00:00.000Z"), clockStepMs: 0, permission: "view", mode: "ok", counts: { spc_users: 4, spc_enquiries: 12, spc_fixtures: 3 } }
  const authChecks = [], requests = [], pending = [], timers = new Map(), logs = [], cache = new Map()
  let nextTimer = 0
  const NativeDate = Date
  class FixtureDate extends NativeDate { constructor(...args) { if (!args.length) state.now += state.clockStepMs; super(...(args.length ? args : [state.now])) } static now() { return state.now } }
  const transport = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url)
    assert.equal(url.origin, "https://synthetic.invalid")
    assert.equal(init.method, "HEAD")
    assert.equal(url.searchParams.get("select"), "id")
    assert.match(new Headers(init.headers).get("prefer"), /count=exact/)
    const table = url.pathname.split("/").at(-1)
    assert.ok(Object.hasOwn(state.counts, table), "Unexpected table " + table)
    requests.push({ table, signal: init.signal })
    if (state.mode === "error") return new Response(null, { status: 503 })
    const result = () => new Response(null, { status: 200, headers: { "content-range": `0-0/${state.counts[table]}` } })
    if (state.mode === "defer") return new Promise(resolve => pending.push({ resolve: () => resolve(result()), signal: init.signal }))
    return result()
  }
  const mocks = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "server-only": {},
    "@supabase/supabase-js": { createClient: (url, key, options = {}) => {
      assert.equal(url, "https://synthetic.invalid"); assert.equal(key, "synthetic-no-remote-key")
      return createClient(url, key, { ...options, auth: { persistSession: false, autoRefreshToken: false }, global: { ...options.global, fetch: transport } })
    } },
    "@/lib/emailNotice": { getEmailNoticeConfigStatus: () => ({ missing: [], from: "synthetic@example.invalid", host: "synthetic.invalid" }) },
    "@/lib/spcAuth": { requireSpcPagePermission: async (page, access) => {
      authChecks.push([page, access]); assert.ok(["spc-tech-stack", "spc-system-health"].includes(page)); assert.equal(access, "view")
      if (state.permission === "signed-out") throw new Error("Unauthorized")
      if (state.permission === "none") throw new Error("Forbidden")
      return { userId: "synthetic-actor", username: "synthetic@example.invalid" }
    } },
  }
  function load(name, parent = root) {
    if (Object.hasOwn(mocks, name)) return mocks[name]
    if (!name.startsWith("@/") && !name.startsWith(".")) return require(name)
    const unresolved = name.startsWith("@/") ? join(root, name.slice(2)) : resolve(parent, name)
    const file = ["", ".ts", ".json", ".js"].map(ext => unresolved + ext).find(existsSync)
    assert.ok(file, "Unresolved " + name)
    if (file.endsWith(".json")) return JSON.parse(readFileSync(file, "utf8"))
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const code = transformSync(readFileSync(file, "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
    new Function("require", "module", "exports", "process", "Date", "setTimeout", "clearTimeout", "console", code)(
      child => load(child, dirname(file)), module, module.exports,
      { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-no-remote-key", ...environment } }, FixtureDate,
      (callback, ms) => { const id = ++nextTimer; timers.set(id, { callback, ms }); return id }, id => timers.delete(id),
      { log: value => logs.push(value), error: value => logs.push(String(value)) },
    )
    return module.exports
  }
  return { state, authChecks, requests, pending, timers, logs, load,
    async get(kind = "system-health", refresh = false) {
      const route = load(`@/app/api/spc/${kind}/route`)
      const response = await route.GET(new Request(`https://synthetic.invalid/api/spc/${kind}${refresh ? "?refresh=1" : ""}`))
      return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.json() }
    },
    expireDeadline() { assert.equal(timers.size, 1); const [id, timer] = [...timers][0]; timers.delete(id); timer.callback() },
  }
}
