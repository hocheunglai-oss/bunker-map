import assert from "node:assert/strict"
import test from "node:test"
import { fcunoConnectionPolicy } from "../config/fcunoConnections.ts"
import { createStorageMediaBudgetRuntime, readStorageMediaBudgetRuntimeConfig } from "../scripts/lib/storage-media-budget-runtime.mjs"
import { main } from "../scripts/backup-storage-media-to-gcs.mjs"

const pinned = fcunoConnectionPolicy.storageMediaBackup
const now = Date.parse("2026-10-26T13:00:00.000Z")
const config = () => ({ schema: "fcuno.media-budget-runtime/v1", projectNumber: "210526897676",
  budgetResourceName: "billingAccounts/000000-AAAAAA-111111/budgets/synthetic-budget",
  topic: `projects/${pinned.googleProjectId}/topics/synthetic-budget`, subscription: `projects/${pinned.googleProjectId}/subscriptions/synthetic-budget-reader`,
  currency: "HKD", budgetAmountMicros: 77_500_000, budgetProvenance: "approved-conservative-native-budget", billingTimeZone: "America/Los_Angeles",
  trustedWriterMembers: [`serviceAccount:${pinned.googleServiceAccount}`, "user:synthetic@example.test"],
  trustedPublisherMembers: ["serviceAccount:synthetic-billing@example.test"],
  deploymentEvidence: { reviewedAt: "2026-10-26T12:00:00.000Z", budgetSha256: "a".repeat(64), projectIamSha256: "b".repeat(64), ancestorIamSha256: "c".repeat(64), subscriptionSha256: "d".repeat(64) },
})
const runtime = value => ({ CLOUD_RUN_JOB: pinned.googleJob, GOOGLE_CLOUD_PROJECT: pinned.googleProjectId, STORAGE_MEDIA_BACKUP_BUDGET_CONFIG_JSON: JSON.stringify(value ?? config()) })
const context = () => ({ signal: new AbortController().signal, deadline: now + 60_000 })
const observation = (id = "100", cost = 1, published = now - 1000) => ({ schema: "fcuno.backup-budget/v1", projectId: pinned.googleProjectId,
  budgetResourceName: config().budgetResourceName, periodStart: "2026-10-01T07:00:00.000Z", periodEnd: "2026-11-01T07:00:00.000Z",
  currency: "HKD", budgetAmountMicros: 77_500_000, actualCostMicros: cost * 1_000_000, forecastThresholdExceeded: null,
  observedAt: new Date(published).toISOString(), source: "gcp-billing-budget", sourceMessageId: id })
const message = (id = "100", cost = 1, published = now - 1000) => ({ ackId: `synthetic-${id}`, message: {
  messageId: id, publishTime: new Date(published).toISOString(), attributes: { billingAccountId: "000000-AAAAAA-111111", budgetId: "synthetic-budget", schemaVersion: "1.0" },
  data: Buffer.from(JSON.stringify({ costAmount: cost, costIntervalStart: "2026-10-01T07:00:00Z", budgetAmount: 77.5, budgetAmountType: "SPECIFIED_AMOUNT", currencyCode: "HKD" })).toString("base64"),
} })

