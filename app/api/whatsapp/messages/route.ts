import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { loadWhatsAppConversationMessages } from "@/lib/whatsapp"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  try {
    await requireAdminPagePermission("whatsapp", "view")
    const conversationId = new URL(request.url).searchParams.get("conversationId")?.trim() || ""
    if (!conversationId) {
      return NextResponse.json({ message: "Conversation id is required." }, { status: 400 })
    }

    const messages = await loadWhatsAppConversationMessages(conversationId)
    return NextResponse.json(
      { messages },
      {
        headers: {
          "Cache-Control": "private, no-store",
        },
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load WhatsApp messages."
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    return NextResponse.json({ message }, { status })
  }
}
