import { NextResponse } from "next/server"
import { getOidcIssuer, getOidcJwks } from "@/lib/fcunoOidc"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  try {
    const issuer = getOidcIssuer()
    // Validate key configuration here too, so discovery never advertises a
    // provider that cannot publish the key set it will use.
    getOidcJwks()
    return NextResponse.json({
      issuer,
      authorization_endpoint: `${issuer}/api/oidc/authorize`,
      token_endpoint: `${issuer}/api/oidc/token`,
      userinfo_endpoint: `${issuer}/api/oidc/userinfo`,
      revocation_endpoint: `${issuer}/api/oidc/revoke`,
      jwks_uri: `${issuer}/api/oidc/jwks`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["ES256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "profile", "email"],
      claims_supported: ["sub", "email", "email_verified", "name", "preferred_username", "identity_revision", "credential_revision", "use_fcos", "use_spc", "revoked_before"],
    }, { headers: { "Cache-Control": "public, max-age=300" } })
  } catch (error) {
    console.error("OIDC discovery configuration error", error)
    return NextResponse.json({ error: "server_error" }, { status: 503, headers: { "Cache-Control": "no-store" } })
  }
}
