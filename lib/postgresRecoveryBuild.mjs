import { fcunoConnectionPolicy } from "../config/fcunoConnections.ts"
import { validatePostgresManifestReceipt } from "./postgresBackupReceipt.mjs"
export { RECOVERY_POSTGRES_IMAGE } from "./postgresRecoveryEvidence.mjs"
const pinned = fcunoConnectionPolicy.storageMediaBackup
export const RECOVERY_NODE_IMAGE = "node@sha256:2dd9a4f758e173b65fee15388f7706af6fb01ef50cf7a2c0538711d67a6981ae"
export const RECOVERY_DOCKER_IMAGE = "gcr.io/cloud-builders/docker@sha256:0aca0f95e1ba8f9107263d3e9782d5ce99a5b60d35b3f8985e4534b65552636f"
export const RECOVERY_WORKSPACE = "/workspace/.fcuno-postgres-recovery"
const fail = () => { throw new Error("Cloud recovery build configuration invalid") }
export function createRecoveryBuild({ manifestReceipt, verificationKeyPem, budgetConfigJson, sourceCommit }) {
  validatePostgresManifestReceipt(manifestReceipt)
  if (typeof verificationKeyPem !== "string" || verificationKeyPem.length > 2048 || !verificationKeyPem.startsWith("-----BEGIN PUBLIC KEY-----\n") ||
      typeof budgetConfigJson !== "string" || Buffer.byteLength(budgetConfigJson) > 16384 || !/^[0-9a-f]{40}$/.test(sourceCommit)) fail()
  const env = ["FCUNO_POSTGRES_RECOVERY_BUILD=1", "FCUNO_POSTGRES_RECOVERY_BUILD_ID=$BUILD_ID", `GOOGLE_CLOUD_PROJECT=${pinned.googleProjectId}`,
    `GCS_BACKUP_BUCKET=${pinned.targetBucket}`, `POSTGRES_RECOVERY_MANIFEST_JSON=${JSON.stringify(manifestReceipt)}`,
    `POSTGRES_BACKUP_VERIFICATION_KEY_PEM=${verificationKeyPem}`, `STORAGE_MEDIA_BACKUP_BUDGET_CONFIG_JSON=${budgetConfigJson}`, `FCUNO_RECOVERY_SOURCE_COMMIT=${sourceCommit}`]
  return {
    serviceAccount: `projects/${pinned.googleProjectId}/serviceAccounts/${pinned.googleServiceAccount}`,
    timeout: "1800s", queueTtl: "600s", options: { logging: "NONE", diskSizeGb: "100", substitutionOption: "MUST_MATCH" },
    steps: [
      { id: "budget-and-private-download", name: RECOVERY_NODE_IMAGE, entrypoint: "node", args: ["scripts/postgres-recovery/cloud.mjs", "download"], env, timeout: "300s" },
      { id: "build-sealed-recovery-runtime", name: RECOVERY_DOCKER_IMAGE, args: ["build", "--platform=linux/amd64", "--file=scripts/postgres-recovery/Dockerfile", "--target=recovery", "--tag=fcuno-private-recovery", "."], timeout: "600s" },
      // Continue only to the mandatory publisher so failed restores retain a
      // private diagnostic. The publisher MUST fail, never accept that result.
      { id: "isolated-restore", name: RECOVERY_DOCKER_IMAGE, entrypoint: "bash", args: ["scripts/postgres-recovery/run-cloud-isolated.sh"], timeout: "1500s", allowFailure: true },
      { id: "private-acceptance-publication", name: RECOVERY_NODE_IMAGE, entrypoint: "node", args: ["scripts/postgres-recovery/cloud.mjs", "publish"], env, timeout: "60s" },
    ], tags: ["fcuno-private-logical-recovery", sourceCommit],
  }
}

export function validateRecoveryHostInspection(value) {
  const host = value?.HostConfig, state = value?.State, config = value?.Config
  if (!host || !state || !config || host.NetworkMode !== "none" || host.Privileged !== false || host.ReadonlyRootfs !== true ||
      !Array.isArray(host.CapDrop) || !host.CapDrop.includes("ALL") || !host.SecurityOpt?.includes("no-new-privileges") ||
      host.Memory !== 2147483648 || host.MemorySwap !== 2147483648 || host.PidsLimit !== 96 || config.User !== "1000:1000" ||
      state.Status !== "exited" || state.Running !== false || state.ExitCode !== 0 || state.OOMKilled !== false ||
      !/^sha256:[0-9a-f]{64}$/.test(value.Image)) fail()
  if (host.CapAdd?.length || host.Devices?.length || host.DeviceRequests?.length || host.Binds?.length ||
      host.PidMode || host.IpcMode === "host" || host.UTSMode || host.UsernsMode === "host" ||
      (config.Env || []).some(item => /^(?:PG|.*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL)|GOOGLE|AWS|AZURE|SUPABASE|DATABASE_URL)/i.test(item.split("=")[0]))) fail()
  const mounts = value.Mounts
  if (!Array.isArray(mounts) || mounts.length !== 3 ||
      !mounts.some(m => m.Type === "bind" && m.Source === `${RECOVERY_WORKSPACE}/input` && m.Destination === "/input" && m.RW === false) ||
      !mounts.some(m => m.Type === "bind" && m.Source === `${RECOVERY_WORKSPACE}/scratch` && m.Destination === "/recovery" && m.RW === true) ||
      !mounts.some(m => m.Type === "bind" && m.Source === `${RECOVERY_WORKSPACE}/output` && m.Destination === "/output" && m.RW === true)) fail()
  return value
}
