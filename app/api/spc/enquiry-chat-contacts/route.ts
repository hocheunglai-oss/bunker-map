import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import { listSpcEnquiryChatContacts } from "@/lib/spcEnquiryChatContacts"

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Failed to load SPC enquiry chat contacts."
  const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
  return NextResponse.json({ message }, { status })
}

export async function GET(request: Request) {
  try {
    await requireSpcPagePermission("spc-buyer-enquiries", "view")
    const usernames = new URL(request.url).searchParams.getAll("username")
    const contacts = await listSpcEnquiryChatContacts(usernames)
    return NextResponse.json(
      { contacts },
      { headers: { "Cache-Control": "private, no-store" } },
    )
  } catch (error) {
    return errorResponse(error)
  }
}
