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
import { runRecurringStorageMediaBackup } from "./lib/storage-media-recurring-run.mjs"
import { createStorageMediaDrivePublisher } from "./lib/storage-media-drive-publication.mjs"
import { createStorageMediaBudgetRuntime } from "./lib/storage-media-budget-runtime.mjs"

export async function main({ args = process.argv.slice(2), runtime = process.env, fetch: fetchImpl = fetch, now = Date.now, publisher, budget } = {}) {
  if (args.length !== 1 || !["--execute-approved-snapshot", "--execute-recurring-daily"].includes(args[0])) throw new Error("Explicit approved-snapshot or recurring-daily execution flag is required")
  const recurring = args[0] === "--execute-recurring-daily"
  requireStorageMediaJobRuntime(runtime)
  if (recurring && runtime.STORAGE_MEDIA_BACKUP_RECURRING_ENABLED !== "1") throw new Error("Recurring media backup requires explicit activation, verified publication and budget controls")
  const parentFolderId = runtime.GOOGLE_DRIVE_BACKUP_FOLDER_ID || runtime.GOOGLE_DRIVE_COMPANY_FOLDER_ID
  if (typeof parentFolderId !== "string" || !parentFolderId) throw new Error("Existing Drive backup parent is not configured")
  const runId = randomUUID(), controller = new AbortController(), deadline = now() + 3_300_000
  const stop = () => controller.abort()
  const timer = setTimeout(stop, 3_300_000)
  process.once("SIGINT", stop); process.once("SIGTERM", stop)
  try {
    const getAccessToken = createMetadataAccessTokenProvider({ fetch: fetchImpl, runtime, now })
    const source = createStorageMediaSourceAdapter({ fetch: fetchImpl, now,
      mode: recurring ? "recurring" : "approved-snapshot",
      getIdentityToken: createMetadataIdentityTokenProvider({ fetch: fetchImpl, runtime, now }) })
    const gcs = createStorageMediaGcsAdapter({ fetch: fetchImpl, runId, now,
      mode: recurring ? "recurring" : "approved-snapshot",
      getAccessToken })
    if (recurring) {
      budget ??= createStorageMediaBudgetRuntime({ runtime, fetch: fetchImpl, now, getAccessToken })
      publisher ??= createStorageMediaDrivePublisher({ runtime, fetch: fetchImpl, now, parentFolderId,
        sharedDriveId: runtime.GOOGLE_DRIVE_SHARED_DRIVE_ID || null,
        getAccessToken: createExistingDriveAccessTokenProvider({ fetch: fetchImpl, runtime, now }),
        getBudgetState: () => budget.getBudgetState?.() ?? null })
      if (typeof publisher?.publishHealth !== "function" || typeof publisher?.publishAttempt !== "function" || typeof budget?.checkOptionalWork !== "function") throw new Error("Recurring media backup requires verified publication and budget controls")
      const result = await runRecurringStorageMediaBackup({ source, gcs, publisher, budget, runId }, { signal: controller.signal, deadline, now })
      return { ...result, googleProject: fcunoConnectionPolicy.storageMediaBackup.googleProjectId }
    }
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
    console.log("Media backup: --execute-approved-snapshot (legacy) or --execute-recurring-daily (explicit activation, verified publisher and budget guard required)")
  } else main().then(result => console.log(JSON.stringify({ status: result.status, copiedObjects: result.copiedObjects,
    copiedBytes: result.copiedBytes, reusedObjects: result.reusedObjects, googleProject: result.googleProject }))).catch(() => {
    console.error("Storage media backup failed. Inspect the private backup control record before retrying.")
    process.exitCode = 1
  })
}
