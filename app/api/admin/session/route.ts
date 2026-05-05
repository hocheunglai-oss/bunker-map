import { cookies } from "next/headers"
import { NextResponse } from "next/server"

const ADMIN_COOKIE_NAME = "bunker_admin_auth"
const ADMIN_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

export async function GET() {
  const cookieStore = await cookies()
  const authenticated = cookieStore.get(ADMIN_COOKIE_NAME)?.value === "1"

  if (authenticated) {
    cookieStore.set(ADMIN_COOKIE_NAME, "1", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: ADMIN_COOKIE_MAX_AGE,
    })
  }

  return NextResponse.json({ authenticated })
}
