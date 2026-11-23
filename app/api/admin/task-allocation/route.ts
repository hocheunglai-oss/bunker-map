import { NextResponse } from "next/server"
import { createAdminAuditContext, createAdminAuditedSupabaseClient } from "@/lib/adminAudit"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import {
  parseTaskAllocationMutation,
  saveTaskAllocation,
  TaskAllocationConflictError,
  TaskAllocationValidationError,
} from "@/lib/taskAllocation"

const pageId = "task-allocation"
const headers = { "Cache-Control": "private, no-store" }

export async function PATCH(request: Request) {
  try {
    const session = await requireAdminPagePermission(pageId, "edit")
    const mutation = parseTaskAllocationMutation(await request.json().catch(() => null))
    const client = createAdminAuditedSupabaseClient(createAdminAuditContext(session, request, pageId), { useServiceRole: true })
    const allocation = await saveTaskAllocation(client, mutation)
    return NextResponse.json({ allocation }, { headers })
  } catch (error) {
    if (error instanceof TaskAllocationConflictError) {
      return NextResponse.json({ message: error.message, allocation: error.allocation }, { status: 409, headers })
    }
    if (error instanceof TaskAllocationValidationError) {
      return NextResponse.json({ message: error.message }, { status: 400, headers })
    }
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json({ message: error.message }, { status: error.message === "Unauthorized" ? 401 : 403, headers })
    }
    return NextResponse.json({ message: "Assignments could not be saved. Try again." }, { status: 500, headers })
  }
}