function fixture(options = {}) {
  const conf = config(), calls = [], writes = [], acknowledgements = [], versions = new Map()
  let latest = null, next = 1000
  const save = value => { const selected = String(++next), bytes = Buffer.from(JSON.stringify(value)); versions.set(selected, bytes); latest = selected; return selected }
  if (options.previous) save(options.previous)
  const batches = options.messageBatches ?? [options.messages ?? [message()]]
  let pulled = 0
  const fetch = async (value, init) => {
    const url = new URL(value); calls.push([url.href, init.method]);
    assert.equal(init.headers.Authorization, "Bearer synthetic-access-token"); assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store")
    assert.ok(init.signal instanceof AbortSignal); assert.notEqual(url.protocol, "http:")
    if (url.hostname === "storage.googleapis.com" && url.pathname.endsWith(`/${pinned.targetBucket}`)) return Response.json({ name: pinned.targetBucket, projectNumber: conf.projectNumber,
      iamConfiguration: { publicAccessPrevention: "enforced", uniformBucketLevelAccess: { enabled: true } }, ...options.bucket })
    if (url.hostname === "storage.googleapis.com" && url.pathname.endsWith("/iam")) return Response.json({ bindings: options.bucketBindings ?? [
      { role: "roles/storage.objectAdmin", members: conf.trustedWriterMembers }, { role: "roles/storage.objectViewer", members: ["user:reader@example.test"] },
    ] })
    if (url.hostname === "pubsub.googleapis.com" && url.pathname.endsWith(":getIamPolicy")) return Response.json({ bindings: options.topicBindings ?? [{ role: "roles/pubsub.publisher", members: conf.trustedPublisherMembers }] })
    if (url.hostname === "pubsub.googleapis.com" && url.pathname === `/v1/${conf.subscription}`) return Response.json({ name: conf.subscription, topic: conf.topic, pushConfig: {}, state: "ACTIVE", ...options.subscription })
    if (url.pathname.endsWith(":pull")) {
      assert.deepEqual(JSON.parse(init.body), { maxMessages: 20 }); return Response.json({ receivedMessages: batches[pulled++] ?? [] })
    }
    if (url.pathname.endsWith(":acknowledge")) { acknowledgements.push(...JSON.parse(init.body).ackIds); if (options.ackFails) return Response.json({ error: "private details" }, { status: 500 }); return Response.json({}) }
    if (url.pathname.startsWith("/upload/storage/v1/")) {
      const expected = url.searchParams.get("ifGenerationMatch")
      if (options.casRace && !writes.length) { save(options.casRace); writes.push("race"); return Response.json({}, { status: 412 }) }
      if (expected !== (latest ?? "0")) return Response.json({}, { status: 412 })
      const parsed = JSON.parse(init.body.toString()), selected = save(parsed); writes.push(parsed)
      return Response.json({ name: `${pinned.targetPrefix}/budget/observation.json`, bucket: pinned.targetBucket, generation: selected, size: String(versions.get(selected).length) })
    }
    if (url.pathname.includes("/o/")) {
      const selected = url.searchParams.get("generation") ?? latest
      if (!selected || !versions.has(selected)) return Response.json({}, { status: 404 })
      const bytes = versions.get(selected)
      if (url.searchParams.get("alt") === "media") return new Response(options.corruptRead ? Buffer.alloc(bytes.length) : bytes, { headers: { "x-goog-generation": selected, "content-length": String(bytes.length) } })
      return Response.json({ name: `${pinned.targetPrefix}/budget/observation.json`, bucket: pinned.targetBucket, generation: selected, size: String(bytes.length) })
    }
    throw Error(`Unexpected synthetic URL: ${url.origin}${url.pathname}`)
  }
  const budget = createStorageMediaBudgetRuntime({ runtime: runtime(conf), fetch, now: () => now, getAccessToken: async () => "synthetic-access-token" })
  return { budget, calls, writes, acknowledgements, latest: () => latest ? JSON.parse(versions.get(latest)) : null }
}

test("runtime binds live private bucket and publisher/subscription before bounded pull, durable CAS and acknowledgment", async () => {
  const f = fixture(), result = await f.budget.checkOptionalWork({ plannedWriteBytes: 10 }, context())
  assert.equal(result.allowed, true); assert.equal(f.writes.length, 1); assert.deepEqual(f.acknowledgements, ["synthetic-100"])
  assert.equal(f.latest().sourceMessageId, "100"); assert.equal(result.currency, "HKD")
  assert.deepEqual(f.budget.getBudgetState(), { state: "normal", checkedAt: new Date(now).toISOString(), projectedUsd: null, limitUsd: 10 })
  assert.ok(f.calls.findIndex(item => item[0].includes(":acknowledge")) > f.calls.findIndex(item => item[0].includes("/upload/")))
})

