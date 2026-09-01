import { createClient } from "@supabase/supabase-js"
import type { OidcIdentity } from "@/lib/fcunoOidc"

type AdminIdentityRow = {
  id: string
  username: string
  display_name: string | null
  email: string | null
  email_verified: boolean
  is_active: boolean
  use_fcos: boolean
  use_spc: boolean
  identity_revision: number
  credential_revision: number
  revoked_before: string
}

export type OidcAuthorizationCode = {
  adminUserId: string
  clientId: string
  redirectUri: string
  scope: string
  nonce: string | null
  codeChallenge: string
  identityRevision: number
  credentialRevision: number
  authTime: string
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function serviceClient() {
  return createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function mapIdentity(row: AdminIdentityRow): OidcIdentity | null {
  if (!row.email || !row.email_verified) return null
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    email: row.email,
    emailVerified: row.email_verified,
    isActive: row.is_active,
    useFcos: row.use_fcos,
    useSpc: row.use_spc,
    identityRevision: Number(row.identity_revision),
    credentialRevision: Number(row.credential_revision),
    revokedBefore: row.revoked_before,
  }
}

export async function getOidcIdentity(id: string) {
  const { data, error } = await serviceClient()
    .from("admin_users")
    .select("id,username,display_name,email,email_verified,is_active,use_fcos,use_spc,identity_revision,credential_revision,revoked_before")
    .eq("id", id)
    .maybeSingle()
  if (error) throw error
  return data ? mapIdentity(data as AdminIdentityRow) : null
}

export async function createOidcAuthorizationCode(input: {
  codeHash: string
  adminUserId: string
  clientId: string
  redirectUri: string
  scope: string
  nonce: string | null
  codeChallenge: string
  identityRevision: number
  credentialRevision: number
  authTime: string
}) {
  const { error } = await serviceClient().from("oidc_authorization_codes").insert({
    code_hash: input.codeHash,
    admin_user_id: input.adminUserId,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: input.scope,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    identity_revision: input.identityRevision,
    credential_revision: input.credentialRevision,
    auth_time: input.authTime,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  })
  if (error) throw error
}

export async function consumeOidcAuthorizationCode(input: { codeHash: string, clientId: string, redirectUri: string, codeVerifier: string }): Promise<OidcAuthorizationCode | null> {
  const { data, error } = await serviceClient().rpc("consume_oidc_authorization_code", {
    p_code_hash: input.codeHash,
    p_client_id: input.clientId,
    p_redirect_uri: input.redirectUri,
    p_code_verifier: input.codeVerifier,
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : null
  if (!row) return null
  return {
    adminUserId: String(row.admin_user_id),
    clientId: String(row.client_id),
    redirectUri: String(row.redirect_uri),
    scope: String(row.scope),
    nonce: typeof row.nonce === "string" ? row.nonce : null,
    codeChallenge: String(row.code_challenge),
    identityRevision: Number(row.identity_revision),
    credentialRevision: Number(row.credential_revision),
    authTime: String(row.auth_time),
  }
}

export async function revokeOidcToken(jtiHash: string, expiresAt: number) {
  const { error } = await serviceClient().from("oidc_token_revocations").upsert({
    jti_hash: jtiHash,
    expires_at: new Date(expiresAt * 1000).toISOString(),
  }, { onConflict: "jti_hash" })
  if (error) throw error
}

export async function isOidcTokenRevoked(jtiHash: string) {
  const { data, error } = await serviceClient()
    .from("oidc_token_revocations")
    .select("jti_hash")
    .eq("jti_hash", jtiHash)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle()
  if (error) throw error
  return Boolean(data)
}
