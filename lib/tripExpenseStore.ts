import "server-only"

import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server"
import { fcunoConnectionPolicy } from "@/config/fcunoConnections"
import {
  hasAdminPagePermission,
  requireAdminIdentitySession,
  requireAdminPagePermissionForRequest,
} from "@/lib/adminAuth"
import { isAdminRole } from "@/lib/adminPages"
import {
  TRIP_EXPENSE_PAGE_ID,
  TRIP_EXPENSE_RECEIPT_BUCKET,
  TripExpenseInputError,
  tripReceiptMime,
  type FiledTripExpense,
  type TripReceipt,
} from "@/lib/tripExpenseClaim"

export const TRIP_EXPENSE_ADMIN_EMAIL = "louisa@cosulich.com.hk"
export const TRIP_EXPENSE_TABLE = "trip_expense_claims"
export const TRIP_PRIVATE_HEADERS = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" }
export const TRIP_CLAIMS_PAGE_SIZE = 30

const SUMMARY_COLUMNS = "id,submitter_name,submitted_at,claim_cents,backed_up_at,email_attempted_at,emailed_at,delivery_lease_until"
const CLAIM_COLUMNS = SUMMARY_COLUMNS + ",submitted_by,details,backup_file_id"

type TripClaimActor = { adminUserId: string; role: string | null }

export type TripClaimSummary = {
  id: string
  submitter_name: string
  submitted_at: string
  claim_cents: number
  backed_up_at: string | null
  email_attempted_at: string | null
  emailed_at: string | null
  delivery_lease_until: string | null
  country: string
  departure_date: string
  return_date: string
  claim_date: string
}

export type TripClaimRow = Omit<TripClaimSummary, "country" | "departure_date" | "return_date" | "claim_date"> & {
  submitted_by: string
  details: FiledTripExpense
  backup_file_id: string | null
}

export class TripExpenseRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export function createTripExpenseDb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Trip expense storage is unavailable.")
  if (process.env.VERCEL === "1" &&
      url !== "https://" + fcunoConnectionPolicy.supabase.projectRef + ".supabase.co") {
    throw new Error("Trip expense storage was configured for a different project.")
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: (input, init) => fetch(input, {
        ...init, cache: "no-store", signal: init?.signal || AbortSignal.timeout(20_000),
      }),
    },
  })
}

type TripDb = ReturnType<typeof createTripExpenseDb>

export async function tripExpensePageSession() {
  const session = await requireAdminIdentitySession()
  if (!hasAdminPagePermission(session, TRIP_EXPENSE_PAGE_ID)) throw new Error("Forbidden")
  return session
}

export async function tripExpenseApiSession(request: Request, access: "view" | "edit" = "view") {
  if (access === "edit") {
    const origin = request.headers.get("origin")
    const isLocal = process.env.VERCEL !== "1"
    const host = request.headers.get("host")
    const fetchSite = request.headers.get("sec-fetch-site")
    const expected = isLocal
      ? new URL(request.url).protocol + "//" + host
      : fcunoConnectionPolicy.vercel.productionOrigins[0]
    if ((fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") ||
        (!isLocal && host !== new URL(expected).host) ||
        (origin !== expected && (!isLocal || origin !== null))) throw new Error("Forbidden")
    if (!isLocal && (process.env.VERCEL_ENV !== "production" ||
        process.env.VERCEL_PROJECT_ID !== fcunoConnectionPolicy.vercel.projectId)) {
      throw new TripExpenseRequestError("File claims on FCUNO production.", 503)
    }
  }
  const session = await requireAdminPagePermissionForRequest(request, TRIP_EXPENSE_PAGE_ID, access)
  if (!session.adminUserId) throw new Error("Unauthorized")
  return { ...session, adminUserId: session.adminUserId }
}

export function tripExpenseApiError(error: unknown, message: string) {
  if (error instanceof TripExpenseRequestError) {
    return NextResponse.json({ message: error.message }, { headers: TRIP_PRIVATE_HEADERS, status: error.status })
  }
  if (error instanceof TripExpenseInputError) {
    return NextResponse.json({ message: error.message }, { headers: TRIP_PRIVATE_HEADERS, status: 400 })
  }
  const authError = error instanceof Error ? error.message : ""
  const status = authError === "Unauthorized" ? 401 : authError === "Forbidden" ? 403 : 500
  return NextResponse.json({ message: status === 500 ? message : authError }, { headers: TRIP_PRIVATE_HEADERS, status })
}

export async function readTripExpenseJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new TripExpenseInputError("Invalid claim request.")
  }
  const value: unknown = await request.json().catch(() => null)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TripExpenseInputError("Invalid claim request.")
  return value as Record<string, unknown>
}