test("90 percent actual cost or forecast boundary pauses only optional work and preserves copies", async () => {
  for (const cost of [69.75, 77.5, 90]) {
    const f = fixture({ messages: [message("100", cost)] }), result = await f.budget.checkOptionalWork({}, context())
    assert.equal(result.allowed, false); assert.equal(result.reason, "actual_cost_near_limit")
    assert.equal(result.essentialExistingBackupUnaffected, true); assert.equal(f.budget.getBudgetState().state, "paused")
    assert.equal(f.calls.some(item => item[1] === "DELETE"), false)
  }
})

test("unrelated read-only IAM additions do not trip brittle full-policy fingerprints", async () => {
  const conf = config(), f = fixture({ topicBindings: [{ role: "roles/pubsub.publisher", members: conf.trustedPublisherMembers }, { role: "roles/pubsub.viewer", members: ["user:new-reader@example.test"] }] })
  assert.equal((await f.budget.checkOptionalWork({}, context())).allowed, true)
})

test("the deployment-reviewed metadata role is accepted only as the exact job's topic reader, not as a publisher", async () => {
  const conf = config(), f = fixture({ topicBindings: [
    { role: "roles/pubsub.publisher", members: conf.trustedPublisherMembers },
    { role: `projects/${pinned.googleProjectId}/roles/fcunoBackupGuardMetadataReader`, members: [`serviceAccount:${pinned.googleServiceAccount}`] },
  ] })
  assert.equal((await f.budget.checkOptionalWork({}, context())).allowed, true)
  assert.deepEqual(f.acknowledgements, ["synthetic-100"]); assert.equal(f.writes.length, 1)
  assert.equal(f.latest().sourceMessageId, "100")
  assert.equal(conf.trustedPublisherMembers.includes(`serviceAccount:${pinned.googleServiceAccount}`), false)
})

test("metadata-role exceptions never admit a foreign role, bucket, condition or expanded principal set", async t => {
  const conf = config(), role = `projects/${pinned.googleProjectId}/roles/fcunoBackupGuardMetadataReader`
  const job = `serviceAccount:${pinned.googleServiceAccount}`, publisher = { role: "roles/pubsub.publisher", members: conf.trustedPublisherMembers }
  const metadata = { role, members: [job] }
  const topic = binding => ({ topicBindings: [publisher, binding] })
  for (const [name, options] of Object.entries({
    bucket: { bucketBindings: [{ role: "roles/storage.objectAdmin", members: conf.trustedWriterMembers }, metadata] },
    foreignProject: topic({ ...metadata, role: "projects/foreign-project/roles/fcunoBackupGuardMetadataReader" }),
    organizationRole: topic({ ...metadata, role: "organizations/123456789/roles/fcunoBackupGuardMetadataReader" }),
    unknownLocalRole: topic({ ...metadata, role: `projects/${pinned.googleProjectId}/roles/unreviewedMetadataReader` }),
    roleSuffix: topic({ ...metadata, role: `${role}Extra` }),
    otherServiceAccount: topic({ ...metadata, members: ["serviceAccount:other@example.test"] }),
    trustedPublisherIsNotJob: topic({ ...metadata, members: conf.trustedPublisherMembers }),
    additionalUnknownMember: topic({ ...metadata, members: [job, "user:stranger@example.test"] }),
    additionalTrustedMember: topic({ ...metadata, members: [job, ...conf.trustedPublisherMembers] }),
    duplicateMember: topic({ ...metadata, members: [job, job] }),
    publicMember: topic({ ...metadata, members: ["allUsers"] }),
    conditional: topic({ ...metadata, condition: { title: "restricted", expression: "resource.name == 'synthetic'" } }),
    emptyCondition: topic({ ...metadata, condition: {} }),
    nullCondition: topic({ ...metadata, condition: null }),
    emptyMembers: topic({ ...metadata, members: [] }),
    unknownOtherBinding: { topicBindings: [publisher, metadata, { role: "projects/foreign-project/roles/unknown", members: [job] }] },
    noActualPublisher: { topicBindings: [metadata] },
    conditionalPublisher: { topicBindings: [metadata, { ...publisher, condition: { expression: "true" } }] },
  })) await t.test(name, async () => {
    const f = fixture(options), result = await f.budget.checkOptionalWork({}, context())
    assert.equal(result.allowed, false); assert.equal(result.reason, "budget_control_unavailable")
    assert.equal(f.calls.some(item => item[0].includes(":pull")), false)
    assert.equal(f.writes.length, 0); assert.deepEqual(f.acknowledgements, [])
  })
})

