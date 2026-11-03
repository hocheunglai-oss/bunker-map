import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { fcunoConnectionPolicy } from "../config/fcunoConnections"
import { buildEcoBackupAlertHtml, evaluateEcoBackup, readEcoBackupObservation, unknownEcoBackupChecks, type BackupRun } from "../lib/ecoBackupWatchdog"
import { handleEcoBackupWatchdog } from "../lib/ecoBackupWatchdogDelivery"
import { healthAlertObservation, type HealthAlertStore } from "../lib/systemHealthAlerts"

const target = fcunoConnectionPolicy.ecosystem.backupMonitor
const now = Date.parse("2026-11-03T01:00:00Z") // 09:00 HKT, after today's deadline.
const checkedAt = new Date(now).toISOString()
const current = Date.parse("2026-11-02T18:30:00Z")
const run = (extra: Partial<BackupRun> = {}): BackupRun => ({
  id: 100, attempt: 1, createdAt: current - 10_000, completedAt: current + 1_000, status: "completed", conclusion: "success",
  capture: "verified", capturedAt: current, ...extra,
})
const evaluate = (runs: BackupRun[], workflowActive = true, at = checkedAt) => evaluateEcoBackup({ checkedAt: at, workflowActive, runs })
const level = (check: ReturnType<typeof evaluate>[number]) => healthAlertObservation(check, false).alert_level

test("fresh verified capture resolves; 30-hour age allows scheduling delay and 48 hours escalates once", () => {
  assert.equal(level(evaluate([run()])[0]), 0)
  const old = run({ createdAt: current - 24 * 3_600_000 - 10_000, capturedAt: current - 24 * 3_600_000 })
  assert.equal(level(evaluate([old])[0]), 1)
  assert.equal(level(evaluate([old], true, "2026-11-03T00:29:59Z")[0]), 0, "allow observed GitHub delay up to 30 hours")
  assert.equal(level(evaluate([old], true, "2026-11-03T00:30:00Z")[0]), 1, "30-hour deadline is inclusive")
  assert.equal(level(evaluate([run({ createdAt: current - 49 * 3_600_000, capturedAt: current - 49 * 3_600_000 })])[0]), 2)
})

test("successful workflow with skipped capture is not backup success; failures, disabled and stalled runs alert", () => {
  assert.match(evaluate([run({ capture: "skipped", capturedAt: null })])[0].message, /skipped/)
  assert.equal(level(evaluate([run({ capture: "skipped", capturedAt: null })])[0]), 1)
  assert.equal(level(evaluate([run({ conclusion: "failure", capture: "failed", capturedAt: null })])[0]), 1)
  assert.equal(level(evaluate([run()], false)[0]), 1)
  assert.match(evaluate([run({ status: "in_progress", conclusion: null, capturedAt: null, capture: "unverified" })])[0].message, /90 minutes/)
})

test("pending and unknown observations preserve incidents; a newer failed run outweighs an earlier success", () => {
  const pending = run({ id: 101, createdAt: now - 60_000, status: "in_progress", conclusion: null, capturedAt: null, capture: "unverified" })
  assert.equal(level(evaluate([pending, run()])[0]), null)
  const failed = run({ id: 102, createdAt: now - 120_000, completedAt: now - 60_000, conclusion: "failure", capture: "failed", capturedAt: null })
  assert.equal(level(evaluate([pending, failed, run()])[0]), 1)
  const unknown = unknownEcoBackupChecks(now)
  assert.equal(level(unknown[0]), null)
  assert.equal(level(unknown[1]), 1)
  assert.match(unknown[1].message, /does not establish/)
})

test("a rerun that completes after another failure recovers regardless of original run ID or creation order", () => {
  const failed = run({ id: 200, createdAt: now - 120_000, completedAt: now - 60_000, conclusion: "failure", capture: "failed", capturedAt: null })
  const retried = run({ id: 99, attempt: 2, createdAt: now - 180_000, completedAt: now - 1_000, capturedAt: now - 2_000 })
  assert.equal(level(evaluate([failed, retried])[0]), 0)
  const laterFailure = { ...failed, completedAt: now }
  assert.equal(level(evaluate([retried, laterFailure])[0]), 1)
})

