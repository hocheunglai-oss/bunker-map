import { cookies } from "next/headers"
import { NextResponse } from "next/server"

const ADMIN_COOKIE_NAME = "bunker_admin_auth"
const ADMIN_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

export async function POST(request: Request) {
  const { username, password } = await request.json()

  const expectedUsername = process.env.ADMIN_USERNAME || "admin"
  const expectedPassword = process.env.ADMIN_PASSWORD

  if (!expectedPassword) {
    return NextResponse.json(
      { success: false, message: "Admin password is not configured." },
      { status: 500 }
    )
  }

  if (username !== expectedUsername || password !== expectedPassword) {
    return NextResponse.json(
      { success: false, message: "Invalid username or password." },
      { status: 401 }
    )
  }

  const cookieStore = await cookies()
  cookieStore.set(ADMIN_COOKIE_NAME, "1", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ADMIN_COOKIE_MAX_AGE,
  })

  return NextResponse.json({ success: true })
}
