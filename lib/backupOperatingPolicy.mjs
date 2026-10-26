import { validateCopyManifest } from "./storageMediaBackup.mjs"
import { validateRecurringMediaManifest } from "./storageMediaRecurring.mjs"

// Provider-neutral policy only. No credentials, environment, IO, timers,
// provider clients or deletion capability. The caller must authenticate every
// receipt and prove inventory completeness; these validators do not turn a
// caller-supplied "verified" flag into proof of a recoverable backup.
export const BACKUP_OPERATING_LIMITS = Object.freeze({
  checkpoints: 10000, objects: 100000, references: 100000,
  budgetMaxAgeMs: 36 * 60 * 60 * 1000,
  budgetLimitUsdMicros: 10_000_000, optionalPauseUsdMicros: 9_000_000,
})
const DAY = 24 * 60 * 60 * 1000
const UINT64_MAX = 18446744073709551615n
const fail = message => { throw new Error(`Backup operating policy: ${message}`) }
function exact(value, fields, label) {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== fields.length || fields.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"))) fail(`${label} invalid exact fields`)
}
function string(value, label, maximum = 1024) {
  if (typeof value !== "string" || !value || !value.isWellFormed() || /[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > maximum) fail(`${label} invalid string`)
  return value
}
function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || Object.is(value, -0)) fail(`${label} invalid integer`)
  return value
}
function timestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail("invalid canonical timestamp")
  return value
}
function array(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) fail(`${label} invalid bounded array`)
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(index)) ?? {}, "value")) fail(`${label} sparse/accessor array`)
  return value
}
export function backupTargetKey(value) {
  exact(value, ["bucket", "objectName", "generation"], "target")
  const bucket = string(value.bucket, "bucket", 222), objectName = string(value.objectName, "object name", 1024)
  if (typeof value.generation !== "string" || !/^[1-9]\d{0,19}$/.test(value.generation) || BigInt(value.generation) > UINT64_MAX) fail("invalid immutable GCS generation")
  return JSON.stringify([bucket, objectName, value.generation])
}
function target(value) { backupTargetKey(value); return { bucket: value.bucket, objectName: value.objectName, generation: value.generation } }
function weekStart(milliseconds) {
  const midnight = Math.floor(milliseconds / DAY) * DAY
  return midnight - ((new Date(midnight).getUTCDay() + 6) % 7) * DAY
}
function checkpoints(value, now) {
  const ids = new Set(), artifacts = new Set()
  let referenceCount = 0
  return array(value, BACKUP_OPERATING_LIMITS.checkpoints, "checkpoints").map(item => {
    exact(item, ["id", "kind", "status", "createdAt", "verifiedAt", "artifact", "mediaReferences"], "checkpoint")
    const id = string(item.id, "checkpoint ID", 256)
    if (!["full-postgresql", "application-json"].includes(item.kind) || !["verified", "failed", "pending"].includes(item.status)) fail("invalid checkpoint kind/status")
    const createdAt = timestamp(item.createdAt), verifiedAt = item.verifiedAt === null ? null : timestamp(item.verifiedAt)
    if (Date.parse(createdAt) > now || (verifiedAt !== null && (Date.parse(verifiedAt) < Date.parse(createdAt) || Date.parse(verifiedAt) > now)) || (item.status === "verified" && verifiedAt === null)) fail("invalid checkpoint verification time")
    const artifact = target(item.artifact), artifactKey = backupTargetKey(artifact)
    if (ids.has(id) || artifacts.has(artifactKey)) fail("duplicate checkpoint ID or immutable artifact")
    ids.add(id); artifacts.add(artifactKey)
    const refs = new Set()
    if (!Array.isArray(item.mediaReferences) || (referenceCount += item.mediaReferences.length) > BACKUP_OPERATING_LIMITS.references) fail("aggregate checkpoint references exceed bounded count")
    const mediaReferences = array(item.mediaReferences, BACKUP_OPERATING_LIMITS.references, "references").map(value => {
      const result = target(value), key = backupTargetKey(result)
      if (refs.has(key)) fail("duplicate exact media dependency")
      refs.add(key); return result
    })
    return { id, kind: item.kind, status: item.status, createdAt, verifiedAt, artifact, mediaReferences }
  })
}

