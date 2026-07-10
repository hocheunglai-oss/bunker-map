import { NextResponse } from "next/server"
import { hasSpcPagePermission, requireSpcPagePermission } from "@/lib/spcAuth"
import { timedJson } from "@/lib/serverTiming"
import { listSupplierTraderOptions } from "@/lib/spcUsers"
import {
  createSpcEnquiry,
  listSpcEnquiries,
  reofferSpcEnquiry,
  updateSpcEnquiryFixture,
  updateSpcEnquiryOutcome,
  type SpcEnquiryOutcome,
} from "@/lib/spcEnquiries"

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
        : message.includes("required")
          ? 400
          : 500
  return NextResponse.json({ message }, { status })
}

export async function GET(request: Request) {
  const startedAt = Date.now()
  try {
    const session = await requireSpcPagePermission("spc-buyer-enquiries", "view")
    const searchParams = new URL(request.url).searchParams
    const status = searchParams.get("status")?.trim() || undefined
    const limit = Number(searchParams.get("limit") || 250)
    const bootstrap = searchParams.get("bootstrap") === "1"
    const updatedAfterValue = searchParams.get("updatedAfter")?.trim() || ""
    const updatedAfter = updatedAfterValue && !Number.isNaN(Date.parse(updatedAfterValue))
      ? updatedAfterValue
      : undefined
    const [enquiries, supplierTraders] = await Promise.all([
      listSpcEnquiries(session, { status, limit, updatedAfter }),
      bootstrap && hasSpcPagePermission(session, "spc-buyer-enquiries", "edit")
        ? listSupplierTraderOptions()
        : Promise.resolve([]),
    ])
    const cursor = enquiries.reduce(
      (latest, enquiry) => !latest || Date.parse(enquiry.updatedAt) > Date.parse(latest)
        ? enquiry.updatedAt
        : latest,
      updatedAfter || "",
    )
    return timedJson(
      "/api/spc/enquiries",
      startedAt,
      { enquiries, cursor, ...(bootstrap ? { supplierTraders } : {}) },
      {
        headers: {
          "Cache-Control": "private, no-store",
        },
      },
      { bootstrap, incremental: Boolean(updatedAfter), returned: enquiries.length },
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
    return NextResponse.json({ success: true, enquiry })
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
