import { createHash, randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createCalendarServiceClient } from "@/lib/calendarServiceClient"
import { sendCalendarEmail } from "@/lib/eventCalendarEmail"
import { getEmailNoticeConfigStatus } from "@/lib/emailNotice"
import { isValidEmailAddress } from "@/lib/emailAddress"

type CalendarDelivery = {
  kind: "task" | "event-daily" | "event-change" | "leave"
  occurrenceDate: string
  recordId: string
  recordVersion?: string
  to: string[]
  cc?: string[]
  subject: string
  html: string
}
type Dependencies = { supabase: SupabaseClient; send: typeof sendCalendarEmail; now?: () => Date; preflight?: () => void }
export type CalendarDeliveryResult = { status: "delivered" | "already_delivered" | "in_progress"; sent: number }

export function calendarDeliveryKey(input: CalendarDelivery) {
  // Changing task wording/recipients during a day must not resend its occurrence.
  // Event-change emails instead identify the exact saved version/batch.
  const occurrence = input.kind === "event-change" ? input.recordVersion : input.occurrenceDate
  if (!input.recordId || !occurrence) throw new Error("Calendar email identity is missing.")
  return `calendar-email:${createHash("sha256").update(JSON.stringify([input.kind, input.recordId, occurrence])).digest("hex")}`
}

export async function deliverCalendarReminder(input: CalendarDelivery, dependencies?: Dependencies): Promise<CalendarDeliveryResult> {
  const to = [...new Set(input.to.map((email) => email.toLowerCase()))]
  const cc = [...new Set((input.cc || []).map((email) => email.toLowerCase()))].filter((email) => !to.includes(email))
  if (!to.length || [...to, ...cc].some((email) => !isValidEmailAddress(email))) throw new Error("Calendar email recipients are incomplete or invalid.")
  const db = dependencies?.supabase || createCalendarServiceClient()
  const now = dependencies?.now || (() => new Date())
  const send = dependencies?.send || sendCalendarEmail
  if (dependencies) dependencies.preflight?.()
  else if (getEmailNoticeConfigStatus().missing.length) throw new Error("Calendar email delivery is not configured. No email was sent.")

  const key = calendarDeliveryKey(input), claimId = randomUUID(), at = now().toISOString()
  const payload = { version: 1, kind: input.kind, occurrenceDate: input.occurrenceDate, claimId, status: "claimed", claimedAt: at, recipientCount: to.length + cc.length }
  // A unique insert is the cross-worker lock. This store is already protected
  // and backed up. No addresses, message content or raw SMTP errors are stored.
  const claim = await db.from("office_calendar_store").insert({ key, payload, updated_at: at })
  if (claim.error) {
    if (claim.error.code !== "23505") throw new Error("Could not record this email attempt. No email was sent.")
    const prior = await db.from("office_calendar_store").select("payload").eq("key", key).maybeSingle()
    if (prior.error || !prior.data?.payload || prior.data.payload.version !== 1) throw new Error("Calendar email delivery history is unavailable. No duplicate email was sent.")
    const previous = prior.data.payload
    if (previous.status === "sent") return { status: "already_delivered", sent: Number(previous.recipientCount) || 0 }
    if (previous.status === "claimed" && Number.isFinite(Date.parse(previous.claimedAt)) && now().getTime() - Date.parse(previous.claimedAt) < 120000) return { status: "in_progress", sent: 0 }
    throw new Error("This email's delivery could not be confirmed. Automatic resend is paused to avoid duplicates; ask an administrator to check Sent Items.")
  }

  async function record(status: "sent" | "uncertain") {
    const result = await db.from("office_calendar_store")
      .update({ payload: { ...payload, status, completedAt: now().toISOString() }, updated_at: now().toISOString() })
      .eq("key", key).eq("payload->>claimId", claimId).eq("payload->>status", "claimed")
      .select("key").maybeSingle()
    if (result.error || !result.data) throw new Error("The email was submitted but its delivery record could not be confirmed. Do not resend; check Sent Items.")
  }

  try {
    const receipt = await send({ to, cc, subject: input.subject, html: input.html })
    const accepted = new Set(receipt.accepted.map((value) => value.toLowerCase()))
    if (receipt.rejected.length || [...to, ...cc].some((email) => !accepted.has(email))) throw new Error("Not all recipients were accepted.")
  } catch {
    await record("uncertain")
    throw new Error("Email delivery was not fully confirmed. Automatic resend is paused to avoid duplicates; ask an administrator to check Sent Items.")
  }
  await record("sent")
  return { status: "delivered", sent: to.length + cc.length }
}
