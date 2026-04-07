import { cookies } from "next/headers"
import { NextResponse } from "next/server"

const ADMIN_COOKIE_NAME = "bunker_admin_auth"

export async function GET() {
  const cookieStore = await cookies()
  const authenticated = cookieStore.get(ADMIN_COOKIE_NAME)?.value === "1"

  return NextResponse.json({ authenticated })
}
