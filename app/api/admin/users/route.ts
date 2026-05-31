import { NextResponse } from "next/server"
import {
  deleteManagedAdminUser,
  listManagedAdminUsers,
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
    role?: string
    password?: string
    permissions?: Record<string, "none" | "view" | "edit">
  }
  id?: string
}

function errorResponse(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback
  const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
  return NextResponse.json({ message }, { status })
}

export async function GET() {
  try {
    await requireAdminPagePermission("user-management", "view")
    const [users, pages] = await Promise.all([
      listManagedAdminUsers(),
      getDiscoveredAdminPages(),
    ])

    return NextResponse.json({
      users,
      pages,
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

      const user = await saveManagedAdminUser(
        {
          id: payload.user.id,
          username: payload.user.username,
          displayName: payload.user.displayName,
          role: payload.user.role,
          password: payload.user.password,
          permissions: payload.user.permissions,
        },
        session
      )

      return NextResponse.json({ success: true, user })
    }

    return NextResponse.json({ message: "Unsupported action." }, { status: 400 })
  } catch (error) {
    return errorResponse(error, "Failed to save admin user.")
  }
}
