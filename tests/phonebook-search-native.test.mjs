import assert from "node:assert/strict"
import test from "node:test"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { transformSync } from "esbuild"
import { createClient } from "@supabase/supabase-js"
import { setupNativeCcinfo, literal } from "./fixtures/native-postgres-ccinfo.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const sha = value => createHash("sha256").update(value).digest("hex")
const companies = [
  { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "ACME (HK), LTD", other_name: 'ANCHOR A*B _ [a-z]+ (?i).* C:\\HK "QUOTED" a:b ***=X 港口' },
  { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "OTHER LTD", other_name: "BETA PARTNER" },
  { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "100% MARINE", other_name: "PERCENT PARTNER" },
  { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "ACME,HK LTD", other_name: "COMMA PARTNER" },
]
const contacts = [
  { id: "11111111-1111-4111-8111-111111111111", full_name: "CAPTAIN ONE", company: companies[0].name },
  { id: "22222222-2222-4222-8222-222222222222", full_name: "CAPTAIN TWO", company: companies[1].name },
  { id: "33333333-3333-4333-8333-333333333333", full_name: "CAPTAIN THREE", company: companies[2].name },
  { id: "44444444-4444-4444-8444-444444444444", full_name: "CAPTAIN FOUR", company: companies[3].name },
].map(row => ({ ...row, search_text: `${row.full_name} ${row.company}`.toLowerCase(), favorite: false }))

function fixtureSql() {
  return `create role service_role nologin nobypassrls;
    grant usage on schema public to service_role;
    create table public.phonebook_contacts (id uuid primary key, full_name text not null, company text, search_text text, favorite boolean not null default false);
    create table public.phonebook_companies (id uuid primary key, name text not null, other_name text);
    alter table public.phonebook_contacts enable row level security;
    alter table public.phonebook_companies enable row level security;
    create policy local_read on public.phonebook_contacts for select to service_role using (true);
    create policy local_read on public.phonebook_companies for select to service_role using (true);
    grant select on public.phonebook_contacts, public.phonebook_companies to service_role;
    insert into public.phonebook_contacts values ${contacts.map(row => `(${literal(row.id)},${literal(row.full_name)},${literal(row.company)},${literal(row.search_text)},false)`).join(",")};
    insert into public.phonebook_companies values ${companies.map(row => `(${literal(row.id)},${literal(row.name)},${literal(row.other_name)})`).join(",")};`
}

// Preserve the cached contact/name+alias all-token rule within the route's
// existing fields. Company-phone lookup is still absent here, and the existing
// six-token ceiling remains; neither limitation is changed by this repair.
function expectedIds(query) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)
  if (!tokens.length) return []
  const matchingCompanies = new Set(companies.filter(row => {
    const text = `${row.name} ${row.other_name || ""}`.toLowerCase()
    return tokens.every(token => text.includes(token))
  }).map(row => row.name))
  return contacts.filter(row => tokens.every(token => row.search_text.includes(token)) || matchingCompanies.has(row.company))
    .sort((a, b) => a.full_name.localeCompare(b.full_name)).map(row => row.id)
}

