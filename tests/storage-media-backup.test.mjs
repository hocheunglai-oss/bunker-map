import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import {
  STORAGE_MEDIA_LIMITS, validateSourceIdentity, validateInventory, measureByteStream,
  copyStorageObject, reuseVerifiedCopy, buildRecoveryPairMapping, validateRecoveryPairMapping,
  buildCopyManifest, validateCopyManifest, encodeCopyManifest,
  acquireMediaLease, releaseMediaLease, publishMediaSuccess, validateControlRecord,
} from "../lib/storageMediaBackup.mjs"

const sha = value => createHash("sha256").update(value).digest("hex")
function checksum(value) {
  let crc = 0xffffffff
  for (const byte of value) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0) }
  const result = Buffer.alloc(4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return result.toString("base64")
}
const clone = value => structuredClone(value)
const source = (index = 0) => ({ bucket: "synthetic-source", path: `file-${index}/video.mp4`, id: `object-${index}`, version: `version-${index}`, sizeBytes: 9 })
const target = (index = 0) => ({ bucket: "synthetic-archive", objectName: `media/${index}`, generation: String(index + 1) })
const body = Buffer.from("123456789")
const controller = new AbortController()
let tick = Date.parse("2026-10-21T00:00:00.000Z")
const operation = () => ({ signal: controller.signal, deadline: tick + 100000, now: () => tick })
async function* bytes(value = body, width = 4) { for (let offset = 0; offset < value.length; offset += width) yield value.subarray(offset, offset + width) }
const evidence = (index = 0) => ({ source: source(index), target: target(index), byteSha256: sha(body), sizeBytes: body.length, crc32c: "4waSgw==", verifiedAt: new Date(tick).toISOString() })

function copyAdapters(overrides = {}) {
  const events = []
  return {
    events,
    inspectSource: async identity => { events.push("source-inspect"); return clone(identity) },
    openSource: async identity => { events.push("source-open"); return { identity: clone(identity), bytes: bytes() } },
    writeTarget: async request => {
      events.push("target-write"); assert.equal(request.ifGenerationMatch, "0")
      const data = []; for await (const chunk of request.bytes) data.push(chunk)
      assert.deepEqual(Buffer.concat(data), body)
      return { target: target(), sizeBytes: 9, crc32c: "4waSgw==" }
    },
    inspectTarget: async identity => { events.push("target-inspect"); return { target: clone(identity), sizeBytes: 9, crc32c: "4waSgw==" } },
    readTarget: async identity => { events.push("target-read"); return { target: clone(identity), bytes: bytes(), crc32c: "4waSgw==" } },
    ...overrides,
  }
}

function pairFixture(inventory = Array.from({ length: 15 }, (_, index) => source(index))) {
  const copies = inventory.map((_, index) => evidence(index))
  const artifacts = [0, 1].map(index => ({ driveFileId: `database-${index}`, uploadedFileSha256: sha(`raw-${index}`), fileByteLength: 500 + index,
    logicalArtifactSha256: sha(`logical-${index}`), checkpoint: { headSequence: index + 2 } }))
  const extracted = artifacts.map((artifact, index) => ({ driveFileId: artifact.driveFileId, result: {
    fileSha256: artifact.uploadedFileSha256, fileBytes: artifact.fileByteLength, sectionSha256: sha(`section-${index}`), chunkCount: 3,
    references: [0, 1, 2].map(item => ({ chunkId: `chunk-${item}`, kind: "video", path: inventory[index * 3 + item].path, expectedBytes: 9 })),
    metadata: { integrity: { artifactSha256: artifact.logicalArtifactSha256, truth: { checkpointAfterExport: clone(artifact.checkpoint) } } },
  } }))
  const mapping = buildRecoveryPairMapping({ sourceBucket: inventory[0].bucket, artifacts, extracted, copies, checkedAt: new Date(tick).toISOString() })
  return { inventory, copies, artifacts, extracted, mapping }
}

function manifestFixture() {
  const fixture = pairFixture()
  return { ...fixture, manifest: buildCopyManifest({ runId: "run-a", inventory: fixture.inventory, copies: fixture.copies, pair: fixture.mapping,
    startedAt: new Date(tick).toISOString(), finishedAt: new Date(tick).toISOString() }) }
}

function controlAdapter() {
  let stored = null, generation = 0
  return {
    read: async () => clone(stored),
    compareAndSwap: async (expectedGeneration, record) => {
      if (expectedGeneration !== (stored?.generation ?? "0")) return null
      stored = { generation: String(++generation), record: clone(record) }
      return clone(stored)
    },
    snapshot: () => clone(stored),
  }
}

