import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

export function proxy(request: NextRequest) {
  const host = (request.headers.get("host") || "").split(":")[0].toLowerCase()
  const isSpcHost = host === "spc.fcuno.com"

  if (isSpcHost && request.nextUrl.pathname === "/spc") {
    const target = request.nextUrl.clone()
    target.pathname = "/"
    return NextResponse.redirect(target, 308)
  }

  if (isSpcHost && request.nextUrl.pathname.startsWith("/spc/")) {
    const target = request.nextUrl.clone()
    target.pathname = request.nextUrl.pathname.replace(/^\/spc/, "") || "/"
    return NextResponse.redirect(target, 308)
  }

  if (isSpcHost && !request.nextUrl.pathname.startsWith("/spc")) {
    const target = request.nextUrl.clone()
    target.pathname =
      request.nextUrl.pathname === "/"
        ? "/spc"
        : `/spc${request.nextUrl.pathname}`
    return NextResponse.rewrite(target)
  }

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