function apiFixture(change?: (path: string, data: Record<string, unknown>) => unknown) {
  const paths: string[] = []
  const repo = { id: target.repositoryId, full_name: target.repository, owner: { id: target.ownerId }, private: false, archived: false }
  const fetcher = (async (url: string | URL | Request, options?: RequestInit) => {
    const parsed = new URL(String(url))
    assert.equal(parsed.origin, "https://api.github.com")
    assert.equal(options?.redirect, "error")
    assert.equal(new Headers(options?.headers).has("authorization"), false)
    assert.equal(options?.cache, "no-store")
    assert.ok(options?.signal)
    const path = parsed.pathname.replace(`/repos/${target.repository}`, "") + parsed.search
    paths.push(path)
    let data: Record<string, unknown>
    if (path === "") data = repo
    else if (path === `/actions/workflows/${target.workflowId}`) data = { id: target.workflowId, path: target.workflowPath, state: "active" }
    else if (path.includes("/runs?")) data = { total_count: 1, workflow_runs: [{
      id: 100, run_attempt: 1, workflow_id: target.workflowId, path: target.workflowPath, repository: repo,
      head_branch: target.branch, event: "schedule", created_at: new Date(current - 10_000).toISOString(),
      run_started_at: new Date(current - 10_000).toISOString(), updated_at: new Date(current + 1_000).toISOString(), status: "completed", conclusion: "success",
    }] }
    else if (path === "/actions/runs/100/attempts/1/jobs?per_page=20") data = { total_count: 1, jobs: [{
      name: target.jobName, run_id: 100, run_attempt: 1, head_branch: target.branch, status: "completed", conclusion: "success", completed_at: new Date(current + 1_000).toISOString(),
      steps: [{ name: target.captureStepNames[0], status: "completed", conclusion: "success", completed_at: new Date(current).toISOString() }],
    }] }
    else assert.fail(`Unexpected endpoint ${path}`)
    const changed = change?.(path, data) ?? data
    return changed instanceof Response ? changed : Response.json(changed)
  }) as typeof fetch
  return { fetcher, paths }
}

test("public evidence validates repository, workflow, branch, attempt and actual capture step", async () => {
  const fixture = apiFixture()
  const result = await readEcoBackupObservation(now, fixture.fetcher)
  assert.equal(result.runs[0].capture, "verified")
  assert.equal(fixture.paths.length, 4)
  assert.ok(fixture.paths.every((path) => !/logs|artifacts|rerun|cancel/.test(path)))
  for (const corrupt of [
    (path: string, data: Record<string, unknown>) => path === "" ? { ...data, id: 999 } : data,
    (path: string, data: Record<string, unknown>) => path.includes("workflows/") && !path.includes("runs?") ? { ...data, id: 999 } : data,
    (path: string, data: Record<string, unknown>) => path.includes("jobs?") ? { ...data, total_count: 2 } : data,
    (path: string, data: Record<string, unknown>) => path.includes("jobs?") ? { ...data, jobs: [{ name: "other" }] } : data,
  ]) await assert.rejects(readEcoBackupObservation(now, apiFixture(corrupt).fetcher))
})

test("skipped backup job cannot masquerade as a successful workflow; renamed steps and HTTP failures remain unknown", async () => {
  const skipped = apiFixture((path, data) => path.includes("jobs?") ? {
    ...data, jobs: [{ name: target.jobName, run_id: 100, run_attempt: 1, head_branch: target.branch, status: "completed", conclusion: "skipped", completed_at: null, steps: [] }],
  } : data)
  assert.equal((await readEcoBackupObservation(now, skipped.fetcher)).runs[0].capture, "skipped")
  for (const status of [403, 429, 503]) {
    await assert.rejects(readEcoBackupObservation(now, apiFixture(() => new Response("unavailable", { status })).fetcher), /unavailable/)
  }
  await assert.rejects(readEcoBackupObservation(now, apiFixture(() => new Response("{}", { headers: { "content-length": "1000001" } })).fetcher), /size limit/)
})

