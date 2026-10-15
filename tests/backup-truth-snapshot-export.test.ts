import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { streamReferencedTruthSnapshots } from "../lib/backupTruthSnapshotExport"
import { createCompressedBackupStage, createCompressedBackupStageReadStream } from "../lib/compressedBackupStage"
import { actualSnapshotSection, directRead, snapshotClient, snapshotRow } from "./fixtures/backup-truth-snapshot-export"

test("each actual PostgREST query fetches one exact indexed identity, preserving every field in deterministic order", async () => {
  const rows = [snapshotRow('{"name":"Synthetic α"}', { extension: { preserved: true } }), snapshotRow('{"name":"Synthetic B"}')]
  const unrelated = snapshotRow('{"name":"Not referenced"}')
  const byHash = new Map([...rows, unrelated].map((row) => [row.snapshot_sha256, row]))
  const f = snapshotClient((hash) => [byHash.get(hash)])
  const saved: unknown[] = []
  const count = await streamReferencedTruthSnapshots({ readSnapshot: f.readSnapshot, snapshotHashes: rows.map((row) => row.snapshot_sha256).reverse(), retryRead: directRead, appendRows: async (batch) => { assert.equal(batch.length, 1); saved.push(...batch) } })
  assert.equal(count, 2)
  assert.deepEqual(saved, rows.sort((a, b) => a.snapshot_sha256.localeCompare(b.snapshot_sha256)))
  assert.deepEqual(f.requests.map((url) => url.searchParams.get("snapshot_sha256")!.slice(3)), rows.map((row) => row.snapshot_sha256))
  assert.ok(!f.requests.some((url) => url.search.includes(unrelated.snapshot_sha256)))
})

test("more than 500 referenced snapshots are exported exactly once without any row-count page cutoff", async () => {
  const rows = Array.from({ length: 507 }, (_, index) => snapshotRow(JSON.stringify({ index })))
  const byHash = new Map(rows.map((row) => [row.snapshot_sha256, row]))
  const f = snapshotClient((hash) => [byHash.get(hash)]), seen: string[] = []
  assert.equal(await streamReferencedTruthSnapshots({ readSnapshot: f.readSnapshot, snapshotHashes: byHash.keys(), retryRead: directRead, appendRows: async (batch) => { seen.push((batch[0] as { snapshot_sha256: string }).snapshot_sha256) } }), 507)
  assert.deepEqual(seen, [...byHash.keys()].sort())
  assert.equal(f.requests.length, 507)
  assert.equal(new Set(seen).size, 507)
})

test("empty references do not touch transport or writer; malformed and duplicate requested identities fail before reading", async () => {
  const f = snapshotClient(() => assert.fail("No reads"))
  const options = { readSnapshot: f.readSnapshot, retryRead: directRead, appendRows: async () => assert.fail("No writes") }
  assert.equal(await streamReferencedTruthSnapshots({ ...options, snapshotHashes: [] }), 0)
  for (const hashes of [["invalid"], ["a".repeat(64), "a".repeat(64)], [null as unknown as string]]) {
    await assert.rejects(() => streamReferencedTruthSnapshots({ ...options, snapshotHashes: hashes }), /identity/)
  }
  assert.equal(f.requests.length, 0)
})

test("missing, duplicate, unexpected, malformed, empty, hash-corrupt and byte-corrupt rows stop immediately without a write", async () => {
  const row = snapshotRow('{"name":"Synthetic α"}')
  const cases: unknown[] = [null, {}, [], [row, row], [null], [[]], [{ ...row, snapshot_sha256: "a".repeat(64) }], [{ ...row, canonical_json: "" }], [{ ...row, canonical_json: "different", byte_length: 9 }], [{ ...row, byte_length: row.byte_length + 1 }], [{ ...row, byte_length: String(row.byte_length) }]]
  for (const result of cases) {
    const f = snapshotClient(() => result)
    await assert.rejects(() => streamReferencedTruthSnapshots({ readSnapshot: f.readSnapshot, snapshotHashes: [row.snapshot_sha256, "f".repeat(64)], retryRead: directRead, appendRows: async () => assert.fail("Invalid row must not reach the writer") }), /snapshot/)
    assert.equal(f.requests.length, 1)
  }
})

