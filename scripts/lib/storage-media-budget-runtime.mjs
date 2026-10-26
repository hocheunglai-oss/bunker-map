import { createHash } from "node:crypto"
import { fcunoConnectionPolicy } from "../../config/fcunoConnections.ts"
import { evaluateOptionalBackupBudget, validateBackupBudgetObservation } from "../../lib/backupOperatingPolicy.mjs"
import { createBackupBudgetGuard } from "./backup-budget-guard.mjs"
import { parseBackupBudgetPubsubMessage, chooseNewerBackupBudgetObservation } from "./backup-budget-pubsub.mjs"
import { requireStorageMediaJobRuntime } from "./storage-media-job-auth.mjs"

const pinned = fcunoConnectionPolicy.storageMediaBackup
const MAX_CONTROL = 16 * 1024, MAX_JSON = 2 * 1024 * 1024
const MAX_PULL_BATCHES = 100, PULL_BATCH_SIZE = 20, EMPTY_PULL_RETRIES = 3
const prefix = `${pinned.targetPrefix}/budget`, objectName = `${prefix}/observation.json`
const digest = bytes => createHash("sha256").update(bytes).digest("hex")
const fail = () => { throw new Error("Media backup budget source could not be verified") }
function exact(value, fields) {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== fields.length || fields.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"))) fail()
}
function members(value, legacyProjectWriters = false) {
  if (!Array.isArray(value) || !value.length || value.length > 30 || new Set(value).size !== value.length ||
      value.some(item => typeof item !== "string" || (!/^(?:user|serviceAccount):[^\s\x00-\x1f]{3,256}$/.test(item) &&
        !(legacyProjectWriters && [`projectOwner:${pinned.googleProjectId}`, `projectEditor:${pinned.googleProjectId}`].includes(item))))) fail()
  return new Set(value)
}
function generation(value) { if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > 18446744073709551615n) fail(); return value }
function normalTime(value) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(); return value }

// The deployment review must inspect the actual budget (one pinned project,
// all services, monthly specified amount), project/inherited IAM and live
// topic/subscription before supplying this non-secret configuration. The
// evidence digests identify that review, not credentials or an invented
// "verified" boolean. Runtime below independently checks the resource-local
// publisher/writer boundaries. Trusted project administrators and this existing
// job remain trusted; this is not a defense against their compromise.
export function readStorageMediaBudgetRuntimeConfig(runtime) {
  requireStorageMediaJobRuntime(runtime)
  const text = runtime.STORAGE_MEDIA_BACKUP_BUDGET_CONFIG_JSON
  if (typeof text !== "string" || Buffer.byteLength(text) > 16 * 1024) fail()
  const value = JSON.parse(text)
  exact(value, ["schema", "projectNumber", "budgetResourceName", "topic", "subscription", "currency", "budgetAmountMicros", "budgetProvenance", "billingTimeZone", "trustedWriterMembers", "trustedPublisherMembers", "deploymentEvidence"])
  const evidence = value.deploymentEvidence
  exact(evidence, ["reviewedAt", "budgetSha256", "projectIamSha256", "ancestorIamSha256", "subscriptionSha256"])
  normalTime(evidence.reviewedAt)
  if (value.schema !== "fcuno.media-budget-runtime/v1" || !/^[1-9]\d{4,19}$/.test(value.projectNumber) ||
      !/^billingAccounts\/[A-Z0-9-]+\/budgets\/[A-Za-z0-9_-]+$/.test(value.budgetResourceName) ||
      !new RegExp(`^projects/${pinned.googleProjectId}/topics/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$`).test(value.topic) ||
      !new RegExp(`^projects/${pinned.googleProjectId}/subscriptions/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$`).test(value.subscription) ||
      ![evidence.budgetSha256, evidence.projectIamSha256, evidence.ancestorIamSha256, evidence.subscriptionSha256].every(item => typeof item === "string" && /^[0-9a-f]{64}$/.test(item)) ||
      !((value.currency === "USD" && value.budgetAmountMicros === 10_000_000 && value.budgetProvenance === "verified-usd") ||
        (value.currency === "HKD" && value.budgetAmountMicros === 77_500_000 && value.budgetProvenance === "approved-conservative-native-budget"))) fail()
  const writers = members(value.trustedWriterMembers, true), publishers = members(value.trustedPublisherMembers)
  if (!writers.has(`serviceAccount:${pinned.googleServiceAccount}`)) fail()
  const policy = { projectId: pinned.googleProjectId, budgetResourceName: value.budgetResourceName, currency: value.currency,
    budgetAmountMicros: value.budgetAmountMicros, budgetProvenance: value.budgetProvenance, billingTimeZone: value.billingTimeZone,
    usdBudgetMicros: 10_000_000, maxAgeMs: 36 * 60 * 60 * 1000, pauseAtPermille: 900 }
  evaluateOptionalBackupBudget(null, { ...policy, now: Date.now() })
  return { ...value, policy, writers, publishers }
}