test("legacy bucket project writer groups require exact pinned project and deployment-reviewed allowlist", () => {
  const conf = config()
  for (const role of ["projectOwner", "projectEditor"]) {
    assert.ok(readStorageMediaBudgetRuntimeConfig(runtime({ ...conf, trustedWriterMembers: [...conf.trustedWriterMembers, `${role}:${pinned.googleProjectId}`] })))
    assert.throws(() => readStorageMediaBudgetRuntimeConfig(runtime({ ...conf, trustedWriterMembers: [...conf.trustedWriterMembers, `${role}:foreign-project`] })))
    assert.throws(() => readStorageMediaBudgetRuntimeConfig(runtime({ ...conf, trustedPublisherMembers: [`${role}:${pinned.googleProjectId}`] })))
  }
})

test("foreign writer, public/mismatched bucket, spoofed topic and unreviewed role stop before any pull/write/ack", async t => {
  for (const [name, options] of Object.entries({ public: { bucket: { iamConfiguration: { publicAccessPrevention: "inherited" } } },
    wrongProject: { bucket: { projectNumber: "999999999999" } }, writer: { bucketBindings: [{ role: "roles/storage.objectAdmin", members: ["user:stranger@example.test"] }] },
    publisher: { topicBindings: [{ role: "roles/pubsub.publisher", members: ["user:stranger@example.test"] }] },
    unknownRole: { topicBindings: [{ role: "projects/synthetic/roles/newRole", members: ["user:stranger@example.test"] }] },
    topic: { subscription: { topic: "projects/foreign/topics/foreign-topic" } }, filter: { subscription: { filter: 'attributes.x = "y"' } },
    push: { subscription: { pushConfig: { pushEndpoint: "https://other.example.test" } } }, detached: { subscription: { detached: true } },
  })) await t.test(name, async () => {
    const f = fixture(options), result = await f.budget.checkOptionalWork({}, context())
    assert.equal(result.allowed, false); assert.equal(result.reason, "budget_control_unavailable")
    assert.equal(f.calls.some(item => item[0].includes(":pull")), false); assert.equal(f.writes.length, 0); assert.equal(f.acknowledgements.length, 0)
  })
})

test("unverified messages never acknowledged, newest authentic record wins even when mixed/out of order", async () => {
  const invalid = message("101"); invalid.message.attributes.budgetId = "foreign-budget"
  const f = fixture({ messages: [message("98", 1, now - 3000), invalid, message("100", 2, now - 1000), message("99", 3, now - 2000)] })
  assert.equal((await f.budget.checkOptionalWork({}, context())).allowed, true)
  assert.equal(f.latest().sourceMessageId, "100"); assert.equal(f.writes.length, 1)
  assert.deepEqual(f.acknowledgements, ["synthetic-100", "synthetic-99", "synthetic-98"])
})

test("concurrent newer observation survives compare-and-swap retry and cannot be downgraded by a cheaper old message", async () => {
  const f = fixture({ casRace: observation("101", 80, now - 500) }), result = await f.budget.checkOptionalWork({}, context())
  assert.equal(result.allowed, false); assert.equal(result.reason, "actual_cost_near_limit")
  assert.equal(f.latest().sourceMessageId, "101"); assert.deepEqual(f.acknowledgements, ["synthetic-100"])
})

