import test from "node:test"
import assert from "node:assert/strict"
import { generateKeyPairSync, randomUUID, createHash } from "node:crypto"
import { fcunoConnectionPolicy as pins } from "../config/fcunoConnections.ts"
import { createPostgresBackupHandler, POSTGRES_BACKUP_URL } from "../lib/postgresBackupCapability.mjs"
import { POSTGRES_BACKUP_PROTOCOL, encodePostgresExport, decodePostgresExport } from "../lib/postgresBackupProtocol.mjs"
import { receivePostgresBackup } from "../scripts/lib/postgres-backup-receiver.mjs"
import { RECOVERY_CATALOG_KEYS } from "../lib/postgresRecoveryCatalog.mjs"

const time = Date.parse("2026-10-27T18:15:00.000Z"), now = () => time
const context = () => ({ signal: AbortSignal.timeout(5000), deadline: time + 5000, now })
const keys = generateKeyPairSync("ed25519"), otherKeys = generateKeyPairSync("ed25519")
const archive = Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(300000, 17)])
function metadata() { return { schema: POSTGRES_BACKUP_PROTOCOL, projectRef: pins.supabase.projectRef,
  organizationId: pins.supabase.organizationId, runId: randomUUID(), startedAt: new Date(time).toISOString(),
  source: { database: "postgres", role: "fcuno_backup_export_login", sessionRole: "fcuno_backup_export_login", serverVersion: "17.11",
    backendTls: true, clientTls: "verify-full", readOnly: true, snapshot: "00000001-00000002-1" },
  catalog: { tables: [{ schema: "public", name: "fixture", kind: "r", readable: true }], roles: [{ rolname: "fcuno_backup_export_login",
    rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: true,
    rolcanlogin: true, rolinherit: true, rolconnlimit: 2, rolvaliduntil: "2026-11-27 00:00:00+00" }],
    memberships: [{ role: "pg_read_all_data", member: "fcuno_backup_export_login", grantor: "postgres", admin: false, inherit: true, set: false }],
    database: { name: "postgres" }, extensions: [], largeObjectCount: 0,
    recovery: Object.fromEntries(RECOVERY_CATALOG_KEYS.map(key => [key, []])) } } }
async function* pieces(bytes) { for (let n = 0; n < bytes.length; n += 16384) yield bytes.subarray(n, n + 16384) }
async function collect(stream) { const parts = []; for await (const part of stream) parts.push(part); return Buffer.concat(parts) }
function encoded(options = {}) { return encodePostgresExport({ metadata: metadata(), archive: pieces(archive), finish: async () => 0,
  privateKey: keys.privateKey, ...options }, context()) }
async function decode(bytes, publicKey = keys.publicKey, ctx = context()) { const events = []; for await (const event of decodePostgresExport(pieces(bytes), publicKey, ctx)) events.push(event); return events }

