import { NextResponse } from "next/server"
import { clearAdminSession, requireAdminSessionForOidc } from "@/lib/adminAuth"
import { federationNotFound, isFcunoOidcEnabled } from "@/lib/fcunoFederationFlags"
import {
  createAuthorizationCode,
  getOidcClient,
  hashOidcValue,
  isFreshOidcAuthentication,
  normaliseScope,
  validatePkceChallenge,
} from "@/lib/fcunoOidc"
import { createOidcAuthorizationCode, getOidcIdentity } from "@/lib/fcunoOidcStore"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function parameter(params: URLSearchParams, name: string) {
  const values = params.getAll(name)
  if (values.length !== 1) throw new Error("invalid_request")
  return values[0]
}

function redirectError(uri: string, error: string, state: string | null) {
  const target = new URL(uri)
  target.searchParams.set("error", error)
  if (state !== null) target.searchParams.set("state", state)
  return NextResponse.redirect(target, { status: 302, headers: { "Cache-Control": "no-store" } })
}

function promptIsNone(params: URLSearchParams) {
  const values = params.getAll("prompt")
  return values.length === 1 && values[0].trim().split(/\s+/).includes("none")
}

function interactiveLoginRedirect(request: Request) {
  const current = new URL(request.url)
  const returnTo = `${current.pathname}${current.search}`
  const target = new URL("/admin", current.origin)
  target.searchParams.set("returnTo", returnTo)
  return NextResponse.redirect(target, { status: 302, headers: { "Cache-Control": "no-store" } })
}

export async function GET(request: Request) {
  if (!isFcunoOidcEnabled()) return federationNotFound()
  const params = new URL(request.url).searchParams
  let clientId = ""
  let redirectUri = ""
  let state: string | null = null
  try {
    clientId = parameter(params, "client_id")
    redirectUri = parameter(params, "redirect_uri")
    const client = getOidcClient(clientId)
    if (!client || !client.redirectUris.includes(redirectUri)) return new Response("invalid_request", { status: 400, headers: { "Cache-Control": "no-store" } })
    state = params.has("state") ? parameter(params, "state") : null
    if (state !== null && (state.length < 1 || state.length > 1024)) return redirectError(redirectUri, "invalid_request", null)
    if (parameter(params, "response_type") !== "code") return redirectError(redirectUri, "unsupported_response_type", state)
    const scope = normaliseScope(parameter(params, "scope"))
    const nonce = parameter(params, "nonce")
    if (nonce.length < 16 || nonce.length > 512) return redirectError(redirectUri, "invalid_request", state)
    if (parameter(params, "code_challenge_method") !== "S256") return redirectError(redirectUri, "invalid_request", state)
    const codeChallenge = parameter(params, "code_challenge")
    if (!validatePkceChallenge(codeChallenge)) return redirectError(redirectUri, "invalid_request", state)
    const session = await requireAdminSessionForOidc().catch(() => null)
    if (!session) {
      return promptIsNone(params)
        ? redirectError(redirectUri, "login_required", state)
        : interactiveLoginRedirect(request)
    }
    if (!isFreshOidcAuthentication(session.authTime)) {
      if (promptIsNone(params)) return redirectError(redirectUri, "login_required", state)
      // A 400-day FCUNO application session is intentionally longer than the
      // OIDC authentication-age limit. Clear the stale session before showing
      // the existing sign-in surface so this cannot bounce forever between
      // /admin and /authorize without actually re-authenticating.
      await clearAdminSession()
      return interactiveLoginRedirect(request)
    }
    const identity = await getOidcIdentity(session.adminUserId)
    if (!identity || !identity.isActive || !identity.useFcos || !identity.emailVerified) return redirectError(redirectUri, "access_denied", state)
    const code = createAuthorizationCode()
    await createOidcAuthorizationCode({
      codeHash: hashOidcValue(code), adminUserId: identity.id, clientId, redirectUri,
      scope, nonce, codeChallenge, identityRevision: identity.identityRevision,
      credentialRevision: identity.credentialRevision, authTime: session.authTime,
    })
    const target = new URL(redirectUri)
    target.searchParams.set("code", code)
    if (state !== null) target.searchParams.set("state", state)
    return NextResponse.redirect(target, { status: 302, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } })
  } catch (error) {
    const protocolError = error instanceof Error && error.message === "invalid_scope" ? "invalid_scope" : "invalid_request"
    if (redirectUri && getOidcClient(clientId)?.redirectUris.includes(redirectUri)) return redirectError(redirectUri, protocolError, state)
    return new Response(protocolError, { status: 400, headers: { "Cache-Control": "no-store" } })
  }
}