test("drains more than one daily batch before deciding and sees a later expensive publication", async () => {
  const messages = Array.from({ length: 45 }, (_, index) => message(String(100 + index), index === 44 ? 80 : 1, now - 60_000 + index))
  const f = fixture({ messageBatches: [messages.slice(0, 20), messages.slice(20, 40), messages.slice(40)] })
  const result = await f.budget.checkOptionalWork({}, context())
  assert.equal(result.allowed, false); assert.equal(result.reason, "actual_cost_near_limit")
  assert.equal(f.latest().sourceMessageId, "144"); assert.equal(f.acknowledgements.length, 45)
  assert.equal(new Set(f.acknowledgements).size, 45)
  assert.equal(f.calls.filter(item => item[0].endsWith(":pull")).length, 6)
})

test("fully validated obsolete publication is acknowledged only after a durable fresh newer record", async () => {
  const old = message("80", 90, now - 48 * 3_600_000), fresh = message("101", 1, now - 500)
  for (const options of [
    { previous: observation(), messageBatches: [[old]] },
    { messageBatches: [[old], [fresh]] },
  ]) {
    const f = fixture(options), result = await f.budget.checkOptionalWork({}, context())
    assert.equal(result.allowed, !options.previous)
    assert.ok(f.acknowledgements.includes("synthetic-80"))
    assert.notEqual(f.latest().sourceMessageId, "80")
    if (!options.previous) {
      assert.equal(f.latest().sourceMessageId, "101")
      assert.deepEqual(f.acknowledgements, ["synthetic-101", "synthetic-80"])
      assert.ok(f.calls.findIndex(item => item[0].includes(":acknowledge")) > f.calls.findIndex(item => item[0].includes("/upload/")))
    }
  }
})

test("obsolete input alone cannot seed the control, be acknowledged or permit optional writes", async () => {
  for (const previous of [undefined, observation("79", 1, now - 49 * 3_600_000)]) {
    const f = fixture({ previous, messageBatches: [[message("80", 1, now - 48 * 3_600_000)]] })
    const result = await f.budget.checkOptionalWork({}, context())
    assert.equal(result.allowed, false); assert.equal(result.reason, "budget_control_unavailable")
    assert.equal(f.writes.length, 0); assert.deepEqual(f.acknowledgements, [])
    assert.notEqual(f.latest()?.sourceMessageId, "80")
  }
})

test("acknowledging obsolete cheap input never weakens a current durable over-budget pause", async () => {
  const f = fixture({ previous: observation("100", 80), messages: [message("80", 1, now - 48 * 3_600_000)] })
  const result = await f.budget.checkOptionalWork({}, context())
  assert.equal(result.allowed, false); assert.equal(result.reason, "budget_control_unavailable")
  assert.equal(f.latest().sourceMessageId, "100"); assert.equal(f.latest().actualCostMicros, 80_000_000)
  assert.deepEqual(f.acknowledgements, ["synthetic-80"]); assert.equal(f.writes.length, 0)
})

test("old malformed or future relevant input is never treated as an acknowledgeable obsolete record", async () => {
  const malformed = message("80", 1, now - 48 * 3_600_000)
  malformed.message.data = Buffer.from("invalid format").toString("base64")
  for (const invalid of [malformed, message("102", 1, now + 1000)]) {
    const f = fixture({ previous: observation(), messageBatches: [[invalid, message("101", 1, now - 500)]] })
    const result = await f.budget.checkOptionalWork({}, context())
    assert.equal(result.allowed, false); assert.equal(result.reason, "budget_control_unavailable")
    assert.equal(f.writes.length, 0); assert.deepEqual(f.acknowledgements, [])
  }
})