// The caller must fetch/authenticate the immutable manifest body first. A
// success-pointer alone cannot protect all older, still-retained generations.
export function collectRetainedMediaTargets(entries) {
  const manifestTargets = new Set(), protectedTargets = new Map(), copyIdentity = new Map()
  for (const entry of array(entries, BACKUP_OPERATING_LIMITS.checkpoints, "retained media manifests")) {
    exact(entry, ["target", "manifest"], "retained manifest")
    const manifestTarget = target(entry.target), key = backupTargetKey(manifestTarget)
    if (manifestTargets.has(key)) fail("duplicate retained manifest generation")
    manifestTargets.add(key); protectedTargets.set(key, manifestTarget)
    const schema = Object.getOwnPropertyDescriptor(entry.manifest ?? {}, "schema")?.value
    const manifest = schema === "fcuno.storage-media-copy/v1" ? validateCopyManifest(entry.manifest) : validateRecurringMediaManifest(entry.manifest)
    for (const copy of manifest.copies) {
      const copyTarget = target(copy.target), copyKey = backupTargetKey(copyTarget)
      const identity = JSON.stringify([copy.byteSha256, copy.sizeBytes, copy.crc32c])
      if (copyIdentity.has(copyKey) && copyIdentity.get(copyKey) !== identity) fail("conflicting retained immutable copy evidence")
      copyIdentity.set(copyKey, identity); protectedTargets.set(copyKey, copyTarget)
      if (protectedTargets.size > BACKUP_OPERATING_LIMITS.objects) fail("aggregate retained media exceeds bounded count")
    }
  }
  if ([...manifestTargets].some(key => copyIdentity.has(key))) fail("manifest and copy target generation collision")
  return [...protectedTargets.values()]
}

// Select the newest verified full PostgreSQL checkpoint in each of the newest
// four distinct UTC weeks. Gaps never cause older known-good weeks to expire.
// Application JSON snapshots are explicitly not full PostgreSQL checkpoints.
export function selectFourWeekCheckpoints(value, { now }) {
  integer(now, "now")
  const ordered = checkpoints(value, now).filter(item => item.kind === "full-postgresql" && item.status === "verified")
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.id.localeCompare(right.id, "en"))
  const weeks = new Set(), selected = []
  for (const item of ordered) {
    const week = weekStart(Date.parse(item.createdAt))
    if (weeks.has(week)) continue
    weeks.add(week); selected.push(item)
    if (selected.length === 4) break
  }
  return { checkpointIds: selected.map(item => item.id),
    weeks: selected.map(item => new Date(weekStart(Date.parse(item.createdAt))).toISOString()),
    requiredWeeks: 4, availableWeeks: selected.length, fourWeeksVerified: selected.length === 4 }
}

// Pure, non-destructive audit. No output is a deletion instruction. All
// supplied retained checkpoints (not only the weekly selection) protect their
// artifact and exact media generations. A complete listing is not evidence
// that every historical reference has been authenticated by the caller.
export function planBackupRetention(value) {
  exact(value, ["checkpoints", "mediaManifests", "objectInventory", "inventoryComplete", "dependencyInventoryComplete", "inventoryCheckedAt", "now", "scope"], "retention inputs")
  integer(value.now, "now")
  exact(value.scope, ["projectId", "bucket", "prefixes"], "retention scope")
  const projectId = string(value.scope.projectId, "project ID", 128), bucket = string(value.scope.bucket, "bucket", 222)
  const prefixes = array(value.scope.prefixes, 16, "prefixes").map(item => {
    string(item, "prefix", 512)
    if (!/^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(item) || item.endsWith("/") || item.includes("//")) fail("invalid exact scoped prefix")
    return `${item}/`
  })
  if (!prefixes.length || new Set(prefixes).size !== prefixes.length || prefixes.some((item, index) => prefixes.some((other, otherIndex) => index !== otherIndex && item.startsWith(other)))) fail("ambiguous scoped prefixes")
  if (typeof value.inventoryComplete !== "boolean" || typeof value.dependencyInventoryComplete !== "boolean") fail("inventory completeness must be explicit")
  const inventoryCheckedAt = timestamp(value.inventoryCheckedAt)
  const inScope = item => item.bucket === bucket && prefixes.some(prefix => item.objectName.startsWith(prefix))
  const selected = checkpoints(value.checkpoints, value.now), byTarget = new Map()
  for (const item of array(value.objectInventory, BACKUP_OPERATING_LIMITS.objects, "object inventory")) {
    const current = target(item), key = backupTargetKey(current)
    if (!inScope(current) || byTarget.has(key)) fail("duplicate or out-of-scope inventory generation")
    byTarget.set(key, current)
  }
  const protectedSet = new Map(), missingSet = new Map()
  for (const checkpoint of selected) for (const item of [checkpoint.artifact, ...checkpoint.mediaReferences]) {
    if (!inScope(item)) fail("checkpoint dependency outside pinned retention scope")
    const key = backupTargetKey(item)
    protectedSet.set(key, item)
    if (!byTarget.has(key)) missingSet.set(key, item)
  }
  for (const item of collectRetainedMediaTargets(value.mediaManifests)) {
    if (!inScope(item)) fail("retained media target outside pinned retention scope")
    const key = backupTargetKey(item)
    protectedSet.set(key, item)
    if (!byTarget.has(key)) missingSet.set(key, item)
  }
  const selection = selectFourWeekCheckpoints(selected, { now: value.now }), blockers = []
  if (!value.inventoryComplete) blockers.push("object_inventory_incomplete")
  if (!value.dependencyInventoryComplete) blockers.push("dependency_inventory_incomplete")
  if (Date.parse(inventoryCheckedAt) > value.now || value.now - Date.parse(inventoryCheckedAt) > DAY) blockers.push("object_inventory_not_fresh")
  if (missingSet.size) blockers.push("exact_generation_dependency_missing")
  if (!selection.fourWeeksVerified) blockers.push("four_verified_database_weeks_unavailable")
  const ordered = values => [...values].sort((left, right) => backupTargetKey(left).localeCompare(backupTargetKey(right), "en"))
  return { schema: "fcuno.backup-retention-audit/v1", mode: "dry-run-only", deletionEnabled: false,
    projectId, bucket, inventoryCheckedAt, selection, blockers,
    coverageVerified: blockers.length === 0,
    protectedTargets: ordered(protectedSet.values()), missingDependencies: ordered(missingSet.values()),
    // These are only unreferenced by the SUPPLIED inventory, not safe-to-delete.
    unreferencedTargets: ordered([...byTarget].filter(([key]) => !protectedSet.has(key)).map(([, item]) => item)),
  }
}

