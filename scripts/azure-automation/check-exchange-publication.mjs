import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { fcunoConnectionPolicy, validateFcunoConnectionPolicy } from "../../config/fcunoConnections.ts"

const sourcePath = "scripts/azure-automation/sync-fcuno-outlook-addressbook.ps1"
const migrationPath = "supabase/migrations/20261007065554_outlook_exchange_alert_delivery.sql"
const sha256 = (text) => createHash("sha256").update(text).digest("hex")

// Offline preservation check only. This command never authenticates, publishes,
// starts an Azure job, changes a database, or sends email. A future intentional
// runbook change requires a separately reviewed baseline update and fresh Azure
// identity/runtime/readback evidence; do not edit the manifest just to pass.
export function verifyExchangePublicationCandidate({ source, migration, baseline, policy = fcunoConnectionPolicy }) {
  validateFcunoConnectionPolicy(policy)
  if (baseline?.schema !== "fcuno.exchange-publication-baseline/v1" ||
      baseline.sourcePath !== sourcePath || baseline.migration?.path !== migrationPath ||
      !Number.isFinite(Date.parse(baseline.verifiedAt || ""))) {
    throw new Error("Exchange publication baseline is missing or malformed")
  }
  if (baseline.productionOrigin !== policy.vercel.productionOrigins[0] ||
      baseline.supabaseProject !== policy.supabase.projectRef) {
    throw new Error("Exchange publication baseline differs from canonical FCUNO connections")
  }
  const workerVersion = source.match(/^\$ExchangeTruthWorkerVersion = "([^"]+)"$/m)?.[1]
  if (workerVersion !== baseline.workerVersion) {
    throw new Error("Runbook version differs from the reviewed live baseline; refusing a possible rollback")
  }
  if (!/^[a-f0-9]{64}$/.test(baseline.sourceSha256 || "") || sha256(source) !== baseline.sourceSha256) {
    throw new Error("Runbook bytes differ from the reviewed live baseline; review before publication")
  }
  if (!/^[a-f0-9]{64}$/.test(baseline.migration.sourceSha256 || "") ||
      sha256(migration) !== baseline.migration.sourceSha256 ||
      baseline.migration.version !== "20261007065554" ||
      baseline.migration.name !== "outlook_exchange_alert_delivery" ||
      baseline.migration.alreadyInstalled !== true) {
    throw new Error("The preserved Exchange alert migration differs from installed provenance")
  }
  const addressBookUrl = `${policy.vercel.productionOrigins[0]}/admin/outlookaddressbook`
  if (source.match(/^\$ExchangeNotificationAddressBookUrl = "([^"]+)"$/m)?.[1] !== addressBookUrl) {
    throw new Error("Runbook address-book link differs from canonical FCUNO connections")
  }
  const requiredFunctions = ["Connect-ExchangeOnlineWithRetry", "Get-ExchangeSyncEmailContent", "Invoke-ExchangeSyncNotificationPolicy"]
  for (const name of requiredFunctions) {
    if (!source.includes(`function ${name}(`)) throw new Error(`Preserved runbook lacks ${name}`)
  }
  if (baseline.azure?.runtimeVersion !== "7.6" ||
      baseline.azure?.exchangeModuleVersion !== "3.10.1" ||
      source.match(/^\$DefaultExchangeOnlineManagementVersion = "([^"]+)"$/m)?.[1] !== baseline.azure.exchangeModuleVersion) {
    throw new Error("Preserved Exchange runtime/module baseline is inconsistent")
  }
  return {
    verified: true,
    offlineOnly: true,
    workerVersion,
    sourceSha256: sha256(source),
    supabaseProject: policy.supabase.projectRef,
    addressBookUrl,
    migrationAlreadyInstalled: true,
  }
}

export function checkExchangePublication() {
  const root = new URL("../../", import.meta.url)
  const baseline = JSON.parse(readFileSync(new URL("./exchange-publication-baseline.json", import.meta.url), "utf8"))
  return verifyExchangePublicationCandidate({
    source: readFileSync(new URL(sourcePath, root), "utf8"),
    migration: readFileSync(new URL(migrationPath, root), "utf8"),
    baseline,
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(checkExchangePublication(), null, 2))
}