test("bounded drain exhaustion preserves durable observations but cannot authorize optional work", async () => {
  const f = fixture({ messageBatches: Array.from({ length: 101 }, (_, index) => [message(String(100 + index), 1, now - 1000 + index)]) })
  const result = await f.budget.checkOptionalWork({}, context())
  assert.equal(result.allowed, false); assert.equal(result.reason, "budget_control_unavailable")
  assert.equal(f.calls.filter(item => item[0].endsWith(":pull")).length, 100)
  assert.equal(f.latest().sourceMessageId, "199"); assert.equal(f.acknowledgements.length, 100)
  assert.equal(f.calls.some(item => item[1] === "DELETE"), false)
})

test("malformed relevant billing publication cannot fall back to an older cheap green observation", async () => {
  const invalid = message("102", 90, now - 500); invalid.message.data = Buffer.from("invalid format").toString("base64")
  const f = fixture({ previous: observation(), messages: [invalid] }), result = await f.budget.checkOptionalWork({}, context())
  assert.equal(result.allowed, false); assert.equal(result.reason, "budget_control_unavailable")
  assert.equal(f.writes.length, 0); assert.equal(f.acknowledgements.length, 0); assert.equal(f.latest().actualCostMicros, 1_000_000)
})

test("empty-only responses never authorize cached costs, including a fresh cheap prior record", async () => {
  for (const previous of [null, observation(), observation("90", 1, now - 48 * 3600000),
    { ...observation(), periodStart: "2026-09-01T07:00:00.000Z", periodEnd: "2026-10-01T07:00:00.000Z", observedAt: "2026-09-30T12:00:00.000Z" }]) {
    const f = fixture({ previous, messages: [] }), result = await f.budget.checkOptionalWork({}, context())
    assert.equal(result.allowed, false); assert.equal(result.reason, "budget_control_unavailable")
    assert.equal(f.writes.length, 0); assert.equal(f.acknowledgements.length, 0)
    assert.equal(f.calls.filter(item => item[0].endsWith(":pull")).length, 3)
  }
})

test("an empty response before a later expensive publication cannot authorize cached cheap costs", async () => {
  const f = fixture({ previous: observation(), messageBatches: [[], [message("101", 80, now - 500)]] })
  const result = await f.budget.checkOptionalWork({}, context())
  assert.equal(result.allowed, false); assert.equal(result.reason, "actual_cost_near_limit")
  assert.equal(f.latest().sourceMessageId, "101"); assert.equal(f.calls.filter(item => item[0].endsWith(":pull")).length, 5)
  assert.deepEqual(f.acknowledgements, ["synthetic-101"])
})

test("interleaved empty responses reset the retry bound when actual messages arrive", async () => {
  const f = fixture({ messageBatches: [[message()], [], [message("101", 80, now - 500)]] })
  const result = await f.budget.checkOptionalWork({}, context())
  assert.equal(result.allowed, false); assert.equal(result.reason, "actual_cost_near_limit")
  assert.equal(f.latest().sourceMessageId, "101"); assert.equal(f.calls.filter(item => item[0].endsWith(":pull")).length, 6)
  assert.deepEqual(f.acknowledgements, ["synthetic-100", "synthetic-101"])
})

test("malformed relevant input after a transient empty response still fails closed", async () => {
  const invalid = message("101", 80, now - 500); invalid.message.data = Buffer.from("bad").toString("base64")
  const f = fixture({ previous: observation(), messageBatches: [[], [invalid]] })
  const result = await f.budget.checkOptionalWork({}, context())
  assert.equal(result.allowed, false); assert.equal(result.reason, "budget_control_unavailable")
  assert.equal(f.calls.filter(item => item[0].endsWith(":pull")).length, 2)
  assert.equal(f.writes.length, 0); assert.deepEqual(f.acknowledgements, [])
})

test("failed readback never acknowledges; acknowledgement failure safely pauses without discarding durable observation", async () => {
  for (const options of [{ corruptRead: true }, { ackFails: true }]) {
    const f = fixture(options), result = await f.budget.checkOptionalWork({}, context())
    assert.equal(result.allowed, false); assert.equal(result.reason, "budget_control_unavailable")
    assert.equal(f.latest().sourceMessageId, "100")
    if (options.corruptRead) assert.equal(f.acknowledgements.length, 0)
    assert.equal(JSON.stringify(result).includes("private details"), false)
  }
})

