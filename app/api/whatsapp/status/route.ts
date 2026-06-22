import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { getWhatsAppConfigStatus, loadWhatsAppInbox } from "@/lib/whatsapp"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  try {
    await requireAdminPagePermission("whatsapp", "view")
    const url = new URL(request.url)
    const inbox = await loadWhatsAppInbox(null).catch((error) => {
      const message = error instanceof Error ? error.message : "Unable to inspect WhatsApp storage."
      return {
        conversations: [],
        messages: [],
        selectedConversationId: null,
        storageReady: false,
        storageMessage: message,
      }
    })

    return NextResponse.json({
      config: getWhatsAppConfigStatus(),
      webhookUrl: `${url.origin}/api/whatsapp/webhook`,
      storageReady: inbox.storageReady,
      storageMessage: inbox.storageMessage,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load WhatsApp status."
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    return NextResponse.json({ message }, { status })
  }
}
