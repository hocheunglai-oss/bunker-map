export type TechStackResponse = {
  generatedAt: string
  deployment: {
    platform: string; project: string; productionUrl: string; gitRepository: string
    environment: string; branch: string; commit: string; functionRegion: string; configuredRegions: string[]
  }
  databaseInventory: { schema: string; migrationHead: string; tables: string[]; checkedAt: string }
  verification: { responseTimeOnly: boolean; externalServices: string; environmentValues: string }
  schedules: { path: string; schedule: string }[]
  secrets: { name: string; configured: boolean | null; status: string; storage: string; value: string }[]
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function strings(value: Record<string, unknown>, keys: readonly string[]) {
  return keys.every(key => typeof value[key] === "string")
}
function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string")
}

export type PhonebookServerConfiguration = {
  hostname: string
  deployment: { environment: "production" | "preview" | "development" | null; commit: string | null }
  connectivity: "not_checked"
  checkedAt: string
}

// This diagnostic accepts only the hostname-only server contract, never a raw
// address-book URL or any additional environment/credential fields.
export function isPhonebookServerConfiguration(value: unknown): value is PhonebookServerConfiguration {
  if (!record(value) || Object.keys(value).sort().join(",") !== "checkedAt,connectivity,deployment,hostname") return false
  if (typeof value.hostname !== "string" || !value.hostname || value.hostname.length > 253
    || !/^[a-z0-9.\[\]:-]+$/.test(value.hostname)) return false
  if (!value.hostname.startsWith("[") && !value.hostname.replace(/\.$/, "").split(".").every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false
  try {
    const url = new URL(`https://${value.hostname}`)
    if (url.hostname !== value.hostname || url.host !== value.hostname || url.pathname !== "/"
      || url.username || url.password || url.search || url.hash) return false
  } catch { return false }
  const deployment = value.deployment
  return record(deployment) && Object.keys(deployment).sort().join(",") === "commit,environment"
    && (deployment.environment === null || ["production", "preview", "development"].includes(deployment.environment as string))
    && (deployment.commit === null || (typeof deployment.commit === "string" && /^[a-f0-9]{40}$/.test(deployment.commit)))
    && value.connectivity === "not_checked"
    && typeof value.checkedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.checkedAt)
    && Number.isFinite(Date.parse(value.checkedAt)) && new Date(value.checkedAt).toISOString() === value.checkedAt
}

// A successful HTTP status alone does not establish a usable inventory.
export function isTechStackResponse(value: unknown): value is TechStackResponse {
  if (!record(value) || typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))) return false
  const { deployment, databaseInventory, verification, schedules, secrets } = value
  return record(deployment)
    && strings(deployment, ["platform", "project", "productionUrl", "gitRepository", "environment", "branch", "commit", "functionRegion"])
    && stringArray(deployment.configuredRegions)
    && record(databaseInventory)
    && databaseInventory.schema === "bunker-map.backup-inventory/v1"
    && strings(databaseInventory, ["migrationHead", "checkedAt"])
    && Number.isFinite(Date.parse(databaseInventory.checkedAt as string))
    && stringArray(databaseInventory.tables)
    && record(verification) && typeof verification.responseTimeOnly === "boolean"
    && strings(verification, ["externalServices", "environmentValues"])
    && Array.isArray(schedules) && schedules.every(row => record(row) && strings(row, ["path", "schedule"]))
    && Array.isArray(secrets) && secrets.every(row => record(row)
      && strings(row, ["name", "status", "storage"])
      && (row.configured === null || typeof row.configured === "boolean")
      && row.value === "MASKED")
}