test("source identity is opaque, exact and rejects missing stable identities and duplicates", () => {
  for (const path of ["a%2Fb/video.mp4", "a/b/video.mp4", "a//b", "a/../b", " é /v "]) assert.equal(validateSourceIdentity({ ...source(), path }).path, path)
  for (const field of ["id", "version", "path", "bucket"]) assert.throws(() => validateSourceIdentity({ ...source(), [field]: "" }))
  assert.throws(() => validateSourceIdentity({ ...source(), sizeBytes: "9" }))
  assert.throws(() => validateSourceIdentity({ ...source(), extra: true }))
  assert.throws(() => validateInventory([source(), source()]), /Duplicate|Conflicting/)
  assert.throws(() => validateInventory([source(), { ...source(), version: "changed" }]), /Duplicate|Conflicting/)
  assert.throws(() => validateInventory([source(), { ...source(1), id: source().id }]), /Duplicate|Conflicting/)
  assert.throws(() => validateInventory(Array(STORAGE_MEDIA_LIMITS.inventoryObjects + 1)), /bounded/)
})

test("stream checks SHA256, EOF size and Castagnoli CRC32C known vectors", async () => {
  const result = await measureByteStream(bytes(), { expectedBytes: 9, expectedSha256: sha(body), expectedCrc32c: "4waSgw==" }, operation())
  assert.deepEqual(result, { sizeBytes: 9, byteSha256: sha(body), crc32c: "4waSgw==" })
  assert.equal((await measureByteStream(bytes(Buffer.alloc(0)), { expectedBytes: 0 }, operation())).crc32c, "AAAAAA==")
  assert.equal((await measureByteStream(bytes(Buffer.from("The quick brown fox jumps over the lazy dog")), { expectedBytes: 43 }, operation())).crc32c, "ImIEBA==")
  for (const options of [{ expectedBytes: 8 }, { expectedBytes: 10 }, { expectedBytes: 9, expectedSha256: "0".repeat(64) }, { expectedBytes: 9, expectedCrc32c: "AAAAAA==" }]) await assert.rejects(measureByteStream(bytes(), options, operation()))
})

test("first copy computes both bodies and exact-generation metadata before and after readback", async () => {
  const adapters = copyAdapters()
  assert.deepEqual(await copyStorageObject(source(), adapters, operation()), evidence())
  assert.deepEqual(adapters.events, ["source-inspect", "source-open", "target-write", "source-inspect", "target-inspect", "target-read", "target-inspect", "source-inspect"])
})

test("wrong, truncated, overlong, changed source and target generation or CRC cannot certify", async context => {
  const faults = {
    "wrong target bytes": { readTarget: async identity => ({ target: identity, bytes: bytes(Buffer.from("wrongbyte")), crc32c: "4waSgw==" }) },
    "truncated target": { readTarget: async identity => ({ target: identity, bytes: bytes(body.subarray(0, 8)), crc32c: "4waSgw==" }) },
    "wrong read generation": { readTarget: async identity => ({ target: { ...identity, generation: "222" }, bytes: bytes(), crc32c: "4waSgw==" }) },
    "wrong read crc": { readTarget: async identity => ({ target: identity, bytes: bytes(), crc32c: "AAAAAA==" }) },
    "wrong metadata crc": { inspectTarget: async identity => ({ target: identity, sizeBytes: 9, crc32c: "AAAAAA==" }) },
    "truncated source": { openSource: async identity => ({ identity, bytes: bytes(body.subarray(0, 8)) }) },
    "overlong source": { openSource: async identity => ({ identity, bytes: bytes(Buffer.concat([body, Buffer.from("x")])) }) },
    "changed source identity": { inspectSource: async identity => ({ ...identity, version: "changed" }) },
    "incomplete upload consumption": { writeTarget: async () => ({ target: target(), sizeBytes: 9, crc32c: "4waSgw==" }) },
    "upload interruption": { writeTarget: async request => { for await (const _ of request.bytes) throw new Error("interrupted"); } },
  }
  for (const [name, overrides] of Object.entries(faults)) await context.test(name, () => assert.rejects(copyStorageObject(source(), copyAdapters(overrides), operation())))
  let inspection = 0
  await assert.rejects(copyStorageObject(source(), copyAdapters({ inspectSource: async identity => ++inspection === 1 ? identity : { ...identity, version: "changed-after" } }), operation()))
  let targetInspection = 0
  await assert.rejects(copyStorageObject(source(), copyAdapters({ inspectTarget: async identity => ({ target: ++targetInspection === 1 ? identity : { ...identity, generation: "999" }, sizeBytes: 9, crc32c: "4waSgw==" }) }), operation()))
  let lateSourceInspection = 0
  await assert.rejects(copyStorageObject(source(), copyAdapters({ inspectSource: async identity => ++lateSourceInspection < 3 ? identity : { ...identity, version: "changed-during-readback" } }), operation()))
})

