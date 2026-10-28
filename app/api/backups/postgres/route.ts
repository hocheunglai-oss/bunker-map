import "server-only"
import { createPostgresBackupRuntimeHandler } from "@/lib/postgresBackupRuntime.mjs"
import { verifyStorageBackupGoogleIdentity } from "@/lib/storageMediaBackupSource"
import { verifyPostgresRuntimeBundle } from "@/scripts/lib/postgres-runtime-bundle.mjs"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

function handle(request: Request) {
  return createPostgresBackupRuntimeHandler({ runtime: process.env,
    verifyToken: verifyStorageBackupGoogleIdentity, verifyBundle: verifyPostgresRuntimeBundle,
  })(request)
}
export const POST = handle
export const GET = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
export const OPTIONS = handle
export const HEAD = handle
