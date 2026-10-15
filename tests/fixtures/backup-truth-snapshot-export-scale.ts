import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { getHeapStatistics } from "node:v8"
import { createCompressedBackupStage, createCompressedBackupStageReadStream } from "../../lib/compressedBackupStage"
import { actualSnapshotSection, snapshotClient, snapshotRow } from "./backup-truth-snapshot-export"

async function main() {
const started = performance.now()
const count = 71
// Realistic full-directory snapshots: mostly unchanged multi-megabyte contact
// documents with distinct generations. Keep only one base document plus tiny
// identity metadata, never an array of 71 materialized snapshot documents.
const base = JSON.stringify({ contacts: Array.from({ length: 10_000 }, (_, index) => ({
  id: `synthetic-contact-${index}`,
  display_name: `SYNTHETIC CONTACT ${index}`,
  email: `contact-${index}@example.test`,
  company: `SYNTHETIC COMPANY ${index % 111}`,
  notes: `Synthetic recovery fixture ${index}. ${"Safe synthetic directory details. ".repeat(4)}`,
})) })
const canonical = (index: number) => `{"generation":${index},"projection":${base}}`
const indices = new Map<string, number>()
for (let index = 0; index < count; index += 1) indices.set(createHash("sha256").update(canonical(index)).digest("hex"), index)
assert.equal(indices.size, count)
assert.ok(Buffer.byteLength(canonical(0)) >= 2_800_000)
assert.ok(Buffer.byteLength(canonical(0)) <= 3_800_000)

let fetched = 0, canonicalBytes = 0, largestCanonical = 0
const expectedWire = createHash("sha256").update('"outlookExchangeTruthSnapshots":[')
const expectedSection = createHash("sha256").update("[")
const f = snapshotClient((hash) => {
  const index = indices.get(hash)
  assert.notEqual(index, undefined)
  const row = snapshotRow(canonical(index!))
  assert.equal(row.snapshot_sha256, hash)
  canonicalBytes += row.byte_length
  largestCanonical = Math.max(largestCanonical, row.byte_length)
  const text = `${fetched++ ? "," : ""}${JSON.stringify(row)}`
  expectedWire.update(text); expectedSection.update(text)
  return [row]
})
const directory = await mkdtemp(join(tmpdir(), "truth-snapshot-scale-")), path = join(directory, "data.json.br")
const stage = createCompressedBackupStage(path, 480 * 1024 * 1024), writer = { stream: stage.writable, stage, sourceByteLength: 0 }
const sections: Record<string, unknown> = {}, counts: Record<string, number> = {}
let completed = false, peakHeap = process.memoryUsage().heapUsed
const sample = setInterval(() => { peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed) }, 5)
try {
  const result = await actualSnapshotSection()(f.supabase, new Set([...indices.keys()].reverse()), writer, sections, counts, count)
  stage.writable.end()
  const stored = await stage.complete()
  completed = true
  expectedWire.update("]"); expectedSection.update("]")
  const actualWire = createHash("sha256")
  let restoredBytes = 0
  for await (const chunk of createCompressedBackupStageReadStream(path)) { actualWire.update(chunk); restoredBytes += chunk.length }
  assert.equal(actualWire.digest("hex"), expectedWire.digest("hex"))
  assert.equal(restoredBytes, writer.sourceByteLength)
  assert.equal(result.snapshotCount, count)
  assert.equal(result.seenSnapshotHashes.size, count)
  assert.equal(f.requests.length, count)
  assert.deepEqual(counts, { outlookExchangeTruthSnapshots: count })
  assert.deepEqual(sections.outlookExchangeTruthSnapshots, { rowCount: count, sha256: expectedSection.digest("hex") })
  assert.ok(canonicalBytes > 190_000_000)
  console.log(JSON.stringify({ snapshots: count, canonicalBytes, largestCanonical, outputBytes: restoredBytes, compressedBytes: stored.storedByteLength, requests: f.requests.length,
    elapsedMs: Math.round(performance.now() - started), oldSpaceLimitMiB: 128, heapSizeLimitMiB: Math.ceil(getHeapStatistics().heap_size_limit / 1024 / 1024),
    sampledPeakHeapMiB: Math.ceil(peakHeap / 1024 / 1024), maxRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024) }))
} finally {
  clearInterval(sample)
  if (!completed) { stage.abort(Error("Synthetic scale fixture stopped")); await stage.complete().catch(() => {}) }
  await rm(directory, { recursive: true, force: true })
}
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
