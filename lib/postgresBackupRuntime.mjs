import { createPrivateKey } from "node:crypto"
import { join } from "node:path"
import { createPostgresBackupHandler } from "./postgresBackupCapability.mjs"
import { createPostgresBackupAdmission } from "./postgresBackupAdmission.mjs"
import { createFixedNativeExporter } from "../scripts/lib/postgres-backup-native.mjs"

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }
// This wrapper is SOURCE-only and must never be included in the Google image.
// No environment loading, native binary execution or credential access happens
// when disabled. An exact deployment must provide the reviewed bundle verifier.
export function createPostgresBackupRuntimeHandler({ runtime, verifyToken, verifyBundle, fetch: fetchImpl = fetch, now = Date.now, root = process.cwd() }) {
  return async request => {
    if (runtime.POSTGRES_BACKUP_SOURCE_ENABLED !== "1") return new Response(null, { status: 404, headers })
    try {
      const admission = createPostgresBackupAdmission({ url: runtime.NEXT_PUBLIC_SUPABASE_URL,
        serviceRoleKey: runtime.SUPABASE_SERVICE_ROLE_KEY, fetch: fetchImpl })
      const handler = createPostgresBackupHandler({ now, admission, verifyToken,
        runtime: { enabled: true, vercel: runtime.VERCEL, environment: runtime.VERCEL_ENV, projectId: runtime.VERCEL_PROJECT_ID,
          googleSubject: runtime.POSTGRES_BACKUP_GOOGLE_SUBJECT },
        async openNative(context) {
          if (typeof verifyBundle !== "function" || !/^[0-9a-f]{64}$/.test(runtime.POSTGRES_BACKUP_CA_SHA256 || "")) throw Error("Runtime unavailable")
          const directory = join(root, ".runtime/postgres")
          const bundle = await verifyBundle(directory, runtime.POSTGRES_BACKUP_BUNDLE_SHA256)
          const key = runtime.POSTGRES_BACKUP_SIGNING_KEY_PEM
          if (typeof key !== "string" || key.length > 4096) throw Error("Signing identity unavailable")
          const privateKey = createPrivateKey(key)
          if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") throw Error("Signing identity invalid")
          return createFixedNativeExporter({ now, privateKey, binaries: bundle.binaries,
            certificate: { path: join(root, ".runtime/postgres-source/root.crt"), sha256: runtime.POSTGRES_BACKUP_CA_SHA256 },
            verifyRuntimeFiles: () => verifyBundle(directory, runtime.POSTGRES_BACKUP_BUNDLE_SHA256),
            getCredential: async () => {
              const serialized = runtime.POSTGRES_BACKUP_SOURCE_CREDENTIAL_JSON
              if (typeof serialized !== "string" || serialized.length > 1024) throw Error("Source credential unavailable")
              return JSON.parse(serialized)
            },
          })(context)
        },
      })
      return await handler(request)
    } catch { return new Response(null, { status: 503, headers }) }
  }
}
