import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { createBackupBudgetGuard } from "../scripts/lib/backup-budget-guard.mjs"

const now = Date.parse("2026-10-26T13:00:00.000Z")
const policy = { projectId: "synthetic-project", budgetResourceName: "billingAccounts/000000-AAAAAA-111111/budgets/synthetic-budget", currency: "HKD", budgetAmountMicros: 77_500_000,
  usdBudgetMicros: 10_000_000, budgetProvenance: "approved-conservative-native-budget", billingTimeZone: "Etc/UTC", maxAgeMs: 36 * 60 * 60 * 1000, pauseAtPermille: 900 }
const control = { bucket: "synthetic-private", prefix: "controls", objectName: "controls/budget.json" }
const target = { bucket: control.bucket, objectName: control.objectName, generation: "123" }
const observation = () => ({ schema: "fcuno.backup-budget/v1", projectId: policy.projectId, budgetResourceName: policy.budgetResourceName,
  periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z", currency: policy.currency, budgetAmountMicros: policy.budgetAmountMicros,
  actualCostMicros: 1_000_000, forecastThresholdExceeded: null, observedAt: new Date(now).toISOString(), source: "gcp-billing-budget", sourceMessageId: "synthetic-message-1" })
const digest = bytes => createHash("sha256").update(bytes).digest("hex")
const operation = () => ({ signal: new AbortController().signal, deadline: now + 60_000, now: () => now })
function fixture(modify = {}) {
  const bytes = Buffer.from(JSON.stringify(observation()))
  const receipt = { target, sizeBytes: bytes.byteLength, byteSha256: digest(bytes) }, events = []
  const transport = {
    async inspectPrivateBucket(input) { events.push(["bucket", input]); return { name: control.bucket, projectId: policy.projectId, publicAccessPrevention: "enforced", uniformBucketLevelAccess: true, trustedBudgetWritersOnly: true } },
    async inspectControl(input) { events.push(["inspect", input]); return structuredClone(receipt) },
    async readControl(input) { events.push(["read", input]); return { target: structuredClone(target), bytes } },
    ...modify,
  }
  return { transport, events, bytes, receipt, guard: createBackupBudgetGuard({ policy, control, transport, now: () => now }) }
}

test("budget reader authenticates private bucket, pins exact generation and reads normalized document", async () => {
  const { guard, events } = fixture()
  const result = await guard.checkOptionalWork({ plannedWriteBytes: 1 }, operation())
  assert.equal(result.allowed, true)
  assert.equal(result.currency, "HKD")
  assert.deepEqual(events.map(item => item[0]), ["bucket", "inspect", "read", "inspect"])
  assert.deepEqual(events[2][1], target)
  assert.deepEqual(events[3][1], target)
})

test("budget reader pauses optional work for foreign/private/source/size/hash/generation failures", async context => {
  const good = fixture()
  const faults = {
    "foreign bucket project": { inspectPrivateBucket: async () => ({ name: control.bucket, projectId: "foreign", publicAccessPrevention: "enforced", uniformBucketLevelAccess: true, trustedBudgetWritersOnly: true }) },
    "public bucket": { inspectPrivateBucket: async () => ({ name: control.bucket, projectId: policy.projectId, publicAccessPrevention: "inherited", uniformBucketLevelAccess: true, trustedBudgetWritersOnly: true }) },
    "unverified writers": { inspectPrivateBucket: async () => ({ name: control.bucket, projectId: policy.projectId, publicAccessPrevention: "enforced", uniformBucketLevelAccess: true, trustedBudgetWritersOnly: false }) },
    "other pointer prefix": { inspectControl: async () => ({ ...good.receipt, target: { ...target, objectName: "controls-poison/budget.json" } }) },
    "other bucket": { inspectControl: async () => ({ ...good.receipt, target: { ...target, bucket: "foreign" } }) },
    "invalid generation": { inspectControl: async () => ({ ...good.receipt, target: { ...target, generation: "01" } }) },
    "large metadata": { inspectControl: async () => ({ ...good.receipt, sizeBytes: 16 * 1024 + 1 }) },
    "truncated body": { readControl: async () => ({ target, bytes: good.bytes.subarray(0, -1) }) },
    "wrong bytes": { readControl: async () => ({ target, bytes: Buffer.alloc(good.bytes.length) }) },
    "wrong read generation": { readControl: async () => ({ target: { ...target, generation: "124" }, bytes: good.bytes }) },
    "invalid UTF8": { readControl: async () => ({ target, bytes: Buffer.alloc(good.bytes.length, 255) }) },
    "provider error": { inspectControl: async () => { throw new Error("private token must not appear") } },
  }
  for (const [name, fault] of Object.entries(faults)) await context.test(name, async () => {
    const result = await fixture(fault).guard.checkOptionalWork({}, operation())
    assert.equal(result.allowed, false)
    assert.equal(result.reason, "budget_control_unavailable")
    assert.equal(JSON.stringify(result).includes("private token"), false)
    assert.equal(result.essentialExistingBackupUnaffected, true)
  })
})

test("changed generation during control read cannot authorize new optional writes", async () => {
  const good = fixture(); let inspections = 0
  const result = await fixture({ inspectControl: async () => ++inspections === 1 ? good.receipt : { ...good.receipt, target: { ...target, generation: "124" } } }).guard.checkOptionalWork({}, operation())
  assert.equal(result.allowed, false)
})

test("malformed normalized JSON, duplicate fields, wrong policy and stale documents fail closed", async () => {
  for (const text of [
    `${JSON.stringify(observation())}\n`,
    JSON.stringify(observation()).replace('"actualCostMicros":1000000', '"actualCostMicros":90000000,"actualCostMicros":1000000'),
    JSON.stringify({ ...observation(), projectId: "foreign-project" }),
    JSON.stringify({ ...observation(), currency: "USD" }),
    JSON.stringify({ ...observation(), observedAt: "2026-10-23T00:00:00.000Z" }),
  ]) {
    const bytes = Buffer.from(text), receipt = { target, sizeBytes: bytes.length, byteSha256: digest(bytes) }
    const result = await fixture({ inspectControl: async () => receipt, readControl: async () => ({ target, bytes }) }).guard.checkOptionalWork({}, operation())
    assert.equal(result.allowed, false)
  }
})

test("cancellation rejects non-cooperative budget transport without exposing or enabling work", async () => {
  const controller = new AbortController(), value = fixture({ inspectControl: () => new Promise(() => {}) })
  const running = value.guard.checkOptionalWork({}, { ...operation(), signal: controller.signal })
  await Promise.resolve(); controller.abort()
  assert.equal((await running).allowed, false)
  assert.equal((await value.guard.checkOptionalWork({}, { ...operation(), deadline: now })).allowed, false)
})

test("constructor refuses unpinned control paths, missing transports and weakened policies", () => {
  const { transport } = fixture()
  for (const altered of [{ ...control, objectName: "other/budget.json" }, { ...control, prefix: "controls/" }, { ...control, extra: true }]) {
    assert.throws(() => createBackupBudgetGuard({ policy, control: altered, transport, now: () => now }))
  }
  assert.throws(() => createBackupBudgetGuard({ policy: { ...policy, pauseAtPermille: 1000 }, control, transport, now: () => now }))
})
