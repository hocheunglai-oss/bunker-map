import { createHash } from "node:crypto"
import { deriveBackupBillingPeriod, validateBackupBudgetObservation } from "../../lib/backupOperatingPolicy.mjs"

const MAX_MESSAGE_BYTES = 64 * 1024
const fail = () => { throw new Error("Backup billing message could not be verified") }
function exact(value, fields) {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== fields.length ||
      fields.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"))) fail()
}
function time(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail()
  return new Date(value).toISOString()
}
function flatJson(text) {
  // Billing payloads are flat. Parse each scalar token independently so a
  // duplicate key is rejected instead of JSON.parse silently keeping its last
  // value. Unknown/nested future formats pause optional work, not core backups.
  const values = Object.create(null), numericTokens = Object.create(null), quoted = /^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/
  let cursor = 0
  const skip = () => { while (/[ \t\r\n]/.test(text[cursor] ?? "") && cursor < text.length) cursor++ }
  const consume = expression => { const found = expression.exec(text.slice(cursor)); if (!found) fail(); cursor += found[0].length; return found[0] }
  skip(); if (text[cursor++] !== "{") fail(); skip()
  if (text[cursor] === "}") { cursor++; skip(); if (cursor !== text.length) fail(); return { values, numericTokens } }
  for (;;) {
    const name = JSON.parse(consume(quoted))
    if (Object.hasOwn(values, name)) fail()
    skip(); if (text[cursor++] !== ":") fail(); skip()
    const raw = text[cursor] === '"' ? consume(quoted) : consume(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)
    values[name] = JSON.parse(raw)
    if (typeof values[name] === "number") numericTokens[name] = raw
    skip(); const delimiter = text[cursor++]
    if (delimiter === "}") break
    if (delimiter !== ",") fail()
    skip()
  }
  skip(); if (cursor !== text.length) fail()
  return { values, numericTokens }
}
function monetaryMicros(value, raw, roundUp) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || Object.is(value, -0)) fail()
  // Use the original JSON decimal token, not Number.toString: a value just
  // above a micro boundary can otherwise round down in IEEE-754 first.
  if (typeof raw !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) fail()
  const [whole, exponentText = "0"] = raw.toLowerCase().split("e"), [integer, fraction = ""] = whole.split(".")
  const decimalExponent = Number(exponentText) - fraction.length + 6, digits = BigInt(integer + fraction)
  if (!Number.isSafeInteger(decimalExponent) || Math.abs(decimalExponent) > MAX_MESSAGE_BYTES) fail()
  let result
  if (decimalExponent >= 0) result = digits * 10n ** BigInt(decimalExponent)
  else {
    const divisor = 10n ** BigInt(-decimalExponent), remainder = digits % divisor
    if (remainder && !roundUp) fail()
    result = digits / divisor + (remainder ? 1n : 0n)
  }
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) fail()
  return Number(result)
}
function sourceOptions(options) {
  exact(options, ["policy", "topic", "subscription", "budgetFilterProjectVerified", "now", "maxMessageAgeMs"])
  const { policy, topic, subscription } = options
  if (!policy || typeof policy !== "object" || typeof policy.projectId !== "string" || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(policy.projectId) || options.budgetFilterProjectVerified !== true ||
      typeof topic !== "string" || !new RegExp(`^projects/${policy.projectId}/topics/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$`).test(topic) ||
      typeof subscription !== "string" || !new RegExp(`^projects/${policy.projectId}/subscriptions/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$`).test(subscription) ||
      !Number.isSafeInteger(options.now) || !Number.isSafeInteger(options.maxMessageAgeMs) || options.maxMessageAgeMs < 1 || options.maxMessageAgeMs > 36 * 60 * 60 * 1000) fail()
  const match = /^billingAccounts\/([A-Z0-9-]+)\/budgets\/([A-Za-z0-9_-]+)$/.exec(policy.budgetResourceName)
  if (!match) fail()
  return { billingAccountId: match[1], budgetId: match[2] }
}

