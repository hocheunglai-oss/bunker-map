import { createHash, sign, verify } from "node:crypto"
import { fcunoConnectionPolicy } from "../config/fcunoConnections.ts"
import { validateRecoveryCatalog } from "./postgresRecoveryCatalog.mjs"

// Fixed, length-prefixed framing: metadata, archive byte frames, signed finish.
// No caller-controlled paths, SQL, options or connection fields exist here.
// This protects against a compromised backup receiver, NOT source compromise.
export const POSTGRES_BACKUP_PROTOCOL = "fcuno.postgresql-export/v1"
export const POSTGRES_BACKUP_CONTENT_TYPE = "application/vnd.fcuno.postgresql-export-v1"
export const POSTGRES_BACKUP_MAGIC = Buffer.from("FCUNOPG1")
const limits = fcunoConnectionPolicy.postgresBackup
const projectRef = fcunoConnectionPolicy.supabase.projectRef
const org = fcunoConnectionPolicy.supabase.organizationId
const fail = () => { throw new Error("PostgreSQL export verification failed") }
export function assertExact(value, fields) {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== fields.length || fields.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"))) fail()
}
export function assertExportContext(context) {
  if (!context?.signal || typeof context.signal.throwIfAborted !== "function" || typeof context.now !== "function" ||
      !Number.isSafeInteger(context.deadline) || !Number.isSafeInteger(context.now()) || context.now() >= context.deadline) fail()
  context.signal.throwIfAborted()
}
export function guardedExport(promise, context, late = () => {}) {
  assertExportContext(context)
  return new Promise((resolve, reject) => {
    let settled = false
    const aborted = () => { if (!settled) { settled = true; reject(new Error("PostgreSQL export cancelled")) } }
    context.signal.addEventListener("abort", aborted, { once: true })
    Promise.resolve(promise).then(value => {
      context.signal.removeEventListener("abort", aborted)
      if (settled || context.signal.aborted) { void Promise.resolve(late(value)).catch(() => {}); aborted(); return }
      settled = true
      try { assertExportContext(context); resolve(value) } catch (error) { void Promise.resolve(late(value)).catch(() => {}); reject(error) }
    }, error => { context.signal.removeEventListener("abort", aborted); if (!settled) { settled = true; reject(error) } })
    if (context.signal.aborted) aborted()
  })
}
export function digest(bytes) { return createHash("sha256").update(bytes).digest("hex") }
export function postgresBackupWeek(milliseconds) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) fail()
  const day = Math.floor(milliseconds / 86400000) * 86400000
  return new Date(day - ((new Date(day).getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10)
}
function identifier(value) { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) fail(); return value }
function timestamp(value) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(); return value }
function hash(value) { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail(); return value }
export function validateExportMetadata(value) {
  assertExact(value, ["schema", "projectRef", "organizationId", "runId", "startedAt", "source", "catalog"])
  if (value.schema !== POSTGRES_BACKUP_PROTOCOL || value.projectRef !== projectRef || value.organizationId !== org) fail()
  identifier(value.runId); timestamp(value.startedAt)
  const source = value.source
  assertExact(source, ["database", "role", "sessionRole", "serverVersion", "backendTls", "clientTls", "readOnly", "snapshot"])
  if (source.database !== limits.databaseName || source.role !== limits.databaseRole || source.sessionRole !== limits.databaseLogin ||
      !/^17\.[0-9]+/.test(source.serverVersion) || source.backendTls !== true || source.clientTls !== "verify-full" || source.readOnly !== true ||
      typeof source.snapshot !== "string" || !/^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]*$/.test(source.snapshot)) fail()
  const catalog = value.catalog
  assertExact(catalog, ["tables", "roles", "memberships", "database", "extensions", "largeObjectCount", "recovery"])
  validateRecoveryCatalog(catalog.recovery)
  if (!Array.isArray(catalog.tables) || !catalog.tables.length || catalog.tables.length > 10000 || !Array.isArray(catalog.roles) ||
      !catalog.roles.length || catalog.roles.length > 1000 || !Array.isArray(catalog.memberships) || catalog.memberships.length > 10000 ||
      !Array.isArray(catalog.extensions) || catalog.extensions.length > 1000 || !Number.isSafeInteger(catalog.largeObjectCount) || catalog.largeObjectCount < 0) fail()
  const tables = new Set()
  for (const item of catalog.tables) {
    assertExact(item, ["schema", "name", "kind", "readable"])
    if (![item.schema, item.name].every(x => typeof x === "string" && x.length && Buffer.byteLength(x) <= 256 && !/[\x00]/.test(x)) ||
        !["r", "p", "m", "f"].includes(item.kind) || item.readable !== true) fail()
    const key = JSON.stringify([item.schema, item.name]); if (tables.has(key)) fail(); tables.add(key)
  }
  // pg_dump does not include foreign-table data by default. Do not claim a
  // complete database when that unsupported source scope exists.
  if (catalog.tables.some(table => table.kind === "f")) fail()
  if (catalog.database?.name !== limits.databaseName) fail()
  // Fail closed if the dedicated source credential gains an administrative
  // attribute or membership. PUBLIC large-object authority is deliberately not
  // misrepresented as removed; this check limits the trusted native reader.
  const reader = catalog.roles.filter(role => role.rolname === limits.databaseLogin)
  if (reader.length !== 1 || reader[0].rolsuper !== false || reader[0].rolcreatedb !== false || reader[0].rolcreaterole !== false ||
      reader[0].rolreplication !== false || reader[0].rolbypassrls !== true || reader[0].rolcanlogin !== true ||
      reader[0].rolinherit !== true || reader[0].rolconnlimit !== 2 || !Number.isFinite(Date.parse(reader[0].rolvaliduntil)) ||
      Date.parse(reader[0].rolvaliduntil) <= Date.parse(value.startedAt) ||
      Date.parse(reader[0].rolvaliduntil) > Date.parse(value.startedAt) + 90 * 86400000) fail()
  const membership = catalog.memberships.filter(item => item.member === limits.databaseLogin)
  if (membership.length !== 1 || membership[0].role !== "pg_read_all_data" || membership[0].admin !== false ||
      membership[0].inherit !== true || membership[0].set !== false) fail()
  const encoded = Buffer.from(JSON.stringify(value))
  if (encoded.length > limits.maximumMetadataBytes) fail()
  return value
}
export function validateExportCompletion(value, metadata) {
  assertExact(value, ["schema", "projectRef", "runId", "metadataSha256", "archiveSha256", "archiveBytes", "finishedAt", "dumpExitCode"])
  if (value.schema !== POSTGRES_BACKUP_PROTOCOL || value.projectRef !== projectRef || value.runId !== metadata.runId ||
      value.dumpExitCode !== 0 || !Number.isSafeInteger(value.archiveBytes) || value.archiveBytes < 5 || value.archiveBytes > limits.maximumArchiveBytes ||
      Date.parse(timestamp(value.finishedAt)) < Date.parse(metadata.startedAt)) fail()
  hash(value.metadataSha256); hash(value.archiveSha256)
  return value
}
function frame(type, bytes) {
  const prefix = Buffer.alloc(5); prefix[0] = type; prefix.writeUInt32BE(bytes.length, 1)
  return Buffer.concat([prefix, bytes])
}
export async function* encodePostgresExport({ metadata, archive, finish, privateKey }, context) {
  validateExportMetadata(metadata)
  if (privateKey?.asymmetricKeyType !== "ed25519" || privateKey.type !== "private" || typeof finish !== "function") fail()
  const encoded = Buffer.from(JSON.stringify(metadata)), hash = createHash("sha256")
  let total = 0, prefix = Buffer.alloc(0)
  yield POSTGRES_BACKUP_MAGIC
  yield frame(1, encoded)
  for await (const bytes of archive) {
    assertExportContext(context)
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > limits.chunkBytes) fail()
    total += bytes.length; if (total > limits.maximumArchiveBytes) fail()
    if (prefix.length < 5) prefix = Buffer.concat([prefix, bytes.subarray(0, 5 - prefix.length)])
    if (prefix.length === 5 && prefix.toString("ascii") !== "PGDMP") fail()
    hash.update(bytes); yield frame(2, bytes)
  }
  assertExportContext(context)
  // finish() must observe native process exit and cleanly end the source
  // transaction. No manifest may be emitted merely because stdout ended.
  if (await guardedExport(finish(), context) !== 0) fail()
  const completion = validateExportCompletion({ schema: POSTGRES_BACKUP_PROTOCOL, projectRef, runId: metadata.runId,
    metadataSha256: digest(encoded), archiveSha256: hash.digest("hex"), archiveBytes: total,
    finishedAt: new Date(context.now()).toISOString(), dumpExitCode: 0 }, metadata)
  const payload = Buffer.from(JSON.stringify(completion))
  const envelope = Buffer.from(JSON.stringify({ completion, signature: sign(null, payload, privateKey).toString("base64url") }))
  yield frame(3, envelope)
}

