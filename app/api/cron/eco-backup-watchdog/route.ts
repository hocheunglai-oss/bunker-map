import { sendNoticeEmail } from "@/lib/emailNotice"
import { createHealthAlertStore } from "@/lib/systemHealthAlertStore"
import { readEcoBackupObservation } from "@/lib/ecoBackupWatchdog"
import { handleEcoBackupWatchdog } from "@/lib/ecoBackupWatchdogDelivery"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 45

export function GET(request: Request) {
  return handleEcoBackupWatchdog(request, {
    environment: process.env.VERCEL_ENV,
    enabled: process.env.ECO_BACKUP_WATCHDOG_ENABLED,
    cronSecret: process.env.CRON_SECRET,
    recipient: process.env.ECO_BACKUP_ALERT_RECIPIENT,
    read: readEcoBackupObservation,
    store: createHealthAlertStore,
    send: sendNoticeEmail,
  })
}