test("current-attempt start is used for reruns and retired older step contracts cannot invalidate a fresh verified run", async () => {
  const rerun = apiFixture((path, data) => {
    if (!path.includes("/runs?")) return data
    const original = (data.workflow_runs as Record<string, unknown>[])[0]
    return { ...data, workflow_runs: [{ ...original, created_at: "2026-10-01T00:00:00Z" }] }
  })
  assert.equal((await readEcoBackupObservation(now, rerun.fetcher)).runs[0].createdAt, current - 10_000)
  const historical = apiFixture((path, data) => {
    if (!path.includes("/runs?")) return data
    const original = (data.workflow_runs as Record<string, unknown>[])[0]
    return { ...data, total_count: 2, workflow_runs: [original, { ...original, id: 99,
      created_at: "2026-10-01T00:00:00Z", run_started_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:05:00Z" }] }
  })
  const observation = await readEcoBackupObservation(now, historical.fetcher)
  assert.equal(level(evaluateEcoBackup(observation)[0]), 0)
  const badCurrent = apiFixture((path, data) => path.includes("jobs?") ? { ...data, jobs: [{
    name: target.jobName, run_id: 100, run_attempt: 1, head_branch: target.branch, status: "completed", conclusion: "success",
    completed_at: new Date(current + 1_000).toISOString(), steps: [{ name: "unrecognized capture", status: "completed", conclusion: "success" }],
  }] } : data)
  await assert.rejects(readEcoBackupObservation(now, badCurrent.fetcher), /could not be verified/)
})

test("confirmed job setup failure remains a backup failure even before a capture step exists", async () => {
  const fixture = apiFixture((path, data) => {
    if (path.includes("/runs?")) return { ...data, workflow_runs: (data.workflow_runs as Record<string, unknown>[]).map((value) => ({ ...value, conclusion: "failure" })) }
    if (path.includes("jobs?")) return { ...data, jobs: (data.jobs as Record<string, unknown>[]).map((value) => ({ ...value, conclusion: "failure", steps: [] })) }
    return data
  })
  const checks = evaluateEcoBackup(await readEcoBackupObservation(now, fixture.fetcher))
  assert.equal(level(checks[0]), 1)
  assert.match(checks[0].message, /unsuccessful/)
  assert.equal(level(checks[1]), 0)
})

test("workflow cancelled before allocating any job is a known unsuccessful backup run", async () => {
  const fixture = apiFixture((path, data) => {
    if (path.includes("/runs?")) return { ...data, workflow_runs: (data.workflow_runs as Record<string, unknown>[]).map((value) => ({ ...value, conclusion: "cancelled" })) }
    if (path.includes("jobs?")) return { total_count: 0, jobs: [] }
    return data
  })
  const checks = evaluateEcoBackup(await readEcoBackupObservation(now, fixture.fetcher))
  assert.equal(level(checks[0]), 1)
  assert.match(checks[0].message, /unsuccessful/)
  assert.equal(level(checks[1]), 0)
})

test("both reviewed capture versions work; ambiguous duplicate captures fail closed", async () => {
  for (const captureName of target.captureStepNames) {
    const fixture = apiFixture((path, data) => path.includes("jobs?") ? { ...data, jobs: (data.jobs as Record<string, unknown>[]).map((job) => ({ ...job,
      steps: (job.steps as Record<string, unknown>[]).map((step) => ({ ...step, name: captureName })),
    })) } : data)
    assert.equal((await readEcoBackupObservation(now, fixture.fetcher)).runs[0].capture, "verified")
  }
  const duplicate = apiFixture((path, data) => path.includes("jobs?") ? { ...data, jobs: (data.jobs as Record<string, unknown>[]).map((job) => ({ ...job,
    steps: target.captureStepNames.map((name) => ({ ...(job.steps as Record<string, unknown>[])[0], name })),
  })) } : data)
  await assert.rejects(readEcoBackupObservation(now, duplicate.fetcher), /could not be verified/)
})

const request = (authorization = "Bearer synthetic-cron") => new Request("https://example.invalid/api/cron/eco-backup-watchdog?to=attacker@example.invalid", { headers: { authorization } })
function dependencies() {
  const events: string[] = []
  const sent: Array<{ to: string[]; subject: string; html: string }> = []
  const deps = {
    environment: "production", enabled: "true", cronSecret: "synthetic-cron", recipient: "owner@example.invalid",
    read: async () => ({ checkedAt, workflowActive: true, runs: [run({ conclusion: "failure", capture: "failed", capturedAt: null })] }),
    store: (recipient: string): HealthAlertStore => {
      assert.equal(recipient, "owner@example.invalid")
      return { claim: async () => { events.push("claim"); return ["eco-nightly-backup"] },
        finish: async (_, delivered) => { events.push(`finish:${delivered}`) } }
    },
    send: async (message: { to: string[]; subject: string; html: string }) => { events.push("send"); sent.push(message); return { accepted: message.to, rejected: [] as string[] } },
    now: () => now,
  }
  return { deps, events, sent }
}

test("only authenticated production cron with explicit enablement and one configured recipient can deliver", async () => {
  for (const [overrides, auth, expected] of [
    [{}, "", 401], [{ cronSecret: undefined }, "", 401], [{ environment: "preview" }, "Bearer synthetic-cron", 403],
    [{ enabled: "false" }, "Bearer synthetic-cron", 200], [{ recipient: "" }, "Bearer synthetic-cron", 503],
    [{ recipient: "one@example.invalid,two@example.invalid" }, "Bearer synthetic-cron", 503],
    [{ recipient: "one@example.invalid\r\nBcc:two@example.invalid" }, "Bearer synthetic-cron", 503],
  ] as const) {
    const { deps, events } = dependencies()
    deps.read = async () => assert.fail("unauthorized read")
    assert.equal((await handleEcoBackupWatchdog(request(auth), { ...deps, ...overrides })).status, expected)
    assert.deepEqual(events, [])
  }
  const { deps, events, sent } = dependencies()
  assert.equal((await handleEcoBackupWatchdog(request(), deps)).status, 200)
  assert.deepEqual(sent[0].to, ["owner@example.invalid"])
  assert.deepEqual(events, ["claim", "send", "finish:true"])
})

test("unaccepted mail releases claim; broken store never sends; duplicate incident never sends", async () => {
  const rejected = dependencies()
  rejected.deps.send = async () => ({ accepted: [], rejected: ["owner@example.invalid"] })
  assert.equal((await handleEcoBackupWatchdog(request(), rejected.deps)).status, 503)
  assert.deepEqual(rejected.events, ["claim", "finish:false"])
  const broken = dependencies()
  broken.deps.store = () => ({ claim: async () => { throw new Error("private provider diagnostic") }, finish: async () => {} })
  const response = await handleEcoBackupWatchdog(request(), broken.deps)
  assert.equal(response.status, 503)
  assert.doesNotMatch(await response.text(), /private provider/)
  assert.equal(broken.sent.length, 0)
  const duplicate = dependencies()
  duplicate.deps.store = () => ({ claim: async () => [], finish: async () => assert.fail("unclaimed finish") })
  await handleEcoBackupWatchdog(request(), duplicate.deps)
  assert.equal(duplicate.sent.length, 0)
})

test("GitHub unavailable produces separate monitor incident and never resolves backup warning", async () => {
  const { deps, sent } = dependencies()
  deps.read = async () => { throw new Error("GitHub unavailable") }
  deps.store = () => ({ claim: async (observations) => {
    assert.equal(observations.find((item) => item.check_id === "eco-nightly-backup")?.alert_level, null)
    return ["eco-backup-monitor"]
  }, finish: async () => {} })
  assert.equal((await handleEcoBackupWatchdog(request(), deps)).status, 502)
  assert.match(sent[0].html, /does not establish that the backup failed/)
})

test("watchdog has fixed source boundaries, own lightweight schedule, and escaped concise mail", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"))
  assert.equal(config.crons.find((item: { path: string }) => item.path === "/api/cron/eco-backup-watchdog").schedule, "7,37 * * * *")
  assert.equal(config.crons.find((item: { path: string }) => item.path === "/api/admin/system-health/notify").schedule, "30 0 * * *")
  const source = readFileSync(new URL("../app/api/cron/eco-backup-watchdog/route.ts", import.meta.url), "utf8")
  assert.doesNotMatch(source, /getSystemHealth|NEXT_PUBLIC_|request\.json|request\.url/)
  assert.match(source, /ECO_BACKUP_ALERT_RECIPIENT/)
  const checks = evaluate([run({ conclusion: "failure", capture: "failed", capturedAt: null })])
  checks[0].message = "<script>not markup</script>"
  const html = buildEcoBackupAlertHtml(checks, checkedAt)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /<script>|@cosulich/)
  assert.match(html, /ECO BACKUP NEEDS ATTENTION/)
})
