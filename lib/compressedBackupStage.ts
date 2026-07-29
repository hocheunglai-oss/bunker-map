import { createReadStream, createWriteStream } from "node:fs"
import { Transform, type TransformCallback } from "node:stream"
import { pipeline } from "node:stream/promises"
import { constants, createGunzip, createGzip } from "node:zlib"

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

export function createCompressedBackupStage(
  filePath: string,
  maximumByteLength: number
) {
  if (!Number.isSafeInteger(maximumByteLength) || maximumByteLength < 1) {
    throw new Error("Compressed backup staging limit must be a positive integer.")
  }

  const writable = createGzip({ level: constants.Z_BEST_SPEED })
  const limiter = new StoredByteLimit(maximumByteLength)
  let failure: Error | null = null
  const settled = pipeline(
    writable,
    limiter,
    createWriteStream(filePath, { flags: "wx", mode: 0o600 })
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

export function createCompressedBackupStageReadStream(filePath: string) {
  const source = createReadStream(filePath)
  const gunzip = createGunzip()
  source.once("error", (error) => gunzip.destroy(error))
  return source.pipe(gunzip)
}
