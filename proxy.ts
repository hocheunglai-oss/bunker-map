import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

// Shared, pinned static resources must not enter SPC or China page routing.
const sharedRobotoPaths = new Set([
  "/fonts/roboto/roboto-v51-cyrillic-ext.e44224eb71a96cb3.woff2",
  "/fonts/roboto/roboto-v51-cyrillic.32886c5ec61a0d06.woff2",
  "/fonts/roboto/roboto-v51-greek-ext.5fdfeaf926cac990.woff2",
  "/fonts/roboto/roboto-v51-greek.4813e3dfbbb23708.woff2",
  "/fonts/roboto/roboto-v51-math.297193369eea6001.woff2",
  "/fonts/roboto/roboto-v51-symbols.fab8a0056d92fdd8.woff2",
  "/fonts/roboto/roboto-v51-vietnamese.2071148c26bd0430.woff2",
  "/fonts/roboto/roboto-v51-latin-ext.cdd53dc5576a79f3.woff2",
  "/fonts/roboto/roboto-v51-latin.0a44e0bb6ba5c853.woff2",
  "/fonts/roboto/OFL.txt",
])

export function proxy(request: NextRequest) {
  const host = (request.headers.get("host") || "").split(":")[0].toLowerCase()
  const isSpcHost = host === "spc.fcuno.com"

  // Keep the RFC 9116 contact at the same public path on every hostname.
  if (request.nextUrl.pathname === "/.well-known/security.txt" || sharedRobotoPaths.has(request.nextUrl.pathname)) {
    return NextResponse.next()
  }

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
