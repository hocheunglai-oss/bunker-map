import { createReadStream, createWriteStream } from "node:fs"
import { open, unlink, type FileHandle } from "node:fs/promises"
import { Transform, type TransformCallback } from "node:stream"
import { pipeline } from "node:stream/promises"
import {
  constants,
  createBrotliCompress,
  createBrotliDecompress,
} from "node:zlib"

class StoredByteLimit extends Transform {
  byteLength = 0

  constructor(private readonly maximumByteLength: number) {
    super()
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ) {
    this.byteLength += chunk.byteLength
    if (this.byteLength > this.maximumByteLength) {
      callback(
        new Error(
          `Compressed backup staging data exceeds the ${this.maximumByteLength}-byte bounded temporary-storage limit.`
        )
      )
      return
    }
    callback(null, chunk)
  }
}

// The caller supplies a new path inside its own private directory. On our
// POSIX host, removing the name before writing means a hard process stop
// releases the bytes even when the route's finally block cannot run.
export async function openUnlinkedBackupStage(path: string) {
  const writer = await open(path, "wx", 0o600)
  let reader: FileHandle | undefined
  try {
    reader = await open(path, "r")
    await unlink(path)
    const handles = [reader, writer]
    return { reader, writer, close: async () => { await Promise.all(handles.map(handle => handle.close())) } }
  } catch (error) {
    await Promise.allSettled([writer.close(), reader?.close()])
    throw error
  }
}

export type UnlinkedBackupStage = Awaited<ReturnType<typeof openUnlinkedBackupStage>>

export function createCompressedBackupStage(
  file: string | UnlinkedBackupStage,
  maximumByteLength: number
) {
  if (!Number.isSafeInteger(maximumByteLength) || maximumByteLength < 1) {
    throw new Error("Compressed backup staging limit must be a positive integer.")
  }

  // Audit snapshots can contain multi-megabyte before/after documents. Gzip's
  // 32 KiB window cannot reuse that distant repetition, which caused the
  // bounded staging file to exceed /tmp even though the logical backup was
  // still valid. Brotli's larger window keeps the same private, bounded staging
  // design while compressing those repeated snapshots efficiently.
  const writable = createBrotliCompress({
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 3,
      [constants.BROTLI_PARAM_LGWIN]: 24,
    },
  })
  const limiter = new StoredByteLimit(maximumByteLength)
  let failure: Error | null = null
  const settled = pipeline(
    writable,
    limiter,
    typeof file === "string" ? createWriteStream(file, { flags: "wx", mode: 0o600 }) : file.writer.createWriteStream()
  ).catch((error: unknown) => {
    failure =
      error instanceof Error ? error : new Error(String(error || "Staging failed."))
  })

  return {
    writable,
    abort(error: Error) {
      writable.destroy(error)
    },
    throwIfFailed() {
      if (failure) throw failure
    },
    async complete() {
      await settled
      if (failure) throw failure
      return { storedByteLength: limiter.byteLength }
    },
  }
}

export function createCompressedBackupStageReadStream(file: string | UnlinkedBackupStage) {
  const source = typeof file === "string" ? createReadStream(file) : file.reader.createReadStream({ start: 0 })
  const brotli = createBrotliDecompress()
  source.once("error", (error) => brotli.destroy(error))
  brotli.once("close", () => source.destroy())
  return source.pipe(brotli)
}
