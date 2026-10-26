import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { fcunoConnectionPolicy } from "../config/fcunoConnections.ts"
import {
  BACKUP_OPERATING_LIMITS, backupTargetKey, selectFourWeekCheckpoints,
  collectRetainedMediaTargets, planBackupRetention,
  validateBackupBudgetObservation, evaluateOptionalBackupBudget, deriveBackupBillingPeriod,
} from "../lib/backupOperatingPolicy.mjs"
import { recurringInventorySha256, recurringMediaScope } from "../lib/storageMediaRecurring.mjs"

const now = Date.parse("2026-10-26T13:00:00.000Z")
const clone = value => structuredClone(value)
const sha = value => createHash("sha256").update(value).digest("hex")
const target = (name = "a", generation = "1") => ({ bucket: "synthetic-private", objectName: `media/${name}`, generation })
const checkpoint = (id, date, overrides = {}) => ({ id, kind: "full-postgresql", status: "verified", createdAt: `${date}T00:00:00.000Z`, verifiedAt: `${date}T00:01:00.000Z`, artifact: target(`db-${id}`), mediaReferences: [target(`file-${id}`)], ...overrides })
const checkpoints = () => [checkpoint("a", "2026-10-26"), checkpoint("b", "2026-10-19"), checkpoint("c", "2026-10-12"), checkpoint("d", "2026-10-05"), checkpoint("e", "2026-09-28")]
const retention = () => {
  const retained = checkpoints()
  return { checkpoints: retained, mediaManifests: [], objectInventory: retained.flatMap(item => [item.artifact, ...item.mediaReferences]).concat(target("unreferenced")),
    inventoryComplete: true, dependencyInventoryComplete: true, inventoryCheckedAt: new Date(now).toISOString(), now,
    scope: { projectId: "synthetic-project", bucket: "synthetic-private", prefixes: ["media"] } }
}
const budgetName = "billingAccounts/000000-AAAAAA-111111/budgets/synthetic-budget"
const options = (overrides = {}) => ({ projectId: "synthetic-project", budgetResourceName: budgetName, currency: "USD", budgetAmountMicros: 10_000_000,
  usdBudgetMicros: 10_000_000, budgetProvenance: "verified-usd", billingTimeZone: "Etc/UTC", now, maxAgeMs: BACKUP_OPERATING_LIMITS.budgetMaxAgeMs, pauseAtPermille: 900, ...overrides })
const observation = (overrides = {}) => ({ schema: "fcuno.backup-budget/v1", projectId: "synthetic-project", budgetResourceName: budgetName,
  periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z", currency: "USD", budgetAmountMicros: 10_000_000,
  actualCostMicros: 1_000_000, forecastThresholdExceeded: null, observedAt: new Date(now).toISOString(), source: "gcp-billing-budget", sourceMessageId: "synthetic-message-1", ...overrides })

test("retention selects four distinct verified full-database UTC weeks, keeping gaps safe", () => {
  const value = checkpoints().concat(checkpoint("a-newer", "2026-10-26", { createdAt: "2026-10-26T01:00:00.000Z", verifiedAt: "2026-10-26T01:01:00.000Z" }))
  assert.deepEqual(selectFourWeekCheckpoints(value, { now }).checkpointIds, ["a-newer", "b", "c", "d"])
  assert.equal(selectFourWeekCheckpoints(value, { now }).fourWeeksVerified, true)
  value[1].status = "failed"
  assert.deepEqual(selectFourWeekCheckpoints(value, { now }).checkpointIds, ["a-newer", "c", "d", "e"])
  value[2].kind = "application-json"
  assert.equal(selectFourWeekCheckpoints(value, { now }).fourWeeksVerified, false)
})

test("UTC week/year boundaries are stable and missing weeks do not expire older verified points", () => {
  const date = Date.parse("2027-01-10T12:00:00.000Z")
  const value = [checkpoint("sun", "2027-01-10"), checkpoint("mon", "2027-01-04"), checkpoint("prev", "2026-12-28"), checkpoint("gap", "2026-11-02"), checkpoint("old", "2026-10-05")]
  const result = selectFourWeekCheckpoints(value, { now: date })
  assert.deepEqual(result.checkpointIds, ["sun", "prev", "gap", "old"])
  assert.equal(result.weeks[0], "2027-01-04T00:00:00.000Z")
})

