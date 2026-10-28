const presentationMediaBucket = "spc-presentation-media"

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
    presentationMediaBucket,
  },
  exchangeAddressBook: {
    tenantId: "70011d0d-19b4-4a61-8195-ab1fd987c20f",
    appId: "1bf8841e-99a9-43fe-a8f7-85aedbd7bdc1",
    organization: "cosulich1.onmicrosoft.com",
    addressBookDomain: "cosulich1.onmicrosoft.com",
    runtimeVersion: "7.6",
    exchangeModuleVersion: "3.10.1",
  },
  storageMediaBackup: {
    sourcePath: "/api/backups/storage-media",
    sourceBucket: presentationMediaBucket,
    approvedObjectCount: 15,
    approvedTotalBytes: 224309367,
    googleProjectId: "bunker-map-drive-uploader",
    googleAccount: "wider.custom@gmail.com",
    googleRegion: "us-central1",
    googleJob: "bunker-map-drive-file-backup",
    googleServiceAccount: "bunker-map-drive-backup@bunker-map-drive-uploader.iam.gserviceaccount.com",
    targetBucket: "bunker-map-drive-uploader-bunker-map-drive-file-backups",
    targetPrefix: "fcuno-storage-media",
    googleTokenIssuer: "https://accounts.google.com",
    recurring: {
      maxObjects: 1000,
      maxTotalBytes: 1073741824,
      maxObjectBytes: 268435456,
      windowStartHourHkt: 2,
      windowEndHourHkt: 6,
      healthFolderName: "Storage Media Backup Manifests",
      healthFilePrefix: "storage-media-backup-health-",
      budgetUsdMicros: 10000000,
    },
  },
  browser: {
    fallbackProfile: "Otto",
  },
  ecosystem: {
    productionOrigin: "https://eco.fcuno.com",
    knowledgeExtractionPath: "/api/ecosystem/knowledge-extract",
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
  requireNonEmpty(policy.storageMediaBackup.sourceBucket, "storageMediaBackup.sourceBucket")
  requireNonEmpty(policy.storageMediaBackup.googleServiceAccount, "storageMediaBackup.googleServiceAccount")
  requireNonEmpty(policy.storageMediaBackup.targetBucket, "storageMediaBackup.targetBucket")
  if (policy.storageMediaBackup.sourceBucket !== policy.supabase.presentationMediaBucket ||
      !policy.storageMediaBackup.googleServiceAccount.endsWith(`@${policy.storageMediaBackup.googleProjectId}.iam.gserviceaccount.com`)) {
    throw new Error("Storage media backup must retain the pinned source and Google job identity.")
  }
  requireNonEmpty(policy.ecosystem.productionOrigin, "ecosystem.productionOrigin")
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
  if (new URL(policy.ecosystem.productionOrigin).origin !== policy.ecosystem.productionOrigin ||
      !policy.ecosystem.productionOrigin.startsWith("https://")) {
    throw new Error("ECOSYSTEM must use an exact HTTPS origin.")
  }

  return policy
}
