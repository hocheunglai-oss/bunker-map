import { NextResponse } from "next/server"
import { createAdminAuditContext } from "@/lib/adminAudit"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { reorderWhatsAppAssignedContacts } from "@/lib/whatsapp"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermission("whatsapp", "edit")
    const auditContext = createAdminAuditContext(session, request, "whatsapp")
    const body = (await request.json()) as {
      items?: unknown
      listType?: unknown
    }
    const items = Array.isArray(body.items)
      ? body.items.map((item) => {
          const value = item as { conversationId?: unknown; order?: unknown }
          return {
            conversationId: typeof value.conversationId === "string" ? value.conversationId : "",
            order: Number(value.order),
          }
        })
      : []

    const listType = body.listType === "buyer" ? "buyer" : "supplier"
    const conversations = await reorderWhatsAppAssignedContacts(items, auditContext, listType)
    return NextResponse.json({ success: true, conversations })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save WhatsApp contact order."
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    return NextResponse.json({ message }, { status })
  }
}