test("transport errors and writer failures propagate without reading the next referenced identity", async () => {
  const rows = [snapshotRow('{"index":1}'), snapshotRow('{"index":2}')].sort((a, b) => a.snapshot_sha256.localeCompare(b.snapshot_sha256))
  for (const transportFails of [true, false]) {
    const f = snapshotClient(() => { if (transportFails) throw Error("Synthetic network outage"); return [rows[0]] })
    await assert.rejects(() => streamReferencedTruthSnapshots({ readSnapshot: f.readSnapshot, snapshotHashes: rows.map((row) => row.snapshot_sha256), retryRead: directRead, appendRows: async () => { throw Error("Synthetic writer failure") } }))
    assert.equal(f.requests.length, transportFails ? 4 : 1)
    assert.ok(f.requests.every((url) => url.searchParams.get("snapshot_sha256") === `eq.${rows[0].snapshot_sha256}`))
  }
})

test("writer backpressure prevents prefetch, and the supplied read retry is used for each exact request", async () => {
  const rows = [snapshotRow('{"index":1}'), snapshotRow('{"index":2}')].sort((a, b) => a.snapshot_sha256.localeCompare(b.snapshot_sha256))
  const f = snapshotClient((hash) => [rows.find((row) => row.snapshot_sha256 === hash)])
  let release!: () => void, blocked!: () => void
  const ready = new Promise<void>((resolve) => { blocked = resolve }), gate = new Promise<void>((resolve) => { release = resolve })
  const names: string[] = []
  let writes = 0
  const result = streamReferencedTruthSnapshots({ readSnapshot: f.readSnapshot, snapshotHashes: rows.map((row) => row.snapshot_sha256), retryRead: async (operation, name) => { names.push(name); return directRead(operation) }, appendRows: async () => { if (++writes === 1) { blocked(); await gate } } })
  await ready
  assert.equal(f.requests.length, 1)
  release()
  assert.equal(await result, 2)
  assert.equal(names.length, 2)
  assert.ok(names.every((name) => name.startsWith("export outlook_exchange_truth_snapshots snapshot ")))
})

