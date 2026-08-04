import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import { listSpcWhatsappChatContacts } from "@/lib/spcWhatsappChatContacts"

export const dynamic = "force-dynamic"

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Failed to load SPC WhatsApp chat contacts."
  const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
  return NextResponse.json({ message }, { status })
}

export async function GET(request: Request) {
  try {
    await requireSpcPagePermission("spc-chrome-extension", "view")
    const names = new URL(request.url).searchParams.getAll("name")
    const contacts = await listSpcWhatsappChatContacts(names)
    return NextResponse.json(
      { contacts },
      { headers: { "Cache-Control": "private, no-store" } },
    )
  } catch (error) {
    return errorResponse(error)
  }
}
