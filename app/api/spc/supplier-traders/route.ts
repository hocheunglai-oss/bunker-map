import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import { listSupplierTraderOptions } from "@/lib/spcUsers"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    await requireSpcPagePermission("spc-buyer-enquiries", "edit")
    const supplierTraders = await listSupplierTraderOptions()
    return NextResponse.json(
      { supplierTraders },
      {
        headers: {
          "Cache-Control": "private, no-store",
        },
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load supplier traders."
    return NextResponse.json(
      { message },
      { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500 },
    )
  }
}
