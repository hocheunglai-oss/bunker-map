import type { HealthCheck } from "@/lib/systemHealth"
import { fcunoConnectionPolicy } from "@/config/fcunoConnections"

export type HealthAlertObservation = {
  check_id: string
  // null preserves an incident while a result is pending or deliberately muted.
  alert_level: number | null
  observed_at: string
}

export function healthAlertObservation(check: HealthCheck, muted: boolean): HealthAlertObservation {
  const resolved = check.status === "ok" && check.details?.incidentResolved !== false
  const eligible = !muted && check.details?.notificationEligible !== false
  const explicitLevel = check.details?.alertLevel
  const level = explicitLevel === 1 || explicitLevel === 2 ? explicitLevel : check.status === "error" ? 2 : 1
  return {
    check_id: check.id,
    alert_level: resolved ? 0 : !eligible || check.status === "ok" ? null
      : level,
    observed_at: check.checkedAt,
  }
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

function displayTime(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "Not verified"
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short",
  }).format(new Date(value)) + " HKT"
}

export function buildHealthAlertHtml(checks: HealthCheck[], checkedAt: string) {
  const rows = checks.map((check) => {
    const details = check.details || {}
    const isDrive = check.id === "drive-file-content-backup"
    const affected = details.missingFileNames
    const action = details.action || "Open System Health to review the issue and its technical details."
    return `<div style="padding:12px 0;border-bottom:1px solid #dbe8f2">
      <p style="margin:0 0 4px;font-weight:700">${escapeHtml(check.label)}: ${check.status.toUpperCase()}</p>
      <p>${escapeHtml(check.message)}</p>
      ${isDrive ? `<p>Last successful backup: ${escapeHtml(displayTime(details.lastSuccessfulBackupAt))}</p>` : ""}
      ${affected ? `<p>Affected files: ${escapeHtml(String(affected))}</p>` : ""}
      <p>Next step: ${escapeHtml(String(action))}</p>
    </div>`
  }).join("")
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#10243a;line-height:1.45">
    <h2>FC Uno System Health Alert</h2>
    <p>Checked at ${escapeHtml(displayTime(checkedAt))}</p>
    ${rows}
    <p>This issue will remain on the dashboard. We will not email the same warning again unless it escalates, or is resolved and later returns.</p>
    <p><a href="${fcunoConnectionPolicy.vercel.productionOrigins[0]}/admin/systemhealth">Open System Health</a></p>
  </div>`
}

export type HealthAlertStore = {
  claim(observations: HealthAlertObservation[], token: string): Promise<string[]>
  finish(token: string, delivered: boolean): Promise<void>
}

// Delivery is acknowledged only after SMTP accepts the message. A crash between
// SMTP acceptance and acknowledgement can still cause a retry: SMTP does not
// provide a transactional/idempotent send API. The database lease prevents
// concurrent cron/manual checks from sending the same incident together.
export async function deliverHealthAlerts(input: {
  checks: HealthCheck[]
  muted: (check: HealthCheck) => boolean
  token: string
  store: HealthAlertStore
  send: (checks: HealthCheck[]) => Promise<void>
}) {
  const ids = await input.store.claim(
    input.checks.map((check) => healthAlertObservation(check, input.muted(check))), input.token,
  )
  const claimed = new Set(ids)
  const checks = input.checks.filter((check) => claimed.has(check.id))
  if (!checks.length) return checks
  try {
    await input.send(checks)
  } catch (error) {
    // Release failed sends for the next run without marking them notified.
    await input.store.finish(input.token, false).catch(() => undefined)
    throw error
  }
  // Do not release a lease if this acknowledgement fails: preserve the lease
  // for its full duration after an ambiguous delivery outcome.
  await input.store.finish(input.token, true)
  return checks
}