function loadTypeScript(source, modules, environment = {}) {
  const mod = { exports: {} }
  const code = transformSync(source, { loader: "ts", format: "cjs", target: "node24" }).code
  new Function("require", "module", "exports", "process", code)(name => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected route dependency: ${name}`)
    return modules[name]
  }, mod, mod.exports, { env: environment })
  return mod.exports
}

test("actual Phonebook GET and SDK preserve literal all-token search through native PostgREST", { timeout: 90000 }, async t => {
  const runtime = process.env.POSTGREST_BIN
  assert.ok(runtime && isAbsolute(runtime), "POSTGREST_BIN must identify the owned PostgREST 16.4 fixture executable")
  const runtimeSha256 = sha(readFileSync(runtime))
  assert.equal(runtimeSha256, "325628d6bc975251c2952c1275e969b8dc57f88db32dfb82c4c6597cebcd260b")
  const source = readFileSync(join(root, "app/api/phonebook/contacts/route.ts"), "utf8")
  const escapingSource = readFileSync(join(root, "lib/queryEscaping.ts"), "utf8")
  const captures = [], permissions = [], results = [], failures = []
  let cluster, child, done, closed = false
  try {
    cluster = await setupNativeCcinfo(fixtureSql())
    const socket = createServer()
    await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve) })
    const port = socket.address().port
    await new Promise(resolve => socket.close(resolve))
    const origin = `http://127.0.0.1:${port}`
    const uri = new URL("postgresql:///postgres")
    uri.searchParams.set("host", cluster.socket)
    uri.searchParams.set("port", "55489")
    uri.searchParams.set("user", "fcuno_ccinfo_fixture_owner")
    child = spawn(runtime, [], { env: { ...cluster.environment,
      DYLD_LIBRARY_PATH: join(dirname(cluster.bin), "lib"),
      PGRST_DB_URI: uri.toString(), PGRST_DB_SCHEMAS: "public", PGRST_DB_ANON_ROLE: "service_role",
      PGRST_SERVER_HOST: "127.0.0.1", PGRST_SERVER_PORT: String(port),
      PGRST_DB_MAX_ROWS: "1000", PGRST_DB_CHANNEL_ENABLED: "false", PGRST_LOG_LEVEL: "warn",
    }, stdio: ["ignore", "ignore", "pipe"] })
    let log = ""
    child.stderr.on("data", data => { log = (log + data).slice(-8000) })
    done = new Promise(resolve => {
      child.once("error", error => { closed = true; resolve({ error: error.message }) })
      child.once("close", (code, signal) => { closed = true; resolve({ code, signal }) })
    })
    const deadline = Date.now() + 10000
    for (;;) {
      if (closed) throw new Error("Owned PostgREST startup failed: " + log)
      try {
        const response = await fetch(origin + "/phonebook_companies?select=id&limit=0", { signal: AbortSignal.timeout(300) })
        await response.arrayBuffer()
        if (response.ok) break
      } catch {}
      assert.ok(Date.now() < deadline, "Owned PostgREST startup deadline")
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const modules = {
      "next/server": { NextResponse: { json: Response.json.bind(Response) } },
      "@/lib/adminAuth": { requireAdminPagePermission: async (page, access) => {
        permissions.push([page, access])
        assert.deepEqual([page, access], ["phonebook", "view"])
      } },
      "@/lib/queryEscaping": loadTypeScript(escapingSource, {}),
      "@supabase/supabase-js": { createClient: (url, key) => {
        assert.equal(url, origin)
        assert.equal(key, "synthetic-local-only")
        return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: {
          fetch: async (input, init) => {
            const target = new URL(input instanceof Request ? input.url : String(input))
            assert.equal(target.origin, origin)
            assert.ok(target.pathname.startsWith("/rest/v1/"))
            assert.equal((init?.method || "GET").toUpperCase(), "GET")
            target.pathname = target.pathname.slice("/rest/v1".length)
            assert.ok(["/phonebook_contacts", "/phonebook_companies"].includes(target.pathname))
            const headers = new Headers(init?.headers)
            headers.delete("authorization")
            headers.delete("apikey")
            const response = await fetch(target, { ...init, headers, redirect: "error" })
            captures.push({ path: target.pathname, query: target.search, status: response.status })
            return response
          },
        } })
      } },
    }
    const route = loadTypeScript(source, modules, { NEXT_PUBLIC_SUPABASE_URL: origin, SUPABASE_SERVICE_ROLE_KEY: "synthetic-local-only" })
    const queries = ["CAPTAIN ONE", "  CaPtAiN \t ONE  ", "ONE CAPTAIN", "ACME (HK),", "(HK)", "ACME,HK", ",", "%", "_", "ACME", "ACME MISSING", "ACME ANCHOR", "OTHER BETA", "A*B", "[a-z]+", "(?i).*", "***=X", '"QUOTED"', "C:\\HK", "a:b", "港口", "CAPTAIN ONE ONE ONE ONE ONE MISSING", ""]
    for (const query of queries) {
      const start = captures.length
      const response = await route.GET(new Request("https://synthetic.invalid/api/phonebook/contacts?" + new URLSearchParams({ query })))
      const payload = await response.json()
      const actual = { status: response.status, ids: payload.contacts?.map(row => row.id), limited: payload.limited }
      const expected = { status: 200, ids: expectedIds(query), limited: query.trim() ? false : undefined }
      results.push({ query, actual, expected, captures: captures.slice(start) })
      if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push({ query, actual, expected })
    }
    for (const [params, expected] of [
      [{ all: "1" }, contacts],
      [{ all: "1", query: "MISSING" }, contacts],
      [{ company: companies[0].name, query: "MISSING" }, [contacts[0]]],
    ]) {
      const response = await route.GET(new Request("https://synthetic.invalid/api/phonebook/contacts?" + new URLSearchParams(params)))
      const payload = await response.json()
      assert.equal(response.status, 200)
      assert.deepEqual(payload.contacts.map(row => row.id).sort(), expected.map(row => row.id).sort())
    }
    assert.equal(permissions.length, queries.length + 3)
    t.diagnostic(JSON.stringify({ sourceSha256: sha(source), queryEscapingSha256: sha(escapingSource), testSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
      method: "Actual GET route and Supabase SDK; owned native PostgreSQL 17.6/PostgREST 16.4; synthetic View authorization and four contacts/companies only.",
      postgresSha256: cluster.runtimeSha256, postgrestSha256: runtimeSha256, permissions, results, failures, productionDataTouched: false,
    }))
    assert.deepEqual(failures, [], "Phonebook search must match literal all-token semantics within its existing fields and token ceiling")
    assert.ok(captures.every(row => row.status === 200), "Every literal filter must parse successfully")
    assert.ok(captures.filter(row => row.path === "/phonebook_companies").every(row => new URLSearchParams(row.query).get("limit") === "120"))
    assert.ok(captures.filter(row => row.path === "/phonebook_contacts" && !new URLSearchParams(row.query).has("offset")).every(row => new URLSearchParams(row.query).get("limit") === "400"))
  } finally {
    if (child && !closed) {
      child.kill("SIGTERM")
      const timer = setTimeout(() => { if (!closed) child.kill("SIGKILL") }, 3000)
      try { await done } finally { clearTimeout(timer) }
    }
    if (cluster) {
      await cluster.close()
      assert.ok(cluster.sessions.every(session => session.closed))
      assert.equal(existsSync(join(cluster.data, "postmaster.pid")), false)
    }
    assert.ok(!child || closed)
    t.diagnostic("All owned native sessions and PostgREST closed; native server stopped. No hosted data or browser activity.")
  }
})
