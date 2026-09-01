import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto"

export const OIDC_AUTH_CODE_TTL_SECONDS = 60
export const OIDC_MAX_AUTH_AGE_SECONDS = 24 * 60 * 60
export const OIDC_TOKEN_TTL_SECONDS = 5 * 60
const OIDC_ALLOWED_SCOPES = new Set(["openid", "profile", "email"])

export type OidcClient = {
  clientId: string
  redirectUris: string[]
  tokenEndpointAuth: "none" | "client_secret_basic"
  clientSecret?: string
}

export type OidcIdentity = {
  id: string
  username: string
  displayName: string
  email: string
  emailVerified: boolean
  isActive: boolean
  useFcos: boolean
  useSpc: boolean
  identityRevision: number
  credentialRevision: number
  revokedBefore: string
}

export type OidcTokenClaims = {
  iss: string
  sub: string
  aud: string
  exp: number
  iat: number
  jti: string
  typ: "at+jwt" | "id_token" | "fcuno.identity-sync+jwt"
  auth_time?: number
  nonce?: string
  scope?: string
  email?: string
  email_verified?: boolean
  name?: string
  preferred_username?: string
  username?: string
  display_name?: string
  is_active?: boolean
  identity_revision?: number
  credential_revision?: number
  use_fcos?: boolean
  use_spc?: boolean
  event_id?: string
  event_type?: string
  occurred_at?: string
  revoked_before?: string
  identity?: {
    sub: string
    email: string
    email_verified: true
    username: string
    display_name: string
    is_active: boolean
    use_fcos: boolean
    use_spc: boolean
    identity_revision: number
    credential_revision: number
    revoked_before: string
  }
}

type RawClient = {
  client_id?: unknown
  redirect_uris?: unknown
  token_endpoint_auth_method?: unknown
  client_secret_env?: unknown
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function parseAbsoluteHttpsUrl(value: string, field: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${field} must be an absolute URL.`)
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${field} must be an HTTPS URL without credentials or fragment.`)
  }
  return url
}

export function getOidcIssuer() {
  const issuer = parseAbsoluteHttpsUrl(requireEnv("FCUNO_OIDC_ISSUER"), "FCUNO_OIDC_ISSUER")
  if (issuer.pathname !== "/" || issuer.search) {
    throw new Error("FCUNO_OIDC_ISSUER must be an origin without path or query.")
  }
  return issuer.origin
}

export function getOidcClients(): OidcClient[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(requireEnv("FCUNO_OIDC_CLIENTS_JSON"))
  } catch {
    throw new Error("FCUNO_OIDC_CLIENTS_JSON must be valid JSON.")
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("FCUNO_OIDC_CLIENTS_JSON must contain at least one client.")
  }
  const ids = new Set<string>()
  return parsed.map((entry): OidcClient => {
    const client = entry as RawClient
    const clientId = typeof client.client_id === "string" ? client.client_id.trim() : ""
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(clientId) || ids.has(clientId)) {
      throw new Error("OIDC client ids must be unique, non-empty identifiers.")
    }
    ids.add(clientId)
    if (!Array.isArray(client.redirect_uris) || client.redirect_uris.length === 0) {
      throw new Error(`OIDC client ${clientId} must have redirect_uris.`)
    }
    const redirectUris = client.redirect_uris.map((uri) => {
      if (typeof uri !== "string") throw new Error(`OIDC client ${clientId} has an invalid redirect URI.`)
      return parseAbsoluteHttpsUrl(uri, `OIDC redirect URI for ${clientId}`).toString()
    })
    if (new Set(redirectUris).size !== redirectUris.length) {
      throw new Error(`OIDC client ${clientId} has duplicate redirect URIs.`)
    }
    const auth = client.token_endpoint_auth_method === "none"
      ? "none"
      : client.token_endpoint_auth_method === "client_secret_basic"
        ? "client_secret_basic"
        : null
    if (!auth) throw new Error(`OIDC client ${clientId} must declare token_endpoint_auth_method.`)
    const secretEnv = typeof client.client_secret_env === "string" ? client.client_secret_env.trim() : ""
    if (auth === "client_secret_basic" && !/^[A-Z][A-Z0-9_]{2,127}$/.test(secretEnv)) {
      throw new Error(`OIDC client ${clientId} must declare a client_secret_env.`)
    }
    return {
      clientId,
      redirectUris,
      tokenEndpointAuth: auth,
      ...(auth === "client_secret_basic" ? { clientSecret: requireEnv(secretEnv) } : {}),
    }
  })
}

export function getOidcClient(clientId: string) {
  return getOidcClients().find((client) => client.clientId === clientId) || null
}

export function hashOidcValue(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

export function createAuthorizationCode() {
  return randomBytes(32).toString("base64url")
}

export function validatePkceChallenge(value: string) {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value)
}

export function verifyPkceS256(verifier: string, challenge: string) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false
  const actual = createHash("sha256").update(verifier, "utf8").digest("base64url")
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(challenge)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

