import { NextResponse } from "next/server"
import { federationNotFound, isFcosIdentitySyncEnabled } from "@/lib/fcunoFederationFlags"
import { getOidcJwks } from "@/lib/fcunoOidc"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  if (!isFcosIdentitySyncEnabled()) return federationNotFound()
  try {
    return NextResponse.json(getOidcJwks(), {
      headers: { "Cache-Control": "public, max-age=300" },
    })
  } catch (error) {
    console.error("FCOS identity synchronization JWKS configuration error", error)
    return NextResponse.json(
      { error: "server_error" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    )
  }
}