function bounded(operation, signal, onLate) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let settled = false
    const abort = () => { if (!settled) { settled = true; reject(new Error("Media backup budget request cancelled")) } }
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation() }).then(value => {
      signal.removeEventListener("abort", abort)
      if (settled || signal.aborted) { try { onLate?.(value) } catch { /* No late result may authorize work. */ } if (!settled) abort(); return }
      settled = true; resolve(value)
    }, error => { signal.removeEventListener("abort", abort); if (!settled) { settled = true; reject(error) } })
    if (signal.aborted) abort()
  })
}

// These are resource-local IAM roles only. The one reviewed metadata role is
// accepted on the pinned topic only for the existing job's sole unconditional
// binding. Deployment must read back its exact three read-only permissions;
// its name is not runtime proof of its definition. Project admins and the job
// remain trusted. Every other custom/new role still pauses optional work.
function verifyResourceIam(value, kind, trusted) {
  if (!value || !Array.isArray(value.bindings) || value.bindings.length > 200) fail()
  const readers = new Set(kind === "bucket" ? ["roles/storage.objectViewer", "roles/storage.legacyBucketReader", "roles/storage.legacyObjectReader"] : ["roles/pubsub.viewer", "roles/pubsub.subscriber"])
  const writers = new Set(kind === "bucket" ? ["roles/storage.admin", "roles/storage.objectAdmin", "roles/storage.objectCreator", "roles/storage.objectUser", "roles/storage.legacyBucketOwner", "roles/storage.legacyObjectOwner"] : ["roles/pubsub.publisher", "roles/pubsub.admin", "roles/owner", "roles/editor"])
  let expected = false
  for (const binding of value.bindings) {
    if (!binding || !Array.isArray(binding.members) || !binding.members.length || binding.members.length > 1000) fail()
    if (binding.role === `projects/${pinned.googleProjectId}/roles/fcunoBackupGuardMetadataReader`) {
      if (kind !== "topic" || Object.hasOwn(binding, "condition") || binding.members.length !== 1 ||
          binding.members[0] !== `serviceAccount:${pinned.googleServiceAccount}`) fail()
      continue
    }
    if (readers.has(binding.role)) continue
    if (!writers.has(binding.role) || binding.members.some(member => !trusted.has(member))) fail()
    if (!binding.condition && binding.members.some(member => trusted.has(member))) expected = true
  }
  if (!expected) fail()
}

