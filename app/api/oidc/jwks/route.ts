import { NextResponse } from "next/server"
import { federationNotFound, isFcunoOidcEnabled } from "@/lib/fcunoFederationFlags"
import { getOidcJwks } from "@/lib/fcunoOidc"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  if (!isFcunoOidcEnabled()) return federationNotFound()
  try {
    return NextResponse.json(getOidcJwks(), { headers: { "Cache-Control": "public, max-age=300" } })
  } catch (error) {
    console.error("OIDC JWKS configuration error", error)
    return NextResponse.json({ error: "server_error" }, { status: 503, headers: { "Cache-Control": "no-store" } })
  }
}
