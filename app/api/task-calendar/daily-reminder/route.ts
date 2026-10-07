import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import {
  getDueTaskCalendarTasks,
  getHongKongTaskDate,
  getTaskScheduleText,
  readTaskCalendarTasks,
  TaskCalendarTask,
} from "@/data/taskCalendar"
import { loadCalendarStaffDirectory, resolveCalendarStaffRecipients } from "@/lib/calendarStaff"
import { deliverCalendarReminder } from "@/lib/calendarDelivery"
import { requireAdminPagePermission } from "@/lib/adminAuth"

const SHARED_STORE_KEY = "task-calendar"

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function getSupabaseClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY")
  )
}

function hasAccess(request: Request) {
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

function buildTaskReminderEmail(task: TaskCalendarTask) {
  return {
    subject: `***** ${task.task}`,
    html: `
        <div style="font-family:Arial,Helvetica,sans-serif;color:#10243a;line-height:1.45">
          <p style="margin:0 0 8px"><strong>Task</strong><br />${escapeHtml(task.task)}</p>
        <p style="margin:0 0 8px"><strong>Schedule</strong><br />${escapeHtml(getTaskScheduleText(task))}</p>
        <p style="margin:0"><strong>Remark</strong><br />${escapeHtml(task.remark || "-")}</p>
      </div>
    `,
  }
}

export async function GET(request: Request) {
  if (!hasAccess(request)) {
    try {
      await requireAdminPagePermission("task-calendar", "edit")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unauthorized"
      return NextResponse.json(
        { message },
        { status: message === "Unauthorized" ? 401 : 403 }
      )
    }
  }

  const { searchParams } = new URL(request.url)
  const dryRun = searchParams.get("dryRun") === "1"
  const sent: Array<{ id: string; subject: string; to: number; cc: number }> = []
  const skipped: Array<{ id: string; reason: string }> = []
  const failed: Array<{ id: string; reason: string }> = []

  try {
    const supabase = getSupabaseClient()
    const { data, error } = await supabase.from("office_calendar_store").select("payload").eq("key", SHARED_STORE_KEY).maybeSingle()
    if (error) throw error
    const storedTasks = readTaskCalendarTasks(data?.payload ?? null)
    const occurrenceDate = getHongKongTaskDate()
    const dueTasks = getDueTaskCalendarTasks(occurrenceDate, storedTasks)
    const staff = dueTasks.length ? await loadCalendarStaffDirectory(supabase) : []
    for (const task of dueTasks) {
      try {
        const notify = resolveCalendarStaffRecipients(task.notify, staff)
        const copied = resolveCalendarStaffRecipients(task.cc, staff)
        const unresolved = Array.from(new Set([...notify.unresolved, ...copied.unresolved]))
        if (unresolved.length) throw new Error(`No confirmed email address for ${unresolved.join(", ")}. Update the staff directory; this reminder was not sent.`)
        const to = notify.recipients
        const cc = copied.recipients.filter((email) => !to.includes(email))
        if (!to.length) throw new Error("No confirmed Notify To recipients. This reminder was not sent.")
        const email = buildTaskReminderEmail(task)
        if (!dryRun) {
          const result = await deliverCalendarReminder({ kind: "task", occurrenceDate, recordId: task.id, to, cc, ...email })
          if (result.status !== "delivered") {
            skipped.push({ id: task.id, reason: result.status === "already_delivered" ? "Already sent for this date." : "Another run is handling this reminder." })
            continue
          }
        }
        sent.push({ id: task.id, subject: email.subject, to: to.length, cc: cc.length })
      } catch (error) {
        failed.push({ id: task.id, reason: error instanceof Error ? error.message : "This task reminder could not be delivered." })
      }
    }

    return NextResponse.json({ success: !failed.length, occurrenceDate, dryRun, due: dueTasks.length, sent, skipped, failed }, { status: failed.length ? 500 : 200 })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Task reminder failed.", sent, skipped, failed },
      { status: 500 }
    )
  }
}
