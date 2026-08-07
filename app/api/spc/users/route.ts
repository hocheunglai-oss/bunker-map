import {
  hasSpcAdminPagePermission,
  requireSpcAdminPagePermission,
  requireSpcSession,
} from "@/lib/spcAuth"
import {
  createSpcAuditContext,
  recordSpcUserManagementAuditEvent,
  type SpcAuditActionContext,
  type SpcAuditContext,
} from "@/lib/spcAudit"
import {
  deleteManagedSpcRoleDefault,
  deleteManagedSpcOffice,
  deleteManagedSpcUser,
  listManagedSpcOffices,
  listManagedSpcRoleDefaults,
  listManagedSpcUsers,
  saveManagedSpcOffice,
  saveManagedSpcUser,
  saveManagedSpcRoleDefault,
  spcUserCanManageUsers,
} from "@/lib/spcUsers"
import { SPC_PAGE_DEFINITIONS } from "@/lib/spcPages"
import { spcPrivateJson } from "@/lib/spcResponse"

type UserActionPayload = {
  action?: string
  user?: {
    id?: string
    username?: string
    displayName?: string
    whatsappPhone?: string
    role?: string
    office?: string
    mustChangePassword?: boolean
    isSupplierTrader?: boolean
    password?: string
    isActive?: boolean
  }
  roleDefault?: {
    role?: string
    permissions?: Record<string, "none" | "view" | "edit">
  }
  office?: string
  id?: string
}

type UserManagementAuditDescriptor = SpcAuditActionContext & {
  operation: "INSERT" | "UPDATE" | "DELETE"
}

function safeAuditText(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return null
  const clean = value.trim().replace(/[\u0000-\u001f\u007f]/g, "")
  return clean ? clean.slice(0, maximumLength) : null
}

function describeUserManagementAction(
  payload: UserActionPayload,
): UserManagementAuditDescriptor {
  switch (payload.action) {
    case "delete":
      return {
        operation: "DELETE",
        action: "delete-user",
        targetType: "spc-user",
        targetId: safeAuditText(payload.id, 256),
      }
    case "save":
      return {
        operation: payload.user?.id ? "UPDATE" : "INSERT",
        action: payload.user?.id ? "update-user" : "create-user",
        targetType: "spc-user",
        targetId: safeAuditText(payload.user?.id, 256),
        targetUsername: safeAuditText(payload.user?.username, 320),
        passwordChanged: Boolean(payload.user?.password),
      }
    case "save-office":
      return {
        operation: "UPDATE",
        action: "save-office",
        targetType: "spc-office",
        targetId: safeAuditText(payload.office, 256),
      }
    case "delete-office":
      return {
        operation: "DELETE",
        action: "delete-office",
        targetType: "spc-office",
        targetId: safeAuditText(payload.office, 256),
      }
    case "save-role-default":
      return {
        operation: "UPDATE",
        action: "save-role-default",
        targetType: "spc-role",
        targetId: safeAuditText(payload.roleDefault?.role, 256),
      }
    case "delete-role-default":
      return {
        operation: "DELETE",
        action: "delete-role-default",
        targetType: "spc-role",
        targetId: safeAuditText(payload.roleDefault?.role, 256),
      }
    default:
      return {
        operation: "UPDATE",
        action: "unsupported-action",
        targetType: "spc-user-management",
      }
  }
}

function errorStatus(error: unknown) {
  const message = error instanceof Error ? error.message : ""
  return (
    message === "Unauthorized"
      ? 401
      : message === "Forbidden"
        ? 403
        : message.includes("required") ||
            message.includes("Missing") ||
            message.includes("Unsupported") ||
            message.includes("Password") ||
            message.includes("password") ||
            message.includes("no more than") ||
            message.includes("cannot delete") ||
            message.includes("final active ADMIN") ||
            message.includes("valid permission group") ||
            message.includes("WhatsApp phone") ||
            message.includes("Built-in") ||
            message.includes("Move all users") ||
            message.includes("Move users")
          ? 400
          : 500
  )
}

function errorResponse(
  error: unknown,
  fallback: string,
  correlationId?: string,
) {
  const status = errorStatus(error)
  const rawMessage = error instanceof Error ? error.message : fallback
  const message =
    status === 500
      ? `${fallback}${correlationId ? ` Reference: ${correlationId}.` : ""}`
      : rawMessage
  return spcPrivateJson({ message }, { status })
}

function auditErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : ""
  if (message === "Forbidden") return "forbidden"
  if (message.includes("final active ADMIN")) return "admin_continuity"
  if (message.includes("signed in with")) return "self_delete_blocked"
  if (
    message.includes("required") ||
    message.includes("Missing") ||
    message.includes("Unsupported") ||
    message.includes("valid permission group") ||
    message.includes("Password") ||
    message.includes("password") ||
    message.includes("no more than") ||
    message.includes("WhatsApp phone")
  ) {
    return "invalid_request"
  }
  return "operation_failed"
}

