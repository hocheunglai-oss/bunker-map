import { NextResponse } from "next/server"
import { invalidateSpcUserLookupCache, requireSpcPagePermission } from "@/lib/spcAuth"
import { createSpcAuditContext } from "@/lib/spcAudit"
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

type UserActionPayload = {
  action?: string
  user?: {
    id?: string
    username?: string
    displayName?: string
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

function errorResponse(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback
  const status =
    message === "Unauthorized"
      ? 401
      : message === "Forbidden"
        ? 403
        : message.includes("required") ||
            message.includes("cannot delete") ||
            message.includes("valid permission group") ||
            message.includes("Built-in") ||
            message.includes("Move all users") ||
            message.includes("Move users")
          ? 400
          : 500
  return NextResponse.json({ message }, { status })
}

export async function GET() {
  try {
    await requireSpcPagePermission("spc-user-management", "view")
    const roleDefaultState = await listManagedSpcRoleDefaults(SPC_PAGE_DEFINITIONS)
    const [users, offices] = await Promise.all([
      listManagedSpcUsers(roleDefaultState, SPC_PAGE_DEFINITIONS),
      listManagedSpcOffices(),
    ])
    return NextResponse.json({
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
  try {
    const session = await requireSpcPagePermission("spc-user-management", "edit")
    const payload = (await request.json()) as UserActionPayload
    const auditContext = createSpcAuditContext(session, request, "spc-user-management")

    if (payload.action === "delete") {
      if (!payload.id) {
        return NextResponse.json({ message: "Missing user id." }, { status: 400 })
      }

      const roleDefaults = await listManagedSpcRoleDefaults(SPC_PAGE_DEFINITIONS)
      const users = await listManagedSpcUsers(roleDefaults, SPC_PAGE_DEFINITIONS)
      const targetUser = users.find((user) => user.id === payload.id)
      const isBootstrapSelfDelete =
        session.username === "spcadmin" &&
        targetUser?.username === "spcadmin" &&
        users.some((user) => user.username !== "spcadmin" && spcUserCanManageUsers(user))

      if (session.username && targetUser?.username === session.username && !isBootstrapSelfDelete) {
        return NextResponse.json(
          { message: "You cannot delete the account you are signed in with." },
          { status: 400 },
        )
      }

      await deleteManagedSpcUser(payload.id, auditContext)
      invalidateSpcUserLookupCache(targetUser?.username)
      return NextResponse.json({ success: true })
    }

    if (payload.action === "save") {
      if (!payload.user?.username) {
        return NextResponse.json({ message: "Username is required." }, { status: 400 })
      }

      const roleDefaults = await listManagedSpcRoleDefaults(SPC_PAGE_DEFINITIONS)
      const user = await saveManagedSpcUser(
        {
          id: payload.user.id,
          username: payload.user.username,
          displayName: payload.user.displayName,
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
      invalidateSpcUserLookupCache(user.username)

      return NextResponse.json({ success: true, user })
    }

    if (payload.action === "save-office") {
      if (!payload.office) {
        return NextResponse.json({ message: "Office is required." }, { status: 400 })
      }

      const offices = await saveManagedSpcOffice(payload.office, auditContext)
      return NextResponse.json({ success: true, offices })
    }

    if (payload.action === "delete-office") {
      if (!payload.office) {
        return NextResponse.json({ message: "Office is required." }, { status: 400 })
      }

      const offices = await deleteManagedSpcOffice(payload.office, auditContext)
      return NextResponse.json({ success: true, offices })
    }

    if (payload.action === "save-role-default") {
      if (!payload.roleDefault?.role) {
        return NextResponse.json({ message: "Role is required." }, { status: 400 })
      }

      const roleDefault = await saveManagedSpcRoleDefault(
        {
          role: payload.roleDefault.role,
          permissions: payload.roleDefault.permissions,
        },
        auditContext,
        SPC_PAGE_DEFINITIONS,
      )

      return NextResponse.json({ success: true, roleDefault })
    }

    if (payload.action === "delete-role-default") {
      if (!payload.roleDefault?.role) {
        return NextResponse.json({ message: "Role is required." }, { status: 400 })
      }

      await deleteManagedSpcRoleDefault(payload.roleDefault.role, auditContext)
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ message: "Unsupported action." }, { status: 400 })
  } catch (error) {
    return errorResponse(error, "Failed to save SPC user.")
  }
}
