import "server-only"

import { randomUUID } from "node:crypto"
import { fcunoConnectionPolicy } from "@/config/fcunoConnections"
import { getEmailNoticeConfigStatus, sendNoticeEmail } from "@/lib/emailNotice"
import { tripClaimHref } from "@/lib/tripExpenseClaim"
import { allocateTripExpenseBackupId, openTripExpenseBackupDrive, writeTripExpenseBackup } from "@/lib/tripExpenseBackup"
import {
  createTripExpenseDb,
  getTripDeliveryClaim,
  TRIP_EXPENSE_ADMIN_EMAIL,
  TRIP_EXPENSE_TABLE,
  tripReceiptBucket,
} from "@/lib/tripExpenseStore"

const LEASE_MS = 6 * 60 * 1000
const RETRY_MS = 15 * 60 * 1000
const deliveryServices = {
  openBackup: openTripExpenseBackupDrive,
  reserveBackup: allocateTripExpenseBackupId,
  writeBackup: writeTripExpenseBackup,
  emailConfig: getEmailNoticeConfigStatus,
  sendEmail: sendNoticeEmail,
}

function timestamp() {
  return new Date().toISOString()
}

export async function deliverTripExpenseClaim(id: string, db = createTripExpenseDb(), services = deliveryServices) {
  // An interrupted worker can retry the backup. An interrupted SMTP attempt
  // leaves an unconfirmed receipt rather than sending a duplicate email.
  const now = timestamp()
  const token = randomUUID()
  const lease = await db.from(TRIP_EXPENSE_TABLE).update({
    delivery_token: token, delivery_lease_until: new Date(Date.now() + LEASE_MS).toISOString(),
  }).eq("id", id).is("email_attempted_at", null).lte("delivery_retry_at", now)
    .or("delivery_lease_until.is.null,delivery_lease_until.lt." + now)
    .select("id").maybeSingle()
  if (lease.error) throw lease.error
  if (!lease.data) return false

  async function update(values: Record<string, string | null>) {
    const { data, error } = await db.from(TRIP_EXPENSE_TABLE).update(values)
      .eq("id", id).eq("delivery_token", token).select("id").maybeSingle()
    if (error || !data) throw new Error("Trip claim delivery state changed.")
  }

  let delivered = false
  try {
    const claim = await getTripDeliveryClaim(db, id)
    if (!claim) throw new Error("Trip claim not found.")
    if (!claim.backed_up_at) {
      const drive = await services.openBackup()
      const fileId = claim.backup_file_id || await services.reserveBackup(drive)
      if (!claim.backup_file_id) await update({ backup_file_id: fileId })
      await services.writeBackup(drive, claim, fileId, tripReceiptBucket(db))
      await update({ backed_up_at: timestamp() })
    }

    if (services.emailConfig().missing.length) throw new Error("Trip claim email is unavailable.")
    await update({ email_attempted_at: timestamp() })
    const url = fcunoConnectionPolicy.vercel.productionOrigins[0] + tripClaimHref(id)
    const result = await services.sendEmail({
      to: [TRIP_EXPENSE_ADMIN_EMAIL],
      subject: "Trip expense claim · " + id.slice(0, 8).toUpperCase(),
      html: '<p>A trip expense claim was submitted.</p><p><a href="' + url + '">Open claim</a></p>',
    }).catch(async (error: unknown) => {
      // SMTP can safely retry a failure that occurred before reaching DATA.
      if (error && typeof error === "object" && "command" in error &&
          typeof error.command === "string" && /^(?:CONN|EHLO|HELO|STARTTLS|AUTH|MAIL FROM|RCPT TO)(?: |$)/.test(error.command)) {
        await update({ email_attempted_at: null })
      }
      throw error
    })
    if (!result.accepted.some(address => address.toLowerCase() === TRIP_EXPENSE_ADMIN_EMAIL)) {
      throw new Error("Trip claim email acceptance is unconfirmed.")
    }
    await update({ emailed_at: timestamp() })
    delivered = true
    return true
  } finally {
    await update({
      delivery_token: null, delivery_lease_until: null,
      ...(delivered ? {} : { delivery_retry_at: new Date(Date.now() + RETRY_MS).toISOString() }),
    })
  }
}

export async function retryTripExpenseDeliveries() {
  const db = createTripExpenseDb()
  const now = timestamp()
  const { data, error } = await db.from(TRIP_EXPENSE_TABLE).select("id").is("email_attempted_at", null)
    .lte("delivery_retry_at", now).or("delivery_lease_until.is.null,delivery_lease_until.lt." + now)
    .order("delivery_retry_at").order("submitted_at").limit(3)
  if (error) throw error
  const deliveries = await Promise.allSettled(data.map(row => deliverTripExpenseClaim(row.id, db)))
  return {
    emailed: deliveries.filter(result => result.status === "fulfilled" && result.value).length,
    failed: deliveries.filter(result => result.status === "rejected").length,
  }
}
