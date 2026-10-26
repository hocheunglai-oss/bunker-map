import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { fcunoConnectionPolicy } from "../config/fcunoConnections.ts"
import { measureByteStream } from "../lib/storageMediaBackup.mjs"
import { recurringInventorySha256, validateRecurringMediaManifest, encodeRecurringMediaManifest } from "../lib/storageMediaRecurring.mjs"
import { runRecurringStorageMediaBackup } from "../scripts/lib/storage-media-recurring-run.mjs"
import { main } from "../scripts/backup-storage-media-to-gcs.mjs"

const policy = fcunoConnectionPolicy.storageMediaBackup
const sha = value => createHash("sha256").update(value).digest("hex")
const inventory = [0, 1].map(index => ({ bucket: policy.sourceBucket, path: `literal/file-${index}`, id: `id-${index}`, version: `version-${index}`, sizeBytes: 4 }))
const body = Buffer.from([1, 2, 3, 4])
async function* bytes(value) { yield value }
function fixture(options = {}, previous = null) {
  let tick = Date.parse("2026-10-26T18:30:00.000Z") + (options.nextDay ? 86_400_000 : 0), generation = previous?.generation || 0
  let currentControl = previous?.control ? structuredClone(previous.control) : null, reads = 0
  const objects = previous?.objects || new Map(), events = [], attempts = [], published = []
  const activeInventory = options.empty ? [] : inventory.map((item, index) => options.changedVersion && index === 0 ? { ...item, version: "replacement-version" } : item)
  const runId = options.nextDay ? "next-day-run" : "first-run"
  const context = { now: () => tick, signal: new AbortController().signal, deadline: tick + 3_300_000 }
  const windowStart = new Date(tick - 30 * 60_000).toISOString(), windowEnd = new Date(tick + 3.5 * 3_600_000).toISOString()
  const source = {
    async inventory() { reads++; return activeInventory.map((source, index) => options.changedInventory && reads > 1 && index === 0 ? { ...source, version: "changed" } : structuredClone(source)) },
    snapshot() { return { inventorySha256: recurringInventorySha256(activeInventory), windowStartsAt: windowStart, windowExpiresAt: windowEnd } },
    async inspectSource(source) { events.push("source-inspect"); return source },
    async openSource(source) { events.push("source-read"); return { identity: source, bytes: bytes(body) } },
  }
  async function save(objectName, stream, size) {
    const pieces = []; for await (const piece of stream) pieces.push(piece)
    const data = Buffer.concat(pieces), measured = await measureByteStream(bytes(data), { expectedBytes: size }, context)
    const target = { bucket: policy.targetBucket, objectName, generation: String(++generation) }
    const result = { target, sizeBytes: data.length, crc32c: measured.crc32c }
    objects.set(JSON.stringify(target), { ...result, data }); return structuredClone(result)
  }
  const gcs = {
    manifestObjectName: `${policy.targetPrefix}/daily/runs/${runId}/manifest.json`,
    async validateBucket() { events.push("validate-bucket") },
    control: {
      async read() { return currentControl && structuredClone(currentControl) },
      async compareAndSwap(expected, record) {
        events.push("cas")
        if (expected !== (currentControl?.generation || "0") || options.conflict) return null
        currentControl = { generation: String(++generation), record: structuredClone(record) }; return structuredClone(currentControl)
      },
    },
    async writeTarget(input) { events.push("object-write"); assert.equal(input.ifGenerationMatch, "0"); return save(`${policy.targetPrefix}/daily/runs/${runId}/objects/${sha(JSON.stringify(input.source))}`, input.bytes, input.source.sizeBytes) },
    async inspectTarget(target) {
      const saved = objects.get(JSON.stringify(target))
      return structuredClone({ target: saved.target, sizeBytes: saved.sizeBytes, crc32c: saved.crc32c })
    },
    async readTarget(target) {
      events.push(target.objectName.endsWith("manifest.json") ? "manifest-read" : "object-readback")
      const saved = objects.get(JSON.stringify(target))
      return { target, crc32c: saved.crc32c, bytes: bytes(options.corruptReadback && !target.objectName.endsWith("manifest.json") ? Buffer.from("nope") : saved.data) }
    },
    async uploadImmutable(input) { events.push("manifest-write"); return save(input.objectName, input.bytes, input.sizeBytes) },
  }
  const budget = { async checkOptionalWork(input) { events.push("budget"); assert.deepEqual(input.inventory, activeInventory); return { allowed: !options.paused, reason: options.paused ? "threshold" : "within-budget" } } }
  const publisher = {
    async publishHealth(manifest, publicationContext) {
      assert.equal(publicationContext.publication.owner, runId)
      assert.ok(Number.isSafeInteger(publicationContext.publication.fence))
      await publicationContext.assertOwnership()
      events.push("health-publication"); published.push(manifest)
      if (options.publicationError) throw new Error("private token must not leak")
      const encoded = encodeRecurringMediaManifest(manifest)
      return { fileId: "private-health-file", version: "1", verified: !options.unverifiedPublication, healthSha256: sha("envelope"),
        byteLength: encoded.length + 200, manifestByteLength: encoded.length, manifestSha256: sha(encoded) }
    },
    async publishAttempt(attempt, publicationContext) {
      assert.equal(publicationContext.publication.owner, runId)
      await publicationContext.assertOwnership(); attempts.push(attempt)
    },
  }
  return { source, gcs, publisher, budget, runId, context, events, attempts, published,
    state: () => ({ control: currentControl, generation, objects }), getControl: () => currentControl }
}

