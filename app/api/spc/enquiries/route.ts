import { after, NextResponse } from "next/server"
import { hasSpcPagePermission, requireSpcPagePermission } from "@/lib/spcAuth"
import { timedJson } from "@/lib/serverTiming"
import { listSupplierTraderOptions } from "@/lib/spcUsers"
import { resolveSpcEnquiryScope } from "@/lib/spcEnquiryScope"
import {
  amendSpcEnquiry,
  createSpcEnquiry,
  listSpcEnquiryIds,
  listSpcEnquiries,
  reofferSpcEnquiry,
  updateSpcEnquiryFixture,
  updateSpcEnquiryOutcome,
  type SpcEnquiry,
  type SpcEnquiryOutcome,
} from "@/lib/spcEnquiries"
import { enqueueSpcMobileEnquiry, processPendingSpcMobileDeliveries } from "@/lib/spcMobileEnquiries"
import { listSpcLostReasons } from "@/lib/spcLostReasons"

type EnquiryPayload = {
  title?: string
  vesselName?: string
  port?: string
  product?: string
  quantity?: string
  deliveryDate?: string
  supplierName?: string
  notes?: string
}

const ISO_CURSOR_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

function errorResponse(error: unknown, fallback: string) {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error && typeof error.message === "string"
        ? error.message
        : fallback
  const status =
    message === "Unauthorized"
      ? 401
      : message === "Forbidden"
        ? 403
        : message.includes("required") || message.startsWith("Select a valid")
          ? 400
          : 500
  return NextResponse.json({ message }, { status })
}

function parseUpdatedAfterCursor(value: string) {
  const separator = value.lastIndexOf("|")
  const timestamp = separator >= 0 ? value.slice(0, separator) : value
  const id = separator >= 0 ? value.slice(separator + 1) : ""
  if (!ISO_CURSOR_TIMESTAMP_PATTERN.test(timestamp) || Number.isNaN(Date.parse(timestamp))) return null
  return {
    timestamp,
    id: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id : "",
  }
}

function latestEnquiryCursor(enquiries: Array<{ id: string; updatedAt: string }>, fallback = "") {
  return enquiries.reduce((latest, enquiry) => {
    const candidate = `${enquiry.updatedAt}|${enquiry.id}`
    if (!latest) return candidate
    const [latestDate, latestId = ""] = latest.split("|")
    const dateOrder = Date.parse(enquiry.updatedAt) - Date.parse(latestDate)
    return dateOrder > 0 || (dateOrder === 0 && enquiry.id.localeCompare(latestId) > 0)
      ? candidate
      : latest
  }, fallback)
}

function parseIsoTimestamp(value: string) {
  return ISO_CURSOR_TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : null
}

async function enqueueAndScheduleSpcMobileDelivery(enquiry: SpcEnquiry) {
  const mobileRecipientCount = await enqueueSpcMobileEnquiry(enquiry)
  if (mobileRecipientCount > 0) {
    after(async () => {
      try {
        await processPendingSpcMobileDeliveries()
      } catch (error) {
        console.error("Immediate SPC mobile delivery failed", error)
      }
    })
  }
  return mobileRecipientCount
}

