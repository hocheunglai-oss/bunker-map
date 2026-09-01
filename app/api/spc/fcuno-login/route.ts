import { NextResponse } from "next/server"
import { requireAdminIdentitySession } from "@/lib/adminAuth"
import { setSpcSession } from "@/lib/spcAuth"
import { getFcunoLinkedSpcUser } from "@/lib/spcUsers"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request) {
  if (process.env.FCUNO_SPC_LOGIN_ENABLED !== "true") {
    return new Response("FCUNO-linked SPC sign-in is not enabled.", { status: 404 })
  }
  const requestUrl = new URL(request.url)
  const silent = requestUrl.searchParams.get("silent") === "1"
  const loginHintValue = requestUrl.searchParams.get("login_hint")?.trim() || ""
  const loginHint = loginHintValue.length <= 320 ? loginHintValue : ""
  let session
  try {
    session = await requireAdminIdentitySession()
  } catch {
    if (silent) {
      return NextResponse.json({ authenticated: false }, { status: 401 })
    }
    const login = new URL("/admin", "https://fcuno.com")
    login.searchParams.set(
      "returnTo",
      new URL("/api/spc/fcuno-login", request.url).toString(),
    )
    if (loginHint) login.searchParams.set("loginHint", loginHint)
    return NextResponse.redirect(login, { status: 302 })
  }
  const user = await getFcunoLinkedSpcUser(session.adminUserId)
  if (!user) {
    return new Response("This FCUNO identity is not authorized for SPC.", { status: 403 })
  }
  await setSpcSession(user)
  if (silent) {
    return NextResponse.json({ authenticated: true })
  }
  return NextResponse.redirect(new URL("/spc", request.url), { status: 302 })
}
