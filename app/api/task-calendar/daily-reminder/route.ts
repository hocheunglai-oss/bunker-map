import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import {
  getDueTaskCalendarTasks,
  getTaskScheduleText,
  resolveTaskRecipients,
  TaskCalendarTask,
  taskCalendarTasks,
} from "@/data/taskCalendar"
import { sendCalendarEmail } from "@/lib/eventCalendarEmail"
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
    process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
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

function normalizeStoredTasks(value: unknown) {
  if (!Array.isArray(value)) return taskCalendarTasks

  const tasks = value.filter((task): task is TaskCalendarTask => {
    return (
      task &&
      typeof task === "object" &&
      typeof task.id === "string" &&
      typeof task.task === "string" &&
      Array.isArray(task.daysOfMonth) &&
      Array.isArray(task.notify) &&
      Array.isArray(task.cc)
    )
  })

  return tasks.length ? tasks : taskCalendarTasks
}

async function loadTaskCalendarTasks() {
  try {
    const supabase = getSupabaseClient()
    const { data, error } = await supabase
      .from("office_calendar_store")
      .select("payload")
      .eq("key", SHARED_STORE_KEY)
      .maybeSingle()

    if (error) throw error
    return normalizeStoredTasks(data?.payload?.tasks)
  } catch {
    return taskCalendarTasks
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
  const storedTasks = await loadTaskCalendarTasks()
  const dueTasks = getDueTaskCalendarTasks(new Date(), storedTasks)
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
      if (dryRun) {
        sent.push({ id: task.id, subject: email.subject, to: to.length, cc: cc.length })
        continue
      }

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
