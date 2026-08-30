import { NextResponse } from "next/server"
import {
  buildIdentityClaims,
  getOidcClient,
  issueOidcToken,
  hashOidcValue,
  validateClientAuthentication,
  verifyPkceS256,
} from "@/lib/fcunoOidc"
import { consumeOidcAuthorizationCode, getOidcIdentity } from "@/lib/fcunoOidcStore"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function errorResponse(error: string, status = 400) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } })
}

function single(form: FormData, name: string, required = true) {
  const values = form.getAll(name)
  if ((required && values.length !== 1) || (!required && values.length > 1) || values.some((value) => typeof value !== "string")) return null
  return values.length ? String(values[0]) : null
}

export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) return errorResponse("invalid_request")
  try {
    const form = await request.formData()
    if (single(form, "grant_type") !== "authorization_code") return errorResponse("unsupported_grant_type")
    const code = single(form, "code")
    const redirectUri = single(form, "redirect_uri")
    const verifier = single(form, "code_verifier")
    const bodyClientId = single(form, "client_id", false)
    if (!code || !redirectUri || !verifier || code.length > 512) return errorResponse("invalid_request")
    const basicClientId = request.headers.get("authorization")?.match(/^Basic ([A-Za-z0-9+/=]+)$/)?.[1]
    let authenticatedClientId = bodyClientId
    if (basicClientId) {
      try { authenticatedClientId = Buffer.from(basicClientId, "base64").toString("utf8").split(":", 1)[0] || null } catch { return errorResponse("invalid_client", 401) }
    }
    const client = authenticatedClientId ? getOidcClient(authenticatedClientId) : null
    if (!client || !validateClientAuthentication(client, request.headers.get("authorization"), bodyClientId)) return errorResponse("invalid_client", 401)
    const usedCode = await consumeOidcAuthorizationCode({ codeHash: hashOidcValue(code), clientId: client.clientId, redirectUri, codeVerifier: verifier })
    if (!usedCode || !verifyPkceS256(verifier, usedCode.codeChallenge)) return errorResponse("invalid_grant")
    const identity = await getOidcIdentity(usedCode.adminUserId)
    if (!identity || !identity.isActive || !identity.useFcos || !identity.emailVerified || identity.identityRevision !== usedCode.identityRevision || identity.credentialRevision !== usedCode.credentialRevision) return errorResponse("invalid_grant")
    const identityClaims = buildIdentityClaims(identity)
    const accessToken = issueOidcToken({ sub: identity.id, aud: client.clientId, typ: "at+jwt", scope: usedCode.scope, ...identityClaims })
    const idToken = issueOidcToken({ sub: identity.id, aud: client.clientId, typ: "id_token", auth_time: Math.floor(Date.parse(usedCode.authTime) / 1000), nonce: usedCode.nonce || undefined, ...identityClaims })
    return NextResponse.json({ access_token: accessToken, token_type: "Bearer", expires_in: 300, id_token: idToken, scope: usedCode.scope }, { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } })
  } catch (error) {
    console.error("OIDC token exchange failed", error)
    return errorResponse("server_error", 503)
  }
}