test("reuse reads exact prior generation and cannot trust metadata alone", async () => {
  const adapters = copyAdapters()
  assert.deepEqual(await reuseVerifiedCopy(source(), evidence(), adapters, operation()), evidence())
  assert.equal(adapters.events.includes("source-open"), false)
  assert.equal(adapters.events.includes("target-read"), true)
  await assert.rejects(reuseVerifiedCopy({ ...source(), version: "new" }, evidence(), adapters, operation()))
  await assert.rejects(reuseVerifiedCopy(source(), evidence(), copyAdapters({ readTarget: async identity => ({ target: identity, bytes: bytes(Buffer.from("wrongbyte")), crc32c: "4waSgw==" }) }), operation()))
})

test("bounded chunks, abort and deadline close cooperative streams", async () => {
  let closed = false
  async function* oversized() { try { yield Buffer.alloc(STORAGE_MEDIA_LIMITS.inputChunkBytes + 1) } finally { closed = true } }
  await assert.rejects(measureByteStream(oversized(), { expectedBytes: STORAGE_MEDIA_LIMITS.inputChunkBytes + 1 }, operation()), /chunk/)
  assert.equal(closed, true)
  const aborter = new AbortController()
  async function* aborted() { try { yield body.subarray(0, 3); aborter.abort(); yield body.subarray(3) } finally { closed = true } }
  closed = false
  await assert.rejects(measureByteStream(aborted(), { expectedBytes: 9 }, { ...operation(), signal: aborter.signal }), /abort/i)
  assert.equal(closed, true)
  await assert.rejects(measureByteStream(bytes(), { expectedBytes: 9 }, { ...operation(), deadline: tick - 1 }), /deadline/)
})

test("pair mappings bind exact trusted IDs, raw receipt, logical hash, checkpoint and section hash separately", () => {
  const fixture = pairFixture()
  assert.deepEqual(validateRecoveryPairMapping(fixture.mapping), fixture.mapping)
  assert.equal(fixture.mapping.historicalByteCorrespondence, "unproved")
  assert.equal(fixture.mapping.artifacts[0].uploadedFileSha256, fixture.artifacts[0].uploadedFileSha256)
  assert.equal(fixture.mapping.artifacts[0].logicalArtifactSha256, fixture.artifacts[0].logicalArtifactSha256)
  assert.notEqual(fixture.mapping.artifacts[0].sectionSha256, fixture.mapping.artifacts[0].uploadedFileSha256)
  const replacement = clone(fixture)
  replacement.artifacts[0].driveFileId = "new-retained-id"
  replacement.extracted[0].driveFileId = "new-retained-id"
  assert.notDeepEqual(buildRecoveryPairMapping({ sourceBucket: source().bucket, ...replacement, checkedAt: fixture.mapping.checkedAt }), fixture.mapping)
  for (const modify of [
    value => { value.artifacts[0].uploadedFileSha256 = "f".repeat(64) },
    value => { value.artifacts[0].fileByteLength++ },
    value => { value.artifacts[0].logicalArtifactSha256 = "f".repeat(64) },
    value => { value.artifacts[0].checkpoint.headSequence++ },
    value => { value.extracted[0].driveFileId = "removed-id" },
    value => { value.artifacts[1] = value.artifacts[0] },
    value => { value.extracted[0].result.references[0].path = "missing/path" },
    value => { value.extracted[0].result.references[0].expectedBytes = 10 },
    value => { value.extracted[0].result.references.push(value.extracted[0].result.references[0]) },
  ]) {
    const value = clone(fixture); modify(value)
    assert.throws(() => buildRecoveryPairMapping({ sourceBucket: source().bucket, ...value, checkedAt: fixture.mapping.checkedAt }))
  }
})

