import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { isAdminRole } from "@/lib/adminPages"
import { fcunoConnectionPolicy } from "@/config/fcunoConnections"
import { probePostgresBackupRuntime } from "@/lib/postgresBackupProbe.mjs"
import { postgresProbeFailureResult } from "@/lib/postgresBackupProbeCapability.mjs"
import { verifyPostgresRuntimeBundle } from "@/scripts/lib/postgres-runtime-bundle.mjs"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 30
const headers = { "Cache-Control": "private, no-store, max-age=0", "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
let inFlight: Promise<unknown> | null = null

export async function GET(request: Request) {
  try {
    const session = await requireAdminPagePermission("system-health", "edit")
    if (!isAdminRole(session.role)) throw Error("Forbidden")
  } catch { return NextResponse.json({ message: "Forbidden" }, { status: 403, headers }) }
  if (request.method !== "GET") return new NextResponse(null, { status: 405, headers: { ...headers, Allow: "GET" } })
  let url: URL
  try { url = new URL(request.url) } catch {
    return NextResponse.json({ message: "Invalid check URL." }, { status: 400, headers })
  }
  if (url.search || url.hash || url.username || url.password || url.pathname !== "/api/admin/system-health/postgres-backup" ||
      url.origin !== fcunoConnectionPolicy.vercel.productionOrigins[0]) {
    return NextResponse.json({ message: "This check does not accept parameters." }, { status: 400, headers })
  }
  if (process.env.POSTGRES_BACKUP_PROBE_ENABLED !== "1") return new NextResponse(null, { status: 404, headers })
  try {
    // Share concurrent admin checks, but retain no result after completion.
    inFlight ??= probePostgresBackupRuntime({ runtime: process.env, verifyBundle: verifyPostgresRuntimeBundle })
      .finally(() => { inFlight = null })
    return NextResponse.json(await inFlight, { headers })
  } catch (error) {
    // Native/provider errors can include data or authentication details: never log them.
    return NextResponse.json(postgresProbeFailureResult(error), { status: 503, headers })
  }
}
