import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import {
  getDueTaskCalendarTasks,
  getTaskScheduleText,
  resolveTaskRecipients,
  TaskCalendarTask,
} from "@/data/taskCalendar"
import { sendCalendarEmail } from "@/lib/eventCalendarEmail"

const ADMIN_COOKIE_NAME = "bunker_admin_auth"

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
  const cookieStore = await cookies()

  if (!hasAccess(request) && cookieStore.get(ADMIN_COOKIE_NAME)?.value !== "1") {
    return NextResponse.json({ message: "Not authorized." }, { status: 401 })
  }

  const dueTasks = getDueTaskCalendarTasks()
  const sent: Array<{ id: string; subject: string; to: number; cc: number }> = []
  const skipped: Array<{ id: string; reason: string }> = []

  try {
    for (const task of dueTasks) {
      const to = resolveTaskRecipients(task.notify)
      const cc = resolveTaskRecipients(task.cc)

      if (!to.length) {
        skipped.push({ id: task.id, reason: "No valid notify recipients." })
        continue
      }

      const email = buildTaskReminderEmail(task)
      await sendCalendarEmail({
        to,
        cc,
        subject: email.subject,
        html: email.html,
      })
      sent.push({ id: task.id, subject: email.subject, to: to.length, cc: cc.length })
    }

    return NextResponse.json({ success: true, due: dueTasks.length, sent, skipped })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Task reminder failed.", sent, skipped },
      { status: 500 }
    )
  }
}
