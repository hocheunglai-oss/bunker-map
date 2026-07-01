import { NextResponse } from "next/server"
import {
  hasSpcPagePermission,
  requireSpcPagePermission,
  requireSpcSession,
} from "@/lib/spcAuth"
import { loadSpcSupplierDataset, saveSpcSupplier } from "@/lib/spcSuppliers"
import type { SpcSupplierSaveInput } from "@/lib/spcSupplierTypes"

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
  try {
    const session = await requireSpcPagePermission("spc-suppliers", "edit")
    const payload = (await request.json()) as Partial<SpcSupplierSaveInput>
    const supplierKey = typeof payload.supplierKey === "string" ? payload.supplierKey : ""
    if (!supplierKey) {
      return NextResponse.json({ message: "Missing supplier." }, { status: 400 })
    }

    const result = await saveSpcSupplier(
      {
        supplierKey,
        info: payload.info,
        contact: payload.contact,
        bdnEntries: Array.isArray(payload.bdnEntries) ? payload.bdnEntries : [],
      },
      session,
      request,
    )

    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "private, no-store",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save supplier."
    return NextResponse.json({ message }, { status: statusForMessage(message) })
  }
}
