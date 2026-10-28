import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import vm from "node:vm"
import ts from "typescript"
import { fcunoConnectionPolicy as pins } from "../config/fcunoConnections.ts"
import { createPostgresProbeHandler, POSTGRES_PROBE_BODY, POSTGRES_PROBE_URL, validatePostgresProbeResult,
  postgresProbeFailure, postgresProbeFailureResult } from "../lib/postgresBackupProbeCapability.mjs"
import { main } from "../scripts/probe-postgres-backup.mjs"

const time = Date.parse("2026-10-28T07:00:00.000Z"), now = () => time
const subject = "114676403773833639351"
const environment = { POSTGRES_BACKUP_PROBE_ENABLED: "1", POSTGRES_BACKUP_SOURCE_ENABLED: "0", VERCEL: "1", VERCEL_ENV: "production",
  VERCEL_PROJECT_ID: pins.vercel.projectId, POSTGRES_BACKUP_GOOGLE_SUBJECT: subject }
const job = { CLOUD_RUN_JOB: pins.storageMediaBackup.googleJob, GOOGLE_CLOUD_PROJECT: pins.storageMediaBackup.googleProjectId, GCS_BACKUP_BUCKET: pins.storageMediaBackup.targetBucket }
const claims = () => ({ iss: pins.storageMediaBackup.googleTokenIssuer, aud: POSTGRES_PROBE_URL, sub: subject,
  email: pins.storageMediaBackup.googleServiceAccount, email_verified: true, iat: time / 1000, exp: time / 1000 + 3600 })
const proof = () => ({ status: "verified", scope: "native-runtime-and-read-only-metadata", databaseVersion: "17.6",
  checkedAt: new Date(time).toISOString(), databaseLastStart: "2026-10-27T19:40:07.000Z", clientTls: "verify-full", backendTls: true,
  restrictedSourceRole: true, intrinsicCannotWrite: false, exportPerformed: false, recoveryVerified: false })
function request({ url = POSTGRES_PROBE_URL, method = "POST", body = POSTGRES_PROBE_BODY, headers = {} } = {}) {
  return new Request(url, { method, headers: { authorization: "Bearer aaa.bbb.ccc", "content-type": "application/json", ...headers },
    ...(!["GET", "HEAD"].includes(method) ? { body } : {}) })
}
function fixture({ runtime = environment, claim = claims, probe = async () => proof() } = {}) {
  const calls = { verify: 0, probe: 0 }
  const handler = createPostgresProbeHandler({ runtime, now, verifyToken: async (token, audience) => {
    calls.verify++; assert.equal(token, "aaa.bbb.ccc"); assert.equal(audience, POSTGRES_PROBE_URL); return claim()
  }, probe: async () => { calls.probe++; return probe() } })
  return { handler, calls }
}
function privateResponse(response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0")
  for (const key of ["cdn-cache-control", "vercel-cdn-cache-control"]) assert.equal(response.headers.get(key), "no-store")
  assert.equal(response.headers.get("x-content-type-options"), "nosniff")
}

