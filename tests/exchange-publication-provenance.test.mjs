import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { checkExchangePublication, verifyExchangePublicationCandidate } from "../scripts/azure-automation/check-exchange-publication.mjs"

const source = readFileSync(new URL("../scripts/azure-automation/sync-fcuno-outlook-addressbook.ps1", import.meta.url), "utf8")
const migration = readFileSync(new URL("../supabase/migrations/20261007065554_outlook_exchange_alert_delivery.sql", import.meta.url), "utf8")
const baseline = JSON.parse(readFileSync(new URL("../scripts/azure-automation/exchange-publication-baseline.json", import.meta.url), "utf8"))
const verify = (changes = {}) => verifyExchangePublicationCandidate({ source, migration, baseline, ...changes })

test("preserved runbook exactly matches independently retrieved live publication", () => {
  const result = checkExchangePublication()
  assert.equal(result.verified, true)
  assert.equal(result.offlineOnly, true)
  assert.equal(result.workerVersion, "fcuno-exchange-runbook/2026-10-09.1")
  assert.equal(result.sourceSha256, "7fbbff302cc843e231ca6b53a5490a9781839f7a84919117773ad4b2eeb030a4")
  assert.equal(result.migrationAlreadyInstalled, true)
})

test("an older worker cannot silently replace the current published repair", () => {
  assert.throws(() => verify({ source: source.replace(baseline.workerVersion, "fcuno-exchange-runbook/2026-09-02.21") }), /possible rollback/)
})

test("a newer worker also needs explicit reviewed source provenance", () => {
  assert.throws(() => verify({ source: source.replace(baseline.workerVersion, "fcuno-exchange-runbook/2026-10-15.1") }), /reviewed live baseline/)
})

test("same version with altered source is not accepted as verified", () => {
  assert.throws(() => verify({ source: source + "# unreviewed modification\n" }), /Runbook bytes differ/)
  assert.throws(() => verify({ source: source.replace("function Invoke-ExchangeSyncNotificationPolicy(", "function RemovedNotificationPolicy(") }), /Runbook bytes differ/)
})

test("missing or corrupted source digest is not proof of preservation", () => {
  for (const sourceSha256 of [null, "", "0".repeat(64)]) {
    assert.throws(() => verify({ baseline: { ...baseline, sourceSha256 } }), /Runbook bytes differ/)
  }
})

test("another project or origin cannot inherit this publication baseline", () => {
  assert.throws(() => verify({ baseline: { ...baseline, supabaseProject: "unrelated-project" } }), /canonical FCUNO/)
  assert.throws(() => verify({ baseline: { ...baseline, productionOrigin: "https://unrelated.invalid" } }), /canonical FCUNO/)
})

test("historical migration contents and installed identity must remain exact", () => {
  assert.throws(() => verify({ migration: migration + "-- changed\n" }), /installed provenance/)
  assert.throws(() => verify({ baseline: { ...baseline, migration: { ...baseline.migration, alreadyInstalled: false } } }), /installed provenance/)
  assert.throws(() => verify({ baseline: { ...baseline, migration: { ...baseline.migration, version: "20261014000000" } } }), /installed provenance/)
  assert.throws(() => verify({ baseline: { ...baseline, migration: { ...baseline.migration, path: "supabase/migrations/new-copy.sql" } } }), /missing or malformed/)
})

test("baseline runtime/module pins cannot silently drift", () => {
  assert.throws(() => verify({ baseline: { ...baseline, azure: { ...baseline.azure, runtimeVersion: "7.4" } } }), /runtime\/module/)
  assert.throws(() => verify({ baseline: { ...baseline, azure: { ...baseline.azure, exchangeModuleVersion: "3.9.2" } } }), /runtime\/module/)
})
