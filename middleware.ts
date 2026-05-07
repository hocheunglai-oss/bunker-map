import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

export function middleware(request: NextRequest) {
  const enableCnRedirect = process.env.ENABLE_CN_REDIRECT === "true"
  const cnSiteUrl = process.env.NEXT_PUBLIC_CN_SITE_URL

  if (!enableCnRedirect || !cnSiteUrl) return NextResponse.next()

  const country = (request.headers.get("x-vercel-ip-country") || "").toUpperCase()
  if (country !== "CN") return NextResponse.next()

  const target = new URL(request.nextUrl.pathname + request.nextUrl.search, cnSiteUrl)
  return NextResponse.redirect(target, 307)
}

export const config = {
  matcher: ["/((?!_next|api|favicon.ico).*)"],
}
