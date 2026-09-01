type Environment = Record<string, string | undefined>

function enabled(value: string | undefined) {
  return value === "true"
}

export function isFcunoOidcEnabled(environment: Environment = process.env) {
  return enabled(environment.FCUNO_OIDC_ENABLED)
}

export function isFcosIdentitySyncEnabled(environment: Environment = process.env) {
  return enabled(environment.FCUNO_FCOS_IDENTITY_SYNC_ENABLED)
}

export function federationNotFound() {
  return new Response("Not Found", {
    status: 404,
    headers: { "Cache-Control": "private, no-store" },
  })
}
