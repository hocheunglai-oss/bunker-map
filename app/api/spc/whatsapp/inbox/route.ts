import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import { getWhatsAppConfigStatus, loadWhatsAppInbox } from "@/lib/whatsapp"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  try {
    await requireSpcPagePermission("spc-whatsapp", "view")
    const selectedConversationId = new URL(request.url).searchParams.get("conversationId")
    const inbox = await loadWhatsAppInbox(selectedConversationId)

    return NextResponse.json(
      {
        ...inbox,
        config: getWhatsAppConfigStatus(),
      },
      {
        headers: {
          "Cache-Control": "private, no-store",
        },
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load WhatsApp inbox."
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    return NextResponse.json({ message }, { status })
  }
}
