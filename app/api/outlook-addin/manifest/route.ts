import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { buildOutlookManifest } from "@/scripts/outlook-manifest.mjs"

function buildBaseUrl(request: Request) {
  const configured = process.env.NEXT_PUBLIC_SITE_URL
  if (configured) return configured.replace(/\/$/, "")

  const url = new URL(request.url)
  const hostname = url.hostname === "localhost" || url.hostname === "127.0.0.1" ? "localhost" : url.hostname
  const port = url.port ? `:${url.port}` : ""
  const protocol = hostname === "localhost" ? "https:" : url.protocol
  return `${protocol}//${hostname}${port}`
}

export async function GET(request: Request) {
  try {
    await requireAdminPagePermission("email-templates", "view")
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unauthorized"
    return NextResponse.json(
      { message },
      { status: message === "Unauthorized" ? 401 : 403 }
    )
  }

  const xml = buildOutlookManifest(buildBaseUrl(request))

  return new NextResponse(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"fratelli-cosulich-templates-manifest.xml\"",
      "Cache-Control": "no-store, max-age=0",
    },
  })
}
