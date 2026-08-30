import { NextResponse } from "next/server"
import { buildIdentityClaims, getOidcClient, hashOidcValue, verifyOidcToken } from "@/lib/fcunoOidc"
import { getOidcIdentity, isOidcTokenRevoked } from "@/lib/fcunoOidcStore"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function unauthorized() {
  return NextResponse.json({ error: "invalid_token" }, { status: 401, headers: { "WWW-Authenticate": 'Bearer error="invalid_token"', "Cache-Control": "no-store" } })
}

export async function GET(request: Request) {
  const match = /^Bearer ([A-Za-z0-9._-]{20,8192})$/.exec(request.headers.get("authorization") || "")
  if (!match) return unauthorized()
  try {
    const claims = verifyOidcToken(match[1])
    if (!claims || claims.typ !== "at+jwt" || !getOidcClient(claims.aud)) return unauthorized()
    const [identity, revoked] = await Promise.all([getOidcIdentity(claims.sub), isOidcTokenRevoked(hashOidcValue(claims.jti))])
    if (!identity || revoked || !identity.isActive || !identity.useFcos || !identity.emailVerified || identity.identityRevision !== claims.identity_revision || identity.credentialRevision !== claims.credential_revision || Math.floor(Date.parse(identity.revokedBefore) / 1000) >= claims.iat) return unauthorized()
    return NextResponse.json({ sub: identity.id, ...buildIdentityClaims(identity) }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    console.error("OIDC userinfo failed", error)
    return unauthorized()
  }
}
