import "server-only"
import { createPostgresProbeHandler } from "@/lib/postgresBackupProbeCapability.mjs"
import { probePostgresBackupRuntime } from "@/lib/postgresBackupProbe.mjs"
import { verifyStorageBackupGoogleIdentity } from "@/lib/storageMediaBackupSource"
import { verifyPostgresRuntimeBundle } from "@/scripts/lib/postgres-runtime-bundle.mjs"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 30

const handle = createPostgresProbeHandler({ runtime: process.env, verifyToken: verifyStorageBackupGoogleIdentity,
  probe: () => probePostgresBackupRuntime({ runtime: process.env, verifyBundle: verifyPostgresRuntimeBundle }),
})
export const POST = handle
export const GET = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
export const OPTIONS = handle
export const HEAD = handle