export async function GET(request: Request) {
  const startedAt = Date.now()
  try {
    const session = await requireSpcPagePermission("spc-buyer-enquiries", "view")
    if (!session.username) throw new Error("Unauthorized")
    const searchParams = new URL(request.url).searchParams
    const status = searchParams.get("status")?.trim() || undefined
    const limit = Number(searchParams.get("limit") || 250)
    const bootstrap = searchParams.get("bootstrap") === "1"
    const createdAfterValue = searchParams.get("createdAfter")?.trim() || ""
    const requestedScope = resolveSpcEnquiryScope(
      searchParams.get("scope"),
      createdAfterValue,
    )
    if (!requestedScope) {
      return NextResponse.json(
        { message: "Unsupported enquiry scope." },
        { status: 400, headers: { "Cache-Control": "private, no-store" } },
      )
    }
    const sharedScope = requestedScope === "shared"
    const recordsScope = requestedScope === "records"
    if (sharedScope && !hasSpcPagePermission(session, "spc-chrome-extension", "view")) {
      throw new Error("Forbidden")
    }
    if (recordsScope && !hasSpcPagePermission(session, "spc-lost-record", "view")) {
      throw new Error("Forbidden")
    }
    const createdByUsername = sharedScope || recordsScope ? undefined : session.username
    const parsedCreatedAfter = createdAfterValue ? parseIsoTimestamp(createdAfterValue) : null
    if (createdAfterValue && !parsedCreatedAfter) {
      return NextResponse.json(
        { message: "createdAfter must be a valid ISO timestamp." },
        { status: 400, headers: { "Cache-Control": "private, no-store" } },
      )
    }
    const createdAfter = parsedCreatedAfter || undefined
    const updatedAfterValue = searchParams.get("updatedAfter")?.trim() || ""
    const updatedAfterCursor = parseUpdatedAfterCursor(updatedAfterValue)
    const updatedAfter = updatedAfterCursor?.timestamp
    const supplierTradersPromise = bootstrap && hasSpcPagePermission(session, "spc-buyer-enquiries", "edit")
      ? listSupplierTraderOptions()
      : Promise.resolve([])
    const buyerLostReasonsPromise = bootstrap && hasSpcPagePermission(session, "spc-buyer-enquiries", "edit")
      ? listSpcLostReasons(session, request, "BUYER TRADER")
      : Promise.resolve([])
    const enquiries = await listSpcEnquiries(session, {
      status,
      limit,
      createdAfter,
      updatedAfter,
      updatedAfterId: updatedAfterCursor?.id,
      createdByUsername,
    })
    // Read the compact snapshot after the change page so inserts cannot be skipped by cursor advancement.
    const [supplierTraders, buyerLostReasons, activeIds] = await Promise.all([
      supplierTradersPromise,
      buyerLostReasonsPromise,
      updatedAfter
        ? listSpcEnquiryIds(session, {
            status,
            limit,
            createdAfter,
            createdByUsername,
          })
        : Promise.resolve(undefined),
    ])
    const cursor = latestEnquiryCursor(enquiries, updatedAfterValue)
    return timedJson(
      "/api/spc/enquiries",
      startedAt,
      {
        enquiries,
        cursor,
        sessionKey: session.username,
        ...(activeIds ? { activeIds } : {}),
        ...(bootstrap ? { supplierTraders, buyerLostReasons } : {}),
      },
      {
        headers: {
          "Cache-Control": "private, no-store",
        },
      },
      {
        bootstrap,
        incremental: Boolean(updatedAfter),
        sharedFeed: sharedScope,
        returned: enquiries.length,
      },
    )
  } catch (error) {
    return errorResponse(error, "Failed to load SPC enquiries.")
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSpcPagePermission("spc-buyer-enquiries", "edit")
    const payload = (await request.json()) as EnquiryPayload
    const enquiry = await createSpcEnquiry(payload, session, request)
    const mobileRecipientCount = await enqueueAndScheduleSpcMobileDelivery(enquiry)
    return NextResponse.json({ success: true, enquiry, mobileRecipientCount })
  } catch (error) {
    return errorResponse(error, "Failed to save SPC enquiry.")
  }
}

