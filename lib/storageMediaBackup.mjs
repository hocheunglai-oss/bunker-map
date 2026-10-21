import { createHash } from "node:crypto"

// Preparation-only provider-neutral helpers. No filesystem, environment,
// credentials, provider clients, timers or import-time IO. Adapters own IO and
// must enforce the supplied signal/deadline, immutable-generation addressing,
// create-only uploads, and genuine atomic generation compare-and-swap.
export const STORAGE_MEDIA_LIMITS = Object.freeze({
  inventoryObjects: 50000, referencesPerArtifact: 20000, chunkRows: 10000,
  inputChunkBytes: 256 * 1024, stringBytes: 4096, checkpointBytes: 64 * 1024,
  metadataBytes: 32 * 1024 * 1024, manifestBytes: 32 * 1024 * 1024,
  jsonDepth: 64, jsonNodes: 500000,
})
const COPY_SCHEMA = "fcuno.storage-media-copy/v1"
const PAIR_SCHEMA = "fcuno.storage-media-pair/v1"
const CONTROL_SCHEMA = "fcuno.storage-media-control/v1"
const SOURCE_KEYS = ["bucket", "path", "id", "version", "sizeBytes"]
const TARGET_KEYS = ["bucket", "objectName", "generation"]
const COPY_KEYS = ["source", "target", "byteSha256", "sizeBytes", "crc32c", "verifiedAt"]
const ARTIFACT_KEYS = ["driveFileId", "uploadedFileSha256", "fileByteLength", "logicalArtifactSha256", "checkpoint"]
const REF_KEYS = ["chunkId", "kind", "path", "expectedBytes"]
const BOUND_REF_KEYS = [...REF_KEYS, "source", "byteSha256", "target"]