// Decoder keeps at most one bounded frame, never a whole database archive.
// A finish frame is accepted only after exact body EOF and source signature.
export async function* decodePostgresExport(bytes, publicKey, context) {
  if (publicKey?.asymmetricKeyType !== "ed25519" || publicKey.type !== "public") fail()
  const iterator = bytes[Symbol.asyncIterator](), hash = createHash("sha256")
  let pending = Buffer.alloc(0), offset = 0, metadata = null, metadataHash = null, total = 0, done = false, prefix = Buffer.alloc(0)
  async function read(length, eof = false) {
    const pieces = []; let count = 0
    while (count < length) {
      assertExportContext(context)
      if (offset === pending.length) {
        const next = await guardedExport(iterator.next(), context)
        if (next.done) { if (eof && count === 0) return null; fail() }
        if (!(next.value instanceof Uint8Array) || !next.value.length || next.value.length > limits.maximumMetadataBytes + 5) fail()
        pending = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength); offset = 0
      }
      const size = Math.min(length - count, pending.length - offset)
      pieces.push(pending.subarray(offset, offset + size)); offset += size; count += size
    }
    return Buffer.concat(pieces, count)
  }
  try {
    if (!(await read(8)).equals(POSTGRES_BACKUP_MAGIC)) fail()
    for (;;) {
      const header = await read(5), type = header[0], length = header.readUInt32BE(1)
      if (![1, 2, 3].includes(type) || !length || length > (type === 2 ? limits.chunkBytes : limits.maximumMetadataBytes)) fail()
      const body = await read(length)
      if (type === 1) {
        if (metadata) fail()
        metadata = validateExportMetadata(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)))
        metadataHash = digest(body); yield { type: "metadata", metadata }
      } else if (type === 2) {
        if (!metadata) fail()
        total += length; if (total > limits.maximumArchiveBytes) fail()
        if (prefix.length < 5) prefix = Buffer.concat([prefix, body.subarray(0, 5 - prefix.length)])
        if (prefix.length === 5 && prefix.toString("ascii") !== "PGDMP") fail()
        hash.update(body); yield { type: "archive", bytes: body }
      } else {
        if (!metadata || total < 5) fail()
        const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))
        assertExact(envelope, ["completion", "signature"])
        const completion = validateExportCompletion(envelope.completion, metadata)
        if (typeof envelope.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature) ||
            !verify(null, Buffer.from(JSON.stringify(completion)), publicKey, Buffer.from(envelope.signature, "base64url")) ||
            completion.metadataSha256 !== metadataHash || completion.archiveSha256 !== hash.digest("hex") || completion.archiveBytes !== total ||
            await read(1, true) !== null) fail()
        done = true; yield { type: "complete", completion, signature: envelope.signature }; return
      }
    }
  } finally {
    if (!done && typeof iterator.return === "function") void Promise.resolve(iterator.return()).catch(() => {})
  }
}
