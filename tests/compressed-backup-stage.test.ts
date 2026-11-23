import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { once } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import {
  createCompressedBackupStage,
  createCompressedBackupStageReadStream,
  openUnlinkedBackupStage,
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

test("the production scratch file can be fully read back without keeping a named file on disk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "backup-private-stage-"))
  try {
    const file = await openUnlinkedBackupStage(join(directory, "data.br"))
    try {
      assert.deepEqual(await readdir(directory), [])
      assert.equal((await file.reader.stat()).nlink, 0)
      const body = Buffer.from("synthetic backup data".repeat(8192))
      const write = createCompressedBackupStage(file, 4096)
      write.writable.end(body)
      assert.ok((await write.complete()).storedByteLength > 0)
      const chunks = []
      for await (const chunk of createCompressedBackupStageReadStream(file)) chunks.push(Buffer.from(chunk))
      assert.deepEqual(Buffer.concat(chunks), body)
    } finally { await file.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("killing an actual exporter process cannot strand its compressed scratch bytes for the next invocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "backup-interrupted-stage-"))
  try {
    const lib = fileURLToPath(new URL("../lib/compressedBackupStage.ts", import.meta.url))
    const child = spawnSync(process.execPath, ["--require", "tsx/cjs", "-e", `
      const { openUnlinkedBackupStage, createCompressedBackupStage } = require(process.argv[1])
      ;(async () => {
        const file = await openUnlinkedBackupStage(process.argv[2])
        const stage = createCompressedBackupStage(file, 2 * 1024 * 1024)
        stage.writable.end(require("node:crypto").randomBytes(1024 * 1024))
        const { storedByteLength } = await stage.complete()
        if (storedByteLength < 512 * 1024 || (await file.reader.stat()).nlink !== 0) process.exit(2)
        process.kill(process.pid, "SIGKILL")
      })().catch(() => process.exit(3))
    `, lib, join(directory, "data.br")], { timeout: 10_000, encoding: "utf8" })
    assert.equal(child.error, undefined)
    assert.equal(child.signal, "SIGKILL", child.stderr)
    assert.deepEqual(await readdir(directory), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("an abandoned upload and a staging overflow both release the private file handles", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "backup-aborted-stage-"))
  try {
    for (const overflow of [false, true]) {
      const file = await openUnlinkedBackupStage(join(directory, "data.br"))
      try {
        const writer = createCompressedBackupStage(file, overflow ? 1 : 4096)
        writer.writable.end(Buffer.alloc(1024 * 1024, 97))
        if (overflow) await assert.rejects(writer.complete(), /bounded temporary-storage limit/)
        else {
          await writer.complete()
          for await (const chunk of createCompressedBackupStageReadStream(file)) {
            assert.ok(chunk.length > 0)
            break
          }
        }
      } finally { await file.close() }
      assert.equal(file.reader.fd, -1)
      assert.equal(file.writer.fd, -1)
      assert.deepEqual(await readdir(directory), [])
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
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