async function canReviewClaims(db: TripDb, actor: TripClaimActor) {
  if (isAdminRole(actor.role)) return true
  const { data, error } = await db.from("admin_users").select("id")
    .eq("id", actor.adminUserId).eq("is_active", true).eq("email_verified", true)
    .ilike("email", TRIP_EXPENSE_ADMIN_EMAIL).maybeSingle()
  if (error) throw error
  return Boolean(data)
}

export async function listTripClaims(db: TripDb, actor: TripClaimActor, offset: number) {
  const query = db.from(TRIP_EXPENSE_TABLE).select(
    SUMMARY_COLUMNS + ",country:details->>country,departure_date:details->>departureDate,return_date:details->>returnDate,claim_date:details->>claimDate",
  ).order("submitted_at", { ascending: false }).order("id", { ascending: false })
    .range(offset, offset + TRIP_CLAIMS_PAGE_SIZE)
  if (!await canReviewClaims(db, actor)) query.eq("submitted_by", actor.adminUserId)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as unknown as TripClaimSummary[]
}

export async function getTripClaim(db: TripDb, id: string, actor: TripClaimActor) {
  const query = db.from(TRIP_EXPENSE_TABLE).select(CLAIM_COLUMNS).eq("id", id)
  if (!await canReviewClaims(db, actor)) query.eq("submitted_by", actor.adminUserId)
  const { data, error } = await query.maybeSingle()
  if (error) throw error
  return data as unknown as TripClaimRow | null
}

export async function getTripDeliveryClaim(db: TripDb, id: string) {
  const { data, error } = await db.from(TRIP_EXPENSE_TABLE).select(CLAIM_COLUMNS).eq("id", id).maybeSingle()
  if (error) throw error
  return data as unknown as TripClaimRow | null
}

export async function tripClaimExistsForOwner(db: TripDb, id: string, owner: string) {
  const { data, error } = await db.from(TRIP_EXPENSE_TABLE).select("id").eq("id", id)
    .eq("submitted_by", owner).maybeSingle()
  if (error) throw error
  return Boolean(data)
}

export function tripReceiptPath(owner: string, claim: string, item: string, receipt: string) {
  return [owner, claim, item, receipt].join("/")
}

export function tripReceiptBucket(db: TripDb) {
  return db.storage.from(TRIP_EXPENSE_RECEIPT_BUCKET)
}

export async function tripReceiptUploaded(bucket: ReturnType<typeof tripReceiptBucket>, path: string, receipt: TripReceipt) {
  const { data, error } = await bucket.info(path)
  if (error) {
    // The Storage info endpoint returns a StorageApiError for a missing key.
    if ("status" in error && Number(error.status) === 404) return false
    if ("statusCode" in error && Number(error.statusCode) === 404) return false
    throw error
  }
  if (data.size !== receipt.size || data.contentType !== tripReceiptMime(receipt.name)) {
    throw new TripExpenseInputError("Receipt metadata changed. Remove the receipt and attach it again.")
  }
  return true
}

export async function verifyTripReceipts(db: TripDb, owner: string, claim: FiledTripExpense) {
  const bucket = tripReceiptBucket(db)
  const receipts = claim.items.flatMap(item => item.receipts.map(receipt => ({
    path: tripReceiptPath(owner, claim.id, item.id, receipt.id),
    receipt,
  })))
  for (let index = 0; index < receipts.length; index += 6) {
    const results = await Promise.all(receipts.slice(index, index + 6).map(({ path, receipt }) => tripReceiptUploaded(bucket, path, receipt)))
    if (results.includes(false)) throw new TripExpenseInputError("Upload all receipts before submitting.")
  }
}

export async function fileTripClaim(db: TripDb, actor: TripClaimActor, name: string, claim: FiledTripExpense) {
  const { error } = await db.from(TRIP_EXPENSE_TABLE).insert({
    id: claim.id,
    submitted_by: actor.adminUserId,
    submitter_name: name.trim().slice(0, 200),
    details: claim,
    claim_cents: claim.totals.claimCents,
  })
  if (!error) return true
  if (error.code === "23505" && await tripClaimExistsForOwner(db, claim.id, actor.adminUserId)) return false
  throw error
}
