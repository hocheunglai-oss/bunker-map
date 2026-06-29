import { NextResponse } from "next/server"
import { requireSpcRole } from "@/lib/spcAuth"
import { loadWhatsAppTemplates } from "@/lib/whatsapp"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    await requireSpcRole("supplier_trader")
    const templates = await loadWhatsAppTemplates()
    return NextResponse.json(
      { templates },
      {
        headers: {
          "Cache-Control": "private, no-store",
        },
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load WhatsApp templates."
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    return NextResponse.json({ message }, { status })
  }
}