test("Google metadata probe works outside export window while exports remain disabled", async () => {
  const { handler, calls } = fixture(), response = await handler(request())
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), proof()); privateResponse(response)
  assert.deepEqual(calls, { verify: 1, probe: 1 })
})
for (const change of [{ POSTGRES_BACKUP_PROBE_ENABLED: "0" }, { POSTGRES_BACKUP_PROBE_ENABLED: undefined, POSTGRES_BACKUP_SOURCE_ENABLED: "1" },
  { VERCEL_ENV: "preview" }, { VERCEL: "0" }, { VERCEL_PROJECT_ID: "other" }]) test(`Google probe gate rejects ${JSON.stringify(change)}`, async () => {
  const { handler, calls } = fixture({ runtime: { ...environment, ...change } })
  const response = await handler(request()); assert.equal(response.status, 404); privateResponse(response)
  assert.deepEqual(calls, { verify: 0, probe: 0 })
})
for (const [label, change] of [
  ["query", { url: `${POSTGRES_PROBE_URL}?sql=SELECT%201` }], ["fragment", { url: `${POSTGRES_PROBE_URL}#unused` }],
  ["SPC host", { url: POSTGRES_PROBE_URL.replace("fcuno.com", "spc.fcuno.com") }],
  ["preview host", { url: POSTGRES_PROBE_URL.replace("fcuno.com", "preview.vercel.app") }],
  ["export path", { url: POSTGRES_PROBE_URL.replace("-probe", "") }], ["GET", { method: "GET" }],
  ["DELETE", { method: "DELETE" }], ["wrong content type", { headers: { "content-type": "text/plain" } }],
  ["encoding", { headers: { "content-encoding": "gzip" } }], ["range", { headers: { range: "bytes=0-1" } }],
  ["media flag", { headers: { "x-fcuno-storage-mode": "recurring" } }],
]) test(`Google probe rejects ${label} before native or authentication IO`, async () => {
  const { handler, calls } = fixture(), response = await handler(request(change))
  assert.equal(response.status, 400); privateResponse(response); assert.deepEqual(calls, { verify: 0, probe: 0 })
})
for (const [label, value] of [
  ["issuer", { iss: "other" }], ["audience", { aud: POSTGRES_PROBE_URL.replace("-probe", "") }],
  ["subject", { sub: "111111111111111111111" }], ["email", { email: "other@example.invalid" }],
  ["email proof", { email_verified: false }], ["expired", { exp: time / 1000 }],
  ["future", { iat: time / 1000 + 31 }], ["old", { iat: time / 1000 - 3631 }],
  ["long-lived", { exp: time / 1000 + 4000 }], ["noninteger", { iat: "1793170800" }],
]) test(`Google probe rejects token ${label}`, async () => {
  const { handler, calls } = fixture({ claim: () => ({ ...claims(), ...value }) })
  const response = await handler(request()); assert.equal(response.status, 401); assert.equal(calls.probe, 0); privateResponse(response)
})
test("missing signature/token and provider verification failure never start native work", async () => {
  for (const authorization of ["", "Bearer opaque", "Basic aaa", "Bearer a.b.c.extra"]) {
    const { handler, calls } = fixture(); assert.equal((await handler(request({ headers: { authorization } }))).status, 401)
    assert.deepEqual(calls, { verify: 0, probe: 0 })
  }
  const { handler, calls } = fixture({ claim: () => { throw Error("synthetic signing failure must remain private") } })
  const response = await handler(request()); assert.equal(response.status, 503); assert.equal(await response.text(), ""); assert.equal(calls.probe, 0)
})
for (const body of ["", "{}", '{"operation":"weekly-full-v1"}', '{"operation":"verify-native-v1","sql":"SELECT 1"}',
  '{"operation":"verify-native-v1","operation":"verify-native-v1"}', `${POSTGRES_PROBE_BODY}\n`, "x".repeat(65)]) test(`Google probe rejects nonliteral operation ${body.slice(0,60)}`, async () => {
  const { handler, calls } = fixture(), response = await handler(request({ body }))
  assert.equal(response.status, 400); assert.equal(calls.probe, 0); privateResponse(response)
})
test("probe shares only in-flight work and authorizes concurrent callers separately", async () => {
  let resolve, entered, permitted = true
  const ready = new Promise(done => { entered = done }), pending = new Promise(done => { resolve = done })
  const { handler, calls } = fixture({ claim: () => permitted ? claims() : {}, probe: () => { entered(); return pending } })
  const first = handler(request()), second = handler(request()); await ready
  assert.equal(calls.probe, 1); permitted = false; assert.equal((await handler(request())).status, 401)
  resolve(proof()); for (const result of await Promise.all([first, second])) assert.equal(result.status, 200)
  permitted = true; assert.equal((await handler(request())).status, 200)
  assert.deepEqual(calls, { verify: 4, probe: 2 })
})
test("unsafe native output is rejected and never disclosed as success", async () => {
  for (const change of [{ status: "unknown" }, { PGPASSWORD: "synthetic" }, { intrinsicCannotWrite: true }, { exportPerformed: true },
    { recoveryVerified: true }, { clientTls: "require" }, { backendTls: false }, { checkedAt: "2026-01-01" }]) {
    const value = { ...proof(), ...change }; assert.throws(() => validatePostgresProbeResult(value, time))
    const { handler } = fixture({ probe: async () => value }), response = await handler(request())
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { ...postgresProbeFailureResult(null), diagnostic: { stage: "result", code: "RESULT_INVALID" } })
  }
})
test("only the authenticated literal operation may receive finite probe diagnostics", async () => {
  const error = postgresProbeFailure("connection", "COMMAND_FAILED")
  error.message = "private password SQL provider host"
  error.stderr = "more private server content"
  const { handler, calls } = fixture({ probe: async () => { throw error } })
  const result = await handler(request())
  assert.equal(result.status, 503); privateResponse(result)
  assert.deepEqual(await result.json(), { ...postgresProbeFailureResult(null), diagnostic: { stage: "connection", code: "COMMAND_FAILED" } })
  for (const bad of [request({ headers: { authorization: "" } }), request({ body: "{}" })]) {
    const response = await handler(bad); assert.ok([400, 401].includes(response.status)); assert.equal(await response.text(), "")
  }
  const providerFailure = fixture({ claim: () => { throw error } })
  const response = await providerFailure.handler(request())
  assert.equal(response.status, 503); assert.equal(await response.text(), ""); assert.equal(providerFailure.calls.probe, 0)
  assert.equal(calls.probe, 1)
})
test("arbitrary thrown values cannot forge a diagnostic or expose message, stack, cause or stderr", async () => {
  for (const error of [Object.assign(Error("synthetic private secret"), { stage: "connection", code: "COMMAND_FAILED", stderr: "private", cause: "private" }),
    { diagnostic: { stage: "bundle", code: "BUNDLE_UNVERIFIED" } }, "synthetic secret", null]) {
    const { handler } = fixture({ probe: async () => { throw error } }), response = await handler(request())
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), postgresProbeFailureResult(null))
  }
  for (const [stage, code] of [["connection", "password=private"], ["private", "COMMAND_FAILED"], [["connection"], "COMMAND_FAILED"], ["__proto__", "COMMAND_FAILED"]]) {
    assert.throws(() => postgresProbeFailure(stage, code))
  }
})

