import { NextResponse } from "next/server"
import { createAdminAuditContext } from "@/lib/adminAudit"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { sendWhatsAppTemplateMessage } from "@/lib/whatsapp"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermission("whatsapp", "edit")
    const auditContext = createAdminAuditContext(session, request, "whatsapp")
    const body = (await request.json()) as {
      to?: unknown
      templateName?: unknown
      language?: unknown
      variableText?: unknown
      variableValues?: unknown
    }
    const to = typeof body.to === "string" ? body.to.trim() : ""
    const templateName = typeof body.templateName === "string" ? body.templateName.trim() : ""
    const language = typeof body.language === "string" ? body.language.trim() : ""
    const variableText = typeof body.variableText === "string" ? body.variableText.trim() : ""
    const variableValues =
      body.variableValues && typeof body.variableValues === "object" && !Array.isArray(body.variableValues)
        ? Object.fromEntries(
            Object.entries(body.variableValues as Record<string, unknown>).flatMap(([key, value]) =>
              key && typeof value === "string" ? [[key, value.trim()]] : [],
            ),
          )
        : undefined

    if (!to) return NextResponse.json({ message: "Recipient phone number is required." }, { status: 400 })
    if (!templateName) return NextResponse.json({ message: "Template is required." }, { status: 400 })
    if (!language) return NextResponse.json({ message: "Template language is required." }, { status: 400 })

    const result = await sendWhatsAppTemplateMessage({
      to,
      templateName,
      language,
      variableText,
      variableValues,
      auditContext,
    })
    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send WhatsApp template."
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    console.error("whatsapp template send failed", error)
    return NextResponse.json({ message }, { status })
  }
}