test("retention protects every retained checkpoint dependency and exact immutable generation", () => {
  const input = retention(), oldGeneration = target("same-name", "11"), newGeneration = target("same-name", "12")
  input.checkpoints[4].mediaReferences.push(oldGeneration)
  input.objectInventory.push(oldGeneration, newGeneration)
  const result = planBackupRetention(input)
  assert.equal(result.mode, "dry-run-only")
  assert.equal(result.deletionEnabled, false)
  assert.equal(result.selection.checkpointIds.includes("e"), false)
  assert.equal(result.protectedTargets.some(item => backupTargetKey(item) === backupTargetKey(oldGeneration)), true)
  assert.equal(result.unreferencedTargets.some(item => backupTargetKey(item) === backupTargetKey(newGeneration)), true)
  assert.equal(result.coverageVerified, true)
  assert.equal(Object.keys(result).some(key => /delete|prune/i.test(key) && key !== "deletionEnabled"), false)
})

test("incomplete, stale or missing dependency inventories cannot establish retention coverage", () => {
  for (const [field, value, reason] of [
    ["inventoryComplete", false, "object_inventory_incomplete"],
    ["dependencyInventoryComplete", false, "dependency_inventory_incomplete"],
    ["inventoryCheckedAt", "2026-10-20T00:00:00.000Z", "object_inventory_not_fresh"],
    ["inventoryCheckedAt", "2026-10-27T00:00:00.000Z", "object_inventory_not_fresh"],
  ]) {
    const result = planBackupRetention({ ...retention(), [field]: value })
    assert.equal(result.coverageVerified, false)
    assert.equal(result.blockers.includes(reason), true)
    assert.equal(result.deletionEnabled, false)
  }
  const input = retention()
  input.objectInventory.shift()
  const result = planBackupRetention(input)
  assert.deepEqual(result.missingDependencies, [input.checkpoints[0].artifact])
  assert.equal(result.blockers.includes("exact_generation_dependency_missing"), true)
  const missingWeeks = retention(); missingWeeks.checkpoints = missingWeeks.checkpoints.slice(0, 3)
  assert.equal(planBackupRetention(missingWeeks).blockers.includes("four_verified_database_weeks_unavailable"), true)
})

test("retention rejects malformed, duplicate, poisoned pointers and cross-scope generations", () => {
  for (const mutate of [
    value => value.checkpoints.push(clone(value.checkpoints[0])),
    value => value.checkpoints[1].artifact = clone(value.checkpoints[0].artifact),
    value => value.checkpoints[0].mediaReferences.push(clone(value.checkpoints[0].mediaReferences[0])),
    value => value.objectInventory.push(clone(value.objectInventory[0])),
    value => value.checkpoints[0].mediaReferences[0].bucket = "foreign-bucket",
    value => value.checkpoints[0].mediaReferences[0].objectName = "media-poison/a",
    value => value.checkpoints[0].mediaReferences[0].generation = "01",
    value => value.checkpoints[0].mediaReferences[0].generation = "18446744073709551616",
    value => value.checkpoints[0].verifiedAt = null,
    value => value.checkpoints[0].createdAt = "2026-10-27T00:00:00.000Z",
    value => value.scope.prefixes = ["media", "media/sub"],
    value => value.inventoryComplete = "true",
    value => value.mediaManifests = [{ target: target(), manifest: { schema: "forged" } }],
    value => { value.checkpoints = Array(2) },
  ]) {
    const value = retention(); mutate(value)
    assert.throws(() => planBackupRetention(value))
  }
  const getter = retention()
  Object.defineProperty(getter.checkpoints[0], "status", { get() { throw new Error("must not execute") }, enumerable: true })
  assert.throws(() => planBackupRetention(getter), /invalid exact fields/)
})

