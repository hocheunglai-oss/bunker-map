import { NextResponse } from "next/server"
import { createAdminAuditContext } from "@/lib/adminAudit"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { sendWhatsAppTextMessage } from "@/lib/whatsapp"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermission("whatsapp", "edit")
    const auditContext = createAdminAuditContext(session, request, "whatsapp")
    const body = (await request.json()) as { to?: unknown; message?: unknown }
    const to = typeof body.to === "string" ? body.to.trim() : ""
    const message = typeof body.message === "string" ? body.message.trim() : ""

    if (!to) return NextResponse.json({ message: "Recipient phone number is required." }, { status: 400 })
    if (!message) return NextResponse.json({ message: "Message is required." }, { status: 400 })

    const result = await sendWhatsAppTextMessage({ to, body: message, auditContext })
    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send WhatsApp message."
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    console.error("whatsapp send failed", error)
    return NextResponse.json({ message }, { status })
  }
}
