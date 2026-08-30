import { NextResponse } from "next/server"
import { getOidcClient, hashOidcValue, validateClientAuthentication, verifyOidcToken } from "@/lib/fcunoOidc"
import { revokeOidcToken } from "@/lib/fcunoOidcStore"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function complete() { return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } }) }

export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) return complete()
  try {
    const form = await request.formData()
    const tokens = form.getAll("token")
    const bodyClientIds = form.getAll("client_id")
    if (tokens.length !== 1 || typeof tokens[0] !== "string" || bodyClientIds.length > 1 || bodyClientIds.some((value) => typeof value !== "string")) return complete()
    const claims = verifyOidcToken(String(tokens[0]), { allowExpired: true })
    if (!claims) return complete()
    const client = getOidcClient(claims.aud)
    if (!client || !validateClientAuthentication(client, request.headers.get("authorization"), bodyClientIds.length ? String(bodyClientIds[0]) : null)) return complete()
    await revokeOidcToken(hashOidcValue(claims.jti), claims.exp)
  } catch (error) {
    console.error("OIDC revocation failed", error)
  }
  return complete()
}
