import "server-only"
import { fcunoConnectionPolicy } from "@/config/fcunoConnections"
import type { HealthCheck } from "@/lib/systemHealth"

const target = fcunoConnectionPolicy.ecosystem.backupMonitor
const HOUR = 3_600_000
const MAX_CAPTURE_AGE = 30 * HOUR // Allow the observed GitHub scheduling delay.
const MAX_RUN_AGE = 90 * 60_000 // 50-minute job limit plus queue/runner grace.
const API_ROOT = `https://api.github.com/repos/${target.repository}`
const MAX_BODY_BYTES = 1_000_000
const MAX_SUCCESS_CANDIDATES = 3
const MAX_FAILURE_CANDIDATES = 3
type Json = Record<string, unknown>
export type BackupRun = {
  id: number
  attempt: number
  createdAt: number
  completedAt: number | null
  status: string
  conclusion: string | null
  capture: "verified" | "skipped" | "failed" | "unverified"
  capturedAt: number | null
  maintenance?: "healthy" | "attention"
}
export type BackupObservation = {
  checkedAt: string
  workflowActive: boolean
  runs: BackupRun[]
}

function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid GitHub evidence")
  return value as Json
}
function positiveInt(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error("Invalid GitHub identifier")
  return value as number
}
function timestamp(value: unknown, now: number): number {
  const time = typeof value === "string" ? Date.parse(value) : NaN
  if (!Number.isFinite(time) || time > now + 5 * 60_000) throw new Error("Invalid GitHub timestamp")
  return time
}
function repository(value: unknown) {
  const repo = object(value)
  if (repo.id !== target.repositoryId || repo.full_name !== target.repository || object(repo.owner).id !== target.ownerId) {
    throw new Error("GitHub repository identity mismatch")
  }
}

// Only fixed public GitHub URLs are used. No FCUNO or ECO token is sent, and no
// log, artifact, backup document or database content is downloaded.
async function githubJson(path: string, fetcher: typeof fetch): Promise<Json> {
  const response = await fetcher(`${API_ROOT}${path}`, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000),
  })
  if (response.status !== 200) {
    await response.body?.cancel()
    throw new Error(`GitHub status unavailable (${response.status})`)
  }
  if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES || !response.body) {
    await response.body?.cancel()
    throw new Error("GitHub evidence exceeded its size limit")
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) throw new Error("GitHub evidence exceeded its size limit")
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return object(JSON.parse(Buffer.concat(chunks).toString("utf8")))
}

function parseRun(value: unknown, now: number): BackupRun {
  const run = object(value)
  repository(run.repository)
  if (run.workflow_id !== target.workflowId || run.path !== target.workflowPath || run.head_branch !== target.branch ||
      !["schedule", "workflow_dispatch"].includes(String(run.event)) ||
      !["completed", "queued", "in_progress", "waiting", "pending", "requested"].includes(String(run.status))) {
    throw new Error("GitHub workflow identity or state mismatch")
  }
  if (run.conclusion !== null && !["success", "failure", "cancelled", "skipped", "timed_out", "action_required", "neutral", "stale"].includes(String(run.conclusion))) {
    throw new Error("Invalid GitHub conclusion")
  }
  if ((run.status === "completed") !== (run.conclusion !== null)) throw new Error("Incomplete GitHub run state")
  const createdAt = timestamp(run.run_started_at ?? run.created_at, now)
  const completedAt = run.status === "completed" ? timestamp(run.updated_at, now) : null
  if (completedAt !== null && completedAt < createdAt) throw new Error("Invalid attempt chronology")
  return {
    id: positiveInt(run.id), attempt: positiveInt(run.run_attempt), createdAt, completedAt,
    status: String(run.status), conclusion: run.conclusion as string | null,
    capture: "unverified", capturedAt: null,
  }
}

