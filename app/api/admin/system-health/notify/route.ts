import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { normalizeEmailList, sendCalendarEmail } from "@/lib/eventCalendarEmail"
import { getErrorMessage, getSystemHealth, type HealthCheck } from "@/lib/systemHealth"

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

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function formatDetails(details: HealthCheck["details"]) {
  if (!details || Object.keys(details).length === 0) return ""

  const rows = Object.entries(details)
    .filter(([, value]) => value !== null && value !== "")
    .map(([key, value]) => `
      <tr>
        <td style="padding:4px 8px;border-bottom:1px solid #e3edf5;color:#5f7384">${escapeHtml(key)}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #e3edf5">${escapeHtml(String(value))}</td>
      </tr>
    `)
    .join("")

  if (!rows) return ""

  return `
    <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:8px;font-size:12px">
      <tbody>${rows}</tbody>
    </table>
  `
}

function buildAlertHtml(unhealthyChecks: HealthCheck[], checkedAt: string) {
  const rows = unhealthyChecks
    .map((check) => `
      <div style="padding:12px 0;border-bottom:1px solid #dbe8f2">
        <p style="margin:0 0 4px;font-weight:700">${escapeHtml(check.label)}: ${escapeHtml(check.status.toUpperCase())}</p>
        <p style="margin:0;color:#334e68">${escapeHtml(check.message)}</p>
        ${formatDetails(check.details)}
      </div>
    `)
    .join("")

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#10243a;line-height:1.45">
      <h2 style="margin:0 0 10px">FC Uno System Health Alert</h2>
      <p style="margin:0 0 12px;color:#5f7384">Checked at ${escapeHtml(checkedAt)}</p>
      ${rows}
      <p style="margin:14px 0 0">
        <a href="https://fcuno.com/admin/systemhealth" style="color:#0a73c9">Open System Health</a>
      </p>
    </div>
  `
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
    const unhealthyChecks = health.checks.filter((check) => check.status !== "ok" && !isNonAlertingCheck(check))

    if (unhealthyChecks.length === 0) {
      return NextResponse.json({
        success: true,
        sent: false,
        status: health.status,
        checkedAt: health.checkedAt,
      })
    }

    const recipients = normalizeEmailList(
      process.env.SYSTEM_HEALTH_EMAIL_RECIPIENTS ||
      process.env.EVENT_CALENDAR_EMAIL_RECIPIENTS
    )

    if (!recipients.length) {
      return NextResponse.json(
        { message: "SYSTEM_HEALTH_EMAIL_RECIPIENTS or EVENT_CALENDAR_EMAIL_RECIPIENTS is not configured." },
        { status: 500 }
      )
    }

    await sendCalendarEmail({
      to: recipients,
      subject: `***** FC Uno System Health ${health.status.toUpperCase()}`,
      html: buildAlertHtml(unhealthyChecks, health.checkedAt),
    })

    return NextResponse.json({
      success: true,
      sent: true,
      status: health.status,
      recipients: recipients.length,
      checks: unhealthyChecks.map((check) => ({
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
