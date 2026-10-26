import assert from "node:assert/strict"
import test from "node:test"
import { parseBackupBudgetPubsubMessage, chooseNewerBackupBudgetObservation } from "../scripts/lib/backup-budget-pubsub.mjs"
import { evaluateOptionalBackupBudget } from "../lib/backupOperatingPolicy.mjs"

const now = Date.parse("2026-10-26T13:00:00.000Z")
const policy = { projectId: "synthetic-project", budgetResourceName: "billingAccounts/000000-AAAAAA-111111/budgets/synthetic-budget", currency: "HKD", budgetAmountMicros: 77_500_000,
  usdBudgetMicros: 10_000_000, budgetProvenance: "approved-conservative-native-budget", billingTimeZone: "America/Los_Angeles", maxAgeMs: 36 * 60 * 60 * 1000, pauseAtPermille: 900 }
const options = () => ({ policy, topic: "projects/synthetic-project/topics/budget-observations", subscription: "projects/synthetic-project/subscriptions/budget-observations-backup-reader", budgetFilterProjectVerified: true, now, maxMessageAgeMs: 36 * 60 * 60 * 1000 })
const verifiedTransport = () => ({ topic: options().topic, subscription: options().subscription })
const payload = (overrides = {}) => ({ budgetDisplayName: "Synthetic scoped budget", costAmount: 1.23, costIntervalStart: "2026-10-01T07:00:00Z", budgetAmount: 77.5, budgetAmountType: "SPECIFIED_AMOUNT", currencyCode: "HKD", ...overrides })
const message = (body = payload()) => ({ data: Buffer.from(JSON.stringify(body)).toString("base64"), messageId: "1234567890", publishTime: "2026-10-26T12:00:00Z",
  attributes: { billingAccountId: "000000-AAAAAA-111111", budgetId: "synthetic-budget", schemaVersion: "1.0" } })
const parse = value => parseBackupBudgetPubsubMessage(value, options(), verifiedTransport())

test("native billing message binds verified transport, budget identity, local calendar and native cost", () => {
  const result = parse(message())
  assert.equal(result.observation.currency, "HKD")
  assert.equal(result.observation.actualCostMicros, 1_230_000)
  assert.equal(result.observation.budgetAmountMicros, 77_500_000)
  assert.equal(result.observation.forecastThresholdExceeded, null)
  assert.equal(result.observation.periodStart, "2026-10-01T07:00:00.000Z")
  assert.equal(result.observation.periodEnd, "2026-11-01T07:00:00.000Z")
  assert.equal(result.source.payloadSha256.length, 64)
  assert.equal(evaluateOptionalBackupBudget(result.observation, { ...policy, now }).optionalWorkAllowed, true)
})

test("zero costs and decimal/sub-micro costs stay safe without floating-point underestimate", () => {
  for (const [value, expected] of [[0, 0], [0.0000001, 1], [0.00000101, 2], [1.23456789, 1_234_568], [77.5, 77_500_000]]) {
    assert.equal(parse(message(payload({ costAmount: value }))).observation.actualCostMicros, expected)
  }
  assert.throws(() => parse(message(payload({ budgetAmount: 77.5000001 }))))
  assert.throws(() => parse(message(payload({ costAmount: 1e308 }))))
  const narrowBoundary = JSON.stringify(payload()).replace('"costAmount":1.23', '"costAmount":0.100000000000000005')
  assert.equal(parse({ ...message(), data: Buffer.from(narrowBoundary).toString("base64") }).observation.actualCostMicros, 100001)
})

test("forecast threshold flag pauses optional work without inventing full projected cost", () => {
  const result = parse(message(payload({ forecastThresholdExceeded: 1.0 })))
  assert.equal(evaluateOptionalBackupBudget(result.observation, { ...policy, now }).reason, "forecast_reaches_limit")
  assert.equal(Object.hasOwn(result.observation, "forecastCostMicros"), false)
})