test("signed complete stream is decoded with bounded chunks and exact data identity", async () => {
  const events = await decode(await collect(encoded()))
  assert.equal(events[0].type, "metadata")
  assert.equal(events.at(-1).type, "complete")
  assert.equal(events.at(-1).completion.archiveBytes, archive.length)
  assert.deepEqual(Buffer.concat(events.filter(event => event.type === "archive").map(event => event.bytes)), archive)
})
for (const mode of ["truncated", "trailing", "mutated", "wrong-key", "bad-magic", "oversized-frame"]) test(`reject ${mode} rather than publishing success`, async () => {
  let bytes = await collect(encoded()), publicKey = keys.publicKey
  if (mode === "truncated") bytes = bytes.subarray(0, bytes.length - 1)
  if (mode === "trailing") bytes = Buffer.concat([bytes, Buffer.from([0])])
  if (mode === "mutated") { bytes = Buffer.from(bytes); bytes[bytes.indexOf("PGDMP") + 10] ^= 1 }
  if (mode === "wrong-key") publicKey = otherKeys.publicKey
  if (mode === "bad-magic") { bytes = Buffer.from(bytes); bytes[0] = 1 }
  if (mode === "oversized-frame") { bytes = Buffer.from(bytes); bytes.writeUInt32BE(0xffffffff, 9) }
  await assert.rejects(decode(bytes, publicKey))
})
test("stdout EOF without native zero exit is not a signed completion", async () => {
  await assert.rejects(collect(encoded({ finish: async () => 1 })))
})
for (const change of [value => { value.source.role = "postgres" }, value => { value.source.backendTls = false },
  value => { value.source.clientTls = "require" }, value => { value.source.readOnly = false },
  value => { value.catalog.tables[0].readable = false }, value => { value.catalog.tables[0].kind = "f" }]) test("reject unsafe source identity or incomplete scope", async () => {
  const value = metadata(); change(value); await assert.rejects(collect(encoded({ metadata: value })))
})
function handlerSetup(options = {}) {
  const calls = { tokens: 0, admission: 0, native: 0, close: 0, finish: 0 }
  const claims = { iss: pins.storageMediaBackup.googleTokenIssuer, aud: POSTGRES_BACKUP_URL, sub: "123456789012345678901",
    email: pins.storageMediaBackup.googleServiceAccount, email_verified: true, iat: time / 1000, exp: time / 1000 + 3600, ...options.claims }
  const runtime = { enabled: true, vercel: "1", environment: "production", projectId: pins.vercel.projectId,
    googleSubject: "123456789012345678901", ...options.runtime }
  const handler = createPostgresBackupHandler({ runtime, now,
    verifyToken: async () => { calls.tokens++; return claims },
    admission: { acquire: async input => { calls.admission++; return { week: input.week, owner: input.owner, fence: 1 } },
      finish: async () => { calls.finish++ } },
    openNative: async ctx => { calls.native++; assert.equal(Object.keys(ctx).sort().join(","), "deadline,now,signal");
      if (options.rejectNativeOpen) throw new Error("Native opening cleanup unconfirmed")
      return { bytes: encoded(), close: async () => { calls.close++ }, completed: () => true } } })
  return { handler, calls }
}
const request = (body = '{"operation":"weekly-full-v1"}', overrides = {}) => new Request(overrides.url || POSTGRES_BACKUP_URL,
  { method: "POST", headers: { authorization: "Bearer aaa.bbb.ccc", "content-type": "application/json", ...overrides.headers }, body, ...overrides.init })
test("only exact export request reaches fixed native adapter, and cleanup follows EOF", async () => {
  const { handler, calls } = handlerSetup()
  const response = await handler(request())
  assert.equal(response.status, 200)
  await decode(Buffer.from(await response.arrayBuffer()))
  assert.equal(calls.native, 1); assert.equal(calls.close, 1); assert.equal(calls.finish, 1)
})
test("cancelling a response before its first read still closes native sessions and admission", async () => {
  const { handler, calls } = handlerSetup()
  const response = await handler(request())
  await response.body.cancel()
  assert.equal(calls.native, 1); assert.equal(calls.close, 1); assert.equal(calls.finish, 1)
})
test("a rejected native opening preserves admission because no owned handle can prove cleanup", async () => {
  const { handler, calls } = handlerSetup({ rejectNativeOpen: true })
  assert.equal((await handler(request())).status, 503)
  assert.equal(calls.native, 1); assert.equal(calls.finish, 0)
})
for (const field of ["sql", "query", "host", "role", "environment", "args", "snapshot", "destination", "command", "__proto__"]) test(`caller-controlled ${field} never reaches native exporter`, async () => {
  const { handler, calls } = handlerSetup()
  const response = await handler(request(`{"operation":"weekly-full-v1","${field}":"select lo_create(1)"}`))
  assert.equal(response.status, 400); assert.equal(calls.native, 0); assert.equal(calls.admission, 0)
})
for (const claims of [{ sub: "333333333333333333333" }, { aud: "https://evil.invalid" }, { iss: "http://accounts.google.com" },
  { email: "different@example.invalid" }, { email_verified: false }, { exp: time / 1000 - 1 }, { iat: time / 1000 + 100 }]) test("wrong Google identity/audience/expiry cannot open a source connection", async () => {
  const { handler, calls } = handlerSetup({ claims })
  assert.equal((await handler(request())).status, 401); assert.equal(calls.native, 0)
})
for (const runtime of [{ enabled: false }, { environment: "preview" }, { projectId: "another-project" }, { vercel: "0" }]) test("disabled/nonproduction runtime is closed before identity or source access", async () => {
  const { handler, calls } = handlerSetup({ runtime })
  assert.equal((await handler(request())).status, 404); assert.equal(calls.tokens, 0); assert.equal(calls.native, 0)
})
for (const overrides of [{ url: `${POSTGRES_BACKUP_URL}?sql=1` }, { url: "https://spc.fcuno.com/api/backups/postgres" },
  { headers: { range: "bytes=0-1" } }, { headers: { "content-encoding": "gzip" } }, { headers: { "content-type": "text/plain" } }]) test("altered request transport is rejected before authentication", async () => {
  const { handler, calls } = handlerSetup()
  assert.equal((await handler(request(undefined, overrides))).status, 400); assert.equal(calls.tokens, 0)
})

