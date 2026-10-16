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
