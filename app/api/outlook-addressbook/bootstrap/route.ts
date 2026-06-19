import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { loadSharedAddressBook } from "@/lib/sharedAddressBookServer"

export async function GET() {
  try {
    await requireAdminPagePermission("outlook-addressbook", "view")
    const startedAt = Date.now()
    const data = await loadSharedAddressBook()

    return NextResponse.json(
      {
        ...data,
        serverFetchMs: Date.now() - startedAt,
      },
      {
        headers: {
          "Cache-Control": "private, no-store",
        },
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load Outlook address book."
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    return NextResponse.json({ message }, { status })
  }
}