async function inspectCapture(run: BackupRun, now: number, fetcher: typeof fetch): Promise<BackupRun> {
  const result = await githubJson(`/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=20`, fetcher)
  if (!Array.isArray(result.jobs) || result.jobs.length > 20 || result.total_count !== result.jobs.length) {
    throw new Error("Incomplete GitHub job evidence")
  }
  const matches = result.jobs.map(object).filter((job) => job.name === target.jobName)
  if (matches.length === 0 && result.total_count === 0 && run.conclusion !== "success") return run
  if (matches.length !== 1) throw new Error("Expected backup job was not found")
  const job = matches[0]
  if (job.run_id !== run.id || job.run_attempt !== run.attempt || job.head_branch !== target.branch) {
    throw new Error("GitHub job identity mismatch")
  }
  if (job.status !== "completed") throw new Error("Completed workflow has incomplete job evidence")
  // GitHub may leave skipped jobs' timestamps null: the completed run's
  // timestamp still orders this known skip, but can never prove a capture.
  if (job.conclusion === "skipped") return { ...run, capture: "skipped" }
  const completedAt = timestamp(job.completed_at, now)
  if (completedAt < run.createdAt) throw new Error("Invalid job chronology")
  run = { ...run, completedAt }
  if (!Array.isArray(job.steps)) {
    if (run.conclusion !== "success" && job.conclusion === "failure") return run
    throw new Error("Capture evidence was not found")
  }
  const steps = job.steps.map(object)
  const capacities = steps.filter((step) => step.name === target.capacityStepName)
  if (capacities.length > 1) throw new Error("Ambiguous capacity evidence")
  const captures = steps.filter((step) => target.captureStepNames.some((name) => name === step.name))
  if (captures.length > 1) throw new Error("Ambiguous capture evidence")
  if (captures.length !== 1) {
    // Setup/runner failure can happen before GitHub creates the capture step.
    // The failed workflow and exact failed backup job still establish failure.
    if (run.conclusion !== "success" && job.conclusion === "failure") return run
    throw new Error("Expected capture step was not found")
  }
  const capture = captures[0]
  if (capture.conclusion === "skipped") return { ...run, capture: "skipped" }
  if (capture.conclusion === "failure" || capture.conclusion === "cancelled" || capture.conclusion === "timed_out") {
    return { ...run, capture: "failed" }
  }
  const capacity = capacities[0]
  const captureSucceeded = capture.status === "completed" && capture.conclusion === "success"
  const capacityAttention = capacity?.status === "completed" && capacity.conclusion === "failure"
  const solelyCapacityFailure = run.conclusion === "failure" && job.conclusion === "failure" && capacityAttention &&
    steps.every((step) => step === capacity || step.status === "completed" && ["success", "skipped"].includes(String(step.conclusion)))
  const runSucceeded = run.conclusion === "success" && job.conclusion === "success"
  if (captureSucceeded && (runSucceeded || solelyCapacityFailure)) {
    const capturedAt = timestamp(capture.completed_at, now)
    if (capturedAt < run.createdAt || capturedAt > completedAt) throw new Error("Invalid capture chronology")
    if (capacity) {
      if (capacity.status !== "completed" || !["success", "failure"].includes(String(capacity.conclusion)) ||
          (runSucceeded && capacity.conclusion !== "success")) throw new Error("Incomplete capacity evidence")
      const capacityAt = timestamp(capacity.completed_at, now)
      if (capacityAt < capturedAt || capacityAt > completedAt) throw new Error("Invalid capacity chronology")
    }
    // The explicitly pinned post-verification maintenance step can fail after
    // both copies passed full readback. Keep that success distinct from cleanup.
    return { ...run, capture: "verified", capturedAt,
      ...(capacity ? { maintenance: capacityAttention ? "attention" as const : "healthy" as const } : {}) }
  }
  if (run.conclusion === "success") throw new Error("Successful workflow has no verified capture evidence")
  return run
}

