import { fcunoConnectionPolicy } from "../config/fcunoConnections.ts"
export const RECOVERY_POSTGRES_IMAGE = "sha256:b75a42959151593e90d6ad7f0ef69abb329916caa397556976375da4c333412e"
const failure = () => { throw new Error("Private cloud recovery could not be verified") }
const exact = (value, keys) => { if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) failure() }
export function validateOfflineRecoveryResult(value, manifest, now = Date.now()) {
  exact(value, ["schema", "status", "projectRef", "archiveSha256", "archiveBytes", "metadataSha256", "runId", "week", "verifiedAt", "runtime", "tables",
    "tableContentProofSha256", "catalogSections", "tocEntries", "unaccountedTocEntries", "sequences", "sequenceProofSha256", "sourceRoleCopiesNoLogin", "productionConnections", "excludes"])
  if (value.schema !== "fcuno.cloud-postgresql-recovery/v1" || value.status !== "isolated-logical-recovery-verified" ||
      value.projectRef !== fcunoConnectionPolicy.supabase.projectRef || value.archiveSha256 !== manifest.completion.archiveSha256 ||
      value.archiveBytes !== manifest.completion.archiveBytes || value.metadataSha256 !== manifest.completion.metadataSha256 ||
      value.runId !== manifest.runId || value.week !== manifest.week || value.runtime !== RECOVERY_POSTGRES_IMAGE ||
      !Number.isFinite(Date.parse(value.verifiedAt)) || Date.parse(value.verifiedAt) < Date.parse(manifest.completion.finishedAt) || Date.parse(value.verifiedAt) > now + 30000 ||
      value.tables !== manifest.metadata.catalog.tables.filter(table => table.kind === "r").length || value.catalogSections !== 12 ||
      !Number.isSafeInteger(value.tocEntries) || value.tocEntries < value.tables || value.unaccountedTocEntries !== 0 ||
      value.sequences !== manifest.metadata.catalog.recovery.sequences.length || value.sourceRoleCopiesNoLogin !== true || value.productionConnections !== 0 ||
      ![value.tableContentProofSha256, value.sequenceProofSha256].every(item => typeof item === "string" && /^[0-9a-f]{64}$/.test(item)) ||
      JSON.stringify(value.excludes) !== JSON.stringify(["hosted-service configuration", "role passwords", "external storage bytes", "Vault root encryption key"])) failure()
  return value
}
