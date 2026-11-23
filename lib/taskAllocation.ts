import "server-only"
import { getStoredAdminRole } from "@/lib/adminUsers"
import { createCalendarServiceClient } from "@/lib/calendarServiceClient"
import { isValidCalendarDate } from "@/lib/eventCalendarDates"
import { defaultEventCalendarPeople, normalizeEventCalendarPeople } from "@/lib/eventCalendarPeople"

export type TaskAllocationTask = {
  id: number
  category: "Sales" | "Support"
  title: string
  region?: string
  assignees: string[]
}

type TaskAllocationSchedule = {
  effectiveDate: string
  tasks: TaskAllocationTask[]
}

export type TaskAllocation = TaskAllocationSchedule & { people: string[] }

function isTask(value: unknown): value is TaskAllocationTask {
  if (!value || typeof value !== "object") return false
  const task = value as Partial<TaskAllocationTask>
  return Number.isInteger(task.id) &&
    (task.category === "Sales" || task.category === "Support") &&
    typeof task.title === "string" && Boolean(task.title.trim()) &&
    (task.region === undefined || typeof task.region === "string") &&
    Array.isArray(task.assignees) && task.assignees.every((person) => typeof person === "string")
}

export function parseTaskAllocationSchedule(value: unknown): TaskAllocationSchedule {
  const schedule = value as Partial<TaskAllocationSchedule> | null
  if (!schedule || typeof schedule.effectiveDate !== "string" ||
    !isValidCalendarDate(schedule.effectiveDate) || !Array.isArray(schedule.tasks) ||
    !schedule.tasks.every(isTask) || new Set(schedule.tasks.map((task) => task.id)).size !== schedule.tasks.length) {
    throw new Error("Invalid task allocation schedule.")
  }
  return { effectiveDate: schedule.effectiveDate, tasks: schedule.tasks }
}

export function resolveTaskAllocation(
  schedule: TaskAllocationSchedule,
  calendarPeople: string[] | null | undefined,
  traders: string[],
): TaskAllocation {
  const personCode = (code: string) => code === "LONG" ? "LV" : code
  const normalize = (codes: string[]) => normalizeEventCalendarPeople(codes).map(personCode)
  const btPeople = normalize(traders).sort((a, b) => a.localeCompare(b))
  const tasks = schedule.tasks.map((task) => {
    const assigned = normalize(task.assignees.flatMap((entry) => entry.split("/")))
    const assignees = [...new Set(assigned.flatMap((code) => code === "BT" ? btPeople : [code]))]
    return { ...task, assignees }
  })
  const people = [...new Set([
    ...normalize(calendarPeople ?? defaultEventCalendarPeople),
    ...tasks.flatMap((task) => task.assignees),
  ])]
  return { effectiveDate: schedule.effectiveDate, tasks, people }
}

export async function loadTaskAllocation(): Promise<TaskAllocation | null> {
  const supabase = createCalendarServiceClient()
  const [schedule, calendar, users, staff] = await Promise.all([
    supabase.from("office_calendar_store").select("payload").eq("key", "task-allocation").maybeSingle(),
    supabase.from("office_calendar_store").select("people:payload->people").eq("key", "event-calendar").maybeSingle(),
    supabase.from("admin_users").select("id,display_name,role,permissions").eq("is_active", true),
    supabase.from("attendance_people").select("admin_user_id,staff_code").eq("is_active", true).not("admin_user_id", "is", null),
  ])
  if (schedule.error || calendar.error || users.error || staff.error) {
    throw new Error("Task allocation data is unavailable.")
  }
  if (!schedule.data) return null

  const calendarPeople: unknown = calendar.data?.people
  if (calendarPeople != null &&
    (!Array.isArray(calendarPeople) || !calendarPeople.every((person) => typeof person === "string"))) {
    throw new Error("The Event Calendar roster is invalid.")
  }

  const staffCodes = new Map(staff.data.map((person) => [person.admin_user_id, person.staff_code] as const))
  const traders = users.data
    .filter((user) => getStoredAdminRole(user) === "BT")
    .map((user) => staffCodes.get(user.id) || user.display_name || "")

  return resolveTaskAllocation(parseTaskAllocationSchedule(schedule.data.payload), calendarPeople, traders)
}
