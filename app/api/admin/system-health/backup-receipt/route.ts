import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { isAdminRole } from "@/lib/adminPages"
import { BackupReceiptUnknown, readDailyBackupProviderReceipt } from "@/lib/dailyBackupProviderReceipt"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 30
const headers = { "Cache-Control": "private, no-store, max-age=0", "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store", Pragma: "no-cache", "X-Content-Type-Options": "nosniff" }

export async function GET(request: Request) {
  try {
    const session = await requireAdminPagePermission("system-health", "edit")
    if (!isAdminRole(session.role)) throw new Error("Forbidden")
  } catch {
    return NextResponse.json({ message: "Forbidden" }, { status: 403, headers })
  }
  if (new URL(request.url).search) return NextResponse.json({ message: "This check does not accept parameters." }, { status: 400, headers })
  try {
    return NextResponse.json(await readDailyBackupProviderReceipt(), { headers })
  } catch (error) {
    // Never log Google errors: these can contain request headers or credentials.
    const code = error instanceof BackupReceiptUnknown ? error.code : "provider_unavailable"
    console.warn("Daily backup receipt check unavailable", { code })
    return NextResponse.json({ status: "unknown", verification: "google-drive-checksum-correspondence", code,
      message: "The backup receipt could not be verified. No backup or data was changed." }, { status: 503, headers })
  }
}