export async function readEcoBackupObservation(now = Date.now(), fetcher: typeof fetch = fetch): Promise<BackupObservation> {
  const [repo, workflow, result] = await Promise.all([
    githubJson("", fetcher),
    githubJson(`/actions/workflows/${target.workflowId}`, fetcher),
    githubJson(`/actions/workflows/${target.workflowId}/runs?branch=${target.branch}&per_page=20`, fetcher),
  ])
  repository(repo)
  if (repo.private !== false || repo.archived !== false || workflow.id !== target.workflowId || workflow.path !== target.workflowPath ||
      !["active", "disabled_manually", "disabled_inactivity", "disabled_fork"].includes(String(workflow.state))) {
    throw new Error("GitHub workflow target mismatch")
  }
  if (!Array.isArray(result.workflow_runs) || result.workflow_runs.length > 20) throw new Error("Invalid GitHub run evidence")
  const runs = result.workflow_runs.map((run) => parseRun(run, now)).sort((a, b) => b.createdAt - a.createdAt)
  if (new Set(runs.map((run) => run.id)).size !== runs.length) throw new Error("Duplicate GitHub run evidence")
  const completed = runs.filter((run) => run.status === "completed").sort((a, b) => b.completedAt! - a.completedAt!)
  const candidates = new Set([
    ...completed.slice(0, 1).map((run) => run.id),
    ...completed.filter((run) => run.conclusion === "success").slice(0, MAX_SUCCESS_CANDIDATES).map((run) => run.id),
    // A verified capture with maintenance attention has an overall failure.
    // Keep its evidence available when a later genuine capture failure occurs.
    ...completed.filter((run) => run.conclusion === "failure").slice(0, MAX_FAILURE_CANDIDATES).map((run) => run.id),
  ])
  const invalid = new Set<number>()
  const inspected = await Promise.all(runs.map(async (run) => {
    if (!candidates.has(run.id)) return run
    try { return await inspectCapture(run, now, fetcher) }
    catch { invalid.add(run.id); return run }
  }))
  const newestVerified = inspected.filter((run) => run.capture === "verified")
    .sort((a, b) => b.completedAt! - a.completedAt!)[0]
  // A retired historical step name cannot invalidate a newer verified run.
  // Unverified current/newer evidence still prevents reporting recovery.
  if (completed[0] && invalid.has(completed[0].id) || inspected.some((run) => invalid.has(run.id) &&
      (!newestVerified || run.completedAt! >= newestVerified.completedAt!))) {
    throw new Error("Current backup capture evidence could not be verified")
  }
  return { checkedAt: new Date(now).toISOString(), workflowActive: workflow.state === "active", runs: inspected }
}

function check(id: string, status: HealthCheck["status"], message: string, checkedAt: string, details: NonNullable<HealthCheck["details"]> = {}): HealthCheck {
  return { id, label: id === "eco-backup-monitor" ? "ECO BACKUP MONITOR" : id === "eco-backup-capacity" ? "ECO BACKUP STORAGE" : "ECO NIGHTLY BACKUP", status, message, checkedAt, details }
}

export function unknownEcoBackupChecks(now = Date.now()): HealthCheck[] {
  const checkedAt = new Date(now).toISOString()
  return [
    check("eco-nightly-backup", "ok", "Backup status has not been verified.", checkedAt, { incidentResolved: false, notificationEligible: false }),
    check("eco-backup-monitor", "warning", "ECO backup status cannot currently be checked. This does not establish that the backup failed.", checkedAt,
      { alertLevel: 1, action: "Check the public backup workflow and monitor availability. An earlier backup warning remains unresolved." }),
    check("eco-backup-capacity", "ok", "Storage maintenance status has not been verified.", checkedAt, { incidentResolved: false, notificationEligible: false }),
  ]
}

