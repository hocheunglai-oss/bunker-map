import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { once } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  createCompressedBackupStage,
  createCompressedBackupStageReadStream,
} from "../lib/compressedBackupStage"

test("production staging limit preserves temporary-disk headroom", async () => {
  const route = await import("node:fs/promises").then(({ readFile }) =>
    readFile(
      new URL("../app/api/backups/bunker-map-drive/route.ts", import.meta.url),
      "utf8"
    )
  )

  assert.match(route, /MAX_COMPRESSED_STAGING_BYTES = 480 \* 1024 \* 1024/)
  assert.doesNotMatch(route, /MAX_COMPRESSED_STAGING_BYTES = 512 \* 1024 \* 1024/)
})

async function writeChunk(
  writable: ReturnType<typeof createCompressedBackupStage>["writable"],
  value: Buffer
) {
  if (!writable.write(value)) await once(writable, "drain")
}

test("Brotli staging round-trips a logical backup larger than its storage limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compressed-backup-stage-"))
  const filePath = join(directory, "data.json.gz")
  try {
    const source = Buffer.from(
      JSON.stringify({
        auditLogs: Array.from({ length: 20_000 }, (_, index) => ({
          id: index,
          action: "verified-backup-test",
        })),
      })
    )
    assert.ok(source.byteLength > 512 * 1024)

    const stage = createCompressedBackupStage(filePath, 64 * 1024)
    await writeChunk(stage.writable, source)
    stage.writable.end()
    const completed = await stage.complete()

    assert.ok(completed.storedByteLength < 64 * 1024)
    const restoredChunks: Buffer[] = []
    for await (const chunk of createCompressedBackupStageReadStream(filePath)) {
      restoredChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    assert.deepEqual(Buffer.concat(restoredChunks), source)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("compressed staging fails closed when compressed bytes exceed the bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compressed-backup-limit-"))
  const filePath = join(directory, "data.json.gz")
  try {
    const source = Buffer.allocUnsafe(64 * 1024)
    for (let index = 0; index < source.length; index += 1) {
      source[index] = index % 251
    }

    const stage = createCompressedBackupStage(filePath, 128)
    await writeChunk(stage.writable, source)
    stage.writable.end()
    await assert.rejects(
      stage.complete(),
      /Compressed backup staging data exceeds the 128-byte bounded temporary-storage limit/
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
