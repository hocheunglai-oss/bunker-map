import test from "node:test"
import assert from "node:assert/strict"
import { readFile, mkdtemp, mkdir, writeFile, rm, stat, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import vm from "node:vm"
import ts from "typescript"
import { validatePostgresProbe, POSTGRES_PROBE_SQL, probePostgresBackupRuntime } from "../lib/postgresBackupProbe.mjs"
import { fcunoConnectionPolicy as pins } from "../config/fcunoConnections.ts"
import { isAdminRole } from "../lib/adminPages.ts"
const time = Date.parse("2026-10-28T05:00:00.000Z")
const fixture = () => ({ database: "postgres", role: pins.postgresBackup.databaseLogin, sessionRole: pins.postgresBackup.databaseLogin,
  version: "17.6", readOnly: true, backendTls: true, checkedAt: new Date(time).toISOString(), lastStart: "2026-10-27T19:40:07.000Z",
  reader: { rolname: pins.postgresBackup.databaseLogin, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: true, rolcanlogin: true,
    rolinherit: true, rolconnlimit: 2, rolvaliduntil: "2026-11-28T00:00:00Z" },
  memberships: [{ role: "pg_read_all_data", admin: false, inherit: true, set: false }] })
test("native smoke reports only compatibility, never an export or intrinsic non-writable role", () => {
  const result = validatePostgresProbe(fixture(), time)
  assert.equal(result.status, "verified")
  for (const key of ["intrinsicCannotWrite", "exportPerformed", "recoveryVerified"]) assert.equal(result[key], false)
  assert.equal(result.reader, undefined); assert.equal(result.memberships, undefined)
})
for (const [label, mutate] of [
  ["wrong database", x => x.database = "other"], ["wrong role", x => x.role = "postgres"],
  ["wrong login", x => x.sessionRole = "postgres"], ["writable transaction", x => x.readOnly = false],
  ["unencrypted backend", x => x.backendTls = false], ["unsupported engine", x => x.version = "18.1"],
  ["malformed engine", x => x.version = "17.6-not-a-version"], ["other catalog role", x => x.reader.rolname = "postgres"],
  ["future start", x => x.lastStart = "2026-10-29T00:00:00Z"],
  ["stale observation", x => x.checkedAt = "2026-10-27T00:00:00Z"], ["invalid start", x => x.lastStart = "bad"],
  ["superuser", x => x.reader.rolsuper = true], ["role creation", x => x.reader.rolcreaterole = true],
  ["database creation", x => x.reader.rolcreatedb = true], ["replication", x => x.reader.rolreplication = true],
  ["incomplete RLS visibility", x => x.reader.rolbypassrls = false], ["unbounded connections", x => x.reader.rolconnlimit = -1],
  ["expired role", x => x.reader.rolvaliduntil = "2026-10-27T00:00:00Z"], ["excess lifetime", x => x.reader.rolvaliduntil = "2027-10-27T00:00:00Z"],
  ["extra membership", x => x.memberships.push({ role: "pg_monitor" })], ["SET authority", x => x.memberships[0].set = true],
  ["ADMIN authority", x => x.memberships[0].admin = true], ["wrong membership", x => x.memberships[0].role = "supabase_admin"],
]) test(`native smoke rejects ${label}`, () => { const value = fixture(); mutate(value); assert.throws(() => validatePostgresProbe(value, time)) })
test("probe cannot read credentials or binaries unless explicitly enabled on pinned production", async () => {
  for (const runtime of [{}, { POSTGRES_BACKUP_PROBE_ENABLED: "1" }, { POSTGRES_BACKUP_PROBE_ENABLED: "1", VERCEL: "1", VERCEL_ENV: "preview", VERCEL_PROJECT_ID: pins.vercel.projectId },
    { POSTGRES_BACKUP_PROBE_ENABLED: "1", VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_ID: "wrong" }]) {
    let calls = 0
    await assert.rejects(probePostgresBackupRuntime({ runtime, verifyBundle: () => { calls++; throw Error("not expected") } }))
    assert.equal(calls, 0)
  }
})
test("fixed SQL only reads metadata inside a read-only transaction", () => {
  assert.match(POSTGRES_PROBE_SQL, /^BEGIN READ ONLY;/)
  assert.match(POSTGRES_PROBE_SQL, /ROLLBACK;$/)
  assert.doesNotMatch(POSTGRES_PROBE_SQL, /pg_export_snapshot|COPY |pg_dump|CREATE |ALTER |INSERT |UPDATE |DELETE /)
  assert.match(POSTGRES_PROBE_SQL, /to_jsonb\(r\)-'rolpassword'/)
})
test("metadata validation rejects an invalid local clock instead of accepting stale data", () => {
  for (const now of [NaN, Infinity, undefined, String(time)]) assert.throws(() => validatePostgresProbe(fixture(), now))
})

const routeSource = await readFile(new URL("../app/api/admin/system-health/postgres-backup/route.ts", import.meta.url), "utf8")
const routeCode = ts.transpileModule(routeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const probeUrl = "https://fcuno.com/api/admin/system-health/postgres-backup"
function loadRoute({ auth = async () => ({ role: "ADMIN" }), environment = { POSTGRES_BACKUP_PROBE_ENABLED: "1", POSTGRES_BACKUP_SOURCE_ENABLED: "0" }, probe = async () => validatePostgresProbe(fixture(), time) } = {}) {
  const exports = {}, calls = { auth: 0, probe: 0 }
  const verifier = () => { throw Error("A mocked probe must not touch the real filesystem") }
  const dependencies = {
    "next/server": { NextResponse: Response },
    "@/lib/adminAuth": { requireAdminPagePermission: async (...args) => {
      calls.auth++; assert.deepEqual(args, ["system-health", "edit"]); return auth()
    } },
    "@/lib/adminPages": { isAdminRole },
    "@/config/fcunoConnections": { fcunoConnectionPolicy: pins },
    "@/scripts/lib/postgres-runtime-bundle.mjs": { verifyPostgresRuntimeBundle: verifier },
    "@/lib/postgresBackupProbe.mjs": { probePostgresBackupRuntime: options => {
      calls.probe++; assert.equal(options.runtime, environment); assert.equal(options.verifyBundle, verifier); return probe()
    } },
  }
  vm.runInNewContext(routeCode, { exports, URL, process: { env: environment }, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`); return dependencies[name]
  } })
  assert.equal(exports.POST, undefined)
  return { GET: exports.GET, calls }
}
function noCache(response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0")
  assert.equal(response.headers.get("cdn-cache-control"), "no-store")
  assert.equal(response.headers.get("vercel-cdn-cache-control"), "no-store")
  assert.equal(response.headers.get("x-content-type-options"), "nosniff")
}
for (const [label, auth] of [
  ["signed out", async () => { throw Error("Unauthenticated") }],
  ["view-only", async () => { throw Error("Page edit denied") }],
  ["non-admin editor", async () => ({ role: "BT" })],
  ["missing session", async () => null],
]) test(`actual GET handler rejects ${label} before any native check`, async () => {
  const route = loadRoute({ auth }), response = await route.GET(new Request(probeUrl))
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), { message: "Forbidden" })
  assert.equal(route.calls.auth, 1); assert.equal(route.calls.probe, 0); noCache(response)
})
for (const [label, url] of [
  ["query", `${probeUrl}?sql=SELECT%201`], ["other origin", probeUrl.replace("fcuno.com", "spc.fcuno.com")],
  ["preview", probeUrl.replace("fcuno.com", "preview.vercel.app")], ["wrong path", "https://fcuno.com/api/backups/postgres"],
  ["fragment", `${probeUrl}#ignored`], ["credentials in URL", probeUrl.replace("https://", "https://user:password@")],
  ["invalid URL", "not a URL"],
]) test(`actual GET handler rejects ${label} without starting a native process`, async () => {
  const route = loadRoute(), response = await route.GET({ method: "GET", url })
  assert.equal(response.status, 400); assert.equal(route.calls.probe, 0); noCache(response)
})
test("actual handler only accepts GET and cannot enable itself through the export flag", async () => {
  const route = loadRoute({ environment: { POSTGRES_BACKUP_SOURCE_ENABLED: "1" } })
  const post = await route.GET(new Request(probeUrl, { method: "POST" }))
  assert.equal(post.status, 405); assert.equal(post.headers.get("allow"), "GET"); noCache(post)
  const disabled = await route.GET(new Request(probeUrl))
  assert.equal(disabled.status, 404); assert.equal(route.calls.probe, 0); noCache(disabled)
})
test("actual GET handler permits a separate probe while exports remain disabled", async () => {
  const route = loadRoute(), response = await route.GET(new Request(probeUrl))
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), validatePostgresProbe(fixture(), time))
  assert.equal(route.calls.probe, 1); noCache(response)
})
test("concurrent checks share only in-flight work and authorize each caller independently", async () => {
  let resolve, started, allowed = true
  const pending = new Promise(done => { resolve = done })
  const ready = new Promise(done => { started = done })
  const route = loadRoute({ auth: async () => { if (!allowed) throw Error("Forbidden"); return { role: "ADMIN" } }, probe: () => { started(); return pending } })
  const first = route.GET(new Request(probeUrl)), second = route.GET(new Request(probeUrl))
  await ready
  assert.equal(route.calls.probe, 1)
  allowed = false
  assert.equal((await route.GET(new Request(probeUrl))).status, 403)
  resolve(validatePostgresProbe(fixture(), time))
  for (const response of await Promise.all([first, second])) { assert.equal(response.status, 200); noCache(response) }
  allowed = true
  assert.equal((await route.GET(new Request(probeUrl))).status, 200)
  assert.equal(route.calls.probe, 2, "A settled result must not become a stale success cache")
  assert.equal(route.calls.auth, 4)
})
test("concurrent native failures are redacted and clear the in-flight promise for a new check", async () => {
  let reject
  const pending = new Promise((_, fail) => { reject = fail })
  const secret = "synthetic-password-and-provider-error-never-return"
  const route = loadRoute({ probe: () => pending })
  const first = route.GET(new Request(probeUrl)), second = route.GET(new Request(probeUrl))
  await Promise.resolve(); await Promise.resolve(); reject(Error(secret))
  for (const response of await Promise.all([first, second])) {
    assert.equal(response.status, 503); noCache(response)
    const text = await response.text(); assert.ok(!text.includes(secret))
    assert.deepEqual(JSON.parse(text), { status: "unknown", scope: "native-runtime-and-read-only-metadata", exportPerformed: false, recoveryVerified: false })
  }
  assert.equal(route.calls.probe, 1)
  assert.equal((await route.GET(new Request(probeUrl))).status, 503)
  assert.equal(route.calls.probe, 2)
})

const syntheticPassword = "synthetic_fixture_only_not_a_real_password_000000"
async function nativeFixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fcuno-probe-test-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ca = Buffer.from("Synthetic pinned certificate bytes; no external connection is made")
  await mkdir(join(root, ".runtime/postgres-source"), { recursive: true })
  await writeFile(join(root, ".runtime/postgres-source/root.crt"), ca)
  const bundle = { binaries: Object.fromEntries([["psql", "psql"], ["pgDump", "pg_dump"], ["pgRestore", "pg_restore"]].map(([name, file]) => [name, { path: join(root, ".runtime/postgres/bin", file) }])) }
  const runtime = { POSTGRES_BACKUP_PROBE_ENABLED: "1", POSTGRES_BACKUP_SOURCE_ENABLED: "0", VERCEL: "1", VERCEL_ENV: "production",
    VERCEL_PROJECT_ID: pins.vercel.projectId, POSTGRES_BACKUP_BUNDLE_SHA256: "a".repeat(64),
    POSTGRES_BACKUP_CA_SHA256: createHash("sha256").update(ca).digest("hex"),
    POSTGRES_BACKUP_SOURCE_CREDENTIAL_JSON: JSON.stringify({ password: syntheticPassword, issuedAt: time - 1000, expiresAt: time + 86400000 }), ...overrides }
  const verified = []
  return { root, runtime, bundle, verified, now: () => time, verifyBundle: async (...args) => { verified.push(args); return bundle } }
}
function spawnFixture({ metadata = JSON.stringify(fixture()), exitCode = 0, stdinFailure = false, hang = false, neverClose = false, version = "17.11", onMetadata = () => {} } = {}) {
  const calls = []
  const spawnImpl = (executable, args, options) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
    const call = { executable, args, options, input: "", signals: [], closed: false, child }; calls.push(call)
    const isVersion = args.length === 1 && args[0] === "--version"
    const close = code => { if (call.closed) return; call.closed = true; child.stdout.end(); child.stderr.end(); child.emit("close", code, null) }
    child.kill = signal => { call.signals.push(signal); if (!neverClose || isVersion) close(null); else child.emit("error", Error("Synthetic failed signal")); return !neverClose }
    child.stdin.on("data", bytes => { call.input += bytes })
    child.stdin.on("finish", () => queueMicrotask(() => {
      if (!isVersion) onMetadata()
      if (!isVersion && hang) return
      child.stdout.write(isVersion ? `${executable.split("/").at(-1)} (PostgreSQL) ${version}\n` : metadata)
      close(isVersion ? 0 : exitCode)
    }))
    if (!isVersion && stdinFailure) child.stdin.end = () => { onMetadata(); throw Error("Synthetic stdin failure") }
    return child
  }
  return { calls, spawnImpl }
}
test("injected native execution checks three pinned versions and only the fixed read-only metadata SQL", async t => {
  const options = await nativeFixture(t), process = spawnFixture()
  const result = await probePostgresBackupRuntime({ ...options, spawnImpl: process.spawnImpl })
  assert.equal(result.status, "verified"); assert.equal(result.exportPerformed, false)
  assert.deepEqual(options.verified, [[join(options.root, ".runtime/postgres"), "a".repeat(64)]])
  assert.deepEqual(process.calls.map(x => x.executable), [options.bundle.binaries.psql.path, options.bundle.binaries.pgDump.path, options.bundle.binaries.pgRestore.path, options.bundle.binaries.psql.path])
  for (const call of process.calls.slice(0, 3)) {
    assert.deepEqual(call.args, ["--version"]); assert.equal(call.input, ""); assert.equal(call.options.env.PGPASSWORD, undefined)
  }
  const call = process.calls[3], env = call.options.env
  assert.equal(call.input, POSTGRES_PROBE_SQL + "\n"); assert.equal(call.options.shell, false)
  assert.deepEqual(call.args, ["-X", "-q", "-A", "-t", "--no-readline", "--no-password", "--set=ON_ERROR_STOP=1"])
  assert.equal(env.PGHOST, `db.${pins.supabase.projectRef}.supabase.co`); assert.equal(env.PGPORT, "5432")
  assert.equal(env.PGUSER, pins.postgresBackup.databaseLogin); assert.equal(env.PGDATABASE, pins.postgresBackup.databaseName)
  assert.equal(env.PGSSLMODE, "verify-full"); assert.equal(env.PGSSLROOTCERT, join(options.root, ".runtime/postgres-source/root.crt"))
  assert.equal(env.PGPASSWORD, syntheticPassword); assert.equal(env.PGCONNECT_TIMEOUT, "10")
  assert.equal(env.PGAPPNAME, "fcuno-read-only-compatibility-probe-v1")
  assert.match(env.PGOPTIONS, /default_transaction_read_only=on.*statement_timeout=20000.*lock_timeout=2000.*idle_in_transaction_session_timeout=25000/)
  for (const name of ["PGHOSTADDR", "PATH", "NODE_OPTIONS", "LD_LIBRARY_PATH", "LD_PRELOAD", "SUPABASE_SERVICE_ROLE_KEY"]) assert.equal(env[name], undefined)
  assert.ok(process.calls.every(x => x.closed)); assert.ok(!JSON.stringify(result).includes(syntheticPassword))
  await assert.rejects(stat(dirname(env.PGPASSFILE)), { code: "ENOENT" })
})
for (const [label, settings] of [
  ["wrong client version", { version: "17.10" }], ["nonzero exit", { exitCode: 1 }],
  ["invalid JSON", { metadata: "invalid" }], ["oversized output", { metadata: "x".repeat(65537) }],
  ["synchronous stdin failure", { stdinFailure: true }],
]) test(`native ${label} fails closed and observes child termination`, async t => {
  const options = await nativeFixture(t), process = spawnFixture(settings)
  await assert.rejects(probePostgresBackupRuntime({ ...options, spawnImpl: process.spawnImpl }))
  assert.ok(process.calls.every(x => x.closed))
  if (settings.stdinFailure) assert.deepEqual(process.calls[3].signals, ["SIGTERM"])
  const directory = process.calls[3]?.options.env.PGPASSFILE
  if (directory) await assert.rejects(stat(dirname(directory)), { code: "ENOENT" })
  if (settings.version) assert.equal(process.calls.length, 1, "Wrong runtime must never connect to PostgreSQL")
})
test("the overall native deadline terminates a metadata process rather than waiting for server timeout", async t => {
  const options = await nativeFixture(t)
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: time })
  let started
  const ready = new Promise(resolve => { started = resolve }), process = spawnFixture({ hang: true, onMetadata: started })
  const check = probePostgresBackupRuntime({ ...options, spawnImpl: process.spawnImpl })
  const rejected = assert.rejects(check, /Native compatibility unavailable/)
  await ready; t.mock.timers.tick(20001); await rejected
  assert.deepEqual(process.calls[3].signals, ["SIGTERM"]); assert.equal(process.calls[3].closed, true)
  await assert.rejects(stat(dirname(process.calls[3].options.env.PGPASSFILE)), { code: "ENOENT" })
})
test("unconfirmed child termination never reports success or removes its diagnostic directory", async t => {
  const options = await nativeFixture(t), process = spawnFixture({ stdinFailure: true, neverClose: true })
  await assert.rejects(probePostgresBackupRuntime({ ...options, spawnImpl: process.spawnImpl }), /termination unconfirmed/)
  const call = process.calls[3], directory = dirname(call.options.env.PGPASSFILE)
  assert.deepEqual(call.signals, ["SIGTERM", "SIGKILL"]); assert.equal(call.closed, false)
  assert.equal((await stat(directory)).isDirectory(), true)
  // This is a synthetic EventEmitter, not an OS process. The test owns its
  // streams and explicitly observes closure before removing its fixture.
  for (const stream of [call.child.stdin, call.child.stdout, call.child.stderr]) stream.destroy()
  call.child.emit("close", null, "SIGKILL")
  await rm(directory, { recursive: true, force: true })
})
for (const [label, overrides] of [
  ["wrong certificate", { POSTGRES_BACKUP_CA_SHA256: "b".repeat(64) }],
  ["malformed credential", { POSTGRES_BACKUP_SOURCE_CREDENTIAL_JSON: "not json" }],
  ["expired credential", { POSTGRES_BACKUP_SOURCE_CREDENTIAL_JSON: JSON.stringify({ password: syntheticPassword, issuedAt: time - 100000, expiresAt: time - 1 }) }],
  ["credential with extra authority", { POSTGRES_BACKUP_SOURCE_CREDENTIAL_JSON: JSON.stringify({ password: syntheticPassword, issuedAt: time - 1000, expiresAt: time + 86400000, host: "other.invalid" }) }],
]) test(`native probe refuses ${label} before starting a child`, async t => {
  const options = await nativeFixture(t, overrides), process = spawnFixture()
  await assert.rejects(probePostgresBackupRuntime({ ...options, spawnImpl: process.spawnImpl }))
  assert.equal(process.calls.length, 0)
})
