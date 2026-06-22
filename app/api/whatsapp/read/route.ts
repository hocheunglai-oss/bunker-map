import { NextResponse } from "next/server"
import { createAdminAuditContext } from "@/lib/adminAudit"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { markWhatsAppConversationRead } from "@/lib/whatsapp"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermission("whatsapp", "view")
    const auditContext = createAdminAuditContext(session, request, "whatsapp")
    const body = (await request.json()) as { conversationId?: unknown }
    const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : ""

    if (!conversationId) {
      return NextResponse.json({ message: "Conversation id is required." }, { status: 400 })
    }

    const conversation = await markWhatsAppConversationRead(conversationId, auditContext)
    return NextResponse.json({ success: true, conversation })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to mark WhatsApp conversation as read."
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    return NextResponse.json({ message }, { status })
  }
}