function crc32c(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0) }
  const buffer = Buffer.alloc(4); buffer.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return buffer.toString("base64") }
function receiverSetup(options = {}) {
  const runId = "synthetic-run", prefix = `${pins.postgresBackup.targetPrefix}/runs/${runId}`
  let generation = 1, current = null, sourceOpens = 0, sourceCloses = 0
  const objects = new Map()
  async function upload(name, input) {
    const bytes = await collect(input.bytes), target = { bucket: pins.storageMediaBackup.targetBucket, objectName: name, generation: String(generation++) }
    assert.equal(objects.has(name), false)
    const receipt = { target, sizeBytes: bytes.length, crc32c: crc32c(bytes) }
    objects.set(name, { bytes, receipt }); return structuredClone(receipt)
  }
  const gcs = { manifestObjectName: `${prefix}/manifest.json`, validateBucket: async () => {},
    control: { read: async () => structuredClone(current), compareAndSwap: async (expected, record) => {
      if (expected !== (current?.generation || "0")) return null
      current = { generation: String(generation++), record: structuredClone(record) }; return structuredClone(current)
    } },
    writeArchivePart: async input => { assert.equal(input.ifGenerationMatch, "0"); return upload(`${prefix}/archive/${String(input.index).padStart(6, "0")}`, input) },
    uploadImmutable: async input => upload(input.objectName, input),
    inspectTarget: async target => { const value = objects.get(target.objectName); assert.deepEqual(target, value.receipt.target); return structuredClone(value.receipt) },
    readTarget: async target => { const value = objects.get(target.objectName); assert.deepEqual(target, value.receipt.target);
      const bytes = options.corruptRead ? Buffer.from(value.bytes).fill(0, 0, 1) : value.bytes
      return { target, crc32c: value.receipt.crc32c, bytes: pieces(bytes) } } }
  return { gcs, objects, current: () => current, opens: () => sourceOpens, closes: () => sourceCloses,
    input: { gcs, runId, week: "2026-10-26", publicKey: keys.publicKey,
      source: { open: async () => { sourceOpens++; return { bytes: options.stream?.() || encoded(), close: async () => { sourceCloses++ } } } },
      budget: { checkOptionalWork: async () => ({ allowed: !options.pause, reason: options.pause ? "budget_near_limit" : "verified" }) } } }
}
test("receiver uses create-only generation readback and fenced final success", async () => {
  const fixture = receiverSetup(), result = await receivePostgresBackup(fixture.input, context())
  assert.equal(result.status, "copied-and-byte-verified")
  assert.equal(result.archiveBytes, archive.length)
  assert.equal(fixture.current().record.lease, null)
  assert.equal(fixture.current().record.latestSuccess.runId, "synthetic-run")
  assert.equal(fixture.opens(), 1); assert.ok(fixture.closes() >= 1)
  assert.equal((await receivePostgresBackup(fixture.input, context())).status, "already-copied")
  assert.equal(fixture.opens(), 1)
})
test("budget pause occurs before source or credential opening", async () => {
  const fixture = receiverSetup({ pause: true })
  assert.equal((await receivePostgresBackup(fixture.input, context())).status, "budget-paused")
  assert.equal(fixture.opens(), 0); assert.equal(fixture.current(), null)
})
test("denied, malformed or unavailable budget prevents all previous-archive reads even for same-week reuse", async () => {
  for (const offset of [0, 7 * 86400000]) for (const mode of ["denied", "malformed", "unavailable"]) {
    const fixture = receiverSetup()
    await receivePostgresBackup(fixture.input, context())
    const before = structuredClone(fixture.current())
    const objectBytes = [...fixture.objects].map(([name, object]) => [name, Buffer.from(object.bytes)])
    let budgetCalls = 0, fullReads = 0, writes = 0
    fixture.gcs.readTarget = async () => { fullReads++; assert.fail("No previous archive or manifest body before fresh budget approval") }
    fixture.gcs.control.compareAndSwap = async () => { writes++; assert.fail("Budget denial cannot mutate the lease or last-good pointer") }
    fixture.input.budget.checkOptionalWork = async () => {
      budgetCalls++
      if (mode === "unavailable") throw Error("Synthetic authentic billing feed unavailable")
      return mode === "denied" ? { allowed: false, reason: "budget_near_limit" } : { allowed: "true", reason: "malformed" }
    }
    const observedAt = time + offset, ctx = { now: () => observedAt, signal: AbortSignal.timeout(5000), deadline: observedAt + 5000 }
    const operation = receivePostgresBackup({ ...fixture.input, week: offset ? "2026-11-02" : fixture.input.week }, ctx)
    if (mode === "denied") assert.equal((await operation).status, "budget-paused")
    else await assert.rejects(operation)
    assert.equal(budgetCalls, 1); assert.equal(fullReads, 0); assert.equal(writes, 0)
    assert.equal(fixture.opens(), 1, "Only the initial known-good fixture copy opened a source")
    assert.deepEqual(fixture.current(), before)
    assert.deepEqual([...fixture.objects].map(([name, object]) => [name, object.bytes]), objectBytes)
  }
})
test("approved budget does not bypass an active lease or old-archive corruption", async () => {
  const leased = receiverSetup()
  await receivePostgresBackup(leased.input, context())
  const nextWeek = time + 7 * 86400000
  leased.current().record.lease = { owner: "other-owner", expiresAt: nextWeek + 5000 }
  const before = structuredClone(leased.current())
  const result = await receivePostgresBackup({ ...leased.input, week: "2026-11-02" },
    { now: () => nextWeek, deadline: nextWeek + 5000, signal: AbortSignal.timeout(5000) })
  assert.equal(result.status, "already-running"); assert.equal(leased.opens(), 1)
  assert.deepEqual(leased.current(), before)
  const corrupt = receiverSetup()
  await receivePostgresBackup(corrupt.input, context())
  const entry = [...corrupt.objects].find(([name]) => name.includes("/archive/"))[1]
  entry.bytes = Buffer.from(entry.bytes); entry.bytes[10] ^= 1
  await assert.rejects(receivePostgresBackup(corrupt.input, context()))
  assert.equal(corrupt.opens(), 1, "Budget approval must not weaken same-week complete archive verification")
})
for (const options of [{ corruptRead: true }, { stream: () => encoded({ finish: async () => 1 }) }]) test("bad copy or native failure cannot replace last-good pointer", async () => {
  const fixture = receiverSetup(options)
  await assert.rejects(receivePostgresBackup(fixture.input, context()))
  assert.equal(fixture.current().record.latestSuccess, null)
  assert.equal(fixture.current().record.lease, null)
})

