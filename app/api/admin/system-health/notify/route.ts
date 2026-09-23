import { NextResponse } from "next/server"
import { randomUUID } from "node:crypto"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { normalizeEmailList, sendCalendarEmail } from "@/lib/eventCalendarEmail"
import { getErrorMessage, getSystemHealth, type HealthCheck } from "@/lib/systemHealth"
import { buildHealthAlertHtml, deliverHealthAlerts } from "@/lib/systemHealthAlerts"
import { createHealthAlertStore } from "@/lib/systemHealthAlertStore"

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
  if (NON_ALERTING_CHECK_IDS.has(check.id)) return true
  if (check.id === "backup" && check.status === "warning") return true
  return check.id === "drive-file-content-backup" && check.details?.firstBackupMissing === true
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
    const health = await getSystemHealth()
    const recipients = normalizeEmailList(
      process.env.SYSTEM_HEALTH_EMAIL_RECIPIENTS ||
      process.env.EVENT_CALENDAR_EMAIL_RECIPIENTS
    )

    if (!recipients.length) {
      throw new Error("SYSTEM_HEALTH_EMAIL_RECIPIENTS or EVENT_CALENDAR_EMAIL_RECIPIENTS is not configured.")
    }
    // Each recipient has independent delivery state: one rejected mailbox must
    // not cause duplicates for colleagues or permanently miss its own alert.
    const deliveries = await Promise.allSettled(recipients.map((recipient) => deliverHealthAlerts({
      checks: health.checks,
      muted: isNonAlertingCheck,
      token: randomUUID(),
      store: createHealthAlertStore(recipient),
      async send(checks) {
        const status = checks.some((check) => check.status === "error") ? "ERROR" : "WARNING"
        const result = await sendCalendarEmail({
          to: [recipient],
          subject: `***** FC Uno System Health ${status}`,
          html: buildHealthAlertHtml(checks, health.checkedAt),
        })
        if (!result.accepted.length) throw new Error("No System Health email recipients were accepted.")
      },
    })))
    const failed = deliveries.find((delivery) => delivery.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
    const notifiedChecks = [...new Map(deliveries.flatMap((delivery) =>
      delivery.status === "fulfilled" ? delivery.value.map((check) => [check.id, check] as const) : [],
    )).values()]

    return NextResponse.json({
      success: true,
      sent: notifiedChecks.length > 0,
      status: health.status,
      checkedAt: health.checkedAt,
      recipients: recipients.length,
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
