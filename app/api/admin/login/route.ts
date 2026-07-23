import { NextResponse } from "next/server"
import { setAdminSession, validateAdminCredentials } from "@/lib/adminAuth"

export async function POST(request: Request) {
  const { username, password } = await request.json()

  let user = null

  try {
    user = await validateAdminCredentials(username || "", password || "")
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        message:
          error instanceof Error ? error.message : "Admin password is not configured.",
      },
      { status: 500 }
    )
  }

  if (!user) {
    return NextResponse.json(
      { success: false, message: "Invalid username or password." },
      { status: 401 }
    )
  }

  try {
    await setAdminSession(user)
  } catch {
    return NextResponse.json(
      {
        success: false,
        message: "Unable to create a secure admin session. Please try again.",
      },
      { status: 503 },
    )
  }

  return NextResponse.json({
    success: true,
    user: {
      username: user.username,
      displayName: user.displayName || user.username,
      role: user.role || null,
      resetRequired: user.passwordResetRequired,
      permissions: user.permissions,
      pages: user.pages,
    },
  })
}