test("a valid signed old export cannot be replayed as a fresh weekly backup", async () => {
  const old = metadata(); old.startedAt = new Date(time - 86400000).toISOString()
  const fixture = receiverSetup({ stream: () => encoded({ metadata: old }) })
  await assert.rejects(receivePostgresBackup(fixture.input, context()))
  assert.equal(fixture.current().record.latestSuccess, null)
})
test("caller cannot select a different backup week", async () => {
  const fixture = receiverSetup()
  await assert.rejects(receivePostgresBackup({ ...fixture.input, week: "2026-10-19" }, context()))
  assert.equal(fixture.opens(), 0)
})
test("persisted signed old receipt cannot suppress a new week's export by relabelling unsigned GCS metadata", async () => {
  const fixture = receiverSetup()
  await receivePostgresBackup(fixture.input, context())
  const pointer = fixture.current().record.latestSuccess
  const stored = fixture.objects.get(pointer.manifest.target.objectName)
  const replay = JSON.parse(stored.bytes.toString("utf8"))
  replay.week = "2026-11-02"
  stored.bytes = Buffer.from(JSON.stringify(replay))
  stored.receipt.sizeBytes = stored.bytes.length
  stored.receipt.crc32c = crc32c(stored.bytes)
  pointer.week = replay.week
  pointer.manifest = { ...stored.receipt, byteSha256: createHash("sha256").update(stored.bytes).digest("hex") }
  const future = time + 7 * 86400000
  await assert.rejects(receivePostgresBackup({ ...fixture.input, week: replay.week },
    { signal: AbortSignal.timeout(5000), deadline: future + 5000, now: () => future }))
  assert.equal(fixture.opens(), 1, "reject replay rather than silently call it a fresh success")
})
