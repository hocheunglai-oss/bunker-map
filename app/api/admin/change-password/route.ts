import { NextResponse } from "next/server"
import { requireAdminPasswordResetSession } from "@/lib/adminAuth"
import { completeDatabaseAdminPasswordReset } from "@/lib/adminUsers"

export async function POST(request: Request) {
  try {
    const session = await requireAdminPasswordResetSession()
    const payload = (await request.json()) as {
      password?: string
      confirmPassword?: string
    }
    const password = payload.password || ""

    if (password !== (payload.confirmPassword || "")) {
      return NextResponse.json(
        { message: "The new passwords do not match." },
        { status: 400 },
      )
    }

    await completeDatabaseAdminPasswordReset({
      adminUserId: session.adminUserId,
      sessionId: session.sessionId,
      newPassword: password,
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Password reset failed."
    const status =
      message === "Unauthorized"
        ? 401
        : message.includes("Password") ||
            message.includes("password") ||
            message.includes("Choose")
          ? 400
          : 500

    return NextResponse.json({ message }, { status })
  }
}
