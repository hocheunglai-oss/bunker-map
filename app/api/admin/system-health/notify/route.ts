import { NextResponse } from "next/server"
import { randomUUID } from "node:crypto"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { normalizeEmailList, sendCalendarEmail } from "@/lib/eventCalendarEmail"
import { getErrorMessage, getSystemHealth, type HealthCheck } from "@/lib/systemHealth"
import { buildHealthAlertHtml, deliverHealthAlerts } from "@/lib/systemHealthAlerts"
import { createHealthAlertStore } from "@/lib/systemHealthAlertStore"
import { createBackupProtectionGapObserver } from "@/lib/backupProtectionGapStore"
import { listManagedAdminUsers } from "@/lib/adminUsers"
import { deliverPostgresBackupMaintenance, getPostgresBackupMaintenanceRecipients, isPostgresBackupMaintenanceCheck } from "@/lib/postgresBackupMaintenance"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 240

const NON_ALERTING_CHECK_IDS = new Set([
  "attendance-sync",
  "schema",
])

function hasCronAccess(request: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get("authorization") === `Bearer ${secret}`) return true
  return false
}

function isNonAlertingCheck(check: HealthCheck) {
  return NON_ALERTING_CHECK_IDS.has(check.id)
}

export async function GET(request: Request) {
  if (!hasCronAccess(request)) {
    try {
      await requireAdminPagePermission("system-health", "view")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unauthorized"
      return NextResponse.json(
        { message },
        { status: message === "Unauthorized" ? 401 : 403 }
      )
    }
  }

  try {
    const health = await getSystemHealth({ backupGapObserver: createBackupProtectionGapObserver() })
    const recipients = normalizeEmailList(
      process.env.SYSTEM_HEALTH_EMAIL_RECIPIENTS ||
      process.env.EVENT_CALENDAR_EMAIL_RECIPIENTS
    )

    // Do not even observe maintenance incidents in the ordinary staff channel:
    // a muted observation can still resolve/rearm an existing incident.
    const ordinaryChecks = health.checks.filter(check => !isPostgresBackupMaintenanceCheck(check))
    const maintenanceNotified: HealthCheck[] = []
    const maintenanceDelivery = (async () => {
      if (process.env.POSTGRES_BACKUP_SOURCE_ENABLED !== "1") return { recipients: 0, sent: 0 }
      const checks = health.checks.filter(isPostgresBackupMaintenanceCheck)
      if (!checks.some(check => check.id === "postgresql-backup-access-renewal")) {
        throw new Error("Independent backup maintenance health was not available.")
      }
      const configuredRecipients = getPostgresBackupMaintenanceRecipients(process.env)
      // Fetch the canonical directory afresh on each enabled notification run.
      // No JWT metadata, cached role or general staff-list fallback is accepted.
      const accounts = await listManagedAdminUsers()
      return deliverPostgresBackupMaintenance({ checks, accounts, configuredRecipients,
        token: randomUUID, createStore: createHealthAlertStore,
        async send(selectedRecipient, selectedChecks) {
          const result = await sendCalendarEmail({ to: [selectedRecipient], subject: "FC Uno: backup maintenance needed",
            html: buildHealthAlertHtml(selectedChecks, health.checkedAt) })
          if (!result.accepted.length) throw new Error("No backup maintenance email recipient was accepted.")
          maintenanceNotified.push(...selectedChecks)
        },
      })
    })()
    // Each recipient has independent delivery state: one rejected mailbox must
    // not cause duplicates for colleagues or permanently miss its own alert.
    const ordinaryDelivery = (async () => {
      if (!recipients.length) throw new Error("SYSTEM_HEALTH_EMAIL_RECIPIENTS or EVENT_CALENDAR_EMAIL_RECIPIENTS is not configured.")
      const deliveries = await Promise.allSettled(recipients.map((recipient) => deliverHealthAlerts({
        checks: ordinaryChecks,
        muted: isNonAlertingCheck,
        token: randomUUID(),
        store: createHealthAlertStore(recipient),
        async send(checks) {
          const result = await sendCalendarEmail({
            to: [recipient],
            subject: "FC Uno: action needed",
            html: buildHealthAlertHtml(checks, health.checkedAt),
          })
          if (!result.accepted.length) throw new Error("No System Health email recipients were accepted.")
        },
      })))
      const failed = deliveries.find((delivery) => delivery.status === "rejected")
      if (failed?.status === "rejected") throw failed.reason
      return deliveries.flatMap(delivery => delivery.status === "fulfilled" ? delivery.value : [])
    })()
    // A broken independent notification channel must not suppress the other.
    const [ordinary, maintenance] = await Promise.allSettled([ordinaryDelivery, maintenanceDelivery])
    if (ordinary.status === "rejected") throw ordinary.reason
    if (maintenance.status === "rejected") throw maintenance.reason
    const notifiedChecks = [...new Map([...ordinary.value, ...maintenanceNotified].map(check => [check.id, check])).values()]

    return NextResponse.json({
      success: true,
      sent: notifiedChecks.length > 0,
      status: health.status,
      checkedAt: health.checkedAt,
      recipients: recipients.length,
      maintenance: maintenance.value,
      checks: notifiedChecks.map((check) => ({
        id: check.id,
        label: check.label,
        status: check.status,
        message: check.message,
      })),
    })
  } catch (error) {
    return NextResponse.json(
      { message: getErrorMessage(error) },
      { status: 500 }
    )
  }
}
