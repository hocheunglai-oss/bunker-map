// The admin page is also FCUNO's existing interactive sign-in surface.  Only
// a local federation request can be resumed after authentication; this
// intentionally rejects arbitrary app paths and every absolute URL.
export function normaliseOidcAuthorizeReturnTo(value: string | null, origin: string) {
  if (!value || value.length > 4096 || value.includes("#")) return null
  let base: URL
  let candidate: URL
  try {
    base = new URL(origin)
    candidate = new URL(value, base)
  } catch {
    return null
  }
  const oidcAuthorize = candidate.pathname === "/api/oidc/authorize" && Boolean(candidate.search)
  const spcLogin = candidate.pathname === "/api/spc/fcuno-login" && !candidate.search
  if (candidate.origin !== base.origin || (!oidcAuthorize && !spcLogin)) return null
  return `${candidate.pathname}${candidate.search}`
}
