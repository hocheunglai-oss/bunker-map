import { NextResponse } from "next/server"
import { requireSpcRole } from "@/lib/spcAuth"
import { createSpcAuditContext } from "@/lib/spcAudit"
import {
  deleteManagedSpcUser,
  listManagedSpcUsers,
  saveManagedSpcUser,
  SPC_ROLE_DEFINITIONS,
} from "@/lib/spcUsers"

type UserActionPayload = {
  action?: string
  user?: {
    id?: string
    username?: string
    displayName?: string
    role?: string
    password?: string
    isActive?: boolean
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
        : message.includes("required") || message.includes("cannot delete")
          ? 400
          : 500
  return NextResponse.json({ message }, { status })
}

export async function GET() {
  try {
    await requireSpcRole("buyer_trader")
    const users = await listManagedSpcUsers()
    return NextResponse.json({ users, roles: SPC_ROLE_DEFINITIONS })
  } catch (error) {
    return errorResponse(error, "Failed to load SPC users.")
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSpcRole("buyer_trader")
    const payload = (await request.json()) as UserActionPayload
    const auditContext = createSpcAuditContext(session, request, "spc-user-management")

    if (payload.action === "delete") {
      if (!payload.id) {
        return NextResponse.json({ message: "Missing user id." }, { status: 400 })
      }

      const users = await listManagedSpcUsers()
      const targetUser = users.find((user) => user.id === payload.id)
      if (session.username && targetUser?.username === session.username) {
        return NextResponse.json(
          { message: "You cannot delete the account you are signed in with." },
          { status: 400 },
        )
      }

      await deleteManagedSpcUser(payload.id, auditContext)
      return NextResponse.json({ success: true })
    }

    if (payload.action === "save") {
      if (!payload.user?.username) {
        return NextResponse.json({ message: "Username is required." }, { status: 400 })
      }

      const user = await saveManagedSpcUser(
        {
          id: payload.user.id,
          username: payload.user.username,
          displayName: payload.user.displayName,
          role: payload.user.role,
          password: payload.user.password,
          isActive: payload.user.isActive,
        },
        auditContext,
      )

      return NextResponse.json({ success: true, user })
    }

    return NextResponse.json({ message: "Unsupported action." }, { status: 400 })
  } catch (error) {
    return errorResponse(error, "Failed to save SPC user.")
  }
}
