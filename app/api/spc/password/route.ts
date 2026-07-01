import { NextResponse } from "next/server"
import { invalidateSpcUserLookupCache, requireSpcSession } from "@/lib/spcAuth"
import { createSpcAuditContext } from "@/lib/spcAudit"
import { changeManagedSpcUserPassword } from "@/lib/spcUsers"

export async function POST(request: Request) {
  try {
    const session = await requireSpcSession()
    if (!session.username) throw new Error("Unauthorized")
    const payload = (await request.json()) as { password?: unknown }
    const password = typeof payload.password === "string" ? payload.password : ""
    const auditContext = createSpcAuditContext(session, request, "spc-user-management")
    const user = await changeManagedSpcUserPassword(session.username, password, auditContext)
    invalidateSpcUserLookupCache(session.username)

    return NextResponse.json({
      success: true,
      user: {
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        office: user.office,
        mustChangePassword: user.mustChangePassword,
        permissions: user.permissions,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update password."
    return NextResponse.json(
      { message },
      {
        status:
          message === "Unauthorized"
            ? 401
            : message.includes("at least") || message.includes("required")
              ? 400
              : 500,
      },
    )
  }
}
