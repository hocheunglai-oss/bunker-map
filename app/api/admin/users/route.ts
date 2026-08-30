import { NextResponse } from "next/server"
import {
  deleteManagedAdminRoleDefault,
  deleteManagedAdminUser,
  listManagedAdminUsers,
  loadManagedAdminRoleDefaults,
  saveManagedAdminRoleDefault,
  saveManagedAdminUser,
} from "@/lib/adminUsers"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { getDiscoveredAdminPages } from "@/lib/adminPageDiscovery"

type UserActionPayload = {
  action?: string
  user?: {
    id?: string
    username?: string
    displayName?: string
    email?: string
    emailVerified?: boolean
    isActive?: boolean
    useFcos?: boolean
    useSpc?: boolean
    role?: string
    attendanceGroup?: "BT" | "BS" | "AC" | null
    password?: string
  }
  roleDefault?: {
    role?: string
    permissions?: Record<string, "none" | "view" | "edit">
  }
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
            message.includes("Password") ||
            message.includes("password") ||
            message.includes("valid permission group") ||
            message.includes("valid attendance group") ||
            message.includes("cannot be deleted") ||
            message.includes("Move all users")
          ? 400
          : 500
  return NextResponse.json({ message }, { status })
}

export async function GET() {
  try {
    await requireAdminPagePermission("user-management", "view")
    const pages = await getDiscoveredAdminPages()
    const roleDefaultState = await loadManagedAdminRoleDefaults(pages)
    const roleDefaults = roleDefaultState.roleDefaults
    const users = await listManagedAdminUsers(roleDefaults, pages)

    return NextResponse.json({
      users,
      pages,
      roleDefaults,
      groupStorage: roleDefaultState.storage,
    })
  } catch (error) {
    return errorResponse(error, "Failed to load admin users.")
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermission("user-management", "edit")
    const payload = (await request.json()) as UserActionPayload

    if (payload.action === "delete") {
      if (!payload.id) {
        return NextResponse.json({ message: "Missing user id." }, { status: 400 })
      }

      const users = await listManagedAdminUsers()
      const targetUser = users.find((user) => user.id === payload.id)

      if (session.username && targetUser?.username === session.username) {
        return NextResponse.json(
          { message: "You cannot delete the account you are signed in with." },
          { status: 400 }
        )
      }

      await deleteManagedAdminUser(payload.id, session)
      return NextResponse.json({ success: true })
    }

    if (payload.action === "save") {
      if (!payload.user?.username) {
        return NextResponse.json({ message: "Username is required." }, { status: 400 })
      }

      const pages = await getDiscoveredAdminPages()
      const roleDefaults = (await loadManagedAdminRoleDefaults(pages)).roleDefaults
      const existingUsers = payload.user.id
        ? await listManagedAdminUsers(roleDefaults, pages)
        : []
      const existingUser = existingUsers.find((user) => user.id === payload.user?.id)
      if (existingUser && session.username === existingUser.username && payload.user.isActive === false) {
        return NextResponse.json(
          { message: "You cannot deactivate the account you are signed in with." },
          { status: 400 },
        )
      }
      const user = await saveManagedAdminUser(
        {
          id: payload.user.id,
          username: payload.user.username,
          displayName: payload.user.displayName,
          email: payload.user.email ?? existingUser?.email ?? "",
          emailVerified: payload.user.emailVerified ?? existingUser?.emailVerified ?? false,
          isActive: payload.user.isActive ?? existingUser?.isActive ?? true,
          useFcos: payload.user.useFcos ?? existingUser?.useFcos ?? false,
          useSpc: payload.user.useSpc ?? existingUser?.useSpc ?? false,
          role: payload.user.role,
          attendanceGroup: payload.user.attendanceGroup,
          password: payload.user.password,
        },
        session,
        pages,
        roleDefaults
      )

      return NextResponse.json({ success: true, user })
    }

    if (payload.action === "save-role-default") {
      if (!payload.roleDefault?.role) {
        return NextResponse.json({ message: "Role is required." }, { status: 400 })
      }

      const pages = await getDiscoveredAdminPages()
      const roleDefault = await saveManagedAdminRoleDefault(
        {
          role: payload.roleDefault.role,
          permissions: payload.roleDefault.permissions,
        },
        session,
        pages
      )

      return NextResponse.json({ success: true, roleDefault })
    }

    if (payload.action === "delete-role-default") {
      if (!payload.roleDefault?.role) {
        return NextResponse.json({ message: "Role is required." }, { status: 400 })
      }

      await deleteManagedAdminRoleDefault(payload.roleDefault.role, session)
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ message: "Unsupported action." }, { status: 400 })
  } catch (error) {
    return errorResponse(error, "Failed to save admin user.")
  }
}