test("manifest inventories all 15 objects including 9 unreferenced and rejects omissions/conflicts", () => {
  const { manifest } = manifestFixture()
  assert.equal(manifest.inventory.length, 15)
  assert.equal(manifest.copies.length, 15)
  assert.equal(manifest.pair.artifacts.flatMap(artifact => artifact.references).length, 6)
  assert.deepEqual(validateCopyManifest(manifest), manifest)
  for (const modify of [
    value => { value.copies.pop() }, value => { value.inventory.pop() },
    value => { value.copies[0].source.version = "changed" },
    value => { value.copies[1].target = value.copies[0].target },
    value => { value.pair.artifacts[0].references[0].target.generation = "999" },
    value => { value.status = "partial" }, value => { value.unknown = true },
  ]) { const value = clone(manifest); modify(value); assert.throws(() => validateCopyManifest(value)) }
})

function publicationAdapters(manifest, artifacts, overrides = {}) {
  const encoded = encodeCopyManifest(manifest)
  const receipt = { target: { ...target(), objectName: "manifests/run-a.json" }, sizeBytes: encoded.length, crc32c: checksum(encoded) }
  return {
    receipt,
    inspectManifest: async identity => ({ target: clone(identity), sizeBytes: encoded.length, crc32c: checksum(encoded) }),
    readManifest: async identity => ({ target: clone(identity), bytes: bytes(encoded, 40), crc32c: checksum(encoded) }),
    readRetainedPair: async () => ({ artifacts: clone(artifacts), checkedAt: new Date(tick).toISOString() }),
    ...overrides,
  }
}

test("control CAS atomically fences acquisition/publication/release; stale A cannot alter B", async () => {
  const control = controlAdapter(), { manifest, artifacts } = manifestFixture()
  const a = await acquireMediaLease(control, { owner: "A", ttlMs: 100 }, operation())
  assert.ok(a)
  assert.equal(await acquireMediaLease(control, { owner: "B", ttlMs: 100 }, operation()), null)
  tick += 101
  const b = await acquireMediaLease(control, { owner: "B", ttlMs: 1000 }, operation())
  const adapters = publicationAdapters(manifest, artifacts)
  const bManifest = { ...manifest, runId: "B" }
  const bAdapters = publicationAdapters(bManifest, artifacts)
  const bAfter = await publishMediaSuccess(control, b, bManifest, bAdapters.receipt, bAdapters, operation())
  assert.equal(control.snapshot().record.latestSuccess.runId, "B")
  await assert.rejects(publishMediaSuccess(control, a, manifest, adapters.receipt, adapters, operation()), /ownership|fence/)
  assert.equal(await releaseMediaLease(control, a, operation()), false)
  assert.equal(control.snapshot().record.lease.owner, "B")
  assert.equal(await releaseMediaLease(control, bAfter, operation()), true)
  assert.equal(control.snapshot().record.lease, null)
  assert.equal(control.snapshot().record.latestSuccess.runId, "B")
  validateControlRecord(control.snapshot().record)
})

test("failed manifest readback or pair rotation never replaces previous success", async () => {
  const { manifest, artifacts } = manifestFixture()
  for (const fault of ["bytes", "truncated", "generation", "crc", "rotation", "removal", "receipt", "after-generation"]) {
    const control = controlAdapter()
    let token = await acquireMediaLease(control, { owner: "run-a", ttlMs: 10000 }, operation())
    const adapters = publicationAdapters(manifest, artifacts)
    token = await publishMediaSuccess(control, token, manifest, adapters.receipt, adapters, operation())
    const before = control.snapshot()
    const bad = publicationAdapters(manifest, artifacts)
    if (fault === "bytes") bad.readManifest = async identity => ({ target: identity, bytes: bytes(Buffer.from("wrong")), crc32c: bad.receipt.crc32c })
    if (fault === "truncated") bad.readManifest = async identity => ({ target: identity, bytes: bytes(encodeCopyManifest(manifest).subarray(0, -1)), crc32c: bad.receipt.crc32c })
    if (fault === "generation") bad.readManifest = async identity => ({ target: { ...identity, generation: "999" }, bytes: bytes(encodeCopyManifest(manifest)), crc32c: bad.receipt.crc32c })
    if (fault === "crc") bad.receipt.crc32c = "AAAAAA=="
    if (fault === "rotation") bad.readRetainedPair = async () => ({ artifacts: [{ ...artifacts[0], driveFileId: "new-id" }, artifacts[1]], checkedAt: new Date(tick).toISOString() })
    if (fault === "removal") bad.readRetainedPair = async () => ({ artifacts: [artifacts[0]], checkedAt: new Date(tick).toISOString() })
    if (fault === "receipt") bad.readRetainedPair = async () => ({ artifacts: [{ ...artifacts[0], uploadedFileSha256: "e".repeat(64) }, artifacts[1]], checkedAt: new Date(tick).toISOString() })
    if (fault === "after-generation") { let reads = 0; bad.inspectManifest = async identity => ({ target: ++reads === 1 ? identity : { ...identity, generation: "999" }, sizeBytes: encodeCopyManifest(manifest).length, crc32c: bad.receipt.crc32c }) }
    await assert.rejects(publishMediaSuccess(control, token, manifest, bad.receipt, bad, operation()))
    assert.deepEqual(control.snapshot(), before)
  }
})