test("actual production section retains its schema, section checksum, checkpoint count and existing transient retry policy", async () => {
  const canonical = '{\r\n  "z": -0, "amount": 1e+3, "escaped": "\\uD83D\\uDE80", "literal": "🚀", "path": "C:\\\\synthetic", "a": 2\r\n}'
  const row = snapshotRow(canonical, { extension: true })
  assert.ok(row.byte_length > canonical.length)
  const f = snapshotClient((_hash, call) => call === 1 ? new Response(JSON.stringify({ message: "Synthetic network outage" }), { status: 502, headers: { "content-type": "application/json" } }) : [row])
  const directory = await mkdtemp(join(tmpdir(), "snapshot-section-")), path = join(directory, "data.json.br")
  const stage = createCompressedBackupStage(path, 1024 * 1024), writer = { stream: stage.writable, stage, sourceByteLength: 0 }
  try {
    const sections: Record<string, unknown> = {}, counts: Record<string, number> = {}
    const result = await actualSnapshotSection()(f.supabase, new Set([row.snapshot_sha256]), writer, sections, counts, 1)
    stage.writable.end(); await stage.complete()
    const chunks: Buffer[] = []
    for await (const chunk of createCompressedBackupStageReadStream(path)) chunks.push(Buffer.from(chunk))
    const actual = Buffer.concat(chunks).toString("utf8")
    assert.equal(actual, `"outlookExchangeTruthSnapshots":[${JSON.stringify(row)}]`)
    assert.deepEqual(sections.outlookExchangeTruthSnapshots, { rowCount: 1, sha256: createHash("sha256").update(`[${JSON.stringify(row)}]`).digest("hex") })
    assert.deepEqual(counts, { outlookExchangeTruthSnapshots: 1 })
    assert.equal(result.snapshotCount, 1)
    assert.deepEqual([...result.seenSnapshotHashes], [row.snapshot_sha256])
    assert.equal(f.requests.length, 2)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("captured reference identities cannot be changed by a caller while the writer is awaited", async () => {
  const rows = [snapshotRow('{"index":1}'), snapshotRow('{"index":2}')].sort((a, b) => a.snapshot_sha256.localeCompare(b.snapshot_sha256))
  const hashes = new Set(rows.map((row) => row.snapshot_sha256))
  const f = snapshotClient((hash) => [rows.find((row) => row.snapshot_sha256 === hash)])
  let written = 0
  assert.equal(await streamReferencedTruthSnapshots({ readSnapshot: f.readSnapshot, snapshotHashes: hashes, retryRead: directRead, appendRows: async () => {
    if (++written === 1) { hashes.clear(); hashes.add("f".repeat(64)) }
  } }), 2)
  assert.equal(f.requests.length, 2)
  assert.ok(f.requests.every((url) => !url.search.includes("f".repeat(64))))
})

test("actual section handles zero references and rejects checkpoint mismatch or a later missing snapshot without acknowledging success", async () => {
  const rows = [snapshotRow('{"index":1}'), snapshotRow('{"index":2}'), snapshotRow('{"index":3}')].sort((a, b) => a.snapshot_sha256.localeCompare(b.snapshot_sha256))
  for (const scenario of ["empty", "count-mismatch", "later-missing"]) {
    const f = snapshotClient((_hash, call) => scenario === "later-missing" && call > 1 ? [] : [rows[0]])
    const directory = await mkdtemp(join(tmpdir(), "snapshot-section-fault-")), path = join(directory, "data.json.br")
    const stage = createCompressedBackupStage(path, 1024 * 1024), writer = { stream: stage.writable, stage, sourceByteLength: 0 }
    const sections: Record<string, unknown> = {}, counts: Record<string, number> = {}
    let closed = false
    try {
      const hashes = new Set(scenario === "empty" ? [] : scenario === "later-missing" ? rows.map((row) => row.snapshot_sha256) : [rows[0].snapshot_sha256])
      const result = actualSnapshotSection()(f.supabase, hashes, writer, sections, counts, scenario === "empty" ? 0 : scenario === "count-mismatch" ? 2 : 3)
      if (scenario === "empty") { assert.equal((await result).snapshotCount, 0); assert.equal(f.requests.length, 0); assert.deepEqual(counts, { outlookExchangeTruthSnapshots: 0 }) }
      else { await assert.rejects(result, scenario === "count-mismatch" ? /Expected 2 referenced truth snapshot/ : /exactly one referenced truth snapshot/) }
      if (scenario === "later-missing") { assert.equal(f.requests.length, 2); assert.deepEqual(sections, {}); assert.deepEqual(counts, {}) }
      stage.writable.end(); await stage.complete(); closed = true
    } finally {
      if (!closed) { stage.abort(Error("Synthetic section fault")); await stage.complete().catch(() => {}) }
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test("actual export pipeline streams 71 roughly3MB documents through production serialization and Brotli with a128MiB old-space cap", { timeout: 120_000 }, async (context) => {
  const report = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=128", "--import", "tsx", fileURLToPath(new URL("./fixtures/backup-truth-snapshot-export-scale.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "pipe", "pipe"], signal: context.signal,
    })
    let output = "", error = ""
    child.stdout.on("data", (chunk) => { output += chunk })
    child.stderr.on("data", (chunk) => { error += chunk })
    child.on("error", reject)
    child.on("close", (code, signal) => code === 0 ? resolve(output) : reject(Error(`Scale fixture exited ${code ?? signal}: ${error.slice(-4000)}`)))
  })
  const result = JSON.parse(report)
  assert.equal(result.snapshots, 71)
  assert.equal(result.requests, 71)
  assert.equal(result.oldSpaceLimitMiB, 128)
  assert.ok(result.heapSizeLimitMiB >= result.oldSpaceLimitMiB)
  assert.ok(result.canonicalBytes > 190_000_000)
  assert.ok(result.largestCanonical <= 3_800_000)
  assert.ok(result.outputBytes > result.canonicalBytes)
  assert.ok(result.sampledPeakHeapMiB < 128)
  context.diagnostic(JSON.stringify(result))
})
