import React from "react"
import { createRoot } from "react-dom/client"
import Page from "../../app/admin/systemhealth/page"
import { AdminNavigationShell } from "../../components/AdminNavigationShell"
import { ADMIN_PAGE_DEFINITIONS } from "../../lib/adminPages"

const states = {
  inactive: { status: "warning", message: "Recurring uploaded-file backups are not activated.", details: { recurringActivated: false, protectionUnknown: true, incidentResolved: false, notificationEligible: false, action: "Finish activation and verify the first cloud backup before relying on recurring protection." } },
  pending: { status: "warning", message: "2 new or changed uploaded file(s) are waiting for the next overnight backup.", details: { activeFiles: 15, coveredFiles: 13, pendingFiles: 2, backupDeadline: "2026-10-26T22:15:00.000Z", incidentResolved: false, notificationEligible: false, action: "No immediate action is needed. The next overnight backup will be checked automatically." } },
  verified: { status: "ok", message: "Every current uploaded file has a recent verified cloud backup.", details: { activeFiles: 15, coveredFiles: 15, lastSuccessfulBackupAt: "2026-10-25T18:05:00.000Z", backupSchedule: "Daily 02:00 Asia/Hong_Kong; retries until 06:00; publication grace until 06:15", retentionMode: "dry-run", retentionDeletionsEnabled: false, budgetState: "normal", budgetLimitUsd: 10, budgetProjectedUsd: null, action: "No immediate action is needed. The next overnight backup will be checked automatically." } },
  paused: { status: "warning", message: "Optional uploaded-file backup work is paused for the cloud budget. Existing copies are preserved.", details: { activeFiles: 15, coveredFiles: 15, budgetState: "paused", budgetLimitUsd: 10, budgetProjectedUsd: 9.9, notificationEligible: false, incidentResolved: false, action: "Review the cloud budget pause. Existing copies are preserved, but optional backup work is paused." } },
  overdue: { status: "error", message: "2 uploaded file(s) still need a verified backup after the deadline.", details: { activeFiles: 15, coveredFiles: 13, missingFiles: 2, lastSuccessfulBackupAt: "2026-10-23T18:05:00.000Z", notificationEligible: true, alertLevel: 2, incidentResolved: false, action: "Open System Health and arrange a verified uploaded-file backup." } },
  unknown: { status: "warning", message: "Uploaded-file backup protection could not be checked. It has not been marked as recovered.", details: { protectionUnknown: true, notificationEligible: false, incidentResolved: false, action: "Open System Health to check backup access and try the check again." } },
}
const harness = {
  mode: "inactive" as keyof typeof states, routes: [] as string[], reads: 0,
  auth: { loading: false, authenticated: true, role: "USER", permissions: { "system-health": "view" },
    username: "synthetic@example.invalid", displayName: "Synthetic Viewer", actorKey: "a".repeat(64), pages: ADMIN_PAGE_DEFINITIONS },
  render: () => {},
}
declare global { interface Window { __storageMediaHealthHarness: typeof harness } }
window.__storageMediaHealthHarness = harness
window.fetch = async input => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin)
  if (url.origin !== location.origin) throw Error("No external requests in this fixture")
  if (url.pathname === "/api/parser-reports") return Response.json({ readyForUserReview: 0 })
  if (url.pathname !== "/api/admin/system-health") throw Error("Unexpected fixture API")
  harness.reads++
  return Response.json({ status: states[harness.mode].status, checkedAt: "2026-10-26T00:00:00.000Z",
    deployment: { commit: "a".repeat(40), shortCommit: "aaaaaaa", branch: "synthetic", deployedAt: "2026-10-25T00:00:00.000Z", environment: "synthetic" },
    checks: [{ id: "backup", label: "Daily Backup", status: "ok", message: "The database has a recent verified backup.", checkedAt: "2026-10-26T00:00:00.000Z" },
      { id: "storage-media-backup", label: "Uploaded-file Backup", checkedAt: "2026-10-26T00:00:00.000Z", ...states[harness.mode] }],
  })
}
const app = createRoot(document.getElementById("root")!)
harness.render = () => app.render(<div className="fc-admin-scope"><AdminNavigationShell><Page /></AdminNavigationShell></div>)
harness.render()
