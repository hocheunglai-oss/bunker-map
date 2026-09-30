import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { isVerifiedBackupActive } from "@/lib/backupMaintenance"
import { runPhonebookCarddavReconcile } from "@/lib/phonebookCarddavReconcile"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" }

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS })
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return privateJson({ message: "Phonebook reconciliation is not configured." }, 503)
  const actual = Buffer.from(request.headers.get("authorization") || "")
  const expected = Buffer.from(`Bearer ${secret}`)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return privateJson({ message: "Unauthorized" }, 401)
  }

  try {
    if (await isVerifiedBackupActive()) {
      return privateJson({ deferred: true, reason: "Verified daily backup in progress" })
    }
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) return privateJson({ message: "Phonebook reconciliation is not configured." }, 503)
    const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    const result = await runPhonebookCarddavReconcile(supabase)
    return privateJson(result)
  } catch {
    // Provider errors can contain contact fields or credentials; keep logs safe.
    console.error("phonebook_carddav_reconcile_failed")
    return privateJson({ message: "Phonebook reconciliation did not complete; saved retry work is retained." }, 503)
  }
}