test("daily complete current inventory copies exact generations and publishes only after independent readbacks", async () => {
  const f = fixture(), result = await runRecurringStorageMediaBackup(f, f.context)
  assert.equal(result.status, "succeeded"); assert.equal(result.copiedObjects, 2); assert.equal(result.copiedBytes, 8)
  assert.equal(f.events.filter(event => event === "object-readback").length, 2)
  assert.ok(f.events.indexOf("health-publication") > f.events.indexOf("manifest-read"))
  assert.equal(f.getControl().record.lease, null); assert.equal(f.getControl().record.latestSuccess.runId, f.runId)
  const manifest = validateRecurringMediaManifest(f.published[0])
  assert.equal(manifest.copies.length, 2); assert.equal(manifest.scope.sourceBucket, policy.sourceBucket)
  assert.equal("pair" in manifest, false); assert.equal("historicalByteCorrespondence" in manifest, false)
})

test("same-day retry verifies pinned previous manifest without copying or republishing a falsely fresh success", async () => {
  const f = fixture(); await runRecurringStorageMediaBackup(f, f.context)
  const repeated = fixture({}, f.state()), result = await runRecurringStorageMediaBackup(repeated, repeated.context)
  assert.equal(result.status, "already-succeeded"); assert.equal(repeated.events.includes("object-write"), false)
  assert.equal(repeated.events.includes("cas"), false); assert.equal(repeated.published.length, 0)
})

test("unchanged verified same-day success needs no new budget delivery or warning publication", async () => {
  const f = fixture(); await runRecurringStorageMediaBackup(f, f.context)
  const repeated = fixture({}, f.state())
  repeated.budget.checkOptionalWork = async () => { throw new Error("No new billing delivery is available") }
  const result = await runRecurringStorageMediaBackup(repeated, repeated.context)
  assert.equal(result.status, "already-succeeded")
  assert.equal(result.runId, f.runId); assert.equal(result.copiedObjects, 0); assert.equal(result.copiedBytes, 0)
  assert.deepEqual(repeated.events, ["validate-bucket", "manifest-read"])
  assert.equal(repeated.attempts.length, 0); assert.equal(repeated.published.length, 0)
  assert.deepEqual(repeated.getControl(), f.getControl())
})

test("same-day changed source version still requires the budget guard and remains paused without new cost evidence", async () => {
  const f = fixture(); await runRecurringStorageMediaBackup(f, f.context)
  const changed = fixture({ changedVersion: true, paused: true }, f.state())
  const result = await runRecurringStorageMediaBackup(changed, changed.context)
  assert.equal(result.status, "budget-paused")
  assert.equal(changed.events.includes("budget"), true); assert.equal(changed.events.includes("object-write"), false)
  assert.equal(changed.published.length, 0); assert.equal(changed.attempts[0].state, "budget-paused")
  assert.deepEqual(changed.getControl().record.latestSuccess, f.getControl().record.latestSuccess)
})

test("same-day no-write shortcut still refuses a changed second source-inventory walk", async () => {
  const f = fixture(); await runRecurringStorageMediaBackup(f, f.context)
  const changed = fixture({ changedInventory: true }, f.state())
  changed.budget.checkOptionalWork = async () => { throw new Error("Shortcut must not call budget") }
  await assert.rejects(runRecurringStorageMediaBackup(changed, changed.context), /existing-daily-success-check/)
  assert.equal(changed.events.includes("object-write"), false); assert.equal(changed.events.includes("cas"), false)
  assert.equal(changed.attempts.length, 0); assert.equal(changed.published.length, 0)
})

test("next-day identical source versions are independently read back and reused without new media writes", async () => {
  const f = fixture(); await runRecurringStorageMediaBackup(f, f.context)
  const next = fixture({ nextDay: true }, f.state()), result = await runRecurringStorageMediaBackup(next, next.context)
  assert.equal(result.status, "succeeded"); assert.equal(result.reusedObjects, 2); assert.equal(result.copiedObjects, 0)
  assert.equal(next.events.filter(event => event === "object-readback").length, 2)
  assert.deepEqual(next.published[0].copies.map(copy => copy.target), f.published[0].copies.map(copy => copy.target))
})