const routeSource = await readFile(new URL("../app/api/backups/postgres-probe/route.ts", import.meta.url), "utf8")
test("actual route only wires reviewed signature verifier, fixed native probe and pinned bundle", async () => {
  const code = ts.transpileModule(routeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}, verifyBundle = () => {}, verifyToken = () => {}, calls = []
  const dependencies = { "server-only": {}, "@/lib/postgresBackupProbeCapability.mjs": { createPostgresProbeHandler: options => {
    assert.equal(options.runtime, environment); assert.equal(options.verifyToken, verifyToken)
    return async () => options.probe()
  } }, "@/lib/postgresBackupProbe.mjs": { probePostgresBackupRuntime: options => { calls.push(options); return proof() } },
  "@/lib/storageMediaBackupSource": { verifyStorageBackupGoogleIdentity: verifyToken },
  "@/scripts/lib/postgres-runtime-bundle.mjs": { verifyPostgresRuntimeBundle: verifyBundle } }
  vm.runInNewContext(code, { exports, process: { env: environment }, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected module ${name}`); return dependencies[name]
  } })
  for (const name of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) assert.equal(exports[name], exports.POST)
  assert.equal(exports.maxDuration, 30); assert.deepEqual(await exports.POST(request()), proof())
  assert.equal(calls.length, 1); assert.equal(calls[0].runtime, environment); assert.equal(calls[0].verifyBundle, verifyBundle)
})
function metadataToken() { return `aaa.${Buffer.from(JSON.stringify(claims())).toString("base64url")}.ccc` }
test("Cloud Run metadata-only client pins exact audience, sends literal body and prints only safe proof", async () => {
  const urls = [], response = await main({ args: ["--verify-native-only"], runtime: job, now, fetch: async (url, init) => {
    urls.push(url); assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store")
    if (url.startsWith("http://metadata.google.internal/")) {
      assert.equal(new URL(url).searchParams.get("audience"), POSTGRES_PROBE_URL); assert.equal(init.headers["Metadata-Flavor"], "Google")
      return new Response(metadataToken(), { headers: { "Metadata-Flavor": "Google" } })
    }
    assert.equal(url, POSTGRES_PROBE_URL); assert.equal(init.method, "POST"); assert.equal(init.body, POSTGRES_PROBE_BODY)
    assert.equal(init.headers.Authorization, `Bearer ${metadataToken()}`)
    return Response.json(proof(), { headers: { "Cache-Control": "private, no-store" } })
  } })
  assert.deepEqual(response, proof()); assert.equal(urls.length, 2)
})
test("metadata-only client denies local runs, arbitrary commands and source credentials before IO", async () => {
  for (const [args, runtime] of [[[], job], [["--verify-native-only", "extra"], job], [["--execute-recurring-weekly"], job],
    [["--verify-native-only"], {}], ...["PGPASSWORD", "DATABASE_URL", "SUPABASE_ACCESS_TOKEN", "POSTGRES_BACKUP_SOURCE_CREDENTIAL_JSON", "POSTGRES_BACKUP_SIGNING_KEY_PEM"].map(key => [["--verify-native-only"], { ...job, [key]: "private" }])]) {
    let calls = 0; await assert.rejects(main({ args, runtime, now, fetch: async () => { calls++; throw Error("unexpected") } })); assert.equal(calls, 0)
  }
})
test("metadata-only client rejects encoded, oversized or misleading native proof", async () => {
  for (const make of [() => new Response("x", { status: 503 }), () => Response.json(proof(), { headers: { "Content-Encoding": "gzip", "Cache-Control": "private, no-store" } }),
    () => Response.json({ ...proof(), exportPerformed: true }, { headers: { "Cache-Control": "private, no-store" } }),
    () => new Response("x".repeat(4097), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } })]) {
    await assert.rejects(main({ args: ["--verify-native-only"], runtime: job, now, fetch: async url => url.startsWith("http://metadata.google.internal/")
      ? new Response(metadataToken(), { headers: { "Metadata-Flavor": "Google" } }) : make() }))
  }
})