function legacyManifest() {
  const source = { bucket: "synthetic-source", path: "example.mp4", id: "source-1", version: "version-1", sizeBytes: 9 }
  const copy = { source, target: target("old-copy"), byteSha256: sha("123456789"), sizeBytes: 9, crc32c: "4waSgw==", verifiedAt: "2026-10-20T00:00:00.000Z" }
  const artifacts = [0, 1].map(index => ({ driveFileId: `synthetic-database-${index}`, uploadedFileSha256: sha(`raw-${index}`), fileByteLength: 100,
    logicalArtifactSha256: sha(`logical-${index}`), checkpoint: { headSequence: index }, sectionSha256: sha(`section-${index}`), references: [] }))
  return { schema: "fcuno.storage-media-copy/v1", status: "succeeded", runId: "synthetic-old", inventory: [source], copies: [copy],
    pair: { schema: "fcuno.storage-media-pair/v1", sourceBucket: source.bucket, checkedAt: "2026-10-20T00:00:00.000Z", historicalByteCorrespondence: "unproved", artifacts },
    startedAt: "2026-10-20T00:00:00.000Z", finishedAt: "2026-10-20T00:00:00.000Z" }
}
function dailyManifest() {
  const policy = fcunoConnectionPolicy.storageMediaBackup
  const source = { bucket: policy.sourceBucket, path: "synthetic/example.mp4", id: "source-1", version: "version-1", sizeBytes: 9 }
  const copy = { source, target: { bucket: policy.targetBucket, objectName: `${policy.targetPrefix}/daily/runs/synthetic-day/objects/${sha("example")}`, generation: "42" },
    byteSha256: sha("123456789"), sizeBytes: 9, crc32c: "4waSgw==", verifiedAt: "2026-10-25T19:10:00.000Z" }
  return { schema: "fcuno.storage-media-daily/v2", status: "succeeded", scope: recurringMediaScope(), runId: "synthetic-day",
    snapshot: { inventorySha256: recurringInventorySha256([source]), windowStartsAt: "2026-10-25T18:00:00.000Z", windowExpiresAt: "2026-10-25T22:00:00.000Z" },
    inventory: [source], copies: [copy], startedAt: "2026-10-25T19:00:00.000Z", finishedAt: "2026-10-25T19:20:00.000Z" }
}

test("all copies including unreferenced media in retained v1 and v2 manifests are protected", () => {
  const legacy = legacyManifest(), daily = dailyManifest()
  const entries = [{ target: target("old-manifest"), manifest: legacy },
    { target: { bucket: fcunoConnectionPolicy.storageMediaBackup.targetBucket, objectName: `${fcunoConnectionPolicy.storageMediaBackup.targetPrefix}/daily/runs/synthetic-day/manifest.json`, generation: "44" }, manifest: daily }]
  const result = collectRetainedMediaTargets(entries)
  assert.equal(result.length, 4)
  assert.equal(result.some(item => backupTargetKey(item) === backupTargetKey(legacy.copies[0].target)), true)
  assert.equal(result.some(item => backupTargetKey(item) === backupTargetKey(daily.copies[0].target)), true)
  assert.throws(() => collectRetainedMediaTargets([entries[0], entries[0]]), /duplicate/)
  const conflict = clone(entries[0]); conflict.target = target("another-manifest"); conflict.manifest.copies[0].byteSha256 = "a".repeat(64)
  assert.throws(() => collectRetainedMediaTargets([entries[0], conflict]), /conflicting/)
})

test("USD budget allows only fresh authenticated matching project/period observations", () => {
  assert.deepEqual(validateBackupBudgetObservation(observation()), observation())
  const allowed = evaluateOptionalBackupBudget(observation(), options())
  assert.equal(allowed.optionalWorkAllowed, true)
  assert.equal(allowed.essentialExistingBackupUnaffected, true)
  assert.equal(allowed.exactSpendingCapGuaranteed, false)
  assert.equal(evaluateOptionalBackupBudget(observation({ forecastThresholdExceeded: null }), options()).optionalWorkAllowed, true)
})

test("budget actual threshold, forecast, stale/unknown and month rollover fail closed only for optional work", () => {
  const cases = [
    [null, "budget_unknown_or_invalid"],
    [observation({ actualCostMicros: 9_000_000 }), "actual_cost_near_limit"],
    [observation({ actualCostMicros: 10_000_000 }), "actual_cost_near_limit"],
    [observation({ forecastThresholdExceeded: 1 }), "forecast_reaches_limit"],
    [observation({ observedAt: "2026-10-24T00:00:00.000Z" }), "budget_observation_not_fresh"],
    [observation({ observedAt: "2026-10-27T00:00:00.000Z" }), "budget_observation_not_fresh"],
    [observation({ observedAt: "2026-09-30T00:00:00.000Z" }), "budget_observation_not_fresh"],
    [observation({ projectId: "other-project" }), "budget_project_mismatch"],
    [observation({ budgetResourceName: budgetName.replace("synthetic-budget", "other") }), "budget_policy_mismatch"],
    [observation({ currency: "HKD" }), "budget_policy_mismatch"],
    [observation({ budgetAmountMicros: 20_000_000 }), "budget_policy_mismatch"],
  ]
  for (const [value, reason] of cases) {
    const result = evaluateOptionalBackupBudget(value, options())
    assert.equal(result.optionalWorkAllowed, false)
    assert.equal(result.reason, reason)
    assert.equal(result.essentialExistingBackupUnaffected, true)
  }
  assert.equal(evaluateOptionalBackupBudget(observation(), options({ now: Date.parse("2026-11-01T00:00:00.000Z") })).reason, "budget_month_mismatch")
  assert.equal(evaluateOptionalBackupBudget(observation({ actualCostMicros: 8_999_999, forecastThresholdExceeded: 0.9 }), options()).optionalWorkAllowed, true)
})