export function deriveBackupBillingPeriod(periodStart, billingTimeZone) {
  timestamp(periodStart); string(billingTimeZone, "billing calendar time zone", 128)
  let formatter
  try { formatter = new Intl.DateTimeFormat("en-US", { timeZone: billingTimeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }) }
  catch { fail("invalid billing calendar time zone") }
  const parts = milliseconds => Object.fromEntries(formatter.formatToParts(milliseconds).filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]))
  const current = parts(Date.parse(periodStart))
  if (current.day !== 1 || current.hour || current.minute || current.second || new Date(periodStart).getUTCMilliseconds()) fail("billing period is not the approved local month boundary")
  const desired = Date.UTC(current.year, current.month, 1), expected = new Date(desired)
  let end = desired
  for (let attempt = 0; attempt < 4; attempt++) {
    const actual = parts(end), represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second)
    const correction = desired - represented
    end += correction
    if (!correction) break
  }
  const endParts = parts(end)
  if (endParts.year !== expected.getUTCFullYear() || endParts.month !== expected.getUTCMonth() + 1 || endParts.day !== 1 || endParts.hour || endParts.minute || endParts.second) fail("unresolvable billing month boundary")
  return { periodStart, periodEnd: new Date(end).toISOString() }
}

const BUDGET_FIELDS = ["schema", "projectId", "budgetResourceName", "periodStart", "periodEnd", "currency", "budgetAmountMicros", "actualCostMicros", "forecastThresholdExceeded", "observedAt", "source", "sourceMessageId"]
export function validateBackupBudgetObservation(value) {
  exact(value, BUDGET_FIELDS, "budget observation")
  if (value.schema !== "fcuno.backup-budget/v1" || !/^[A-Z]{3}$/.test(value.currency) || value.source !== "gcp-billing-budget") fail("unverified budget source/currency/schema")
  const projectId = string(value.projectId, "budget project ID", 128), periodStart = timestamp(value.periodStart), periodEnd = timestamp(value.periodEnd), observedAt = timestamp(value.observedAt)
  const budgetResourceName = string(value.budgetResourceName, "budget resource", 256)
  if (!/^billingAccounts\/[A-Z0-9-]+\/budgets\/[A-Za-z0-9_-]+$/.test(budgetResourceName)) fail("invalid budget resource name")
  const span = Date.parse(periodEnd) - Date.parse(periodStart)
  if (span < 28 * DAY - 2 * 3_600_000 || span > 31 * DAY + 2 * 3_600_000) fail("invalid complete billing calendar month")
  if (value.forecastThresholdExceeded !== null && (typeof value.forecastThresholdExceeded !== "number" || !Number.isFinite(value.forecastThresholdExceeded) || value.forecastThresholdExceeded < 0 || value.forecastThresholdExceeded > 100 || Object.is(value.forecastThresholdExceeded, -0))) fail("invalid forecast threshold ratio")
  return { schema: value.schema, projectId, budgetResourceName, periodStart, periodEnd, currency: value.currency,
    budgetAmountMicros: integer(value.budgetAmountMicros, "budget amount micros", 1),
    actualCostMicros: integer(value.actualCostMicros, "actual cost micros"),
    forecastThresholdExceeded: value.forecastThresholdExceeded,
    observedAt, source: value.source, sourceMessageId: string(value.sourceMessageId, "budget source message ID", 256) }
}