export function evaluateEcoBackup(observation: BackupObservation): HealthCheck[] {
  const now = Date.parse(observation.checkedAt)
  const runs = [...observation.runs].sort((a, b) => b.createdAt - a.createdAt)
  const successes = runs.filter((run) => run.capture === "verified" && run.capturedAt !== null)
    .sort((a, b) => b.capturedAt! - a.capturedAt!)
  const success = successes[0]
  const lastSuccess = success?.capturedAt ?? null
  const latestCompleted = runs.filter((run) => run.status === "completed").sort((a, b) => b.completedAt! - a.completedAt!)[0]
  const latest = runs[0]
  const laterFailure = latestCompleted && (!success || latestCompleted.completedAt! > success.completedAt!) &&
    (latestCompleted.conclusion !== "success" || latestCompleted.capture === "skipped" || latestCompleted.capture === "failed")
  const stale = lastSuccess === null || now - lastSuccess >= MAX_CAPTURE_AGE
  let message = "A recent verified backup run was confirmed, including its successful capture step."
  let warning = false
  if (!observation.workflowActive) {
    warning = true; message = "ECO's scheduled backup workflow is disabled."
  } else if (laterFailure) {
    warning = true
    message = latestCompleted.capture === "skipped" || latestCompleted.conclusion === "skipped"
      ? "ECO's latest backup was skipped; no completed capture was confirmed for that run."
      : "ECO's latest completed backup run was unsuccessful. Check its run details before relying on it."
  } else if (latest && latest.status !== "completed" && now - latest.createdAt >= MAX_RUN_AGE) {
    warning = true; message = "ECO's backup run has not completed within 90 minutes."
  } else if (stale) {
    warning = true; message = "No verified ECO backup run was confirmed in the past 30 hours."
  }
  // Incomplete evidence never closes an existing incident, even if an older
  // successful run is still within the daily freshness window.
  const pending = latest?.status !== "completed" || latestCompleted?.capture === "unverified"
  const severity = warning && lastSuccess !== null && now - lastSuccess >= 48 * HOUR ? 2 : 1
  return [
    check("eco-nightly-backup", warning ? (severity === 2 ? "error" : "warning") : "ok", message, observation.checkedAt, {
      alertLevel: severity, incidentResolved: !warning && !pending,
      notificationEligible: warning, lastSuccessfulRunAt: lastSuccess === null ? null : new Date(lastSuccess).toISOString(),
      action: "Review the ECO nightly backup workflow. A successful run is capture evidence; it is not a restoration test.",
    }),
    check("eco-backup-monitor", "ok", "Public backup workflow status was checked.", observation.checkedAt),
    check("eco-backup-capacity", success?.maintenance === "attention" ? "warning" : "ok",
      success?.maintenance === "attention"
        ? "ECO's backup copies passed verification, but storage capacity or retention needs attention. This is not a failed backup capture."
        : success?.maintenance === "healthy" ? "Backup storage and retention checks passed." : "Storage maintenance status has not been verified.",
      observation.checkedAt, {
        alertLevel: 1, notificationEligible: success?.maintenance === "attention",
        incidentResolved: success?.maintenance === "healthy" && !warning && !pending,
        action: "Review the private capacity and retention report. Resolve low space or incomplete cleanup before it prevents a future backup.",
      }),
  ]
}

export function buildEcoBackupAlertHtml(checks: HealthCheck[], checkedAt: string): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!)
  const display = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) + " HKT"
    : "Not verified"
  return `<div style="font-family:Arial,sans-serif;color:#10243a;background:#fff;line-height:1.5;max-width:640px;padding:16px;overflow-wrap:anywhere">
    <h2>ECO BACKUP NEEDS ATTENTION</h2><p>Checked at ${escape(display(checkedAt))}.</p>
    ${checks.map((item) => `<p><strong>${escape(item.label)}</strong><br>${escape(item.message)}</p>
      ${item.id === "eco-nightly-backup" ? `<p>Last verified backup run: ${escape(display(item.details?.lastSuccessfulRunAt))}.</p>` : ""}
      <p>${escape(String(item.details?.action ?? "Review the backup workflow."))}</p>`).join("")}
    <p><a href="https://github.com/${target.repository}/actions/workflows/${target.workflowPath.split("/").pop()}">VIEW ECO BACKUP RUNS</a></p>
    <p>This check runs independently of the backup scheduler. Unchanged incidents are not repeatedly emailed; a verified recovery re-arms the next alert.</p></div>`
}
