export const fcunoConnectionPolicy = Object.freeze({
  schemaVersion: 1,
  policyVersion: 2,
  connectionOrder: ["api", "cli", "chrome"] as const,
  github: {
    repository: "hocheunglai-oss/bunker-map",
    mutationAccount: "hocheunglai-oss",
  },
  vercel: {
    team: "hocheunglai-6535s-projects",
    teamId: "team_MbKDazzCrou3eKTuausPv4X2",
    project: "bunker-map-c2ks",
    projectId: "prj_8OifIFDF7Gcpd2i4VSRJOHjL3A9Q",
    productionOrigins: ["https://fcuno.com", "https://spc.fcuno.com"] as const,
  },
  supabase: {
    projectRef: "gglyugbrnyvyfktgwert",
  },
  browser: {
    fallbackProfile: "Otto",
  },
  federation: {
    issuer: "https://fcuno.com",
    protocolVersion: "1.0",
    syncAudience: "fcos-identity-sync",
    syncJwksUrl: "https://fcuno.com/api/fcos-identity-sync/jwks",
    oidcClientId: "fcos-production",
    oidcRedirectUris: [
      "https://pjforfvchygdyqfcgpmw.supabase.co/auth/v1/callback",
    ] as const,
    fcos: {
      repository: "hocheunglai-oss/fcos",
      vercelTeam: "hocheunglai-6535s-projects",
      vercelProject: "fcos",
      vercelProjectId: "prj_0pUORPGfFPyKtYhKr6ecwJ9ydvEs",
      supabaseProjectRef: "pjforfvchygdyqfcgpmw",
      productionOrigin: "https://fcos.fcuno.com",
      syncEndpoint: "https://fcos.fcuno.com/api/fcuno/identity-sync",
    },
  },
})

function requireNonEmpty(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`FCUNO connection policy requires ${path}.`)
  }
}

export function validateFcunoConnectionPolicy(
  policy: typeof fcunoConnectionPolicy = fcunoConnectionPolicy,
) {
  if (policy.connectionOrder.join(",") !== "api,cli,chrome") {
    throw new Error("FCUNO connections must remain API, CLI, then Chrome.")
  }

  requireNonEmpty(policy.github.repository, "github.repository")
  requireNonEmpty(policy.github.mutationAccount, "github.mutationAccount")
  requireNonEmpty(policy.vercel.teamId, "vercel.teamId")
  requireNonEmpty(policy.vercel.projectId, "vercel.projectId")
  requireNonEmpty(policy.supabase.projectRef, "supabase.projectRef")
  requireNonEmpty(policy.federation.issuer, "federation.issuer")
  requireNonEmpty(policy.federation.protocolVersion, "federation.protocolVersion")
  requireNonEmpty(policy.federation.syncAudience, "federation.syncAudience")
  requireNonEmpty(policy.federation.syncJwksUrl, "federation.syncJwksUrl")
  requireNonEmpty(policy.federation.oidcClientId, "federation.oidcClientId")
  requireNonEmpty(
    policy.federation.fcos.supabaseProjectRef,
    "federation.fcos.supabaseProjectRef",
  )
  requireNonEmpty(policy.federation.fcos.syncEndpoint, "federation.fcos.syncEndpoint")

  if (policy.browser.fallbackProfile !== "Otto") {
    throw new Error("FCUNO browser fallback must use the Otto profile.")
  }
  if (policy.vercel.productionOrigins[0] !== policy.federation.issuer) {
    throw new Error("The primary FCUNO origin must equal the OIDC issuer.")
  }
  if (policy.federation.syncJwksUrl !== `${policy.federation.issuer}/api/fcos-identity-sync/jwks`) {
    throw new Error("FCUNO synchronization verification keys must use the dedicated issuer route.")
  }
  if (policy.federation.fcos.syncEndpoint !== `${policy.federation.fcos.productionOrigin}/api/fcuno/identity-sync`) {
    throw new Error("FCOS identity synchronization must use the pinned production endpoint.")
  }
  if (policy.supabase.projectRef === policy.federation.fcos.supabaseProjectRef) {
    throw new Error("FCUNO and FCOS must retain separate Supabase projects.")
  }
  if (!policy.federation.oidcRedirectUris.every((value) => value.startsWith("https://"))) {
    throw new Error("Federation redirect URIs must use HTTPS.")
  }

  return policy
}