// Budget freshness fails closed for OPTIONAL new work only. It must not be
// wired as an unconditional stop around essential existing CCINFO backup work.
// Billing is delayed, so this is not an exact all-service spending hard cap.
export function evaluateOptionalBackupBudget(observation, options) {
  exact(options, ["projectId", "budgetResourceName", "currency", "budgetAmountMicros", "usdBudgetMicros", "budgetProvenance", "billingTimeZone", "now", "maxAgeMs", "pauseAtPermille"], "budget options")
  const projectId = string(options.projectId, "pinned project ID", 128), now = integer(options.now, "now"), maxAge = integer(options.maxAgeMs, "max budget age", 1)
  string(options.billingTimeZone, "billing calendar time zone", 128)
  try { new Intl.DateTimeFormat("en-US", { timeZone: options.billingTimeZone }) }
  catch { fail("invalid pinned billing calendar time zone") }
  if (maxAge > BACKUP_OPERATING_LIMITS.budgetMaxAgeMs) fail("budget freshness cannot be weakened")
  const budgetAmountMicros = integer(options.budgetAmountMicros, "pinned native budget amount", 1), pauseAtPermille = integer(options.pauseAtPermille, "optional pause ratio", 1)
  if (options.usdBudgetMicros !== BACKUP_OPERATING_LIMITS.budgetLimitUsdMicros || pauseAtPermille > 900 ||
      !/^[A-Z]{3}$/.test(options.currency) || !/^billingAccounts\/[A-Z0-9-]+\/budgets\/[A-Za-z0-9_-]+$/.test(options.budgetResourceName) ||
      !["verified-usd", "approved-conservative-native-budget"].includes(options.budgetProvenance) ||
      (options.budgetProvenance === "verified-usd" && (options.currency !== "USD" || budgetAmountMicros !== options.usdBudgetMicros)) ||
      (options.currency === "USD" && options.budgetProvenance !== "verified-usd")) fail("invalid approved budget provenance/amount")
  // Native-currency policy is approved and pinned OUTSIDE the observation.
  // Never manufacture USD costs or infer an exchange rate from a message.
  const paused = reason => ({ optionalWorkAllowed: false, reason, projectId, budgetResourceName: options.budgetResourceName,
    currency: options.currency, budgetAmountMicros, usdBudgetMicros: options.usdBudgetMicros,
    budgetProvenance: options.budgetProvenance, pauseAtPermille, essentialExistingBackupUnaffected: true, exactSpendingCapGuaranteed: false })
  let current
  try { current = validateBackupBudgetObservation(observation) } catch { return paused("budget_unknown_or_invalid") }
  if (current.projectId !== projectId) return paused("budget_project_mismatch")
  if (current.budgetResourceName !== options.budgetResourceName || current.currency !== options.currency || current.budgetAmountMicros !== budgetAmountMicros) return paused("budget_policy_mismatch")
  try { if (deriveBackupBillingPeriod(current.periodStart, options.billingTimeZone).periodEnd !== current.periodEnd) return paused("budget_calendar_mismatch") }
  catch { return paused("budget_calendar_mismatch") }
  if (now < Date.parse(current.periodStart) || now >= Date.parse(current.periodEnd)) return paused("budget_month_mismatch")
  const observed = Date.parse(current.observedAt)
  if (observed > now || observed < Date.parse(current.periodStart) || now - observed > maxAge) return paused("budget_observation_not_fresh")
  const summary = { observedAt: current.observedAt, actualCostMicros: current.actualCostMicros, forecastThresholdExceeded: current.forecastThresholdExceeded }
  if (BigInt(current.actualCostMicros) * 1000n >= BigInt(budgetAmountMicros) * BigInt(pauseAtPermille)) return { ...paused("actual_cost_near_limit"), ...summary }
  if (current.forecastThresholdExceeded !== null && current.forecastThresholdExceeded >= 1) return { ...paused("forecast_reaches_limit"), ...summary }
  return { ...paused("below_optional_pause_threshold"), optionalWorkAllowed: true, ...summary }
}