export function createStorageMediaBudgetRuntime({ runtime, getAccessToken, fetch: fetchImpl = fetch, now = Date.now } = {}) {
  const config = readStorageMediaBudgetRuntimeConfig(runtime)
  if (typeof getAccessToken !== "function" || typeof fetchImpl !== "function" || typeof now !== "function") fail()
  let state = null
  function operation(context) {
    if (typeof context?.signal?.throwIfAborted !== "function" || !Number.isSafeInteger(context.deadline) || !Number.isSafeInteger(now())) fail()
    context.signal.throwIfAborted()
    const remaining = Math.min(context.deadline - now(), 30_000)
    if (remaining <= 0) fail()
    return { signal: AbortSignal.any([context.signal, AbortSignal.timeout(remaining)]), deadline: now() + remaining }
  }
  async function request(url, context, { method = "GET", body, headers, maximum = MAX_JSON, allowMissing = false, allowConflict = false } = {}) {
    const op = operation(context), token = await bounded(() => getAccessToken(op), op.signal)
    if (typeof token !== "string" || !token || token.length > 16384 || /[\s\x00-\x1f\x7f]/.test(token)) fail()
    const response = await bounded(() => fetchImpl(url, { method, body, headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "identity", ...headers },
      signal: op.signal, redirect: "error", cache: "no-store" }), op.signal, value => { void value.body?.cancel().catch(() => {}) })
    if ((allowMissing && response.status === 404) || (allowConflict && response.status === 412)) { void response.body?.cancel().catch(() => {}); return { status: response.status } }
    if (response.status !== 200 || !response.body || response.headers.has("content-range") || ![null, "identity"].includes(response.headers.get("content-encoding"))) { void response.body?.cancel().catch(() => {}); fail() }
    const reader = response.body.getReader(), chunks = []; let total = 0, done = false
    const cancel = () => { void reader.cancel().catch(() => {}) }
    op.signal.addEventListener("abort", cancel, { once: true })
    try {
      for (;;) {
        const next = await bounded(() => reader.read(), op.signal)
        op.signal.throwIfAborted()
        if (next.done) { done = true; break }
        if (!(next.value instanceof Uint8Array) || (total += next.value.length) > maximum) fail()
        chunks.push(next.value)
      }
      return { status: response.status, headers: response.headers, bytes: Buffer.concat(chunks) }
    } finally { op.signal.removeEventListener("abort", cancel); if (!done) cancel(); try { reader.releaseLock() } catch { /* Cancelled reader. */ } }
  }
  async function json(url, context, options) {
    const response = await request(url, context, options)
    if (!response.bytes) return response
    let value
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.bytes)) } catch { fail() }
    if (!value || typeof value !== "object" || Array.isArray(value)) fail()
    return { ...response, value }
  }
  const objectUrl = generation => `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(pinned.targetBucket)}/o/${encodeURIComponent(objectName)}${generation ? `?generation=${generation}` : ""}`
  async function preflight(context) {
    const bucket = (await json(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(pinned.targetBucket)}?fields=name,projectNumber,iamConfiguration`, context)).value
    if (bucket.name !== pinned.targetBucket || String(bucket.projectNumber) !== config.projectNumber || bucket.iamConfiguration?.publicAccessPrevention !== "enforced" || bucket.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true) fail()
    verifyResourceIam((await json(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(pinned.targetBucket)}/iam?optionsRequestedPolicyVersion=3`, context)).value, "bucket", config.writers)
    const subscription = (await json(`https://pubsub.googleapis.com/v1/${config.subscription}`, context)).value
    if (subscription.name !== config.subscription || subscription.topic !== config.topic || subscription.filter || subscription.deadLetterPolicy || subscription.pushConfig?.pushEndpoint || subscription.detached === true ||
        (subscription.state !== undefined && subscription.state !== "ACTIVE")) fail()
    verifyResourceIam((await json(`https://pubsub.googleapis.com/v1/${config.topic}:getIamPolicy?options.requestedPolicyVersion=3`, context)).value, "topic", config.publishers)
    return { name: pinned.targetBucket, projectId: pinned.googleProjectId, publicAccessPrevention: "enforced", uniformBucketLevelAccess: true, trustedBudgetWritersOnly: true }
  }
  async function readSelected(selected, context, allowMissing = false) {
    const selectedGeneration = selected === null ? null : generation(selected)
    const metadata = await json(objectUrl(selectedGeneration), context, { allowMissing })
    if (metadata.status === 404) return null
    const info = metadata.value
    if (info.bucket !== pinned.targetBucket || info.name !== objectName || (selectedGeneration && info.generation !== selectedGeneration) ||
        !/^[1-9]\d*$/.test(info.size ?? "") || Number(info.size) > MAX_CONTROL) fail()
    generation(info.generation)
    const result = await request(`${objectUrl(info.generation)}&alt=media`, context, { maximum: MAX_CONTROL })
    if (result.headers.get("x-goog-generation") !== info.generation || result.bytes.length !== Number(info.size) ||
        result.headers.get("content-length") !== info.size) fail()
    const text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes), observation = validateBackupBudgetObservation(JSON.parse(text))
    if (JSON.stringify(observation) !== text) fail()
    return { target: { bucket: pinned.targetBucket, objectName, generation: info.generation }, bytes: result.bytes, observation,
      sizeBytes: result.bytes.length, byteSha256: digest(result.bytes) }
  }
  async function record(incoming, context) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const previous = await readSelected(null, context, true), selected = chooseNewerBackupBudgetObservation(previous?.observation ?? null, incoming)
      if (!selected.accepted) return selected
      const bytes = Buffer.from(JSON.stringify(selected.observation))
      const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(pinned.targetBucket)}/o`)
      url.searchParams.set("uploadType", "media"); url.searchParams.set("name", objectName); url.searchParams.set("ifGenerationMatch", previous?.target.generation ?? "0")
      const saved = await json(url.href, context, { method: "POST", headers: { "Content-Type": "application/json" }, body: bytes, maximum: MAX_CONTROL, allowConflict: true })
      if (saved.status === 412) continue
      if (saved.value.bucket !== pinned.targetBucket || saved.value.name !== objectName) fail()
      const checked = await readSelected(generation(saved.value.generation), context)
      if (!checked.bytes.equals(bytes)) fail()
      // Re-read the live pointer after the CAS; never authorize from an older
      // generation if another accepted observation has already superseded it.
      const current = await readSelected(null, context)
      chooseNewerBackupBudgetObservation(current.observation, incoming)
      return { ...selected, observation: current.observation }
    }
    fail()
  }
  async function ingest(context) {
    await preflight(context)
    let obsolete = []
    let consecutiveEmpty = 0, currentPublicationRecorded = false
    const [, billingAccountId, budgetId] = /^billingAccounts\/([A-Z0-9-]+)\/budgets\/([A-Za-z0-9_-]+)$/.exec(config.budgetResourceName)
    async function acknowledge(ids) {
      for (let offset = 0; offset < ids.length; offset += PULL_BATCH_SIZE) {
        await json(`https://pubsub.googleapis.com/v1/${config.subscription}:acknowledge`, context, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ackIds: ids.slice(offset, offset + PULL_BATCH_SIZE) }), maximum: 4096,
        })
      }
    }
    for (let batch = 0; batch < MAX_PULL_BATCHES; batch++) {
      const pulled = (await json(`https://pubsub.googleapis.com/v1/${config.subscription}:pull`, context, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ maxMessages: PULL_BATCH_SIZE }), maximum: MAX_JSON,
      })).value
      const entries = pulled.receivedMessages === undefined ? [] : pulled.receivedMessages
      if (!Array.isArray(entries) || entries.length > PULL_BATCH_SIZE) fail()
      consecutiveEmpty = entries.length ? 0 : consecutiveEmpty + 1
      const verified = []
      let relevantUnverified = false
      for (const entry of entries) {
        try {
          if (!entry || typeof entry.ackId !== "string" || !entry.ackId || entry.ackId.length > 4096 || /[\x00-\x1f\x7f]/.test(entry.ackId)) fail()
          const current = now(), published = Date.parse(entry.message?.publishTime ?? "")
          if (!Number.isSafeInteger(current) || !Number.isSafeInteger(published) || published > current) fail()
          // Validate an old publication's entire authenticated envelope and
          // payload at its publication time. It is never a fresh cost input:
          // only a durable, genuinely current newer observation below may
          // authorize its acknowledgement. Malformed/future input still fails.
          const stale = current - published > config.policy.maxAgeMs
          const parsed = parseBackupBudgetPubsubMessage(entry.message, { policy: config.policy, topic: config.topic, subscription: config.subscription,
            budgetFilterProjectVerified: true, now: stale ? published : current, maxMessageAgeMs: config.policy.maxAgeMs }, { topic: config.topic, subscription: config.subscription })
          if (stale) obsolete.push({ ackId: entry.ackId, ...parsed })
          else verified.push({ ackId: entry.ackId, ...parsed })
        } catch {
          // An invalid publication claiming THIS budget cannot be ignored in
          // favor of an older cheap observation. Foreign budgets never become
          // this policy's cost, but remain unacknowledged as unverified input.
          if (entry?.message?.attributes?.billingAccountId === billingAccountId && entry?.message?.attributes?.budgetId === budgetId) relevantUnverified = true
        }
      }
      if (relevantUnverified) fail()
      verified.sort((left, right) => Date.parse(right.observation.observedAt) - Date.parse(left.observation.observedAt))
      const acknowledgements = []
      for (const selected of verified) {
        await record(selected.observation, context)
        acknowledgements.push(selected.ackId)
        const decision = evaluateOptionalBackupBudget(selected.observation, { ...config.policy, now: now() })
        if (["below_optional_pause_threshold", "actual_cost_near_limit", "forecast_reaches_limit"].includes(decision.reason)) currentPublicationRecorded = true
      }
      if (obsolete.length) {
        const durable = await readSelected(null, context, true)
        const decision = durable && evaluateOptionalBackupBudget(durable.observation, { ...config.policy, now: now() })
        if (decision && ["below_optional_pause_threshold", "actual_cost_near_limit", "forecast_reaches_limit"].includes(decision.reason)) {
          for (const selected of obsolete) {
            if (chooseNewerBackupBudgetObservation(durable.observation, selected.observation).accepted) fail()
            acknowledgements.push(selected.ackId)
          }
          obsolete = []
        }
      }
      await acknowledge(acknowledgements)
      if (consecutiveEmpty >= EMPTY_PULL_RETRIES) {
        // Pub/Sub may return zero even while messages remain available. These
        // bounded retries are not proof of an empty queue or real-time costs.
        // Cached cheap evidence plus empty pulls must never authorize work:
        // require a current matching publication durably handled in THIS run.
        if (obsolete.length || !currentPublicationRecorded) fail()
        return
      }
    }
    // Exhausting the polling budget is an unknown state, not evidence that
    // pending cost publications were consumed. Existing copies are untouched.
    fail()
  }
  const transport = {
    inspectPrivateBucket: (_input, context) => preflight(context),
    async inspectControl(input, context) {
      if (input.bucket !== pinned.targetBucket || input.objectName !== objectName) fail()
      const selected = await readSelected(input.generation ?? null, context)
      return { target: selected.target, sizeBytes: selected.sizeBytes, byteSha256: selected.byteSha256 }
    },
    async readControl(input, context) {
      if (input.bucket !== pinned.targetBucket || input.objectName !== objectName) fail()
      const selected = await readSelected(input.generation, context)
      return { target: selected.target, bytes: selected.bytes }
    },
  }
  const guard = createBackupBudgetGuard({ policy: config.policy, control: { bucket: pinned.targetBucket, prefix, objectName }, transport, now })
  return Object.freeze({
    async checkOptionalWork(input, context) {
      let decision
      try { await ingest(context); decision = await guard.checkOptionalWork(input, context) }
      catch { decision = { ...evaluateOptionalBackupBudget(null, { ...config.policy, now: now() }), allowed: false, reason: "budget_control_unavailable" } }
      state = { state: decision.allowed ? "normal" : "paused", checkedAt: new Date(now()).toISOString(), projectedUsd: null, limitUsd: 10 }
      return decision
    },
    getBudgetState: () => state ? { ...state } : null,
  })
}
