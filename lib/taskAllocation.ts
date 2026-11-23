import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { getStoredAdminRole } from "@/lib/adminUsers"
import { createCalendarServiceClient } from "@/lib/calendarServiceClient"
import { isValidCalendarDate } from "@/lib/eventCalendarDates"
import { defaultEventCalendarPeople, normalizeEventCalendarPeople } from "@/lib/eventCalendarPeople"
import { compareAndSetCalendarPayload } from "@/lib/officeCalendarStore"
import { compareOfficeStaff } from "@/lib/officeStaffOrder"
import { getTaskCalendarTaskVersion } from "@/lib/taskCalendarStore"

const scheduleKey = "task-allocation"

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
  btPeople?: string[]
}

export type TaskAllocationRow = TaskAllocationTask & {
  directAssignees: string[]
  assignedToBt: boolean
  version: string
}

export type TaskAllocation = {
  effectiveDate: string
  updatedAt: string | null
  tasks: TaskAllocationRow[]
  people: string[]
  btPeople: string[]
}

type TaskAllocationMutation = { id: number; assignees: string[]; version: string }

export class TaskAllocationValidationError extends Error {}

export class TaskAllocationConflictError extends Error {
  constructor(readonly allocation: TaskAllocation | null) {
    super("Assignments changed while you were editing. Reopen the task to review them.")
  }
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isTask(value: unknown): value is TaskAllocationTask {
  if (!value || typeof value !== "object") return false
  const task = value as Partial<TaskAllocationTask>
  return Number.isInteger(task.id) &&
    (task.category === "Sales" || task.category === "Support") &&
    typeof task.title === "string" && Boolean(task.title.trim()) &&
    (task.region === undefined || typeof task.region === "string") &&
    isStringList(task.assignees)
}

export function parseTaskAllocationSchedule(value: unknown): TaskAllocationSchedule {
  const schedule = value as Partial<TaskAllocationSchedule> | null
  if (!schedule || typeof schedule.effectiveDate !== "string" ||
    !isValidCalendarDate(schedule.effectiveDate) || !Array.isArray(schedule.tasks) ||
    !schedule.tasks.every(isTask) || new Set(schedule.tasks.map((task) => task.id)).size !== schedule.tasks.length ||
    (schedule.btPeople !== undefined && !isStringList(schedule.btPeople))) {
    throw new Error("Invalid task allocation schedule.")
  }
  return { ...schedule, effectiveDate: schedule.effectiveDate, tasks: schedule.tasks }
}

export function parseTaskAllocationMutation(value: unknown): TaskAllocationMutation {
  const input = value as Partial<TaskAllocationMutation> | null
  if (!input || typeof input.id !== "number" || !Number.isSafeInteger(input.id) ||
    !isStringList(input.assignees) || typeof input.version !== "string" || !/^[a-f0-9]{64}$/.test(input.version)) {
    throw new TaskAllocationValidationError("Invalid task assignment.")
  }
  return { id: input.id, assignees: [...new Set(input.assignees)], version: input.version }
}

function allocationCodes(codes: string[]) {
  return normalizeEventCalendarPeople(codes).map((code) => code === "LONG" ? "LV" : code)
}

export function resolveTaskAllocation(
  schedule: TaskAllocationSchedule,
  calendarPeople: string[] | null | undefined,
  traders: string[],
  updatedAt: string | null = null,
): TaskAllocation {
  const btPeople = [...new Set(allocationCodes(schedule.btPeople ?? traders))].filter((code) => code !== "BT").sort(compareOfficeStaff)
  const tasks = schedule.tasks.map((task) => {
    const assigned = [...new Set(allocationCodes(task.assignees.flatMap((entry) => entry.split("/"))))]
    const assignedToBt = assigned.includes("BT")
    const directAssignees = assigned.filter((code) => code !== "BT")
    const assignees = [...new Set([...directAssignees, ...(assignedToBt ? btPeople : [])])].sort(compareOfficeStaff)
    const version = getTaskCalendarTaskVersion({ task, btPeople })
    return { ...task, assignees, assignedToBt, directAssignees, version }
  })
  const people = [...new Set([
    ...allocationCodes(calendarPeople ?? defaultEventCalendarPeople),
    ...btPeople,
    ...tasks.flatMap((task) => task.assignees),
  ])].sort(compareOfficeStaff)
  return { effectiveDate: schedule.effectiveDate, updatedAt, tasks, people, btPeople }
}

function readSchedule(supabase: SupabaseClient) {
  return supabase.from("office_calendar_store").select("payload,updated_at").eq("key", scheduleKey).maybeSingle()
}

async function loadCalendarPeople(supabase: SupabaseClient) {
  const { data, error } = await supabase.from("office_calendar_store").select("people:payload->people").eq("key", "event-calendar").maybeSingle()
  if (error) throw error
  const people: unknown = data?.people
  if (people == null) return null
  if (!isStringList(people)) throw new Error("The Event Calendar roster is invalid.")
  return people
}

async function loadLegacyBtPeople(supabase: SupabaseClient) {
  const [users, staff] = await Promise.all([
    supabase.from("admin_users").select("id,display_name,role,permissions").eq("is_active", true),
    supabase.from("attendance_people").select("admin_user_id,staff_code").eq("is_active", true).not("admin_user_id", "is", null),
  ])
  if (users.error || staff.error) throw new Error("Task allocation staff is unavailable.")
  const staffCodes = new Map(staff.data.map((person) => [person.admin_user_id, person.staff_code] as const))
  return users.data
    .filter((user) => getStoredAdminRole(user) === "BT")
    .map((user) => staffCodes.get(user.id) || user.display_name || "")

}

export async function loadTaskAllocation(): Promise<TaskAllocation | null> {
  const supabase = createCalendarServiceClient()
  const [stored, calendarPeople] = await Promise.all([readSchedule(supabase), loadCalendarPeople(supabase)])
  if (stored.error) throw stored.error
  if (!stored.data) return null

  const schedule = parseTaskAllocationSchedule(stored.data.payload)
  const traders = schedule.btPeople ?? await loadLegacyBtPeople(supabase)
  return resolveTaskAllocation(schedule, calendarPeople, traders, stored.data.updated_at)
}

export function applyTaskAllocationMutation(
  current: TaskAllocationSchedule,
  allocation: TaskAllocation,
  mutation: TaskAllocationMutation,
): TaskAllocationSchedule {
  const task = allocation.tasks.find((row) => row.id === mutation.id)
  if (!task) throw new TaskAllocationConflictError(allocation)

  const allowed = new Set([...allocation.people, "BT"])
  if (mutation.assignees.some((code) => !allowed.has(code))) {
    throw new TaskAllocationValidationError("Choose PIC from the current roster.")
  }

  const saved = new Set([...task.directAssignees, ...(task.assignedToBt ? ["BT"] : [])])
  if (saved.size === mutation.assignees.length && mutation.assignees.every((code) => saved.has(code))) return current
  if (task.version !== mutation.version) throw new TaskAllocationConflictError(allocation)

  return {
    ...current,
    tasks: current.tasks.map((row) => row.id === task.id ? { ...row, assignees: mutation.assignees } : row),
  }
}

export async function saveTaskAllocation(supabase: SupabaseClient, mutation: TaskAllocationMutation) {
  const calendarPeople = await loadCalendarPeople(supabase)
  let legacyBtPeople: string[] | undefined

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { data, error } = await readSchedule(supabase)
    if (error) throw error
    if (!data) throw new TaskAllocationConflictError(null)

    const current = parseTaskAllocationSchedule(data.payload)
    const btPeople = current.btPeople ?? (legacyBtPeople ??= await loadLegacyBtPeople(supabase))
    const allocation = resolveTaskAllocation(current, calendarPeople, btPeople, data.updated_at)
    const next = applyTaskAllocationMutation(current, allocation, mutation)
    if (next === current) return allocation

    const saved = await compareAndSetCalendarPayload(supabase, scheduleKey, data.updated_at, next)
    if (saved.error) throw saved.error
    if (saved.data) {
      return resolveTaskAllocation(parseTaskAllocationSchedule(saved.data.payload), calendarPeople, btPeople, saved.data.updated_at)
    }
  }

  throw new Error("The schedule is busy. Try saving again.")
}