export async function PATCH(request: Request) {
  try {
    const payload = (await request.json()) as {
      id?: unknown
      mode?: unknown
      outcome?: unknown
      lostReason?: unknown
      supplierTraderUsername?: unknown
      supplierTraderDisplayName?: unknown
      fixture?: unknown
    }
    const id = typeof payload.id === "string" ? payload.id.trim() : ""
    if (!id) throw new Error("Enquiry id is required.")

    if (payload.mode === "fixture") {
      const session = await requireSpcPagePermission("spc-fixtures", "edit")
      const fixture =
        payload.fixture && typeof payload.fixture === "object"
          ? (payload.fixture as Record<string, string>)
          : {}
      const enquiry = await updateSpcEnquiryFixture(
        id,
        {
          supplier: typeof fixture.supplier === "string" ? fixture.supplier : "",
          eta: typeof fixture.eta === "string" ? fixture.eta : "",
          hsfo: typeof fixture.hsfo === "string" ? fixture.hsfo : "",
          vlsfo: typeof fixture.vlsfo === "string" ? fixture.vlsfo : "",
          lsmgo: typeof fixture.lsmgo === "string" ? fixture.lsmgo : "",
          price: typeof fixture.price === "string" ? fixture.price : "",
          barging: typeof fixture.barging === "string" ? fixture.barging : "",
        },
        session,
        request,
      )
      return NextResponse.json({ success: true, enquiry })
    }

    if (payload.mode === "reoffer") {
      const session = await requireSpcPagePermission("spc-buyer-enquiries", "edit")
      const source = payload as Record<string, unknown>
      const enquiry = await reofferSpcEnquiry(
        id,
        {
          title: typeof source.title === "string" ? source.title : "",
          vesselName: typeof source.vesselName === "string" ? source.vesselName : "",
          port: typeof source.port === "string" ? source.port : "",
          product: typeof source.product === "string" ? source.product : "",
          quantity: typeof source.quantity === "string" ? source.quantity : "",
          deliveryDate: typeof source.deliveryDate === "string" ? source.deliveryDate : "",
          supplierName: typeof source.supplierName === "string" ? source.supplierName : "",
          notes: typeof source.notes === "string" ? source.notes : "",
        },
        session,
        request,
      )
      const mobileRecipientCount = await enqueueAndScheduleSpcMobileDelivery(enquiry)
      return NextResponse.json({ success: true, enquiry, mobileRecipientCount })
    }

    if (payload.mode === "amend") {
      const session = await requireSpcPagePermission("spc-buyer-enquiries", "edit")
      const source = payload as Record<string, unknown>
      const enquiry = await amendSpcEnquiry(
        id,
        {
          title: typeof source.title === "string" ? source.title : "",
          vesselName: typeof source.vesselName === "string" ? source.vesselName : "",
          port: typeof source.port === "string" ? source.port : "",
          product: typeof source.product === "string" ? source.product : "",
          quantity: typeof source.quantity === "string" ? source.quantity : "",
          deliveryDate: typeof source.deliveryDate === "string" ? source.deliveryDate : "",
          supplierName: typeof source.supplierName === "string" ? source.supplierName : "",
          notes: typeof source.notes === "string" ? source.notes : "",
        },
        session,
        request,
      )
      return NextResponse.json({ success: true, enquiry })
    }

    const session = await requireSpcPagePermission("spc-buyer-enquiries", "edit")
    const outcome: SpcEnquiryOutcome | null =
      payload.outcome === "stem" ||
      payload.outcome === "lost" ||
      payload.outcome === "postpone" ||
      payload.outcome === "cancel"
        ? payload.outcome
        : null
    if (!outcome) throw new Error("Outcome is required.")
    if (outcome === "lost") {
      const lostReason = typeof payload.lostReason === "string" ? payload.lostReason.trim() : ""
      const validLostReasons = await listSpcLostReasons(session, request, "BUYER TRADER")
      if (!validLostReasons.includes(lostReason)) throw new Error("Select a valid buyer lost reason.")
    }

    const enquiry = await updateSpcEnquiryOutcome(
      id,
      {
        outcome,
        lostReason: typeof payload.lostReason === "string" ? payload.lostReason : "",
        supplierTraderUsername:
          typeof payload.supplierTraderUsername === "string" ? payload.supplierTraderUsername : "",
        supplierTraderDisplayName:
          typeof payload.supplierTraderDisplayName === "string" ? payload.supplierTraderDisplayName : "",
      },
      session,
      request,
    )
    return NextResponse.json({ success: true, enquiry })
  } catch (error) {
    return errorResponse(error, "Failed to update SPC enquiry.")
  }
}