test("approved native-currency cap compares actual currency without fabricating an exchange rate", () => {
  const policy = options({ currency: "HKD", budgetAmountMicros: 77_500_000, budgetProvenance: "approved-conservative-native-budget" })
  const native = observation({ currency: "HKD", budgetAmountMicros: 77_500_000, actualCostMicros: 69_749_999, forecastThresholdExceeded: null })
  const allowed = evaluateOptionalBackupBudget(native, policy)
  assert.equal(allowed.optionalWorkAllowed, true)
  assert.equal(allowed.currency, "HKD")
  assert.equal(Object.hasOwn(allowed, "actualUsdMicros"), false)
  assert.equal(evaluateOptionalBackupBudget({ ...native, actualCostMicros: 69_750_000 }, policy).reason, "actual_cost_near_limit")
  assert.equal(evaluateOptionalBackupBudget({ ...native, forecastThresholdExceeded: 1.0 }, policy).reason, "forecast_reaches_limit")
  assert.throws(() => evaluateOptionalBackupBudget(native, { ...policy, budgetProvenance: "verified-usd" }))
  assert.throws(() => evaluateOptionalBackupBudget(native, { ...policy, usdBudgetMicros: 20_000_000 }))
})

test("budget rejects malformed money, source, period, fields, and weakened trusted policy", () => {
  for (const update of [
    { actualCostMicros: -1 }, { actualCostMicros: -0 }, { actualCostMicros: 1.5 }, { actualCostMicros: "1" }, { actualCostMicros: Number.MAX_SAFE_INTEGER + 1 },
    { forecastThresholdExceeded: NaN }, { forecastThresholdExceeded: -1 }, { currency: "usd" }, { source: "manual-untrusted" },
    { periodEnd: "2026-10-02T00:00:00.000Z" },
    { budgetResourceName: "https://untrusted.example/budget" }, { sourceMessageId: "" }, { forgedUsdRate: 7.8 },
  ]) assert.equal(evaluateOptionalBackupBudget(observation(update), options()).reason, "budget_unknown_or_invalid")
  for (const update of [{ pauseAtPermille: 1000 }, { maxAgeMs: BACKUP_OPERATING_LIMITS.budgetMaxAgeMs + 1 }, { budgetProvenance: "payload-says-approved" }, { extra: true }]) {
    assert.throws(() => evaluateOptionalBackupBudget(observation(), options(update)))
  }
  const accessor = observation()
  Object.defineProperty(accessor, "actualCostMicros", { get() { throw new Error("must not execute") }, enumerable: true })
  assert.equal(evaluateOptionalBackupBudget(accessor, options()).reason, "budget_unknown_or_invalid")
})

test("approved billing calendar supports native Pacific month boundaries and daylight-saving changes", () => {
  assert.deepEqual(deriveBackupBillingPeriod("2026-02-01T08:00:00.000Z", "America/Los_Angeles"), { periodStart: "2026-02-01T08:00:00.000Z", periodEnd: "2026-03-01T08:00:00.000Z" })
  assert.equal(deriveBackupBillingPeriod("2026-03-01T08:00:00.000Z", "America/Los_Angeles").periodEnd, "2026-04-01T07:00:00.000Z")
  assert.equal(deriveBackupBillingPeriod("2026-11-01T07:00:00.000Z", "America/Los_Angeles").periodEnd, "2026-12-01T08:00:00.000Z")
  assert.throws(() => deriveBackupBillingPeriod("2026-10-01T00:00:00.000Z", "America/Los_Angeles"))
  assert.equal(evaluateOptionalBackupBudget(observation({ periodStart: "2026-10-02T00:00:00.000Z", periodEnd: "2026-11-02T00:00:00.000Z" }), options()).reason, "budget_calendar_mismatch")
})