test("spoofed channel, budget, schema, period, currency and stale/future publications are refused", () => {
  const faults = [
    value => { value.attributes.billingAccountId = "other-account" },
    value => { value.attributes.budgetId = "other-budget" },
    value => { value.attributes.schemaVersion = "2.0" },
    value => { value.attributes.topic = options().topic },
    value => { value.publishTime = "2026-10-27T00:00:00Z" },
    value => { value.publishTime = "2026-10-20T00:00:00Z" },
    value => { value.messageId = "not-an-id" },
    value => { value.data += "=" },
    value => { value.data = "" },
    value => { value.extra = true },
  ]
  for (const mutate of faults) { const value = message(); mutate(value); assert.throws(() => parse(value)) }
  for (const altered of [{ currencyCode: "USD" }, { budgetAmount: 80 }, { costAmount: -1 }, { budgetAmountType: "LAST_MONTH_COST" },
    { costIntervalStart: "2026-10-01T00:00:00Z" }, { costIntervalStart: "2026-10-02T07:00:00Z" }, { forecastThresholdExceeded: -1 },
    { costIntervalStart: "2026-10-01" }, { costAmount: "1.23" }, { guessedUsdCost: 0.1 }]) assert.throws(() => parse(message(payload(altered))))
  assert.throws(() => parseBackupBudgetPubsubMessage(message(), { ...options(), budgetFilterProjectVerified: false }, verifiedTransport()))
  assert.throws(() => parseBackupBudgetPubsubMessage(message(), options(), { ...verifiedTransport(), topic: "projects/foreign/topics/budget" }))
  assert.throws(() => parseBackupBudgetPubsubMessage(message(), options(), { ...verifiedTransport(), subscription: "projects/synthetic-project/subscriptions/other" }))
})

test("billing parser rejects duplicate JSON fields, nested structures, invalid Unicode bytes and overflow", () => {
  for (const text of [
    JSON.stringify(payload()).replace('"costAmount":1.23', '"costAmount":99,"costAmount":1.23'),
    JSON.stringify(payload()).replace('"costAmount":1.23', '"costAmount":{"value":1.23}'),
    JSON.stringify(payload()).replace('"costAmount":1.23', '"costAmount":[1.23]'),
    `${JSON.stringify(payload())} garbage`,
    JSON.stringify(payload()).replace('"costAmount":1.23', '"costAmount":1e999'),
  ]) assert.throws(() => parse({ ...message(), data: Buffer.from(text).toString("base64") }))
  assert.throws(() => parse({ ...message(), data: Buffer.from([255, 254]).toString("base64") }))
  assert.throws(() => parse({ ...message(), data: Buffer.alloc(65537).toString("base64") }))
  const reordered = JSON.stringify(payload(), null, 2)
  assert.equal(parse({ ...message(), data: Buffer.from(reordered).toString("base64") }).observation.actualCostMicros, 1_230_000)
})

test("duplicate/out-of-order/old-month messages do not overwrite a newer control observation", () => {
  const current = parse(message()).observation
  assert.equal(chooseNewerBackupBudgetObservation(null, current).accepted, true)
  assert.equal(chooseNewerBackupBudgetObservation(current, current).reason, "duplicate")
  assert.throws(() => chooseNewerBackupBudgetObservation(current, { ...current, actualCostMicros: current.actualCostMicros + 1 }))
  const old = { ...current, sourceMessageId: "1234567889", observedAt: "2026-10-26T11:00:00.000Z" }
  assert.equal(chooseNewerBackupBudgetObservation(current, old).reason, "older_observation")
  const previousMonth = { ...current, sourceMessageId: "1234567891", periodStart: "2026-09-01T07:00:00.000Z", periodEnd: "2026-10-01T07:00:00.000Z", observedAt: "2026-10-26T12:30:00.000Z" }
  assert.equal(chooseNewerBackupBudgetObservation(current, previousMonth).reason, "older_observation")
  assert.throws(() => chooseNewerBackupBudgetObservation(current, { ...current, sourceMessageId: "1234567891" }))
  const next = { ...current, sourceMessageId: "1234567892", observedAt: "2026-10-26T12:30:00.000Z" }
  assert.equal(chooseNewerBackupBudgetObservation(current, next).accepted, true)
  assert.throws(() => chooseNewerBackupBudgetObservation(current, { ...next, currency: "USD" }))
})