function fail(message) { throw new Error(message) }
function plain(value) { return value !== null && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) }
function keys(value, expected, label) {
  if (!plain(value) || Reflect.ownKeys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key)) || Object.getOwnPropertyNames(value).some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) fail(`${label} has invalid exact fields`)
}
function text(value, label) {
  if (typeof value !== "string" || !value || !value.isWellFormed() || /[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > STORAGE_MEDIA_LIMITS.stringBytes) fail(`${label} must be an exact bounded nonempty string`)
  return value
}
function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || Object.is(value, -0)) fail(`${label} must be a safe integer >= ${minimum}`)
  return value
}
function hash(value) { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail("Invalid SHA-256"); return value }
function crc(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{6}==$/.test(value) || Buffer.from(value, "base64").length !== 4 || Buffer.from(value, "base64").toString("base64") !== value) fail("Invalid canonical CRC32C")
  return value
}
function generation(value) { if (typeof value !== "string" || !/^[1-9]\d{0,39}$/.test(value)) fail("Invalid immutable target/control generation"); return value }
function time(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail("Invalid canonical timestamp")
  return value
}
function array(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} exceeds bounded count`)
  if (Reflect.ownKeys(value).length !== value.length + 1) fail(`${label} has sparse or unexpected fields`)
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(index)) ?? {}, "value")) fail(`${label} has sparse/accessor fields`)
  return value
}

// Canonical JSON is solely for deterministic evidence bytes/equality. It never
// rewrites a source identity string. Reject accessors, undefined, cycles, exotic
// objects and unbounded metadata before JSON.stringify can run arbitrary hooks.
function canonical(value, maxBytes = STORAGE_MEDIA_LIMITS.manifestBytes) {
  let bytes = 0, nodes = 0
  const ancestors = new Set()
  const add = piece => { bytes += Buffer.byteLength(piece); if (bytes > maxBytes) fail("JSON exceeds bounded bytes"); return piece }
  const visit = (item, depth) => {
    if (++nodes > STORAGE_MEDIA_LIMITS.jsonNodes || depth > STORAGE_MEDIA_LIMITS.jsonDepth) fail("JSON exceeds bounded structure")
    if (item === null || typeof item === "boolean") return add(JSON.stringify(item))
    if (typeof item === "number") { if (!Number.isFinite(item) || Object.is(item, -0)) fail("Invalid JSON number"); return add(JSON.stringify(item)) }
    if (typeof item === "string") {
      if (!item.isWellFormed()) fail("Invalid JSON Unicode")
      if (Buffer.byteLength(item) > maxBytes) fail("JSON string exceeds bounded bytes")
      return add(JSON.stringify(item))
    }
    if (!plain(item) && !Array.isArray(item)) fail("Invalid JSON value")
    if (ancestors.has(item)) fail("Cyclic JSON")
    ancestors.add(item)
    const isArray = Array.isArray(item)
    if (isArray && item.length > STORAGE_MEDIA_LIMITS.jsonNodes) fail("JSON array exceeds bounded structure")
    const names = isArray ? Array.from({ length: item.length }, (_, index) => String(index)) : Object.keys(item).sort()
    if (names.length > STORAGE_MEDIA_LIMITS.jsonNodes || Reflect.ownKeys(item).length !== names.length + (isArray ? 1 : 0)) fail("Invalid JSON keys")
    const start = add(isArray ? "[" : "{")
    const entries = names.map((key, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("Invalid JSON accessor or sparse array")
      if (Buffer.byteLength(key) > maxBytes) fail("JSON key exceeds bounded bytes")
      return (index ? add(",") : "") + (isArray ? "" : add(JSON.stringify(key)) + add(":")) + visit(descriptor.value, depth + 1)
    })
    ancestors.delete(item)
    return start + entries.join("") + add(isArray ? "]" : "}")
  }
  return visit(value, 0)
}
function same(left, right) { return canonical(left) === canonical(right) }
function copyJson(value, maximum) { return JSON.parse(canonical(value, maximum)) }
function pathKey(value) { return JSON.stringify([value.bucket, value.path]) }
function idKey(value) { return JSON.stringify([value.bucket, value.id]) }
function targetKey(value) { return JSON.stringify([value.bucket, value.objectName, value.generation]) }

export function validateSourceIdentity(value) {
  keys(value, SOURCE_KEYS, "Source identity")
  return { bucket: text(value.bucket, "Source bucket"), path: text(value.path, "Source path"), id: text(value.id, "Stable source ID"),
    version: text(value.version, "Stable source version"), sizeBytes: integer(value.sizeBytes, "Source size") }
}
export function validateTargetIdentity(value) {
  keys(value, TARGET_KEYS, "Target identity")
  return { bucket: text(value.bucket, "Target bucket"), objectName: text(value.objectName, "Target object name"), generation: generation(value.generation) }
}
export function validateInventory(value) {
  const paths = new Set(), ids = new Set()
  return array(value, STORAGE_MEDIA_LIMITS.inventoryObjects, "Inventory").map(item => {
    const source = validateSourceIdentity(item)
    if (paths.has(pathKey(source)) || ids.has(idKey(source))) fail("Duplicate or conflicting source identity/version in inventory")
    paths.add(pathKey(source)); ids.add(idKey(source)); return source
  })
}
export function validateCopyEvidence(value) {
  keys(value, COPY_KEYS, "Copy evidence")
  const source = validateSourceIdentity(value.source), sizeBytes = integer(value.sizeBytes, "Copy size")
  if (sizeBytes !== source.sizeBytes) fail("Copy size does not match exact source")
  return { source, target: validateTargetIdentity(value.target), byteSha256: hash(value.byteSha256), sizeBytes, crc32c: crc(value.crc32c), verifiedAt: time(value.verifiedAt) }
}
function copies(value) {
  const identities = new Set(), targets = new Set(), paths = new Set()
  return array(value, STORAGE_MEDIA_LIMITS.inventoryObjects, "Copies").map(item => {
    const evidence = validateCopyEvidence(item)
    if (identities.has(idKey(evidence.source)) || paths.has(pathKey(evidence.source)) || targets.has(targetKey(evidence.target))) fail("Duplicate or conflicting copy source/target generation")
    identities.add(idKey(evidence.source)); paths.add(pathKey(evidence.source)); targets.add(targetKey(evidence.target)); return evidence
  })
}

function operation(context) {
  if (!context || typeof context.now !== "function" || typeof context.signal?.throwIfAborted !== "function") fail("Common injected signal/deadline/clock required")
  integer(context.deadline, "Operation deadline", 1)
  context.signal.throwIfAborted()
  const now = integer(context.now(), "Injected time", 0)
  if (now >= context.deadline) fail("Operation deadline exceeded")
  return now
}
async function call(adapter, args, context) {
  operation(context)
  if (typeof adapter !== "function") fail("Required injected adapter missing")
  const result = await adapter(...args, { signal: context.signal, deadline: context.deadline })
  try { operation(context) } catch (error) { await closeReturnedBytes(result); throw error }
  return result
}
async function closeReturnedBytes(value) {
  // Do not execute a malformed result's accessor merely to attempt cleanup.
  const bytes = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "bytes")?.value : null
  if (typeof bytes?.[Symbol.asyncIterator] === "function") await bytes[Symbol.asyncIterator]().return?.()
}

// CRC-32C (Castagnoli), reflected polynomial 0x82f63b78, initial/final
// XOR 0xffffffff. The unsigned 32-bit result is big-endian then base64,
// matching GCS CRC32C encoding. CRC is transport corruption evidence only;
// cryptographic content identity remains SHA-256. Known vectors in tests:
// empty=00000000, "123456789"=e3069283, quick-brown-fox=22620404.
function crcUpdate(state, bytes) {
  for (const byte of bytes) {
    state = (state ^ byte) >>> 0
    for (let bit = 0; bit < 8; bit++) state = ((state >>> 1) ^ ((state & 1) ? 0x82f63b78 : 0)) >>> 0
  }
  return state
}
function crcFinish(state) { const bytes = Buffer.allocUnsafe(4); bytes.writeUInt32BE((state ^ 0xffffffff) >>> 0); return bytes.toString("base64") }
function meter(source, expected, context) {
  operation(context)
  if (!source || typeof source[Symbol.asyncIterator] !== "function") fail("Byte source must be an async iterable")
  keys(expected, Object.keys(expected), "Measurement expectations")
  if (Object.keys(expected).some(key => !["expectedBytes", "expectedSha256", "expectedCrc32c"].includes(key))) fail("Unknown measurement expectation")
  const expectedBytes = integer(expected.expectedBytes, "Expected byte length")
  if (expected.expectedSha256 !== undefined) hash(expected.expectedSha256)
  if (expected.expectedCrc32c !== undefined) crc(expected.expectedCrc32c)
  const iterator = source[Symbol.asyncIterator](), digest = createHash("sha256")
  let count = 0, crcState = 0xffffffff, complete = false, result = null, closed = false
  const close = async () => { if (!closed) { closed = true; if (typeof iterator.return === "function") await iterator.return() } }
  const stream = (async function* () {
    try {
      for (;;) {
        operation(context)
        const item = await iterator.next()
        operation(context)
        if (item.done) break
        if (!(item.value instanceof Uint8Array) || item.value.byteLength > STORAGE_MEDIA_LIMITS.inputChunkBytes) fail("Invalid or oversized bounded byte chunk")
        count += item.value.byteLength
        if (!Number.isSafeInteger(count) || count > expectedBytes) fail("Byte stream exceeds expected size")
        digest.update(item.value); crcState = crcUpdate(crcState, item.value)
        yield item.value
      }
      if (count !== expectedBytes) fail("Byte stream truncated before expected EOF size")
      result = { sizeBytes: count, byteSha256: digest.digest("hex"), crc32c: crcFinish(crcState) }
      if (expected.expectedSha256 !== undefined && result.byteSha256 !== expected.expectedSha256) fail("Byte SHA-256 mismatch")
      if (expected.expectedCrc32c !== undefined && result.crc32c !== expected.expectedCrc32c) fail("Byte CRC32C mismatch")
      complete = true
    } finally { await close() }
  })()
  return { stream, close: async () => { await stream.return(); await close() }, finish: () => { if (!complete) fail("Upload did not fully consume byte stream through EOF"); return result } }
}
export async function measureByteStream(source, expected, context) {
  const measured = meter(source, expected, context)
  try { for await (const _ of measured.stream) { /* Hash only; never collect body. */ } return measured.finish() }
  finally { await measured.close() }
}
function receipt(value) {
  keys(value, ["target", "sizeBytes", "crc32c"], "Target receipt")
  return { target: validateTargetIdentity(value.target), sizeBytes: integer(value.sizeBytes, "Target receipt size"), crc32c: crc(value.crc32c) }
}
function matchReceipt(actual, expected) { if (!same(receipt(actual), expected)) fail("Exact target generation/size/CRC receipt mismatch") }
async function verifyBody(expected, byteSha256, inspect, read, context) {
  matchReceipt(await call(inspect, [expected.target], context), expected)
  const opened = await call(read, [expected.target], context)
  let result, measured
  try {
    keys(opened, ["target", "bytes", "crc32c"], "Target readback")
    if (!same(validateTargetIdentity(opened.target), expected.target) || crc(opened.crc32c) !== expected.crc32c) fail("Exact readback target generation/CRC mismatch")
    measured = meter(opened.bytes, { expectedBytes: expected.sizeBytes, expectedSha256: byteSha256, expectedCrc32c: expected.crc32c }, context)
    for await (const _ of measured.stream) { /* Independent exact-generation body measurement. */ }
    result = measured.finish()
  } finally { if (measured) await measured.close(); else await closeReturnedBytes(opened) }
  matchReceipt(await call(inspect, [expected.target], context), expected)
  return result
}
async function inspectSource(source, adapter, context) {
  if (!same(validateSourceIdentity(await call(adapter, [source], context)), source)) fail("Source identity/version changed")
}
export async function copyStorageObject(identity, adapters, context) {
  const source = validateSourceIdentity(identity)
  await inspectSource(source, adapters.inspectSource, context)
  const opened = await call(adapters.openSource, [source], context)
  let measured, saved, actual
  try {
    keys(opened, ["identity", "bytes"], "Opened source")
    if (!same(validateSourceIdentity(opened.identity), source)) fail("Opened source identity/version changed")
    measured = meter(opened.bytes, { expectedBytes: source.sizeBytes }, context)
    saved = receipt(await call(adapters.writeTarget, [{ source, bytes: measured.stream, ifGenerationMatch: "0" }], context))
    actual = measured.finish()
    if (saved.sizeBytes !== actual.sizeBytes || saved.crc32c !== actual.crc32c) fail("Upload receipt does not match computed source size/CRC")
  } finally { if (measured) await measured.close(); else await closeReturnedBytes(opened) }
  await inspectSource(source, adapters.inspectSource, context)
  await verifyBody(saved, actual.byteSha256, adapters.inspectTarget, adapters.readTarget, context)
  await inspectSource(source, adapters.inspectSource, context)
  return validateCopyEvidence({ source, target: saved.target, ...actual, verifiedAt: new Date(operation(context)).toISOString() })
}
export async function reuseVerifiedCopy(identity, previous, adapters, context) {
  const source = validateSourceIdentity(identity), evidence = validateCopyEvidence(previous)
  if (!same(source, evidence.source)) fail("Reuse source identity/version does not exactly match prior evidence")
  await inspectSource(source, adapters.inspectSource, context)
  await verifyBody({ target: evidence.target, sizeBytes: evidence.sizeBytes, crc32c: evidence.crc32c }, evidence.byteSha256, adapters.inspectTarget, adapters.readTarget, context)
  await inspectSource(source, adapters.inspectSource, context)
  return { ...evidence, verifiedAt: new Date(operation(context)).toISOString() }
}

function artifact(value) {
  keys(value, ARTIFACT_KEYS, "Trusted database artifact")
  if (!plain(value.checkpoint)) fail("Trusted artifact checkpoint must be bounded JSON object")
  return { driveFileId: text(value.driveFileId, "Exact retained Drive file ID"), uploadedFileSha256: hash(value.uploadedFileSha256), fileByteLength: integer(value.fileByteLength, "Trusted raw file byte length", 1),
    logicalArtifactSha256: hash(value.logicalArtifactSha256), checkpoint: copyJson(value.checkpoint, STORAGE_MEDIA_LIMITS.checkpointBytes) }
}
function artifacts(value) {
  array(value, 2, "Trusted retained database artifacts")
  if (value.length !== 2) fail("Exactly two trusted retained database artifacts required")
  const result = value.map(artifact)
  if (result[0].driveFileId === result[1].driveFileId) fail("Duplicate retained database artifact IDs")
  return result.sort((left, right) => left.driveFileId < right.driveFileId ? -1 : left.driveFileId > right.driveFileId ? 1 : 0)
}
function reference(value, bound = false) {
  keys(value, bound ? BOUND_REF_KEYS : REF_KEYS, "Media reference")
  if (!["video", "narration"].includes(value.kind)) fail("Invalid media reference kind")
  const result = { chunkId: text(value.chunkId, "Chunk ID"), kind: value.kind, path: text(value.path, "Exact reference path"), expectedBytes: integer(value.expectedBytes, "Expected reference size", 1) }
  if (bound) {
    result.source = validateSourceIdentity(value.source); result.byteSha256 = hash(value.byteSha256); result.target = validateTargetIdentity(value.target)
    if (result.source.path !== result.path || result.source.sizeBytes !== result.expectedBytes) fail("Bound reference identity/size mismatch")
  }
  return result
}
function references(value, bound = false) {
  const ids = new Set(), paths = new Map()
  return array(value, STORAGE_MEDIA_LIMITS.referencesPerArtifact, "References").map(item => {
    const result = reference(item, bound), key = JSON.stringify([result.chunkId, result.kind])
    if (ids.has(key)) fail("Duplicate chunk/kind reference")
    if (paths.has(result.path) && paths.get(result.path) !== result.expectedBytes) fail("Conflicting same-path expected size")
    ids.add(key); paths.set(result.path, result.expectedBytes); return result
  })
}
export function buildRecoveryPairMapping({ sourceBucket, artifacts: selected, extracted, copies: evidence, checkedAt }) {
  text(sourceBucket, "Source reference bucket"); time(checkedAt)
  const trusted = artifacts(selected), verified = copies(evidence)
  array(extracted, 2, "Authenticated extraction results")
  if (extracted.length !== 2) fail("Exactly two authenticated extraction results required")
  const byId = new Map()
  for (const item of extracted) {
    keys(item, ["driveFileId", "result"], "Extraction identity")
    text(item.driveFileId, "Extraction exact Drive ID")
    if (byId.has(item.driveFileId)) fail("Duplicate extraction artifact ID")
    byId.set(item.driveFileId, item.result)
  }
  const byPath = new Map(verified.map(item => [pathKey(item.source), item]))
  const mapped = trusted.map(selectedArtifact => {
    const result = byId.get(selectedArtifact.driveFileId)
    keys(result, ["references", "metadata", "chunkCount", "sectionSha256", "fileSha256", "fileBytes"], "Authenticated extraction")
    const metadata = copyJson(result.metadata, STORAGE_MEDIA_LIMITS.metadataBytes)
    integer(result.chunkCount, "Extracted chunk count")
    if (result.chunkCount > STORAGE_MEDIA_LIMITS.chunkRows || result.fileSha256 !== selectedArtifact.uploadedFileSha256 || result.fileBytes !== selectedArtifact.fileByteLength) fail("Extraction does not match independent exact raw receipt")
    if (metadata.integrity?.artifactSha256 !== selectedArtifact.logicalArtifactSha256 || !same(metadata.integrity?.truth?.checkpointAfterExport, selectedArtifact.checkpoint)) fail("Authenticated logical artifact/checkpoint differs from trusted receipt")
    const refs = references(result.references)
    if (new Set(refs.map(item => item.chunkId)).size > result.chunkCount) fail("Reference chunk count mismatch")
    const sectionSha256 = hash(result.sectionSha256)
    const declared = metadata.integrity?.sections?.spcPresentationChunks
    if (declared !== undefined && (declared.sha256 !== sectionSha256 || declared.rowCount !== result.chunkCount)) fail("Authenticated section hash/count mismatch")
    return { ...selectedArtifact, sectionSha256, references: refs.map(item => {
      const copy = byPath.get(JSON.stringify([sourceBucket, item.path]))
      if (!copy || copy.source.sizeBytes !== item.expectedBytes) fail("Required database reference has no exact verified current source copy")
      return { ...item, source: copy.source, byteSha256: copy.byteSha256, target: copy.target }
    }) }
  })
  return validateRecoveryPairMapping({ schema: PAIR_SCHEMA, sourceBucket, checkedAt, historicalByteCorrespondence: "unproved", artifacts: mapped })
}
export function validateRecoveryPairMapping(value) {
  keys(value, ["schema", "sourceBucket", "checkedAt", "historicalByteCorrespondence", "artifacts"], "Recovery pair mapping")
  if (value.schema !== PAIR_SCHEMA || value.historicalByteCorrespondence !== "unproved") fail("Invalid recovery mapping claim/schema")
  const sourceBucket = text(value.sourceBucket, "Mapping source bucket")
  array(value.artifacts, 2, "Mapped artifacts")
  if (value.artifacts.length !== 2) fail("Exactly two mapped artifacts required")
  const mapped = value.artifacts.map(item => {
    keys(item, [...ARTIFACT_KEYS, "sectionSha256", "references"], "Mapped artifact")
    const descriptor = artifact(Object.fromEntries(ARTIFACT_KEYS.map(key => [key, item[key]])))
    const refs = references(item.references, true)
    if (refs.some(ref => ref.source.bucket !== sourceBucket)) fail("Mapped reference uses wrong source bucket")
    return { ...descriptor, sectionSha256: hash(item.sectionSha256), references: refs }
  })
  artifacts(mapped.map(item => Object.fromEntries(ARTIFACT_KEYS.map(key => [key, item[key]]))))
  // All mappings of a single path must name the same captured current bytes;
  // this does not establish that old JSONs historically referenced those bytes.
  const paths = new Map()
  for (const item of mapped) for (const ref of item.references) {
    const key = pathKey(ref.source), identity = { source: ref.source, byteSha256: ref.byteSha256, target: ref.target }
    if (paths.has(key) && !same(paths.get(key), identity)) fail("Conflicting same-path mapped source/version/bytes/target")
    paths.set(key, identity)
  }
  return { schema: PAIR_SCHEMA, sourceBucket, checkedAt: time(value.checkedAt), historicalByteCorrespondence: "unproved", artifacts: mapped }
}

export function buildCopyManifest(value) {
  keys(value, ["runId", "inventory", "copies", "pair", "startedAt", "finishedAt"], "Manifest inputs")
  return validateCopyManifest({ schema: COPY_SCHEMA, status: "succeeded", ...value })
}
export function validateCopyManifest(value) {
  keys(value, ["schema", "status", "runId", "inventory", "copies", "pair", "startedAt", "finishedAt"], "Copy manifest")
  if (value.schema !== COPY_SCHEMA || value.status !== "succeeded") fail("Manifest is not strict complete copy success")
  const inventory = validateInventory(value.inventory), evidence = copies(value.copies), pair = validateRecoveryPairMapping(value.pair)
  const startedAt = time(value.startedAt), finishedAt = time(value.finishedAt)
  if (Date.parse(startedAt) > Date.parse(finishedAt) || Date.parse(pair.checkedAt) < Date.parse(startedAt) || Date.parse(pair.checkedAt) > Date.parse(finishedAt)) fail("Manifest timestamp order invalid")
  if (inventory.length !== evidence.length) fail("Not every inventory object has a verified copy")
  const byPath = new Map(evidence.map(item => [pathKey(item.source), item]))
  for (const source of inventory) if (!same(byPath.get(pathKey(source))?.source, source)) fail("Inventory/source copy mismatch")
  for (const item of pair.artifacts) for (const ref of item.references) {
    const copy = byPath.get(pathKey(ref.source))
    if (!copy || !same(copy.source, ref.source) || copy.byteSha256 !== ref.byteSha256 || !same(copy.target, ref.target)) fail("Mapping is not bound to actual manifest copy evidence")
  }
  if (evidence.some(item => Date.parse(item.verifiedAt) > Date.parse(finishedAt))) fail("Copy verification occurs after manifest completion")
  const result = { schema: COPY_SCHEMA, status: "succeeded", runId: text(value.runId, "Run ID"), inventory, copies: evidence, pair, startedAt, finishedAt }
  canonical(result)
  return result
}
export function encodeCopyManifest(value) { return Buffer.from(canonical(validateCopyManifest(value)), "utf8") }

function pairDescriptors(mapping) { return artifacts(mapping.artifacts.map(item => Object.fromEntries(ARTIFACT_KEYS.map(key => [key, item[key]])))) }
function success(value) {
  keys(value, ["runId", "manifest", "observedPair"], "Latest-success pointer")
  keys(value.manifest, ["target", "sizeBytes", "crc32c", "byteSha256"], "Manifest byte identity")
  keys(value.observedPair, ["artifacts", "checkedAt"], "Observed retained pair")
  return { runId: text(value.runId, "Success run ID"), manifest: { ...receipt({ target: value.manifest.target, sizeBytes: value.manifest.sizeBytes, crc32c: value.manifest.crc32c }), byteSha256: hash(value.manifest.byteSha256) },
    observedPair: { artifacts: artifacts(value.observedPair.artifacts), checkedAt: time(value.observedPair.checkedAt) } }
}
export function validateControlRecord(value) {
  keys(value, ["schema", "fence", "lease", "latestSuccess"], "Storage control record")
  if (value.schema !== CONTROL_SCHEMA) fail("Invalid Storage control schema")
  let lease = null
  if (value.lease !== null) {
    keys(value.lease, ["owner", "expiresAt"], "Lease")
    lease = { owner: text(value.lease.owner, "Lease owner"), expiresAt: integer(value.lease.expiresAt, "Lease expiration", 1) }
  }
  return { schema: CONTROL_SCHEMA, fence: integer(value.fence, "Lease fence", 1), lease, latestSuccess: value.latestSuccess === null ? null : success(value.latestSuccess) }
}
function snapshot(value) {
  if (value === null) return null
  keys(value, ["generation", "record"], "Control snapshot")
  return { generation: generation(value.generation), record: validateControlRecord(value.record) }
}
function token(value) {
  keys(value, ["owner", "fence", "generation"], "Lease token")
  return { owner: text(value.owner, "Token owner"), fence: integer(value.fence, "Token fence", 1), generation: generation(value.generation) }
}
async function swap(control, expected, record, context) {
  const result = snapshot(await call(control.compareAndSwap?.bind(control), [expected, record], context))
  if (result && (!same(result.record, record) || result.generation === expected)) fail("CAS adapter did not return exact newly committed generation/record")
  return result
}
function ownership(current, held, now) {
  return current && current.generation === held.generation && current.record.fence === held.fence && current.record.lease?.owner === held.owner && current.record.lease.expiresAt > now
}
export async function acquireMediaLease(control, options, context) {
  keys(options, ["owner", "ttlMs"], "Lease acquisition")
  const owner = text(options.owner, "New lease owner"), ttl = integer(options.ttlMs, "Lease TTL", 1)
  const now = operation(context), current = snapshot(await call(control.read?.bind(control), [], context))
  if (current?.record.lease && current.record.lease.expiresAt > now) return null
  const expiresAt = integer(now + ttl, "New lease expiration", 1)
  if (expiresAt > context.deadline) fail("Lease cannot outlive common operation deadline")
  const fence = integer((current?.record.fence ?? 0) + 1, "New fence", 1)
  const result = await swap(control, current?.generation ?? "0", { schema: CONTROL_SCHEMA, fence, lease: { owner, expiresAt }, latestSuccess: current?.record.latestSuccess ?? null }, context)
  return result ? { owner, fence, generation: result.generation } : null
}
export async function releaseMediaLease(control, lease, context) {
  const held = token(lease), current = snapshot(await call(control.read?.bind(control), [], context))
  if (!ownership(current, held, operation(context))) return false
  return !!(await swap(control, held.generation, { ...current.record, lease: null }, context))
}

/** Publish only evidence for the exact named pair observed at checkedAt. This
 * is not an atomic guarantee that the pair remains latest after that check.
 * Catalog descriptors/receipts must be independently trusted at the caller's
 * edge; the reviewed R2 extractor must produce authenticated extraction input.
 * The common signal must cancel each adapter's pending IO cooperatively; these
 * helpers cannot interrupt an arbitrary non-cooperative iterator/adapter.
 */
export async function publishMediaSuccess(control, lease, value, manifestReceipt, adapters, context) {
  const held = token(lease), manifest = validateCopyManifest(value), expected = receipt(manifestReceipt)
  const current = snapshot(await call(control.read?.bind(control), [], context))
  if (!ownership(current, held, operation(context)) || held.owner !== manifest.runId) fail("Lost lease ownership/fence before publication")
  const encoded = encodeCopyManifest(manifest)
  const measured = await measureByteStream((async function* () { for (let offset = 0; offset < encoded.length; offset += STORAGE_MEDIA_LIMITS.inputChunkBytes) yield encoded.subarray(offset, offset + STORAGE_MEDIA_LIMITS.inputChunkBytes) })(), { expectedBytes: encoded.length }, context)
  if (expected.sizeBytes !== measured.sizeBytes || expected.crc32c !== measured.crc32c) fail("Manifest upload receipt does not match strict expected bytes")
  await verifyBody(expected, measured.byteSha256, adapters.inspectManifest, adapters.readManifest, context)
  const observed = await call(adapters.readRetainedPair, [], context)
  keys(observed, ["artifacts", "checkedAt"], "Final retained pair check")
  const finalPair = { artifacts: artifacts(observed.artifacts), checkedAt: time(observed.checkedAt) }
  const now = operation(context)
  if (!same(finalPair.artifacts, pairDescriptors(manifest.pair)) || Date.parse(finalPair.checkedAt) < Date.parse(manifest.pair.checkedAt) || Date.parse(finalPair.checkedAt) > now) fail("Retained pair/receipts rotated, disappeared or final checkedAt invalid")
  // Re-read ownership after all slow IO, then atomically CAS BOTH authority
  // and pointer. Stale A cannot alter B even if paused until after B publishes.
  const latest = snapshot(await call(control.read?.bind(control), [], context))
  if (!ownership(latest, held, operation(context))) fail("Lost lease ownership/fence during publication")
  const result = await swap(control, held.generation, { ...latest.record, latestSuccess: { runId: manifest.runId, manifest: { ...expected, byteSha256: measured.byteSha256 }, observedPair: finalPair } }, context)
  if (!result) fail("Lost lease fence generation CAS during publication")
  return { owner: held.owner, fence: held.fence, generation: result.generation }
}
