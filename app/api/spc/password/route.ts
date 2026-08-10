import { requireSpcSession, setSpcSession } from "@/lib/spcAuth"
import {
  createSpcAuditContext,
  recordSpcUserManagementAuditEvent,
  type SpcAuditContext,
} from "@/lib/spcAudit"
import { changeManagedSpcUserPassword } from "@/lib/spcUsers"
import { spcPrivateJson } from "@/lib/spcResponse"

function passwordErrorStatus(error: unknown) {
  const message = error instanceof Error ? error.message : ""
  return message === "Unauthorized"
    ? 401
    : message.includes("at least") ||
        message.includes("required") ||
        message.includes("no more than")
      ? 400
      : 500
}

export async function POST(request: Request) {
  let auditContext: SpcAuditContext | null = null

  try {
    const session = await requireSpcSession()
    if (!session.username) throw new Error("Unauthorized")
    auditContext = createSpcAuditContext(
      session,
      request,
      "spc-user-management",
      {
        action: "change-password",
        targetType: "spc-user",
        targetUsername: session.username,
        passwordChanged: true,
      },
    )
    const payload = (await request.json()) as { password?: unknown }
    const password = typeof payload.password === "string" ? payload.password : ""
    const user = await changeManagedSpcUserPassword(session.username, password, auditContext)
    await setSpcSession(user, {
      preserveMfaFromCurrentSession: Boolean(session.mfaVerifiedAt),
    })

    return spcPrivateJson({
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
    const status = passwordErrorStatus(error)
    if (auditContext) {
      try {
        await recordSpcUserManagementAuditEvent(
          { ...auditContext, outcome: "failed" },
          {
            operation: "UPDATE",
            errorCode: status === 400 ? "invalid_request" : "operation_failed",
          },
        )
      } catch {
        return spcPrivateJson(
          {
            message: `Audit evidence could not be recorded. Reference: ${auditContext.correlationId}.`,
          },
          {
            status: 500,
            headers: { "Cache-Control": "private, no-store" },
          },
        )
      }
    }

    const message = error instanceof Error ? error.message : "Failed to update password."
    return spcPrivateJson(
      {
        message:
          status === 500
            ? `Failed to update password.${auditContext ? ` Reference: ${auditContext.correlationId}.` : ""}`
            : message,
      },
      {
        status,
        headers: { "Cache-Control": "private, no-store" },
      },
    )
  }
}
