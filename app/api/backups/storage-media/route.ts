import "server-only"
import {
  createSupabaseStorageReadProvider, handleStorageMediaBackupSource, verifyStorageBackupGoogleIdentity,
} from "@/lib/storageMediaBackupSource"

export const dynamic = "force-dynamic"
export const maxDuration = 300

function handle(request: Request) {
  return handleStorageMediaBackupSource(request, {
    runtime: {
      enabled: process.env.STORAGE_MEDIA_BACKUP_ENABLED,
      recurringEnabled: process.env.STORAGE_MEDIA_BACKUP_RECURRING_ENABLED,
      recurringActivatedAt: process.env.STORAGE_MEDIA_BACKUP_RECURRING_ACTIVATED_AT,
      vercel: process.env.VERCEL,
      environment: process.env.VERCEL_ENV,
      projectId: process.env.VERCEL_PROJECT_ID,
      windowStartsAt: process.env.STORAGE_MEDIA_BACKUP_ACCESS_STARTS_AT,
      windowExpiresAt: process.env.STORAGE_MEDIA_BACKUP_ACCESS_EXPIRES_AT,
      approvedInventorySha256: process.env.STORAGE_MEDIA_BACKUP_APPROVED_INVENTORY_SHA256,
    },
    now: Date.now,
    verifyToken: verifyStorageBackupGoogleIdentity,
    provider() {
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ""
      return {
        receiptKey: key,
        storage: createSupabaseStorageReadProvider({ url: process.env.NEXT_PUBLIC_SUPABASE_URL || "", serviceRoleKey: key, fetch }),
      }
    },
    onFailure: code => console.error("storage_media_source", code),
  })
}

export const POST = handle
export const GET = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
export const OPTIONS = handle
export const HEAD = handle