test("a replaced version is copied as new evidence and does not reuse an equal path or equal size", async () => {
  const f = fixture(); await runRecurringStorageMediaBackup(f, f.context)
  const next = fixture({ nextDay: true, changedVersion: true }, f.state()), result = await runRecurringStorageMediaBackup(next, next.context)
  assert.equal(result.reusedObjects, 1); assert.equal(result.copiedObjects, 1); assert.equal(result.copiedBytes, 4)
  assert.notDeepEqual(next.published[0].copies[0].target, f.published[0].copies[0].target)
  assert.equal(next.published[0].copies[0].source.version, "replacement-version")
})

test("an honestly empty current inventory publishes zero copies without deleting retained object generations", async () => {
  const f = fixture(); await runRecurringStorageMediaBackup(f, f.context)
  const retainedTargets = f.published[0].copies.map(copy => JSON.stringify(copy.target))
  const next = fixture({ nextDay: true, empty: true }, f.state()), result = await runRecurringStorageMediaBackup(next, next.context)
  assert.equal(result.status, "succeeded"); assert.equal(result.copiedObjects, 0); assert.equal(result.reusedObjects, 0)
  assert.equal(next.published[0].inventory.length, 0); assert.equal(next.published[0].copies.length, 0)
  for (const target of retainedTargets) assert.ok(next.state().objects.has(target))
})

test("an unowned active lease cannot publish a failure or mutate another owner's control", async () => {
  const f = fixture()
  const state = f.state(); state.control = { generation: "1", record: { schema: "fcuno.storage-media-daily-control/v1", fence: 1,
    lease: { owner: "other-owner", expiresAt: f.context.now() + 60_000 }, latestSuccess: null } }; state.generation = 1
  const concurrent = fixture({}, state)
  await assert.rejects(runRecurringStorageMediaBackup(concurrent, concurrent.context), /lease-acquisition/)
  assert.equal(concurrent.attempts.length, 0); assert.equal(concurrent.published.length, 0)
  assert.equal(concurrent.events.includes("cas"), false); assert.deepEqual(concurrent.getControl(), state.control)
})

test("a previous manifest timestamp in the future cannot authorize a same-day skip or publication", async () => {
  const f = fixture(), original = f.context.now()
  f.context.now = () => original + 10 * 60_000
  await runRecurringStorageMediaBackup(f, f.context)
  const rewound = fixture({}, f.state())
  await assert.rejects(runRecurringStorageMediaBackup(rewound, rewound.context), /previous-manifest-verification/)
  assert.equal(rewound.attempts.length, 0); assert.equal(rewound.published.length, 0)
})

test("budget pause performs only safety lease writes, no object/manifest copies and preserves last-good evidence", async () => {
  const f = fixture({ paused: true }), result = await runRecurringStorageMediaBackup(f, f.context)
  assert.equal(result.status, "budget-paused"); assert.equal(f.getControl().record.latestSuccess, null); assert.equal(f.getControl().record.lease, null)
  assert.deepEqual(f.events, ["validate-bucket", "budget", "cas", "cas"]); assert.equal(f.attempts[0].state, "budget-paused")
})

test("source mutation, corrupt bytes, CAS loss and unverified publication fail closed", async () => {
  for (const options of [{ changedInventory: true }, { corruptReadback: true }, { conflict: true }, { publicationError: true }, { unverifiedPublication: true }]) {
    const f = fixture(options)
    await assert.rejects(runRecurringStorageMediaBackup(f, f.context), error => error.message.startsWith("Recurring storage media backup failed during ") && !error.message.includes("private token"))
    assert.equal(f.getControl()?.record.latestSuccess || null, null)
    if (options.conflict) assert.equal(f.attempts.length, 0)
    else assert.equal(f.attempts.at(-1).state, "failed")
  }
})

test("manifest validator rejects unrelated scope, missing copies, changed source versions and loose daily windows", async () => {
  const f = fixture(); await runRecurringStorageMediaBackup(f, f.context)
  for (const mutate of [value => { value.scope.supabaseProject = "different" }, value => { value.copies.pop() },
    value => { value.inventory[0].version = "other" }, value => { value.snapshot.windowStartsAt = "2026-10-26T18:00:01.000Z" },
    value => { value.copies[0].target.objectName = "arbitrary/path" }]) {
    const value = structuredClone(f.published[0]); mutate(value); assert.throws(() => validateRecurringMediaManifest(value))
  }
})

test("recurring entry refuses disabled activation and missing controls before provider IO", async () => {
  for (const runtime of [{ CLOUD_RUN_JOB: policy.googleJob }, { CLOUD_RUN_JOB: policy.googleJob, STORAGE_MEDIA_BACKUP_RECURRING_ENABLED: "1" }]) {
    let called = false
    await assert.rejects(main({ args: ["--execute-recurring-daily"], runtime, fetch: async () => { called = true; throw Error("unexpected") } }))
    assert.equal(called, false)
  }
})
