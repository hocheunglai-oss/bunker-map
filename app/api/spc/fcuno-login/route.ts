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
  let session
  try {
    session = await requireAdminIdentitySession()
  } catch {
    const login = new URL("/admin", request.url)
    login.searchParams.set("returnTo", "/api/spc/fcuno-login")
    return NextResponse.redirect(login, { status: 302 })
  }
  const user = await getFcunoLinkedSpcUser(session.adminUserId)
  if (!user) {
    return new Response("This FCUNO identity is not authorized for SPC.", { status: 403 })
  }
  await setSpcSession(user)
  return NextResponse.redirect(new URL("/spc", request.url), { status: 302 })
}