test("config requires actual audited deployment evidence and exact capped currency/provenance, with no source credentials", () => {
  assert.equal(readStorageMediaBudgetRuntimeConfig(runtime()).policy.pauseAtPermille, 900)
  for (const change of [{ budgetAmountMicros: 100_000_000 }, { currency: "HKD", budgetProvenance: "verified-usd" }, { billingTimeZone: "bad/zone" },
    { topic: "projects/foreign/topics/budget-alerts" }, { trustedWriterMembers: ["user:someone@example.test"] }, { deploymentEvidence: { verified: true } },
    { trustedPublisherMembers: ["allUsers"] }]) assert.throws(() => readStorageMediaBudgetRuntimeConfig(runtime({ ...config(), ...change })))
  assert.throws(() => readStorageMediaBudgetRuntimeConfig({ ...runtime(), GOOGLE_APPLICATION_CREDENTIALS: "/private/key.json" }))
})

test("non-cooperative token requests are bounded by cancellation and never start provider IO afterwards", async () => {
  const controller = new AbortController(); let calls = 0
  const budget = createStorageMediaBudgetRuntime({ runtime: runtime(), now: () => now,
    getAccessToken: () => new Promise(() => {}), fetch: async () => { calls++; throw Error("must not call") } })
  const running = budget.checkOptionalWork({}, { ...context(), signal: controller.signal })
  await Promise.resolve(); controller.abort()
  assert.equal((await running).allowed, false); assert.equal(calls, 0)
})

test("real recurring entry constructs native budget and Drive publisher without test injection, while retaining activation gates", async () => {
  let calls = 0
  const current = Date.now()
  const enabled = { ...runtime(), STORAGE_MEDIA_BACKUP_RECURRING_ENABLED: "1", STORAGE_MEDIA_BACKUP_RECURRING_ACTIVATED_AT: new Date(current - 60_000).toISOString(),
    GOOGLE_DRIVE_BACKUP_FOLDER_ID: "synthetic-parent-folder" }
  const fetch = async url => { calls++; assert.equal(new URL(url).hostname, "metadata.google.internal"); return new Response("synthetic unavailable", { status: 500 }) }
  await assert.rejects(main({ args: ["--execute-recurring-daily"], runtime: enabled, fetch, now: () => current }), /failed during source-inventory/)
  assert.equal(calls, 1, "both native factories constructed successfully before the deliberately unavailable synthetic source")
  calls = 0
  await assert.rejects(main({ args: ["--execute-recurring-daily"], runtime: { ...enabled, STORAGE_MEDIA_BACKUP_RECURRING_ENABLED: "0" }, fetch, now: () => current }))
  await assert.rejects(main({ args: ["--execute-recurring-daily"], runtime: { ...enabled, STORAGE_MEDIA_BACKUP_BUDGET_CONFIG_JSON: "" }, fetch, now: () => current }))
  assert.equal(calls, 0, "missing activation or verified configuration cannot reach provider IO")
})

test("real recurring entry retains explicit publisher/budget injection for synthetic integration", async () => {
  let calls = 0
  const current = Date.now()
  await assert.rejects(main({ args: ["--execute-recurring-daily"], runtime: { CLOUD_RUN_JOB: pinned.googleJob,
    STORAGE_MEDIA_BACKUP_RECURRING_ENABLED: "1", GOOGLE_DRIVE_BACKUP_FOLDER_ID: "synthetic-parent-folder" },
    publisher: { publishHealth() {}, publishAttempt() {} }, budget: { checkOptionalWork() {} }, now: () => current,
    fetch: async () => { calls++; return new Response("synthetic unavailable", { status: 500 }) } }), /failed during source-inventory/)
  assert.equal(calls, 1)
})
