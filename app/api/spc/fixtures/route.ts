import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import {
  deleteSpcFixture,
  listSpcFixtures,
  updateSpcFixture,
  type SpcFixtureInput,
} from "@/lib/spcFixtures"
import { listSpcUserReferenceOptions } from "@/lib/spcUsers"

export const dynamic = "force-dynamic"

function errorResponse(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback
  const status =
    message === "Unauthorized"
      ? 401
      : message === "Forbidden"
        ? 403
        : message.startsWith("Only the assigned")
          ? 403
          : message.includes("required") ||
              message.startsWith("Select a valid") ||
              message.startsWith("Complete ")
          ? 400
          : 500
  return NextResponse.json({ message }, { status })
}

function fixtureInput(source: Record<string, unknown>): SpcFixtureInput {
  return {
    fixtureDate: typeof source.fixtureDate === "string" ? source.fixtureDate : "",
    supplierTrader: typeof source.supplierTrader === "string" ? source.supplierTrader : "",
    buyerTrader: typeof source.buyerTrader === "string" ? source.buyerTrader : "",
    account: typeof source.account === "string" ? source.account : "",
    commission: typeof source.commission === "string" ? source.commission : "",
    earliestEta: typeof source.earliestEta === "string" ? source.earliestEta : "",
    vesselName: typeof source.vesselName === "string" ? source.vesselName : "",
    hsfo: typeof source.hsfo === "string" ? source.hsfo : "",
    vlsfo: typeof source.vlsfo === "string" ? source.vlsfo : "",
    lsmgo: typeof source.lsmgo === "string" ? source.lsmgo : "",
    supplierName: typeof source.supplierName === "string" ? source.supplierName : "",
    price: typeof source.price === "string" ? source.price : "",
    barging: typeof source.barging === "string" ? source.barging : "",
  }
}

export async function GET(request: Request) {
  try {
    const session = await requireSpcPagePermission("spc-fixtures", "view")
    const limit = Number(new URL(request.url).searchParams.get("limit") || 5000)
    const [fixtures, users] = await Promise.all([
      listSpcFixtures(session, limit),
      listSpcUserReferenceOptions(),
    ])
    return NextResponse.json(
      { fixtures, users },
      {
        headers: {
          "Cache-Control": "private, no-store",
        },
      },
    )
  } catch (error) {
    return errorResponse(error, "Failed to load SPC fixtures.")
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requireSpcPagePermission("spc-fixtures", "edit")
    const payload = (await request.json()) as {
      id?: unknown
      action?: unknown
      fixture?: unknown
    }
    const id = typeof payload.id === "string" ? payload.id.trim() : ""
    if (!id) throw new Error("Fixture id is required.")
    const action = payload.action === "complete" ? "complete" : payload.action === "delete" ? "delete" : "save"
    if (action === "delete") {
      const deletedId = await deleteSpcFixture(id, session, request)
      return NextResponse.json({ success: true, id: deletedId })
    }
    const source =
      payload.fixture && typeof payload.fixture === "object"
        ? (payload.fixture as Record<string, unknown>)
        : {}
    const fixture = await updateSpcFixture(id, fixtureInput(source), action, session, request)
    return NextResponse.json({ success: true, fixture })
  } catch (error) {
    return errorResponse(error, "Failed to save SPC fixture.")
  }
}