export async function GET() {
  try {
    await requireSpcAdminPagePermission("spc-user-management", "view")
    const roleDefaultState = await listManagedSpcRoleDefaults(SPC_PAGE_DEFINITIONS)
    const [users, offices] = await Promise.all([
      listManagedSpcUsers(roleDefaultState, SPC_PAGE_DEFINITIONS),
      listManagedSpcOffices(),
    ])
    return spcPrivateJson({
      users,
      offices,
      pages: SPC_PAGE_DEFINITIONS,
      roleDefaults: roleDefaultState,
      groupStorage: "shared-store",
    })
  } catch (error) {
    return errorResponse(error, "Failed to load SPC users.")
  }
}

export async function POST(request: Request) {
  let auditContext: SpcAuditContext | null = null
  let auditOperation: UserManagementAuditDescriptor["operation"] = "UPDATE"
  let outcomeAuditAttempted = false

  try {
    const session = await requireSpcSession()
    if (!hasSpcAdminPagePermission(session, "edit")) {
      auditContext = createSpcAuditContext(
        session,
        request,
        "spc-user-management",
        {
          action: "access-user-management",
          targetType: "spc-user-management",
          outcome: "denied",
        },
      )
      outcomeAuditAttempted = true
      await recordSpcUserManagementAuditEvent(auditContext, {
        operation: "UPDATE",
        errorCode: "forbidden",
      })
      throw new Error("Forbidden")
    }

    const payload = (await request.json().catch(() => ({}))) as UserActionPayload
    const descriptor = describeUserManagementAction(payload)
    auditOperation = descriptor.operation
    auditContext = createSpcAuditContext(
      session,
      request,
      "spc-user-management",
      descriptor,
    )

    if (payload.action === "delete") {
      if (!payload.id) {
        throw new Error("Missing user id.")
      }

      const roleDefaults = await listManagedSpcRoleDefaults(SPC_PAGE_DEFINITIONS)
      const users = await listManagedSpcUsers(roleDefaults, SPC_PAGE_DEFINITIONS)
      const targetUser = users.find((user) => user.id === payload.id)
      const isBootstrapSelfDelete =
        session.username === "spcadmin" &&
        targetUser?.username === "spcadmin" &&
        users.some(
          (user) =>
            user.username !== "spcadmin" &&
            user.isActive &&
            user.role === "ADMIN" &&
            spcUserCanManageUsers(user),
        )

      if (session.username && targetUser?.username === session.username && !isBootstrapSelfDelete) {
        throw new Error("You cannot delete the account you are signed in with.")
      }

      await deleteManagedSpcUser(payload.id, auditContext)
      return spcPrivateJson({ success: true })
    }

    if (payload.action === "save") {
      if (!payload.user?.username) {
        throw new Error("Username is required.")
      }

      const roleDefaults = await listManagedSpcRoleDefaults(SPC_PAGE_DEFINITIONS)
      const user = await saveManagedSpcUser(
        {
          id: payload.user.id,
          username: payload.user.username,
          displayName: payload.user.displayName,
          whatsappPhone: payload.user.whatsappPhone,
          role: payload.user.role,
          office: payload.user.office,
          mustChangePassword: payload.user.mustChangePassword,
          isSupplierTrader: payload.user.isSupplierTrader,
          password: payload.user.password,
          isActive: payload.user.isActive,
        },
        auditContext,
        SPC_PAGE_DEFINITIONS,
        roleDefaults,
      )
      return spcPrivateJson({ success: true, user })
    }

    if (payload.action === "save-office") {
      if (!payload.office) {
        throw new Error("Office is required.")
      }

      const offices = await saveManagedSpcOffice(payload.office, auditContext)
      return spcPrivateJson({ success: true, offices })
    }

    if (payload.action === "delete-office") {
      if (!payload.office) {
        throw new Error("Office is required.")
      }

      const offices = await deleteManagedSpcOffice(payload.office, auditContext)
      return spcPrivateJson({ success: true, offices })
    }

    if (payload.action === "save-role-default") {
      if (!payload.roleDefault?.role) {
        throw new Error("Role is required.")
      }

      const roleDefault = await saveManagedSpcRoleDefault(
        {
          role: payload.roleDefault.role,
          permissions: payload.roleDefault.permissions,
        },
        auditContext,
        SPC_PAGE_DEFINITIONS,
      )

      return spcPrivateJson({ success: true, roleDefault })
    }

    if (payload.action === "delete-role-default") {
      if (!payload.roleDefault?.role) {
        throw new Error("Role is required.")
      }

      await deleteManagedSpcRoleDefault(payload.roleDefault.role, auditContext)
      return spcPrivateJson({ success: true })
    }

    throw new Error("Unsupported action.")
  } catch (error) {
    if (auditContext && !outcomeAuditAttempted) {
      outcomeAuditAttempted = true
      try {
        await recordSpcUserManagementAuditEvent(
          { ...auditContext, outcome: "failed" },
          {
            operation: auditOperation,
            errorCode: auditErrorCode(error),
          },
        )
      } catch {
        return errorResponse(
          new Error("Audit evidence could not be recorded."),
          "Failed to save SPC user.",
          auditContext.correlationId,
        )
      }
    }

    return errorResponse(
      error,
      "Failed to save SPC user.",
      auditContext?.correlationId,
    )
  }
}