export function normaliseScope(rawScope: string) {
  const scopes = rawScope.trim().split(/\s+/).filter(Boolean)
  if (!scopes.includes("openid") || scopes.some((scope) => !OIDC_ALLOWED_SCOPES.has(scope))) {
    throw new Error("invalid_scope")
  }
  return [...new Set(scopes)].sort().join(" ")
}

export function isFreshOidcAuthentication(authTime: string, now = Date.now()) {
  const time = Date.parse(authTime)
  return Number.isFinite(time) && time <= now + 60_000 && now - time <= OIDC_MAX_AUTH_AGE_SECONDS * 1000
}

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}

function getPrivateKey(name: "CURRENT" | "NEXT") {
  const raw = requireEnv(`FCUNO_OIDC_ES256_${name}_PRIVATE_KEY`).replace(/\\n/g, "\n")
  return createPrivateKey(raw)
}

function keyMaterial(name: "CURRENT" | "NEXT") {
  const key = getPrivateKey(name)
  const jwk = createPublicKey(key).export({ format: "jwk" }) as JsonWebKey
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error(`FCUNO_OIDC_ES256_${name}_PRIVATE_KEY must be a P-256 key.`)
  }
  return {
    kid: requireEnv(`FCUNO_OIDC_ES256_${name}_KID`),
    key,
    jwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, use: "sig", alg: "ES256" },
  }
}

export function getOidcJwks() {
  const current = keyMaterial("CURRENT")
  const next = keyMaterial("NEXT")
  if (current.kid === next.kid) throw new Error("OIDC current and next key ids must differ.")
  return { keys: [{ ...current.jwk, kid: current.kid }, { ...next.jwk, kid: next.kid }] }
}

export function issueOidcToken(
  input: Omit<OidcTokenClaims, "iss" | "iat" | "exp" | "jti"> & { expiresInSeconds?: number, jti?: string },
) {
  const { expiresInSeconds, jti, ...tokenInput } = input
  const current = keyMaterial("CURRENT")
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: "ES256", kid: current.kid, typ: "JWT" }
  const claims: OidcTokenClaims = {
    ...tokenInput,
    iss: getOidcIssuer(),
    iat: now,
    exp: now + (expiresInSeconds || OIDC_TOKEN_TTL_SECONDS),
    jti: jti || randomUUID(),
  }
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: current.key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url")
  return `${signingInput}.${signature}`
}

function parseJwt(token: string) {
  const pieces = token.split(".")
  if (pieces.length !== 3 || pieces.some((piece) => !/^[A-Za-z0-9_-]+$/.test(piece))) return null
  try {
    const header = JSON.parse(Buffer.from(pieces[0], "base64url").toString("utf8")) as { alg?: unknown, kid?: unknown }
    const claims = JSON.parse(Buffer.from(pieces[1], "base64url").toString("utf8")) as Partial<OidcTokenClaims>
    if (header.alg !== "ES256" || typeof header.kid !== "string") return null
    return { header, claims, signingInput: `${pieces[0]}.${pieces[1]}`, signature: Buffer.from(pieces[2], "base64url") }
  } catch {
    return null
  }
}

export function verifyOidcToken(token: string, options: { allowExpired?: boolean } = {}) {
  const parsed = parseJwt(token)
  if (!parsed) return null
  let jwk: JsonWebKey | undefined
  try {
    jwk = getOidcJwks().keys.find((key) => key.kid === parsed.header.kid)
  } catch {
    return null
  }
  if (!jwk || !verify("sha256", Buffer.from(parsed.signingInput), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, parsed.signature)) return null
  const claims = parsed.claims
  const now = Math.floor(Date.now() / 1000)
  if (
    claims.iss !== getOidcIssuer()
    || typeof claims.sub !== "string"
    || typeof claims.aud !== "string"
    || typeof claims.jti !== "string"
    || !Number.isSafeInteger(claims.iat)
    || !Number.isSafeInteger(claims.exp)
    || claims.exp! <= claims.iat!
    || claims.iat! > now + 60
    || (!options.allowExpired && claims.exp! <= now)
  ) return null
  return claims as OidcTokenClaims
}

export function buildIdentityClaims(identity: OidcIdentity) {
  return {
    email: identity.email,
    email_verified: identity.emailVerified,
    name: identity.displayName,
    preferred_username: identity.username,
    identity_revision: identity.identityRevision,
    credential_revision: identity.credentialRevision,
    use_fcos: identity.useFcos,
    use_spc: identity.useSpc,
    revoked_before: identity.revokedBefore,
  }
}

export function validateClientAuthentication(client: OidcClient, authorization: string | null, bodyClientId: string | null) {
  if (client.tokenEndpointAuth === "none") return !authorization && bodyClientId === client.clientId
  if (!authorization || bodyClientId) return false
  const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(authorization)
  if (!match) return false
  let decoded = ""
  try { decoded = Buffer.from(match[1], "base64").toString("utf8") } catch { return false }
  const separator = decoded.indexOf(":")
  if (separator < 1) return false
  const clientId = decoded.slice(0, separator)
  const secret = decoded.slice(separator + 1)
  const expected = client.clientSecret || ""
  const actualBytes = Buffer.from(secret)
  const expectedBytes = Buffer.from(expected)
  return clientId === client.clientId && actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}
