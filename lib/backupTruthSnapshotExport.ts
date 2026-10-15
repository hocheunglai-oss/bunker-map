import { createHash } from "node:crypto"

type SnapshotReadResult = { data: unknown; error: unknown }

type SnapshotRead = (
  operation: () => PromiseLike<SnapshotReadResult>,
  operationName: string
) => Promise<unknown>

export async function streamReferencedTruthSnapshots(options: {
  readSnapshot: (hash: string) => PromiseLike<SnapshotReadResult>
  snapshotHashes: Iterable<string>
  retryRead: SnapshotRead
  appendRows: (rows: unknown[]) => Promise<void>
}) {
  const hashes = new Set<string>()
  for (const hash of options.snapshotHashes) {
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error("Referenced truth snapshot identity is invalid.")
    }
    if (hashes.has(hash)) {
      throw new Error("Referenced truth snapshot identity is duplicated.")
    }
    hashes.add(hash)
  }

  let exported = 0
  for (const hash of [...hashes].sort()) {
    // Snapshot documents are individually multi-megabyte. A row-count page of
    // 500 can make PostgREST aggregate the entire snapshot history at once.
    // Fetch the exact indexed identity, never unrelated history, one document
    // at a time; await its downstream write before requesting another.
    const data = await options.retryRead(
      () => options.readSnapshot(hash),
      `export outlook_exchange_truth_snapshots snapshot ${hash}`
    )
    if (!Array.isArray(data) || data.length !== 1) {
      throw new Error("Expected exactly one referenced truth snapshot.")
    }
    const row: unknown = data[0]
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("Referenced truth snapshot returned an invalid row.")
    }
    const snapshot = row as Record<string, unknown>
    if (snapshot.snapshot_sha256 !== hash) {
      throw new Error("Referenced truth snapshot returned an unexpected identity.")
    }
    if (typeof snapshot.canonical_json !== "string" || !snapshot.canonical_json.length) {
      throw new Error("Referenced truth snapshot canonical document is missing.")
    }
    const byteLength = Buffer.byteLength(snapshot.canonical_json, "utf8")
    if (!Number.isSafeInteger(snapshot.byte_length) || snapshot.byte_length !== byteLength) {
      throw new Error("Referenced truth snapshot byte length does not match its document.")
    }
    if (createHash("sha256").update(snapshot.canonical_json, "utf8").digest("hex") !== hash) {
      throw new Error("Referenced truth snapshot checksum does not match its identity.")
    }

    // Preserve every field and the existing hash-sorted section order. No
    // prefetch or Promise.all: bounded reads must honor writer backpressure.
    await options.appendRows([row])
    exported += 1
  }
  if (exported !== hashes.size) {
    throw new Error("Referenced truth snapshot export is incomplete.")
  }
  return exported
}