// The topic/subscription in `verifiedTransport` are supplied by the
// authenticated target-locked Pub/Sub PULL adapter, never by message contents.
// Validate the live budget's exact one-project filter and publisher IAM before
// providing budgetFilterProjectVerified=true. Message strings are not identity
// credentials. This parser performs no API calls, acknowledgement or writes.
export function parseBackupBudgetPubsubMessage(message, options, verifiedTransport) {
  const expected = sourceOptions(options)
  exact(verifiedTransport, ["topic", "subscription"])
  if (verifiedTransport.topic !== options.topic || verifiedTransport.subscription !== options.subscription) fail()
  exact(message, ["data", "messageId", "publishTime", "attributes"])
  exact(message.attributes, ["billingAccountId", "budgetId", "schemaVersion"])
  if (message.attributes.billingAccountId !== expected.billingAccountId || message.attributes.budgetId !== expected.budgetId || message.attributes.schemaVersion !== "1.0" ||
      typeof message.messageId !== "string" || !/^[1-9]\d{0,39}$/.test(message.messageId) || typeof message.data !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data) || message.data.length > Math.ceil(MAX_MESSAGE_BYTES / 3) * 4) fail()
  const publishedAt = time(message.publishTime), published = Date.parse(publishedAt)
  if (published > options.now || options.now - published > options.maxMessageAgeMs) fail()
  const bytes = Buffer.from(message.data, "base64")
  if (!bytes.length || bytes.length > MAX_MESSAGE_BYTES || bytes.toString("base64") !== message.data) fail()
  const { values: payload, numericTokens } = flatJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  const allowed = ["budgetDisplayName", "alertThresholdExceeded", "forecastThresholdExceeded", "costAmount", "costIntervalStart", "budgetAmount", "budgetAmountType", "currencyCode"]
  if (Object.keys(payload).some(key => !allowed.includes(key)) || !["costAmount", "costIntervalStart", "budgetAmount", "budgetAmountType", "currencyCode"].every(key => Object.hasOwn(payload, key)) ||
      payload.budgetAmountType !== "SPECIFIED_AMOUNT" || payload.currencyCode !== options.policy.currency ||
      (payload.budgetDisplayName !== undefined && (typeof payload.budgetDisplayName !== "string" || payload.budgetDisplayName.length > 1024)) ||
      (payload.alertThresholdExceeded !== undefined && (typeof payload.alertThresholdExceeded !== "number" || !Number.isFinite(payload.alertThresholdExceeded) || payload.alertThresholdExceeded < 0))) fail()
  const period = deriveBackupBillingPeriod(time(payload.costIntervalStart), options.policy.billingTimeZone)
  const budgetAmountMicros = monetaryMicros(payload.budgetAmount, numericTokens.budgetAmount, false)
  if (budgetAmountMicros !== options.policy.budgetAmountMicros || published < Date.parse(period.periodStart)) fail()
  const observation = validateBackupBudgetObservation({ schema: "fcuno.backup-budget/v1", projectId: options.policy.projectId,
    budgetResourceName: options.policy.budgetResourceName, ...period, currency: payload.currencyCode, budgetAmountMicros,
    actualCostMicros: monetaryMicros(payload.costAmount, numericTokens.costAmount, true), forecastThresholdExceeded: payload.forecastThresholdExceeded ?? null,
    observedAt: publishedAt, source: "gcp-billing-budget", sourceMessageId: message.messageId })
  return { observation, source: { topic: options.topic, subscription: options.subscription, messageId: message.messageId,
    publishTime: publishedAt, payloadSha256: createHash("sha256").update(bytes).digest("hex") } }
}

// Call inside the control object's generation-CAS loop. A result is a decision
// only, not a write. Root must not acknowledge a message until its applicable
// observation is durably recorded or proven an already-recorded duplicate.
export function chooseNewerBackupBudgetObservation(previous, incoming) {
  const next = validateBackupBudgetObservation(incoming)
  if (previous === null) return { accepted: true, reason: "first_observation", observation: next }
  const current = validateBackupBudgetObservation(previous)
  if (current.projectId !== next.projectId || current.budgetResourceName !== next.budgetResourceName || current.currency !== next.currency || current.budgetAmountMicros !== next.budgetAmountMicros) fail()
  if (current.sourceMessageId === next.sourceMessageId) {
    if (JSON.stringify(current) !== JSON.stringify(next)) fail()
    return { accepted: false, reason: "duplicate", observation: current }
  }
  if (Date.parse(next.observedAt) < Date.parse(current.observedAt) || Date.parse(next.periodStart) < Date.parse(current.periodStart)) return { accepted: false, reason: "older_observation", observation: current }
  if (next.observedAt === current.observedAt) fail()
  return { accepted: true, reason: "newer_observation", observation: next }
}
