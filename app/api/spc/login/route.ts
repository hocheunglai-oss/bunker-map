import { NextResponse } from "next/server"
import { setSpcSession, validateSpcCredentials } from "@/lib/spcAuth"
import { getDefaultSpcLandingPath, SPC_PAGE_DEFINITIONS } from "@/lib/spcPages"

export async function POST(request: Request) {
  const { username, password } = await request.json()

  let user = null

  try {
    user = await validateSpcCredentials(username || "", password || "")
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        message: error instanceof Error ? error.message : "SPC login is not configured.",
      },
      { status: 500 },
    )
  }

  if (!user) {
    return NextResponse.json(
      { success: false, message: "Invalid username or password." },
      { status: 401 },
    )
  }

  await setSpcSession(user)

  return NextResponse.json({
    success: true,
    user: {
      username: user.username,
      displayName: user.displayName || user.username,
      role: user.role,
      permissions: user.permissions,
    },
    pages: SPC_PAGE_DEFINITIONS,
    redirectTo: getDefaultSpcLandingPath(user.permissions),
  })
}
