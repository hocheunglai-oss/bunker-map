#!/usr/bin/env node
import { randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { fcunoConnectionPolicy } from "../config/fcunoConnections.ts"
import { createMetadataIdentityTokenProvider, createStorageMediaSourceAdapter } from "./lib/storage-media-source-adapter.mjs"
import { createMetadataAccessTokenProvider, createExistingDriveAccessTokenProvider, requireStorageMediaJobRuntime } from "./lib/storage-media-job-auth.mjs"
import { createStorageMediaGcsAdapter } from "./lib/storage-media-gcs-adapter.mjs"
import { createRetainedDriveReadAdapter } from "./lib/storage-media-retained-drive.mjs"
import { runStorageMediaBackup } from "./lib/storage-media-run.mjs"

export async function main({ args = process.argv.slice(2), runtime = process.env, fetch: fetchImpl = fetch, now = Date.now } = {}) {
  if (args.length !== 1 || args[0] !== "--execute-approved-snapshot") throw new Error("Explicit one-time --execute-approved-snapshot is required")
  requireStorageMediaJobRuntime(runtime)
  const parentFolderId = runtime.GOOGLE_DRIVE_BACKUP_FOLDER_ID || runtime.GOOGLE_DRIVE_COMPANY_FOLDER_ID
  if (typeof parentFolderId !== "string" || !parentFolderId) throw new Error("Existing Drive backup parent is not configured")
  const runId = randomUUID(), controller = new AbortController(), deadline = now() + 3_300_000
  const stop = () => controller.abort()
  const timer = setTimeout(stop, 3_300_000)
  process.once("SIGINT", stop); process.once("SIGTERM", stop)
  try {
    const source = createStorageMediaSourceAdapter({ fetch: fetchImpl, now,
      getIdentityToken: createMetadataIdentityTokenProvider({ fetch: fetchImpl, runtime, now }) })
    const gcs = createStorageMediaGcsAdapter({ fetch: fetchImpl, runId, now,
      getAccessToken: createMetadataAccessTokenProvider({ fetch: fetchImpl, runtime, now }) })
    const retained = createRetainedDriveReadAdapter({ fetch: fetchImpl, parentFolderId,
      sharedDriveId: runtime.GOOGLE_DRIVE_SHARED_DRIVE_ID || null,
      getAccessToken: createExistingDriveAccessTokenProvider({ fetch: fetchImpl, runtime, now }) })
    const result = await runStorageMediaBackup({ source, gcs, retained, runId }, { signal: controller.signal, deadline, now })
    // Counts and target generation only; no private source paths or Drive IDs.
    return { ...result, googleProject: fcunoConnectionPolicy.storageMediaBackup.googleProjectId }
  } finally {
    clearTimeout(timer); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(" ") === "--help") {
    console.log("One-time media backup: node scripts/backup-storage-media-to-gcs.mjs --execute-approved-snapshot")
  } else main().then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error("Storage media backup failed. Inspect the private backup control record before retrying.")
    process.exitCode = 1
  })
}