test("fence remains monotonic with same owner name, malformed control fails closed, adapters expose no deletion API", async () => {
  const control = controlAdapter()
  const old = await acquireMediaLease(control, { owner: "same", ttlMs: 1 }, operation())
  tick += 2
  const newer = await acquireMediaLease(control, { owner: "same", ttlMs: 1000 }, operation())
  assert.equal(newer.fence, old.fence + 1)
  assert.equal(await releaseMediaLease(control, old, operation()), false)
  assert.equal(await releaseMediaLease(control, newer, operation()), true)
  assert.throws(() => validateControlRecord({ schema: "wrong" }))
  assert.deepEqual(Object.keys(control).sort(), ["compareAndSwap", "read", "snapshot"])
})

test("A paused during readback cannot publish or release after B takes over and publishes", async () => {
  const control = controlAdapter(), { manifest, artifacts } = manifestFixture()
  const aManifest = { ...manifest, runId: "A" }, bManifest = { ...manifest, runId: "B" }
  const a = await acquireMediaLease(control, { owner: "A", ttlMs: 10 }, operation())
  let resume, entered
  const paused = new Promise(resolve => { resume = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const aAdapters = publicationAdapters(aManifest, artifacts)
  const originalRead = aAdapters.readManifest
  aAdapters.readManifest = async (identity, context) => { entered(); await paused; return originalRead(identity, context) }
  const aAttempt = publishMediaSuccess(control, a, aManifest, aAdapters.receipt, aAdapters, operation())
  await started
  tick += 11
  const b = await acquireMediaLease(control, { owner: "B", ttlMs: 1000 }, operation())
  const bAdapters = publicationAdapters(bManifest, artifacts)
  await publishMediaSuccess(control, b, bManifest, bAdapters.receipt, bAdapters, operation())
  const publishedB = control.snapshot()
  resume()
  await assert.rejects(aAttempt, /ownership|fence/)
  assert.equal(await releaseMediaLease(control, a, operation()), false)
  assert.deepEqual(control.snapshot(), publishedB)
})

test("same-generation simultaneous lease acquisition permits at most one winner", async () => {
  const control = controlAdapter()
  const results = await Promise.all(["A", "B"].map(owner => acquireMediaLease(control, { owner, ttlMs: 1000 }, operation())))
  assert.equal(results.filter(Boolean).length, 1)
  assert.equal(control.snapshot().record.fence, 1)
})

test("successful and failed copy paths never call source cleanup, archive deletion, ACL or resources", async () => {
  let forbidden = 0
  const forbiddenCall = () => { forbidden++; throw new Error("Forbidden provider mutation") }
  const extra = { remove: forbiddenCall, delete: forbiddenCall, deleteGeneration: forbiddenCall, setIamPolicy: forbiddenCall, createBucket: forbiddenCall, createJob: forbiddenCall }
  await copyStorageObject(source(), { ...copyAdapters(), ...extra }, operation())
  await assert.rejects(copyStorageObject(source(), { ...copyAdapters({ readTarget: async () => { throw new Error("readback failed") } }), ...extra }, operation()))
  assert.equal(forbidden, 0)
})

test("strict shape/metadata/reference bounds fail closed without accepting sparse or accessor input", () => {
  assert.throws(() => validateInventory(Array(1)), /sparse/)
  const accessor = source(); Object.defineProperty(accessor, "version", { enumerable: true, get() { throw new Error("Getter must not execute") } })
  assert.throws(() => validateSourceIdentity(accessor), /exact fields/)
  const fixture = pairFixture()
  fixture.artifacts[0].checkpoint = { padding: "x".repeat(STORAGE_MEDIA_LIMITS.checkpointBytes + 1) }
  assert.throws(() => buildRecoveryPairMapping({ sourceBucket: source().bucket, ...fixture, checkedAt: fixture.mapping.checkedAt }), /bounded/)
  const tooMany = pairFixture()
  tooMany.extracted[0].result.references = Array(STORAGE_MEDIA_LIMITS.referencesPerArtifact + 1)
  assert.throws(() => buildRecoveryPairMapping({ sourceBucket: source().bucket, ...tooMany, checkedAt: tooMany.mapping.checkedAt }), /bounded/)
})

function malformedPairArray(values, kind, onGetter) {
  const result = [...values]
  if (kind === "accessor") Object.defineProperty(result, "0", { enumerable: true, configurable: true, get() { onGetter(); return values[0] } })
  if (kind === "sparse") delete result[0]
  if (kind === "extra") result.unexpected = true
  return result
}
function successfulControlRecord(artifacts) {
  return { schema: "fcuno.storage-media-control/v1", fence: 1, lease: { owner: "run-a", expiresAt: tick + 1000 }, latestSuccess: {
    runId: "run-a", manifest: { target: target(), sizeBytes: 9, crc32c: "4waSgw==", byteSha256: sha(body) },
    observedPair: { artifacts, checkedAt: new Date(tick).toISOString() },
  } }
}

test("all public mapping and control validators reject malformed exact-pair arrays without executing getters", () => {
  const fixture = manifestFixture()
  let getters = 0
  for (const kind of ["accessor", "sparse", "extra"]) {
    const bad = values => malformedPairArray(values, kind, () => { getters++ })
    const mapping = { ...fixture.mapping, artifacts: bad(fixture.mapping.artifacts) }
    const manifest = { ...fixture.manifest, pair: mapping }
    assert.throws(() => buildRecoveryPairMapping({ sourceBucket: source().bucket, ...fixture, artifacts: bad(fixture.artifacts), checkedAt: fixture.mapping.checkedAt }), /sparse|accessor|unexpected/)
    assert.throws(() => buildRecoveryPairMapping({ sourceBucket: source().bucket, ...fixture, extracted: bad(fixture.extracted), checkedAt: fixture.mapping.checkedAt }), /sparse|accessor|unexpected/)
    assert.throws(() => validateRecoveryPairMapping(mapping), /sparse|accessor|unexpected/)
    assert.throws(() => validateCopyManifest(manifest), /sparse|accessor|unexpected/)
    assert.throws(() => encodeCopyManifest(manifest), /sparse|accessor|unexpected/)
    const { schema, status, ...inputs } = manifest
    assert.throws(() => buildCopyManifest(inputs), /sparse|accessor|unexpected/)
    assert.throws(() => validateControlRecord(successfulControlRecord(bad(fixture.artifacts))), /sparse|accessor|unexpected/)
    assert.equal(getters, 0)
  }
})

test("lease/publication paths reject malformed stored or final-catalog pairs without getters or CAS writes", async () => {
  const { manifest, artifacts } = manifestFixture()
  const held = { owner: "run-a", fence: 1, generation: "1" }
  let getters = 0, writes = 0
  for (const kind of ["accessor", "sparse", "extra"]) {
    const bad = () => malformedPairArray(artifacts, kind, () => { getters++ })
    const control = { read: async () => ({ generation: "1", record: successfulControlRecord(bad()) }), compareAndSwap: async () => { writes++; throw new Error("Must not write") } }
    await assert.rejects(acquireMediaLease(control, { owner: "other", ttlMs: 100 }, operation()), /sparse|accessor|unexpected/)
    await assert.rejects(releaseMediaLease(control, held, operation()), /sparse|accessor|unexpected/)
    const adapters = publicationAdapters(manifest, artifacts)
    await assert.rejects(publishMediaSuccess(control, held, manifest, adapters.receipt, adapters, operation()), /sparse|accessor|unexpected/)
    const goodControl = controlAdapter()
    const token = await acquireMediaLease(goodControl, { owner: "run-a", ttlMs: 1000 }, operation())
    const before = goodControl.snapshot()
    adapters.readRetainedPair = async () => ({ artifacts: bad(), checkedAt: new Date(tick).toISOString() })
    await assert.rejects(publishMediaSuccess(goodControl, token, manifest, adapters.receipt, adapters, operation()), /sparse|accessor|unexpected/)
    assert.deepEqual(goodControl.snapshot(), before)
    assert.equal(getters, 0)
    assert.equal(writes, 0)
  }
})
