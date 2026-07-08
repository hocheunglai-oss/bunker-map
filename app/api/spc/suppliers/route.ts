import { NextResponse } from "next/server"
import {
  hasSpcPagePermission,
  requireSpcSession,
} from "@/lib/spcAuth"
import { loadSpcSupplierDataset } from "@/lib/spcSuppliers"

export const dynamic = "force-dynamic"

function statusForMessage(message: string) {
  if (message === "Unauthorized") return 401
  if (message === "Forbidden") return 403
  return 500
}

async function requireSupplierView() {
  const session = await requireSpcSession()
  if (
    !hasSpcPagePermission(session, "spc-suppliers", "view") &&
    !hasSpcPagePermission(session, "spc-fixtures", "view")
  ) {
    throw new Error("Forbidden")
  }
  return session
}

export async function GET() {
  try {
    await requireSupplierView()
    const dataset = await loadSpcSupplierDataset()
    return NextResponse.json(dataset, {
      headers: {
        "Cache-Control": "private, no-store",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load suppliers."
    return NextResponse.json({ message }, { status: statusForMessage(message) })
  }
}

export async function PATCH(request: Request) {
  void request
  return NextResponse.json(
    { message: "Supplier database is imported from the supplier sheet." },
    { status: 405 },
  )
}
